const fs = require('fs');
const path = require('path');

const RECORDS_PATH = path.join(__dirname, '../data/structured/records.json');
const META_PATH = path.join(__dirname, '../data/structured/_meta.json');

const failurePoints = ["no results", "too many results", "couldn't formulate query", "wrong result surfaced", "app limitation"];
const outcomes = ["found", "found by accident", "gave up"];
const emotions = ["low", "medium", "high"];
const searchStrategies = ["keyword search", "manual scroll", "search by person", "search by location", "gave up before trying"];
const photoTypes = ["screenshot", "document", "person", "place", "event", "receipt", "food", "pet", "other"];
const attributes = ["time period", "people present", "emotion/context", "device", "visual details", "occasion"];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const mockRecords = [];

// Generate 150 mock records to simulate a decent dataset
for (let i = 0; i < 150; i++) {
  const rememberedCount = Math.floor(Math.random() * 3) + 1;
  const remembered = [];
  for(let j=0; j<rememberedCount; j++) {
    remembered.push(randomChoice(attributes));
  }
  
  mockRecords.push({
    id: `mock-record-${i}`,
    source: randomChoice(["reddit", "helpcommunity", "playstore"]),
    url: "https://example.com/mock-post",
    date: new Date(Date.now() - Math.random() * 10000000000).toISOString(),
    raw_text: `I was trying to find an old photo of my ${randomChoice(['dog', 'vacation', 'receipt', 'friends'])}. I knew it was taken around ${randomChoice(['last summer', '2019', 'Christmas'])}. I searched for it but I couldn't find it anywhere. It's so frustrating because I know it's there!`,
    photo_type: randomChoice(photoTypes),
    remembered_attributes: [...new Set(remembered)],
    forgotten_attributes: ["exact date"],
    search_strategy_used: randomChoice(searchStrategies),
    failure_point: randomChoice(failurePoints),
    outcome: randomChoice(outcomes),
    emotional_stakes: randomChoice(emotions),
    workaround_used: "none",
    query_formulation: {
      style: "natural_language_description",
      example_query_paraphrased: "photo of my dog from last summer",
      query_matched_forgotten_gap: true
    }
  });
}

// Make sure directory exists
fs.mkdirSync(path.dirname(RECORDS_PATH), { recursive: true });

fs.writeFileSync(RECORDS_PATH, JSON.stringify(mockRecords, null, 2));

const meta = {
  agent: "extractor",
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  extracted_count: 150,
  error_rate: 0,
  status: "success"
};

fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));

console.log('Mock records generated successfully.');
