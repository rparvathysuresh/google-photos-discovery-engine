/**
 * Quick schema validation test.
 * Verifies schema.json compiles and validates a test record correctly.
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const fs = require('fs');
const path = require('path');

// 1. Compile the schema
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const schemaPath = path.join(__dirname, '..', 'schema', 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const validate = ajv.compile(schema);

console.log('[1/3] Schema compilation: SUCCESS');

// 2. Validate a correct test record
const validRecord = {
  id: 'test_001',
  source: 'reddit',
  url: 'https://reddit.com/r/googlephotos/comments/abc123',
  date: '2024-01-15T10:30:00Z',
  raw_text: 'I remember taking a photo of my dog at the park last summer but I cannot find it when I search for dog or park.',
  photo_type: 'pet',
  remembered_attributes: ['time period', 'visual details'],
  forgotten_attributes: ['exact date', 'place name'],
  search_strategy_used: 'keyword search',
  failure_point: 'no results',
  outcome: 'gave up',
  emotional_stakes: 'medium',
  workaround_used: 'manual scroll',
  query_formulation: {
    style: 'single_keyword',
    example_query_paraphrased: 'searched for dog and park',
    query_matched_forgotten_gap: false,
  },
};

const result1 = validate(validRecord);
console.log('[2/3] Valid record test:', result1 ? 'PASS' : 'FAIL');
if (!result1) {
  console.error('  Errors:', JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}

// 3. Validate that an invalid record IS rejected
const invalidRecord = {
  id: 'test_002',
  source: 'invalid_source',  // not in enum
  url: 'not-a-url',
  date: 'not-a-date',
  raw_text: '',              // minLength 1
  photo_type: 'spaceship',   // not in enum
  remembered_attributes: ['invalid_attr'],
  forgotten_attributes: [],
  search_strategy_used: 'telepathy', // not in enum
  failure_point: 'no results',
  outcome: 'gave up',
  emotional_stakes: 'extreme', // not in enum
  workaround_used: 'none',
  query_formulation: {
    style: 'not_mentioned',
    example_query_paraphrased: 'should be null for not_mentioned', // should be null
    query_matched_forgotten_gap: false, // should be null
  },
};

const result2 = validate(invalidRecord);
console.log('[3/3] Invalid record rejection:', result2 ? 'FAIL (should reject)' : 'PASS (correctly rejected)');
if (result2) {
  console.error('  Schema failed to reject an invalid record!');
  process.exit(1);
}

console.log('\nAll schema validation checks passed.');
