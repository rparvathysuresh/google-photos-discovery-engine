/**
 * Quick syntax + require check for all 5 collectors.
 */

const collectors = [
  'playstore',
  'appstore',
  'reddit',
  'helpcommunity',
  'youtube',
];

let allOk = true;

for (const name of collectors) {
  try {
    const mod = require(`./collectors/${name}`);
    if (typeof mod.collect !== 'function') {
      throw new Error('Missing collect() export');
    }
    console.log(`  ✓ ${name}.js — loaded, collect() exported`);
  } catch (error) {
    console.error(`  ✗ ${name}.js — FAILED: ${error.message}`);
    allOk = false;
  }
}

console.log(allOk ? '\nAll collectors OK.' : '\nSome collectors failed!');
process.exit(allOk ? 0 : 1);
