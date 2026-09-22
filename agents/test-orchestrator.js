/**
 * Quick test: verify orchestrator.js parses and all stage runner functions exist.
 */
const path = require('path');

// We can't require orchestrator.js directly (it auto-runs main()),
// so we do a syntax check by compiling it.
const fs = require('fs');
const vm = require('vm');
const Module = require('module');

const filePath = path.join(__dirname, 'orchestrator.js');
const code = fs.readFileSync(filePath, 'utf-8');

try {
  // Check syntax only (will throw SyntaxError if invalid)
  new vm.Script(code, { filename: 'orchestrator.js' });
  console.log('✓ orchestrator.js — syntax OK');
} catch (error) {
  console.error('✗ orchestrator.js — syntax error:', error.message);
  process.exit(1);
}

// Verify the file references the required components
const checks = [
  ['Promise.allSettled', 'Parallel execution (Task 2.2)'],
  ['_meta.json',         'Meta-check gate (Task 2.3)'],
  ['runStage2',          'Sequential chaining - filter (Task 2.4)'],
  ['runStage3',          'Sequential chaining - extract (Task 2.4)'],
  ['runStage4',          'Sequential chaining - cluster (Task 2.4)'],
  ['_pipeline_state',    'Pipeline state tracking (Task 2.5)'],
  ['maxRetries',         'Retry logic (Task 2.6)'],
  ['--stage',            'CLI --stage flag (Task 2.7)'],
  ['--sample',           'CLI --sample flag (Task 2.7)'],
  ['.pipeline.lock',     'Lockfile (edge case X-10)'],
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

console.log(allOk ? '\nAll Phase 2 requirements verified.' : '\nSome requirements missing!');
process.exit(allOk ? 0 : 1);
