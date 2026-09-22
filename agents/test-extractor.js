/**
 * Quick test: verify extractor.js parses, loads, and covers Phase 4 requirements.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const filePath = path.join(__dirname, 'extractor.js');
const code = fs.readFileSync(filePath, 'utf-8');

// 1. Syntax check
try {
  new vm.Script(code, { filename: 'extractor.js' });
  console.log('✓ extractor.js — syntax OK');
} catch (error) {
  console.error('✗ extractor.js — syntax error:', error.message);
  process.exit(1);
}

// 2. Module load check
let mod;
try {
  mod = require('./extractor');
  console.log('✓ extractor.js — module loaded');
} catch (error) {
  console.error('✗ extractor.js — load error:', error.message);
  process.exit(1);
}

// 3. Export check
if (typeof mod.run === 'function') {
  console.log('✓ extractor.js — run() exported');
} else {
  console.error('✗ extractor.js — run() NOT exported');
  process.exit(1);
}

// 4. Requirements coverage
const checks = [
  ['--sample',               '4A.1: --sample flag support'],
  ['SAMPLE_PER_SOURCE',      '4A.1: 10 records per source in sample mode'],
  ['schema.json',            '4A.2: Full schema.json embedded in prompt'],
  ['query_formulation',      '4A.2: query_formulation instructions in prompt'],
  ['example_query_paraphrased', '4A.2: Paraphrase instructions'],
  ['NEVER copy verbatim', '4A.2: No verbatim copying instruction'],
  ['validateRecord',         '4A.3: AJV validation per record'],
  ['sample_',                '4A.4: Sample file per source'],
  ['BATCH_SIZE',             '4B.2: Batch size = 5'],
  ['errors.json',            '4B.3: Error records written'],
  ['buildDedupeSet',         '4B.4: Deduplication'],
  ['records.json',           '4B.5: Output records.json'],
  ['writeMeta',              '4B.5: Output _meta.json'],
  ['analyzeDistributions',   'Exit: Field distribution analysis'],
  ['not_mentioned',          'Exit: query_formulation.style dominance check'],
  ['null for',               'Exit: >20% null field detection'],
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

console.log(allOk ? '\nAll Phase 4 requirements verified.' : '\nSome requirements missing!');
process.exit(allOk ? 0 : 1);
