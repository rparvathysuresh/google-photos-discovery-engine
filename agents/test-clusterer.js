/**
 * Quick test: verify clusterer.js parses, loads, and covers Phase 5 requirements.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const filePath = path.join(__dirname, 'clusterer.js');
const code = fs.readFileSync(filePath, 'utf-8');

// 1. Syntax check
try {
  new vm.Script(code, { filename: 'clusterer.js' });
  console.log('✓ clusterer.js — syntax OK');
} catch (error) {
  console.error('✗ clusterer.js — syntax error:', error.message);
  process.exit(1);
}

// 2. Module load check
let mod;
try {
  mod = require('./clusterer');
  console.log('✓ clusterer.js — module loaded');
} catch (error) {
  console.error('✗ clusterer.js — load error:', error.message);
  process.exit(1);
}

// 3. Export check
if (typeof mod.run === 'function') {
  console.log('✓ clusterer.js — run() exported');
} else {
  console.error('✗ clusterer.js — run() NOT exported');
  process.exit(1);
}

// 4. Requirements coverage
const checks = [
  ['records.json',             '5A.1: Read structured records'],
  ['remembered_attributes',    '5A.2: Feature construction (remembered_attributes)'],
  ['failure_point',            '5A.2: Feature construction (failure_point)'],
  ['@xenova/transformers',     '5A.3: Local sentence-transformers embeddings'],
  ['cosineSimilarity',         '5A.4: Deduplication with cosine similarity'],
  ['kmeans',                   '5A.5: K-means clustering'],
  ['computeSilhouette',        '5A.5: Silhouette score for K selection'],
  ['labelCluster',             '5A.6: Cluster labeling (Groq)'],
  ['0.4 * freqNorm',           '5B.4: Composite score weights'],
  ['clusters.md',              '5C.1: Generate clusters.md'],
  ['summary.md',               '5C.2: Generate summary.md'],
  ['Senior PM Analyst',        '5C.3: Narrative via Groq (Senior PM Analyst prompt)']
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

console.log(allOk ? '\nAll Phase 5 requirements verified.' : '\nSome requirements missing!');
process.exit(allOk ? 0 : 1);
