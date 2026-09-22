/**
 * Filtering Agent (Stage 2)
 * 
 * Reads all raw records from /data/raw/*.json, merges them into a single pool,
 * then uses Groq LLM to classify each record as in-scope or out-of-scope
 * based on the 3-part scope criteria:
 * 
 *   (a) User knows a photo/video exists
 *   (b) Cannot recall enough specific detail to search precisely
 *   (c) Either failed, struggled, or found a workaround
 * 
 * Output:
 *   /data/filtered/filtered.json    — in-scope records only
 *   /data/filtered/rejected.json    — out-of-scope records (for audit)
 * 
 * Usage:
 *   node agents/filter.js           — standalone run
 *   (or called by orchestrator as Stage 2)
 */

const fs = require('fs');
const path = require('path');
const { readJSON, writeJSON, writeMeta, callGroqJSON, sleep, log, projectPath } = require('./utils');

const AGENT = 'filter';
const BATCH_SIZE = 20;
const DELAY_BETWEEN_BATCHES_MS = 1000;
const MIN_TEXT_LENGTH = 20;

const RAW_DATA_DIR = projectPath('data', 'raw');
const FILTERED_PATH = projectPath('data', 'filtered', 'filtered.json');
const REJECTED_PATH = projectPath('data', 'filtered', 'rejected.json');

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a precise classification agent for a Google Photos user-research project.

Your task: determine whether each user-written text describes an **incomplete-memory photo retrieval failure** in Google Photos.

## Scope Criteria (ALL three must be true to classify as IN SCOPE)

A record is IN SCOPE if and only if the user:
  (a) **Knows a photo or video exists** in their Google Photos library
  (b) **Cannot recall enough specific detail** (exact date, location name, album, precise keywords) to search for it directly
  (c) **Either failed to find it, struggled to find it, or used a workaround** to eventually locate it

## OUT OF SCOPE — Reject these:
- General complaints about Google Photos bugs, slowness, UI, or crashes
- Reports of photos being **deleted, lost, or missing** (the photo doesn't exist anymore — different from can't find it)
- Feature requests without describing a retrieval failure experience
- Reviews that only mention backup, storage, sharing, or editing issues
- Extremely short or vague text with no retrieval-failure signal (e.g., "app sucks", "1 star")
- Complaints about search being "broken" WITHOUT describing a specific memory-based retrieval attempt
- Posts about finding OTHER PEOPLE's photos (privacy concerns, not retrieval)

## Ambiguous Cases — Apply these tiebreakers:
- If the user describes BOTH a bug AND a memory-retrieval failure → IN SCOPE (the retrieval failure signal is present)
- If the user mentions a third-party app solving the problem → IN SCOPE (workaround is valid data)
- If sarcastic/ironic → interpret the user's INTENT, not literal text
- "I wish I could search by X" is OUT OF SCOPE unless they also describe a failed retrieval attempt

## Response Format

Respond with ONLY a valid JSON array. For each record in the batch, output:
{
  "index": <integer — 0-based position in the batch>,
  "is_in_scope": <boolean>,
  "scope_reasoning": "<one sentence explaining why this record is or is not in scope>"
}

Example:
[
  {"index": 0, "is_in_scope": true, "scope_reasoning": "User remembers a beach photo from last summer but cannot recall the date or location name and search returned nothing."},
  {"index": 1, "is_in_scope": false, "scope_reasoning": "User is complaining about photos disappearing after an update — this is a deletion/sync bug, not a memory-retrieval failure."}
]`;

// ---------------------------------------------------------------------------
// Load Raw Records
// ---------------------------------------------------------------------------

/**
 * Read all /data/raw/*.json files and merge into a single array.
 * Skips _meta.json, _run_log.json, and files that don't parse.
 */
function loadRawRecords() {
  const allRecords = [];

  if (!fs.existsSync(RAW_DATA_DIR)) {
    log(AGENT, `ERROR: Raw data directory does not exist: ${RAW_DATA_DIR}`);
    return allRecords;
  }

  const files = fs.readdirSync(RAW_DATA_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('_meta') && !f.includes('_run_log'));

  for (const file of files) {
    const filePath = path.join(RAW_DATA_DIR, file);
    try {
      const records = readJSON(filePath);
      if (Array.isArray(records)) {
        log(AGENT, `  Loaded ${records.length} records from ${file}`);
        allRecords.push(...records);
      }
    } catch (error) {
      log(AGENT, `  WARNING: Failed to read ${file}: ${error.message}`);
    }
  }

  return allRecords;
}

// ---------------------------------------------------------------------------
// Batch Classification
// ---------------------------------------------------------------------------

/**
 * Classify a batch of records using Groq.
 * @param {Array<object>} batch - Array of raw records.
 * @param {number} batchStartIndex - Global index offset for this batch.
 * @returns {Promise<Array<{index: number, is_in_scope: boolean, scope_reasoning: string}>>}
 */
async function classifyBatch(batch, batchStartIndex) {
  // Build user prompt with numbered records
  const userPrompt = batch
    .map((record, i) => {
      const text = (record.raw_text || '').substring(0, 1500); // Cap per-record text
      return `[Record ${i}] (source: ${record.source})\n${text}`;
    })
    .join('\n\n---\n\n');

  const fullUserPrompt = `Classify the following ${batch.length} records. Respond with a JSON array of ${batch.length} objects.\n\n${userPrompt}`;

  const result = await callGroqJSON({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: fullUserPrompt,
    model: 'llama-3.3-70b-versatile',
    temperature: 0,
    maxRetries: 3,
    retryDelayMs: 5000,
  });

  // Validate response shape
  if (!Array.isArray(result)) {
    throw new Error('Groq response is not an array');
  }

  // Ensure we have a classification for each record in the batch
  const classifications = [];
  for (let i = 0; i < batch.length; i++) {
    const found = result.find((r) => r.index === i);
    if (found && typeof found.is_in_scope === 'boolean') {
      classifications.push(found);
    } else {
      // Default: reject records with missing classifications (safer than accepting)
      classifications.push({
        index: i,
        is_in_scope: false,
        scope_reasoning: 'Classification missing from LLM response — defaulted to out-of-scope.',
      });
    }
  }

  return classifications;
}

// ---------------------------------------------------------------------------
// Main Filter Pipeline
// ---------------------------------------------------------------------------

async function run() {
  const startedAt = new Date().toISOString();
  log(AGENT, '═══════════════════════════════════════════════');
  log(AGENT, 'FILTERING AGENT — Stage 2');
  log(AGENT, '═══════════════════════════════════════════════');

  // Load all raw records
  log(AGENT, 'Loading raw records…');
  const allRecords = loadRawRecords();

  if (allRecords.length === 0) {
    log(AGENT, 'ERROR: No raw records found. Run Stage 1 (collection) first.');
    return { status: 'failed', records_in: 0, records_out: 0 };
  }

  log(AGENT, `Loaded ${allRecords.length} total raw records`);

  // Pre-filter: remove records that are too short
  const preFiltered = allRecords.filter((r) => (r.raw_text || '').trim().length >= MIN_TEXT_LENGTH);
  const preFilteredOut = allRecords.length - preFiltered.length;
  if (preFilteredOut > 0) {
    log(AGENT, `Pre-filtered out ${preFilteredOut} records below ${MIN_TEXT_LENGTH} chars`);
  }

  // Process in batches
  const accepted = [];
  const rejected = [];
  const errors = [];
  let batchNum = 0;

  for (let i = 0; i < preFiltered.length; i += BATCH_SIZE) {
    batchNum++;
    const batch = preFiltered.slice(i, i + BATCH_SIZE);
    log(AGENT, `Processing batch ${batchNum} (records ${i + 1}–${i + batch.length} of ${preFiltered.length})…`);

    try {
      const classifications = await classifyBatch(batch, i);

      for (let j = 0; j < batch.length; j++) {
        const record = batch[j];
        const classification = classifications[j];

        // Attach classification metadata to the record
        const enrichedRecord = {
          ...record,
          is_in_scope: classification.is_in_scope,
          scope_reasoning: classification.scope_reasoning,
        };

        if (classification.is_in_scope) {
          accepted.push(enrichedRecord);
        } else {
          rejected.push(enrichedRecord);
        }
      }

      const batchAccepted = classifications.filter((c) => c.is_in_scope).length;
      log(AGENT, `  Batch ${batchNum}: ${batchAccepted}/${batch.length} in scope`);

    } catch (batchError) {
      const msg = `Batch ${batchNum} failed: ${batchError.message}`;
      log(AGENT, `  ERROR: ${msg}`);
      errors.push(msg);

      // Mark all records in the failed batch as errors (don't silently drop them)
      for (const record of batch) {
        rejected.push({
          ...record,
          is_in_scope: false,
          scope_reasoning: `Batch processing error: ${batchError.message}`,
        });
      }
    }

    // Rate-limit delay between batches
    if (i + BATCH_SIZE < preFiltered.length) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Anomaly Detection
  // ---------------------------------------------------------------------------

  const acceptanceRate = accepted.length / preFiltered.length;
  if (acceptanceRate > 0.9) {
    log(AGENT, `⚠ WARNING: Acceptance rate is ${(acceptanceRate * 100).toFixed(1)}% — prompt may be too permissive.`);
  } else if (acceptanceRate < 0.05) {
    log(AGENT, `⚠ WARNING: Acceptance rate is ${(acceptanceRate * 100).toFixed(1)}% — prompt may be too restrictive.`);
  }

  // ---------------------------------------------------------------------------
  // Write Outputs
  // ---------------------------------------------------------------------------

  writeJSON(FILTERED_PATH, accepted);
  log(AGENT, `Wrote ${accepted.length} accepted records to ${FILTERED_PATH}`);

  writeJSON(REJECTED_PATH, rejected);
  log(AGENT, `Wrote ${rejected.length} rejected records to ${REJECTED_PATH}`);

  // Write meta
  const status = errors.length > 0 ? 'partial' : 'success';
  writeMeta(FILTERED_PATH, {
    agent: AGENT,
    record_count: accepted.length,
    status,
    errors,
    started_at: startedAt,
    total_raw_records: allRecords.length,
    pre_filtered_out: preFilteredOut,
    records_processed: preFiltered.length,
    accepted_count: accepted.length,
    rejected_count: rejected.length,
    acceptance_rate: `${(acceptanceRate * 100).toFixed(1)}%`,
    batches_processed: batchNum,
    expected_acceptance_range: '10–30%',
  });

  log(AGENT, '───────────────────────────────────────────────');
  log(AGENT, `Filtering complete:`);
  log(AGENT, `  Total raw records:    ${allRecords.length}`);
  log(AGENT, `  Pre-filtered out:     ${preFilteredOut}`);
  log(AGENT, `  Processed:            ${preFiltered.length}`);
  log(AGENT, `  Accepted (in-scope):  ${accepted.length} (${(acceptanceRate * 100).toFixed(1)}%)`);
  log(AGENT, `  Rejected:             ${rejected.length}`);
  log(AGENT, `  Batch errors:         ${errors.length}`);
  log(AGENT, '───────────────────────────────────────────────');

  return {
    status,
    records_in: allRecords.length,
    records_out: accepted.length,
  };
}

// ---------------------------------------------------------------------------
// Standalone Entry Point
// ---------------------------------------------------------------------------

if (require.main === module) {
  run().then((result) => {
    console.log('Result:', result);
    process.exit(result.status === 'failed' ? 1 : 0);
  });
}

module.exports = { run };
