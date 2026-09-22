/**
 * Shared Utilities Module
 * 
 * Provides helpers for:
 * - Reading/writing JSON files
 * - Writing _meta.json sidecars
 * - Groq API wrapper (with retry + rate limiting)
 * - Rate-limit-aware HTTP fetch
 */

const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Load .env from config directory */
function loadEnv() {
  require('dotenv').config({ path: path.resolve(__dirname, '..', 'config', '.env') });
}

/** Project root directory */
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Resolve a path relative to project root */
function projectPath(...segments) {
  return path.join(PROJECT_ROOT, ...segments);
}

// ---------------------------------------------------------------------------
// JSON File I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file.
 * @param {string} filePath - Absolute or project-relative path.
 * @returns {any} Parsed JSON content.
 */
function readJSON(filePath) {
  const absPath = path.isAbsolute(filePath) ? filePath : projectPath(filePath);
  const raw = fs.readFileSync(absPath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Write data as formatted JSON to a file, creating parent directories if needed.
 * @param {string} filePath - Absolute or project-relative path.
 * @param {any} data - Data to serialize.
 */
function writeJSON(filePath, data) {
  const absPath = path.isAbsolute(filePath) ? filePath : projectPath(filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Meta Sidecar
// ---------------------------------------------------------------------------

/**
 * Write a _meta.json sidecar alongside a data file.
 * 
 * @param {string} dataFilePath - Path to the data file (e.g., '/data/raw/reddit.json').
 * @param {object} meta - Metadata object.
 * @param {string} meta.agent - Agent identifier (e.g., 'collector-reddit').
 * @param {number} meta.record_count - Number of records written.
 * @param {string} meta.status - 'success' | 'partial' | 'failed'.
 * @param {Array<string>} [meta.errors] - Error messages, if any.
 * @param {object} [meta.extra] - Any additional metadata.
 */
function writeMeta(dataFilePath, { agent, record_count, status, errors = [], ...extra }) {
  const absPath = path.isAbsolute(dataFilePath) ? dataFilePath : projectPath(dataFilePath);
  const dir = path.dirname(absPath);
  const baseName = path.basename(absPath, path.extname(absPath));
  const metaPath = path.join(dir, `${baseName}_meta.json`);

  const metaContent = {
    agent,
    started_at: extra.started_at || new Date().toISOString(),
    completed_at: new Date().toISOString(),
    record_count,
    errors,
    status,
    ...extra,
  };

  writeJSON(metaPath, metaContent);
  return metaPath;
}

// ---------------------------------------------------------------------------
// Groq API Wrapper
// ---------------------------------------------------------------------------

/** Lazily initialized Groq client */
let _groqClient = null;

function getGroqClient() {
  if (!_groqClient) {
    loadEnv();
    _groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groqClient;
}

/**
 * Call the Groq chat completion API with automatic retries.
 * 
 * @param {object} options
 * @param {string} options.systemPrompt - System message content.
 * @param {string} options.userPrompt - User message content.
 * @param {string} [options.model='llama-3.1-8b-instant'] - Groq model ID.
 * @param {number} [options.temperature=0.2] - Sampling temperature.
 * @param {boolean} [options.jsonMode=false] - If true, request JSON response format.
 * @param {number} [options.maxRetries=3] - Maximum number of retries on failure.
 * @param {number} [options.retryDelayMs=5000] - Base delay between retries (exponential backoff).
 * @returns {Promise<string>} The assistant's response content.
 */
async function callGroq({
  systemPrompt,
  userPrompt,
  model = 'llama-3.3-70b-versatile',
  temperature = 0,
  jsonMode = false,
  maxRetries = 3,
  retryDelayMs = 5000,
}) {
  const client = getGroqClient();

  const requestBody = {
    model,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };

  if (jsonMode) {
    requestBody.response_format = { type: 'json_object' };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create(requestBody);
      return response.choices[0].message.content;
    } catch (error) {
      const isLast = attempt === maxRetries;
      const delay = retryDelayMs * Math.pow(2, attempt - 1);

      console.error(
        `[Groq] Attempt ${attempt}/${maxRetries} failed: ${error.message}` +
        (isLast ? ' — giving up.' : ` — retrying in ${delay}ms…`)
      );

      if (isLast) throw error;
      await sleep(delay);
    }
  }
}

/**
 * Call Groq and parse the response as JSON.
 * Re-prompts once if the initial response is malformed.
 * 
 * @param {object} options - Same as callGroq options.
 * @returns {Promise<any>} Parsed JSON object.
 */
async function callGroqJSON(options) {
  const opts = { ...options, jsonMode: true };
  const raw = await callGroq(opts);

  try {
    return JSON.parse(raw);
  } catch (parseError) {
    console.warn('[Groq] Malformed JSON response, re-prompting with stricter instructions…');
    const retryOpts = {
      ...opts,
      userPrompt:
        opts.userPrompt +
        '\n\nIMPORTANT: Your previous response was not valid JSON. ' +
        'Respond with ONLY a valid JSON object or array. No markdown, no explanation.',
      maxRetries: 1,
    };
    const retryRaw = await callGroq(retryOpts);
    return JSON.parse(retryRaw); // If this fails too, let it throw
  }
}

// ---------------------------------------------------------------------------
// Rate-Limit-Aware Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch a URL with automatic retry on rate-limit (429) and server errors (5xx).
 * 
 * @param {string} url - The URL to fetch.
 * @param {object} [options={}] - Fetch options (method, headers, body, etc.).
 * @param {object} [retryConfig={}] - Retry configuration.
 * @param {number} [retryConfig.maxRetries=5] - Maximum retries.
 * @param {number} [retryConfig.baseDelayMs=1000] - Base delay in ms (exponential backoff).
 * @param {number} [retryConfig.maxDelayMs=60000] - Maximum delay cap in ms.
 * @returns {Promise<Response>} The fetch Response object.
 */
async function rateLimitedFetch(url, options = {}, retryConfig = {}) {
  const { maxRetries = 5, baseDelayMs = 1000, maxDelayMs = 60000 } = retryConfig;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (response.ok) return response;

    const isRetryable = response.status === 429 || response.status >= 500;
    const isLast = attempt === maxRetries;

    if (!isRetryable || isLast) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    // Check for Retry-After header
    const retryAfter = response.headers.get('Retry-After');
    let delay;
    if (retryAfter) {
      delay = (parseInt(retryAfter, 10) || 1) * 1000;
    } else {
      delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
    }

    console.warn(
      `[Fetch] ${response.status} for ${url} — retry ${attempt}/${maxRetries} in ${delay}ms`
    );
    await sleep(delay);
  }
}

// ---------------------------------------------------------------------------
// Schema Validation
// ---------------------------------------------------------------------------

let _validator = null;

/**
 * Validate a record against schema.json using AJV.
 * 
 * @param {object} record - The record to validate.
 * @returns {{ valid: boolean, errors: Array|null }} Validation result.
 */
function validateRecord(record) {
  if (!_validator) {
    const Ajv = require('ajv');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schema = readJSON(projectPath('schema', 'schema.json'));
    _validator = ajv.compile(schema);
  }

  const valid = _validator(record);
  return {
    valid,
    errors: valid ? null : _validator.errors,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Log a timestamped message with an agent prefix.
 * @param {string} agent - Agent identifier.
 * @param {string} message - Log message.
 */
function log(agent, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${agent}] ${message}`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Config
  loadEnv,
  PROJECT_ROOT,
  projectPath,

  // File I/O
  readJSON,
  writeJSON,
  writeMeta,

  // Groq
  getGroqClient,
  callGroq,
  callGroqJSON,

  // HTTP
  rateLimitedFetch,

  // Schema
  validateRecord,

  // Helpers
  sleep,
  log,
};
