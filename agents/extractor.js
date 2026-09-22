/**
 * Structured Extraction Agent (Stage 3)
 * 
 * Reads filtered records from /data/filtered/filtered.json, sends them to
 * Groq in batches of 5, and extracts structured fields per schema.json.
 * 
 * Modes:
 *   --sample   Pick 10 random records per source (50 total) → write samples
 *   (default)  Process ALL filtered records → write records.json
 * 
 * Output:
 *   Sample mode:  /data/structured/samples/sample_{source}.json
 *   Full mode:    /data/structured/records.json
 *                 /data/structured/errors.json
 */

const fs = require('fs');
const path = require('path');
const {
  readJSON, writeJSON, writeMeta, callGroqJSON,
  validateRecord, sleep, log, projectPath,
} = require('./utils');

const AGENT = 'extractor';
const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES_MS = 1200;

const FILTERED_PATH = projectPath('data', 'filtered', 'filtered.json');
const RECORDS_PATH = projectPath('data', 'structured', 'records.json');
const ERRORS_PATH = projectPath('data', 'structured', 'errors.json');
const SAMPLES_DIR = projectPath('data', 'structured', 'samples');
const SCHEMA_PATH = projectPath('schema', 'schema.json');

const SOURCES = ['playstore', 'appstore', 'reddit', 'helpcommunity', 'youtube'];
const SAMPLE_PER_SOURCE = 10;

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  const schema = readJSON(SCHEMA_PATH);
  const schemaStr = JSON.stringify(schema, null, 2);

  return `You are a structured data extraction agent for a Google Photos user-research project.

Your task: Given user-written text about a **Google Photos retrieval failure**, extract structured fields defined by the JSON Schema below.

## JSON Schema (source of truth)

\`\`\`json
${schemaStr}
\`\`\`

## Extraction Rules

### General
- Extract ONLY what is explicitly stated or strongly implied in the raw text.
- DO NOT hallucinate details. If a field cannot be determined, use the most conservative/neutral valid enum value.
- For array fields (\`remembered_attributes\`, \`forgotten_attributes\`), include only attributes with clear textual evidence. An empty array is acceptable.

### Field-Specific Guidance

**photo_type**: Classify the media the user sought. Use "other" when ambiguous.

**remembered_attributes**: What the user DOES remember. Only include attributes explicitly mentioned:
  - "time period" → user mentions when (last summer, 2 years ago, Christmas, etc.)
  - "people present" → user mentions who was in the photo
  - "emotion/context" → user describes the mood, event context, or why it matters
  - "device" → user mentions which phone/camera took the photo
  - "visual details" → user describes what the photo looks like (beach, sunset, red dress, etc.)
  - "occasion" → user mentions a specific event (birthday, wedding, vacation, etc.)

**forgotten_attributes**: What the user CANNOT recall, preventing effective search:
  - "exact date" → user doesn't know when precisely
  - "place name" → user can't name the location
  - "album" → user doesn't know which album
  - "search keywords" → user doesn't know what words to search for

**search_strategy_used**: The search approach the user actually tried (not what they wish they could do).
  - Use "gave up before trying" if user didn't attempt any search.

**failure_point**: Where the search broke down.
  - "couldn't formulate query" → user didn't know what to type
  - "no results" → search returned nothing
  - "too many results" → search returned too many irrelevant results
  - "wrong result surfaced" → search returned incorrect photos
  - "app limitation" → the app lacks the feature they need

**outcome**: Final result of the retrieval attempt.

**emotional_stakes**: How emotionally significant the photo is:
  - "high" → involves loss of a loved one, health/medical, once-in-a-lifetime moments, nostalgia for deceased person
  - "medium" → vacation, family gatherings, milestones (graduation, etc.)
  - "low" → everyday photos, screenshots, receipts

**workaround_used**: Any workaround outside of Google Photos search.

### query_formulation — CRITICAL INSTRUCTIONS

**style**: Infer ONLY from explicit search-behavior described in \`raw_text\`.
  - DO NOT infer a search attempt if the record only describes the memory, frustration, or a wish.
  - The user must describe an ACTION they took (typed, searched, looked for, browsed, scrolled, etc.)
  - "natural_language_description" → user typed a descriptive phrase (e.g., "photo of dog at park")
  - "single_keyword" → user typed one word (e.g., "dog", "beach")
  - "person_name" → user searched by a person's name
  - "location_name" → user searched by a place name
  - "date_guess" → user navigated to a guessed date range
  - "visual_descriptor" → user described visual features (color, object, scene)
  - "no_query_browsed_manually" → user only scrolled/browsed without typing a query
  - "not_mentioned" → raw_text does NOT describe any explicit search action

**example_query_paraphrased**: 
  - MUST be ≤ 12 words
  - MUST be paraphrased in YOUR OWN words — NEVER copy verbatim from raw_text
  - Set to null when style is "not_mentioned"

**query_matched_forgotten_gap**:
  - true = the query targeted the specific thing they'd forgotten
  - false = the query was unrelated to the forgotten gap, or they gave up before formulating one
  - null = when style is "not_mentioned" or "no_query_browsed_manually"

## Response Format

You will receive a batch of raw records. For each, respond with a JSON array of extracted structured records.

IMPORTANT: 
- The \`id\`, \`source\`, \`url\`, \`date\`, and \`raw_text\` fields will be provided — carry them through unchanged.
- Extract ALL other fields from the raw text content.
- Respond with ONLY valid JSON — no markdown fences, no explanations.`;
}

// ---------------------------------------------------------------------------
// Batch Extraction
// ---------------------------------------------------------------------------

/**
 * Extract structured fields from a batch of filtered records using Groq.
 * @param {Array<object>} batch - Array of filtered records
 * @param {number} batchIndex - For logging
 * @returns {Promise<Array<object>>} Extracted structured records
 */
async function extractBatch(batch, batchIndex) {
  const userPrompt = batch
    .map((record, i) => {
      return `[Record ${i}]
id: ${record.id || 'unknown'}
source: ${record.source}
url: ${record.url || 'unknown'}
date: ${record.date || 'unknown'}
raw_text: ${(record.raw_text || '').substring(0, 1500)}`;
    })
    .join('\n\n---\n\n');

  const fullPrompt = `Extract structured fields for the following ${batch.length} records. Respond with a JSON array of ${batch.length} objects.\n\n${userPrompt}`;

  const systemPrompt = buildSystemPrompt();

  const result = await callGroqJSON({
    systemPrompt,
    userPrompt: fullPrompt,
    model: 'llama-3.3-70b-versatile',
    temperature: 0,
    maxRetries: 3,
    retryDelayMs: 5000,
  });

  if (!Array.isArray(result)) {
    throw new Error('Groq response is not an array');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Record ID Generation & Deduplication
// ---------------------------------------------------------------------------

let globalCounter = {};

function generateId(source) {
  if (!globalCounter[source]) globalCounter[source] = 0;
  globalCounter[source]++;
  return `${source}_${String(globalCounter[source]).padStart(3, '0')}`;
}

/**
 * Simple near-duplicate detection based on raw_text similarity.
 * Uses first 200 chars as a fingerprint.
 */
function buildDedupeSet(records) {
  const seen = new Set();
  const unique = [];
  const dupes = [];

  for (const record of records) {
    const fingerprint = (record.raw_text || '').substring(0, 200).toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(fingerprint)) {
      dupes.push(record);
    } else {
      seen.add(fingerprint);
      unique.push(record);
    }
  }

  return { unique, dupes };
}

// ---------------------------------------------------------------------------
// Sample Mode
// ---------------------------------------------------------------------------

async function runSampleMode(filteredRecords) {
  log(AGENT, 'Running in SAMPLE MODE');

  // Pick 10 random records per source
  const samplesBySource = {};
  for (const source of SOURCES) {
    const fromSource = filteredRecords.filter((r) => r.source === source);
    if (fromSource.length === 0) {
      log(AGENT, `  No records from ${source}`);
      continue;
    }

    // Shuffle and take up to SAMPLE_PER_SOURCE
    const shuffled = [...fromSource].sort(() => Math.random() - 0.5);
    samplesBySource[source] = shuffled.slice(0, SAMPLE_PER_SOURCE);
    log(AGENT, `  Selected ${samplesBySource[source].length} samples from ${source}`);
  }

  // Flatten into batches of BATCH_SIZE
  const allSamples = Object.values(samplesBySource).flat();
  log(AGENT, `Total samples to extract: ${allSamples.length}`);

  // Assign IDs
  const withIds = allSamples.map((r) => ({
    ...r,
    id: generateId(r.source),
  }));

  // Process in batches
  const allExtracted = [];
  const allErrors = [];

  for (let i = 0; i < withIds.length; i += BATCH_SIZE) {
    const batch = withIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    log(AGENT, `  Extracting batch ${batchNum} (${batch.length} records)…`);

    try {
      const extracted = await extractBatch(batch, batchNum);

      // Merge extracted fields with original metadata
      for (let j = 0; j < batch.length; j++) {
        const merged = {
          id: batch[j].id,
          source: batch[j].source,
          url: batch[j].url,
          date: batch[j].date,
          raw_text: batch[j].raw_text,
          ...(extracted[j] || {}),
          // Ensure pass-through fields are not overwritten by extraction
          id: batch[j].id,
          source: batch[j].source,
          url: batch[j].url,
          date: batch[j].date,
          raw_text: batch[j].raw_text,
        };

        // Validate against schema
        const validation = validateRecord(merged);
        if (validation.valid) {
          allExtracted.push(merged);
        } else {
          log(AGENT, `    Record ${merged.id} failed validation: ${JSON.stringify(validation.errors[0])}`);
          allErrors.push({ record: merged, errors: validation.errors });
        }
      }
    } catch (error) {
      log(AGENT, `    Batch ${batchNum} FAILED: ${error.message}`);
      for (const record of batch) {
        allErrors.push({ record, errors: [{ message: error.message }] });
      }
    }

    if (i + BATCH_SIZE < withIds.length) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  // Write sample files per source
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });

  for (const source of SOURCES) {
    const sourceRecords = allExtracted.filter((r) => r.source === source);
    if (sourceRecords.length > 0) {
      const samplePath = path.join(SAMPLES_DIR, `sample_${source}.json`);
      writeJSON(samplePath, sourceRecords);
      log(AGENT, `  Wrote ${sourceRecords.length} samples to sample_${source}.json`);
    }
  }

  // Write errors
  if (allErrors.length > 0) {
    writeJSON(ERRORS_PATH, allErrors);
  }

  log(AGENT, `Sample extraction complete: ${allExtracted.length} valid, ${allErrors.length} errors`);

  return {
    status: allExtracted.length > 0 ? 'success' : 'failed',
    records_extracted: allExtracted.length,
    errors_count: allErrors.length,
  };
}

// ---------------------------------------------------------------------------
// Full Mode
// ---------------------------------------------------------------------------

async function runFullMode(filteredRecords) {
  log(AGENT, 'Running in FULL MODE');
  log(AGENT, `Processing ${filteredRecords.length} filtered records`);

  // Assign IDs
  const withIds = filteredRecords.map((r) => ({
    ...r,
    id: generateId(r.source),
  }));

  // Process in batches
  const allExtracted = [];
  const allErrors = [];
  let batchNum = 0;

  for (let i = 0; i < withIds.length; i += BATCH_SIZE) {
    batchNum++;
    const batch = withIds.slice(i, i + BATCH_SIZE);
    log(AGENT, `Extracting batch ${batchNum} (records ${i + 1}–${i + batch.length} of ${withIds.length})…`);

    try {
      const extracted = await extractBatch(batch, batchNum);

      for (let j = 0; j < batch.length; j++) {
        const merged = {
          id: batch[j].id,
          source: batch[j].source,
          url: batch[j].url,
          date: batch[j].date,
          raw_text: batch[j].raw_text,
          ...(extracted[j] || {}),
          // Ensure pass-through fields are preserved
          id: batch[j].id,
          source: batch[j].source,
          url: batch[j].url,
          date: batch[j].date,
          raw_text: batch[j].raw_text,
        };

        // Validate against schema
        const validation = validateRecord(merged);
        if (validation.valid) {
          allExtracted.push(merged);
        } else {
          log(AGENT, `  Record ${merged.id} failed validation`);
          allErrors.push({ record: merged, errors: validation.errors });
        }
      }

      // Log progress every 10 batches
      if (batchNum % 10 === 0) {
        log(AGENT, `  Progress: ${allExtracted.length} valid, ${allErrors.length} errors`);
      }
    } catch (error) {
      log(AGENT, `  Batch ${batchNum} FAILED: ${error.message}`);
      for (const record of batch) {
        allErrors.push({ record, errors: [{ message: error.message }] });
      }
    }

    if (i + BATCH_SIZE < withIds.length) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  // Deduplication
  const { unique, dupes } = buildDedupeSet(allExtracted);
  if (dupes.length > 0) {
    log(AGENT, `Deduplication: removed ${dupes.length} near-duplicate records`);
  }

  // Write outputs
  writeJSON(RECORDS_PATH, unique);
  log(AGENT, `Wrote ${unique.length} records to ${RECORDS_PATH}`);

  if (allErrors.length > 0) {
    writeJSON(ERRORS_PATH, allErrors);
    log(AGENT, `Wrote ${allErrors.length} errors to ${ERRORS_PATH}`);
  }

  return {
    extracted: unique,
    errors: allErrors,
    dupes,
  };
}

// ---------------------------------------------------------------------------
// Field Distribution Analysis
// ---------------------------------------------------------------------------

function analyzeDistributions(records) {
  const distributions = {};

  // Enum fields
  const enumFields = [
    'photo_type', 'search_strategy_used', 'failure_point',
    'outcome', 'emotional_stakes', 'workaround_used',
  ];

  for (const field of enumFields) {
    const counts = {};
    let nullCount = 0;
    for (const r of records) {
      const val = r[field];
      if (val == null) { nullCount++; continue; }
      counts[val] = (counts[val] || 0) + 1;
    }
    distributions[field] = { counts, null_count: nullCount, null_pct: `${((nullCount / records.length) * 100).toFixed(1)}%` };
  }

  // Array fields
  for (const field of ['remembered_attributes', 'forgotten_attributes']) {
    const counts = {};
    let emptyCount = 0;
    for (const r of records) {
      const arr = r[field] || [];
      if (arr.length === 0) emptyCount++;
      for (const val of arr) {
        counts[val] = (counts[val] || 0) + 1;
      }
    }
    distributions[field] = { counts, empty_count: emptyCount, empty_pct: `${((emptyCount / records.length) * 100).toFixed(1)}%` };
  }

  // query_formulation.style
  const qfCounts = {};
  for (const r of records) {
    const style = r.query_formulation?.style || 'MISSING';
    qfCounts[style] = (qfCounts[style] || 0) + 1;
  }
  distributions['query_formulation.style'] = { counts: qfCounts };

  // Check for "not_mentioned" dominance
  const notMentionedCount = qfCounts['not_mentioned'] || 0;
  const notMentionedPct = (notMentionedCount / records.length) * 100;
  if (notMentionedPct > 80) {
    log(AGENT, `⚠ WARNING: query_formulation.style is "not_mentioned" for ${notMentionedPct.toFixed(1)}% of records — possible prompt failure`);
  }

  // Check for >20% null on any field
  for (const field of enumFields) {
    const nullPct = (distributions[field].null_count / records.length) * 100;
    if (nullPct > 20) {
      log(AGENT, `⚠ WARNING: ${field} is null for ${nullPct.toFixed(1)}% of records`);
    }
  }

  return distributions;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

async function run(options = {}) {
  const startedAt = new Date().toISOString();
  const sampleMode = options.sample || false;

  log(AGENT, '═══════════════════════════════════════════════');
  log(AGENT, `EXTRACTION AGENT — Stage 3 ${sampleMode ? '(SAMPLE MODE)' : '(FULL MODE)'}`);
  log(AGENT, '═══════════════════════════════════════════════');

  // Load filtered records
  let filteredRecords;
  try {
    filteredRecords = readJSON(FILTERED_PATH);
  } catch (error) {
    log(AGENT, `ERROR: Cannot read filtered data: ${error.message}`);
    log(AGENT, 'Run Stage 2 (filtering) first.');
    return { status: 'failed', records_extracted: 0, errors_count: 0 };
  }

  if (!Array.isArray(filteredRecords) || filteredRecords.length === 0) {
    log(AGENT, 'ERROR: No filtered records found.');
    return { status: 'failed', records_extracted: 0, errors_count: 0 };
  }

  log(AGENT, `Loaded ${filteredRecords.length} filtered records`);

  // Run appropriate mode
  if (sampleMode) {
    return await runSampleMode(filteredRecords);
  }

  // Full mode
  const { extracted, errors, dupes } = await runFullMode(filteredRecords);

  // Analyze field distributions
  if (extracted.length > 0) {
    log(AGENT, '───────────────────────────────────────────────');
    log(AGENT, 'Field distribution analysis:');
    const distributions = analyzeDistributions(extracted);

    // Log key stats
    for (const [field, data] of Object.entries(distributions)) {
      if (data.counts) {
        const entries = Object.entries(data.counts)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        log(AGENT, `  ${field}: ${entries}`);
      }
    }
  }

  // Write meta
  const errorRate = errors.length / filteredRecords.length;
  const status = extracted.length === 0 ? 'failed' : errorRate > 0.05 ? 'partial' : 'success';

  writeMeta(RECORDS_PATH, {
    agent: AGENT,
    record_count: extracted.length,
    status,
    started_at: startedAt,
    filtered_input_count: filteredRecords.length,
    extracted_count: extracted.length,
    error_count: errors.length,
    error_rate: `${(errorRate * 100).toFixed(1)}%`,
    duplicate_count: dupes.length,
    batches_processed: Math.ceil(filteredRecords.length / BATCH_SIZE),
  });

  log(AGENT, '───────────────────────────────────────────────');
  log(AGENT, `Extraction complete:`);
  log(AGENT, `  Input records:      ${filteredRecords.length}`);
  log(AGENT, `  Extracted (valid):  ${extracted.length}`);
  log(AGENT, `  Errors:             ${errors.length} (${(errorRate * 100).toFixed(1)}%)`);
  log(AGENT, `  Duplicates removed: ${dupes.length}`);
  log(AGENT, `  Status:             ${status}`);
  log(AGENT, '───────────────────────────────────────────────');

  return {
    status,
    records_extracted: extracted.length,
    errors_count: errors.length,
  };
}

// ---------------------------------------------------------------------------
// Standalone Entry Point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const isSample = process.argv.includes('--sample');
  run({ sample: isSample }).then((result) => {
    console.log('Result:', result);
    process.exit(result.status === 'failed' ? 1 : 0);
  });
}

module.exports = { run };
