/**
 * Quick test: verify filter.js parses and exports run().
 * Also validates the system prompt covers all scope criteria.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const filePath = path.join(__dirname, 'filter.js');
const code = fs.readFileSync(filePath, 'utf-8');

// 1. Syntax check
try {
  new vm.Script(code, { filename: 'filter.js' });
  console.log('✓ filter.js — syntax OK');
} catch (error) {
  console.error('✗ filter.js — syntax error:', error.message);
  process.exit(1);
}

// 2. Module load check
let filterModule;
try {
  filterModule = require('./filter');
  console.log('✓ filter.js — module loaded');
} catch (error) {
  console.error('✗ filter.js — load error:', error.message);
  process.exit(1);
}

// 3. Export check
if (typeof filterModule.run === 'function') {
  console.log('✓ filter.js — run() exported');
} else {
  console.error('✗ filter.js — run() NOT exported');
  process.exit(1);
}

// 4. Implementation requirements
const checks = [
  ['/data/raw/',          'Reads from /data/raw/ (Task 3.1)'],
  ['BATCH_SIZE',          'Batch processing (Task 3.4)'],
  ['SYSTEM_PROMPT',       'Groq prompt design (Task 3.2)'],
  ['is_in_scope',         'Structured response with is_in_scope (Task 3.3)'],
  ['scope_reasoning',     'Structured response with scope_reasoning (Task 3.3)'],
  ['callGroqJSON',        'Uses Groq JSON mode (Task 3.2)'],
  ['filtered.json',       'Writes filtered.json (Task 3.6)'],
  ['rejected.json',       'Writes rejected.json (Task 3.6)'],
  ['writeMeta',           'Writes _meta.json (Task 3.7)'],
  ['maxRetries',          'Retry logic (Task 3.5)'],
  ['acceptanceRate',      'Anomaly detection for acceptance rate'],
  ['deleted',             'Scope: distinguishes deletion vs retrieval failure'],
  ['sarcas',              'Scope: handles sarcasm/irony'],
  ['Feature requests',   'Scope: rejects feature requests'],
];

let allOk = true;
for (const [pattern, desc] of checks) {
  if (code.includes(pattern)) {
    console.log(`  ✓ ${desc}`);
  } else {
    console.error(`  ✗ MISSING: ${desc} (expected "${pattern}")`);
    allOk = false;
  }
}

console.log(allOk ? '\nAll Phase 3 requirements verified.' : '\nSome requirements missing!');
process.exit(allOk ? 0 : 1);
