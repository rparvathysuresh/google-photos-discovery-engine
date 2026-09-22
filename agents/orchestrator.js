/**
 * Pipeline Orchestrator
 * 
 * Top-level async controller that:
 * - Runs all 5 collectors in parallel (Stage 1)
 * - Checks _meta.json gates between stages
 * - Chains filter → extract → cluster sequentially (Stages 2–4)
 * - Tracks pipeline state in /data/_pipeline_state.json
 * - Supports CLI flags: --stage <n>, --sample
 * 
 * Usage:
 *   node agents/orchestrator.js              # Full pipeline
 *   node agents/orchestrator.js --stage 2    # Resume from filtering
 *   node agents/orchestrator.js --stage 3 --sample  # Sample extraction only
 */

const fs = require('fs');
const path = require('path');
const { log, writeJSON, readJSON, projectPath, sleep } = require('./utils');

const AGENT = 'orchestrator';

// ---------------------------------------------------------------------------
// Collector Registry
// ---------------------------------------------------------------------------

const COLLECTORS = [
  { name: 'playstore',      module: './collectors/playstore' },
  { name: 'appstore',       module: './collectors/appstore' },
  { name: 'reddit',         module: './collectors/reddit' },
  { name: 'helpcommunity',  module: './collectors/helpcommunity' },
  { name: 'youtube',        module: './collectors/youtube' },
];

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    stage: null,   // Start from this stage (1–4), null = run all
    sample: false, // Pass --sample to extraction agent
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stage' && args[i + 1]) {
      parsed.stage = parseInt(args[i + 1], 10);
      if (isNaN(parsed.stage) || parsed.stage < 1 || parsed.stage > 4) {
        console.error('ERROR: --stage must be 1, 2, 3, or 4');
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--sample') {
      parsed.sample = true;
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Pipeline State Management
// ---------------------------------------------------------------------------

const STATE_PATH = projectPath('data', '_pipeline_state.json');

function loadState() {
  try {
    return readJSON(STATE_PATH);
  } catch {
    return {
      pipeline_id: `run_${Date.now()}`,
      started_at: new Date().toISOString(),
      completed_at: null,
      stages: {},
    };
  }
}

function saveState(state) {
  writeJSON(STATE_PATH, state);
}

function updateStageState(state, stageNum, status, details = {}) {
  state.stages[`stage_${stageNum}`] = {
    status,
    started_at: details.started_at || new Date().toISOString(),
    completed_at: status === 'running' ? null : new Date().toISOString(),
    ...details,
  };
  saveState(state);
}

// ---------------------------------------------------------------------------
// Stage 1: Collection (Parallel with Retry)
// ---------------------------------------------------------------------------

/**
 * Run a single collector with retry logic.
 * @param {object} collector - {name, module}
 * @param {number} maxRetries - Maximum retries
 * @returns {Promise<{name: string, status: string, count: number, error?: string}>}
 */
async function runCollectorWithRetry(collector, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(AGENT, `[${collector.name}] Attempt ${attempt}/${maxRetries}…`);
      const mod = require(collector.module);
      const result = await mod.collect();

      if (result.status !== 'failed') {
        log(AGENT, `[${collector.name}] Completed: ${result.status}, ${result.count} records`);
        return { name: collector.name, ...result };
      }

      // Failed — retry if attempts remain
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        log(AGENT, `[${collector.name}] Failed, retrying in ${delay}ms…`);
        await sleep(delay);
      }
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        log(AGENT, `[${collector.name}] Error: ${error.message}, retrying in ${delay}ms…`);
        await sleep(delay);
      } else {
        log(AGENT, `[${collector.name}] All retries exhausted: ${error.message}`);
        return { name: collector.name, status: 'failed', count: 0, error: error.message };
      }
    }
  }

  return { name: collector.name, status: 'failed', count: 0, error: 'All retries exhausted' };
}

/**
 * Run all collectors in parallel using Promise.allSettled.
 */
async function runStage1(state) {
  log(AGENT, '═══════════════════════════════════════════════');
  log(AGENT, 'STAGE 1: Collection (parallel)');
  log(AGENT, '═══════════════════════════════════════════════');

  const startedAt = new Date().toISOString();
  updateStageState(state, 1, 'running', { started_at: startedAt });

  const results = await Promise.allSettled(
    COLLECTORS.map((c) => runCollectorWithRetry(c))
  );

  const collectorResults = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { name: COLLECTORS[i].name, status: 'failed', count: 0, error: r.reason?.message };
  });

  // Summary
  const succeeded = collectorResults.filter((r) => r.status === 'success');
  const partial = collectorResults.filter((r) => r.status === 'partial');
  const failed = collectorResults.filter((r) => r.status === 'failed');
  const totalRecords = collectorResults.reduce((sum, r) => sum + (r.count || 0), 0);

  log(AGENT, '───────────────────────────────────────────────');
  log(AGENT, `Stage 1 Summary:`);
  log(AGENT, `  Success: ${succeeded.length}, Partial: ${partial.length}, Failed: ${failed.length}`);
  log(AGENT, `  Total records: ${totalRecords}`);
  log(AGENT, '───────────────────────────────────────────────');

  // Determine stage status
  const allFailed = failed.length === COLLECTORS.length;
  const stageStatus = allFailed ? 'failed' : failed.length > 0 || partial.length > 0 ? 'partial' : 'success';

  updateStageState(state, 1, stageStatus, {
    started_at: startedAt,
    collectors: collectorResults,
    total_records: totalRecords,
  });

  if (allFailed) {
    log(AGENT, 'FATAL: All collectors failed. Pipeline cannot continue.');
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Meta-Check Gate
// ---------------------------------------------------------------------------

/**
 * Read _meta.json sidecars for all collectors and validate.
 * Logs warnings for partial, returns false only if ALL failed.
 */
function checkStage1Meta() {
  log(AGENT, 'Checking Stage 1 meta files…');
  let totalRecords = 0;
  let anySuccess = false;

  for (const collector of COLLECTORS) {
    const metaPath = projectPath('data', 'raw', `${collector.name}_meta.json`);
    try {
      const meta = readJSON(metaPath);
      if (meta.status === 'success') {
        log(AGENT, `  ✓ ${collector.name}: ${meta.record_count} records (success)`);
        anySuccess = true;
      } else if (meta.status === 'partial') {
        log(AGENT, `  ⚠ ${collector.name}: ${meta.record_count} records (partial — ${meta.errors?.length || 0} errors)`);
        anySuccess = true;
      } else {
        log(AGENT, `  ✗ ${collector.name}: failed`);
      }
      totalRecords += meta.record_count || 0;
    } catch {
      log(AGENT, `  ✗ ${collector.name}: no meta file found`);
    }
  }

  log(AGENT, `  Total records across all sources: ${totalRecords}`);
  return anySuccess;
}

// ---------------------------------------------------------------------------
// Stage 2: Filtering
// ---------------------------------------------------------------------------

async function runStage2(state) {
  log(AGENT, '═══════════════════════════════════════════════');
  log(AGENT, 'STAGE 2: Filtering');
  log(AGENT, '═══════════════════════════════════════════════');

  const startedAt = new Date().toISOString();
  updateStageState(state, 2, 'running', { started_at: startedAt });

  try {
    const filter = require('./filter');
    const result = await filter.run();

    updateStageState(state, 2, result.status, {
      started_at: startedAt,
      records_in: result.records_in || 0,
      records_out: result.records_out || 0,
    });

    log(AGENT, `Stage 2 complete: ${result.records_out}/${result.records_in} records passed filter`);
    return result.status !== 'failed';
  } catch (error) {
    log(AGENT, `Stage 2 FAILED: ${error.message}`);
    updateStageState(state, 2, 'failed', { started_at: startedAt, error: error.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stage 3: Extraction
// ---------------------------------------------------------------------------

async function runStage3(state, sampleMode = false) {
  log(AGENT, '═══════════════════════════════════════════════');
  log(AGENT, `STAGE 3: Extraction${sampleMode ? ' (SAMPLE MODE)' : ''}`);
  log(AGENT, '═══════════════════════════════════════════════');

  const startedAt = new Date().toISOString();
  updateStageState(state, 3, 'running', { started_at: startedAt, sample_mode: sampleMode });

  try {
    const extractor = require('./extractor');
    const result = await extractor.run({ sample: sampleMode });

    updateStageState(state, 3, result.status, {
      started_at: startedAt,
      sample_mode: sampleMode,
      records_extracted: result.records_extracted || 0,
      errors: result.errors_count || 0,
    });

    log(AGENT, `Stage 3 complete: ${result.records_extracted} records extracted`);
    return result.status !== 'failed';
  } catch (error) {
    log(AGENT, `Stage 3 FAILED: ${error.message}`);
    updateStageState(state, 3, 'failed', { started_at: startedAt, error: error.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stage 4: Clustering
// ---------------------------------------------------------------------------

async function runStage4(state) {
  log(AGENT, '═══════════════════════════════════════════════');
  log(AGENT, 'STAGE 4: Clustering & Analysis');
  log(AGENT, '═══════════════════════════════════════════════');

  const startedAt = new Date().toISOString();
  updateStageState(state, 4, 'running', { started_at: startedAt });

  try {
    const clusterer = require('./clusterer');
    const result = await clusterer.run();

    updateStageState(state, 4, result.status, {
      started_at: startedAt,
      clusters_produced: result.clusters_produced || 0,
    });

    log(AGENT, `Stage 4 complete: ${result.clusters_produced} clusters produced`);
    return result.status !== 'failed';
  } catch (error) {
    log(AGENT, `Stage 4 FAILED: ${error.message}`);
    updateStageState(state, 4, 'failed', { started_at: startedAt, error: error.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pipeline Lockfile
// ---------------------------------------------------------------------------

const LOCK_PATH = projectPath('data', '.pipeline.lock');

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'));
      log(AGENT, `WARNING: Pipeline lock exists (started at ${lockData.started_at}, PID ${lockData.pid}).`);
      log(AGENT, 'Another pipeline run may be in progress. Delete data/.pipeline.lock to override.');
      return false;
    }
  } catch {
    // Lock file is corrupt — overwrite it
  }

  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.writeFileSync(LOCK_PATH, JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
  }));
  return true;
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // Already removed
  }
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const startStage = args.stage || 1;

  log(AGENT, '╔═══════════════════════════════════════════════╗');
  log(AGENT, '║  Google Photos Retrieval Failure Pipeline     ║');
  log(AGENT, '╚═══════════════════════════════════════════════╝');
  log(AGENT, `Starting from stage: ${startStage}${args.sample ? ' (sample mode)' : ''}`);

  // Acquire lock
  if (!acquireLock()) {
    process.exit(1);
  }

  const state = loadState();
  state.started_at = new Date().toISOString();
  state.completed_at = null;
  state.args = { start_stage: startStage, sample: args.sample };
  saveState(state);

  let ok = true;

  try {
    // Stage 1: Collection
    if (startStage <= 1) {
      ok = await runStage1(state);
      if (!ok) {
        log(AGENT, 'Pipeline halted after Stage 1 (all collectors failed).');
        return;
      }
    } else {
      // Verify Stage 1 data exists when skipping
      log(AGENT, `Skipping Stage 1 (starting from stage ${startStage}). Checking existing data…`);
      ok = checkStage1Meta();
      if (!ok) {
        log(AGENT, 'No Stage 1 data found. Run the full pipeline first (without --stage).');
        return;
      }
    }

    // Stage 2: Filtering
    if (startStage <= 2 && ok) {
      ok = await runStage2(state);
      if (!ok) {
        log(AGENT, 'Pipeline halted after Stage 2 (filtering failed).');
        return;
      }
    } else if (startStage > 2) {
      log(AGENT, 'Skipping Stage 2 (filtering). Using existing filtered data.');
      // Verify filtered data exists
      const filteredPath = projectPath('data', 'filtered', 'filtered.json');
      if (!fs.existsSync(filteredPath)) {
        log(AGENT, 'ERROR: No filtered data found at data/filtered/filtered.json. Run stage 2 first.');
        ok = false;
        return;
      }
    }

    // Stage 3: Extraction
    if (startStage <= 3 && ok) {
      ok = await runStage3(state, args.sample);
      if (!ok) {
        log(AGENT, 'Pipeline halted after Stage 3 (extraction failed).');
        return;
      }

      // If sample mode, stop here — don't auto-proceed to clustering
      if (args.sample) {
        log(AGENT, 'Sample extraction complete. Review samples before running full extraction.');
        return;
      }
    } else if (startStage > 3) {
      log(AGENT, 'Skipping Stage 3 (extraction). Using existing structured data.');
      const recordsPath = projectPath('data', 'structured', 'records.json');
      if (!fs.existsSync(recordsPath)) {
        log(AGENT, 'ERROR: No structured data found at data/structured/records.json. Run stage 3 first.');
        ok = false;
        return;
      }
    }

    // Stage 4: Clustering
    if (startStage <= 4 && ok) {
      ok = await runStage4(state);
      if (!ok) {
        log(AGENT, 'Pipeline halted after Stage 4 (clustering failed).');
        return;
      }
    }

    log(AGENT, '═══════════════════════════════════════════════');
    log(AGENT, 'Pipeline completed successfully!');
    log(AGENT, '═══════════════════════════════════════════════');

  } finally {
    state.completed_at = new Date().toISOString();
    state.final_status = ok ? 'success' : 'failed';
    saveState(state);
    releaseLock();

    log(AGENT, `Pipeline state saved to ${STATE_PATH}`);
  }
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

main().catch((error) => {
  log(AGENT, `UNHANDLED ERROR: ${error.message}`);
  console.error(error.stack);
  releaseLock();
  process.exit(1);
});
