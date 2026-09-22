const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../config/.env') });
const { getGroqClient } = require('../agents/utils');

const app = express();
const PORT = process.env.PORT || 3001;

// Paths
const DATA_DIR = path.join(__dirname, '../data');
const ANALYSIS_DIR = path.join(__dirname, '../analysis');
const RECORDS_PATH = path.join(DATA_DIR, 'structured', 'records.json');
const STRUCTURED_META = path.join(DATA_DIR, 'structured', '_meta.json');
const CLUSTERS_MD = path.join(ANALYSIS_DIR, 'clusters.md');
const SUMMARY_MD = path.join(ANALYSIS_DIR, 'summary.md');

// Middleware
app.use(cors());
app.use(express.json());

// Helpers
const safeReadJSON = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
};

const safeReadText = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return null;
  }
};

// -----------------------------------------------------------------------------
// ENDPOINTS
// -----------------------------------------------------------------------------

// 1. Status Endpoint
app.get('/api/status', (req, res) => {
  const structuredMeta = safeReadJSON(STRUCTURED_META);
  
  if (!structuredMeta) {
    return res.json({ status: 'not_run', message: 'Pipeline has not completed extraction phase.' });
  }

  res.json({
    status: structuredMeta.status,
    last_run: structuredMeta.started_at,
    extracted_records: structuredMeta.extracted_count,
    error_rate: structuredMeta.error_rate
  });
});

// 2. Clusters Endpoint
app.get('/api/clusters', (req, res) => {
  const clustersRaw = safeReadText(CLUSTERS_MD);
  const summaryRaw = safeReadText(SUMMARY_MD);

  if (!clustersRaw || !summaryRaw) {
    return res.status(404).json({ error: 'Clustering analysis not found. Run stage 4.' });
  }

  // Parse markdown table in clusters.md
  // The table format:
  // | Rank | Cluster Label | Size | Abandonment % | Composite Score | Top Features | Quote |
  // |------|---------------|------|---------------|-----------------|--------------|-------|
  const lines = clustersRaw.split('\n');
  const parsedClusters = [];
  let isTable = false;

  for (const line of lines) {
    if (line.trim().startsWith('| Rank |')) {
      isTable = true;
      continue;
    }
    if (line.trim().startsWith('|------|')) continue;
    
    if (isTable && line.trim().startsWith('|')) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 8) { // Account for leading and trailing |
        parsedClusters.push({
          rank: parts[1],
          label: parts[2].replace(/\*\*/g, ''), // remove bold
          size: parseInt(parts[3], 10),
          abandonment_pct: parts[4],
          composite_score: parseFloat(parts[5]),
          top_features: parts[6],
          quote: parts[7].replace(/\*|"/g, '').replace(/\[src\].*$/, '').trim() // clean up quote and remove markdown link
        });
      }
    }
  }

  res.json({
    summary_markdown: summaryRaw,
    clusters: parsedClusters
  });
});

// 3. Records Endpoint (with filtering and pagination)
app.get('/api/records', (req, res) => {
  const records = safeReadJSON(RECORDS_PATH);
  
  if (!records) {
    return res.status(404).json({ error: 'Records not found. Run stage 3.' });
  }

  let filtered = records;

  // Apply filters if provided
  const { source, photo_type, failure_point, search_strategy_used } = req.query;

  if (source) filtered = filtered.filter(r => r.source === source);
  if (photo_type) filtered = filtered.filter(r => r.photo_type === photo_type);
  if (failure_point) filtered = filtered.filter(r => r.failure_point === failure_point);
  if (search_strategy_used) filtered = filtered.filter(r => r.search_strategy_used === search_strategy_used);

  // Pagination
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;

  const paginated = filtered.slice(startIndex, endIndex);

  res.json({
    total: filtered.length,
    page,
    limit,
    total_pages: Math.ceil(filtered.length / limit),
    data: paginated
  });
});

// 4. Chat AI Endpoint
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Keep only the last 5 messages to prevent hitting token limits
  const recentMessages = messages.slice(-5);

  // Load context from pipeline
  const clusters = safeReadText(CLUSTERS_MD) || "No clusters available.";
  const summary = safeReadText(SUMMARY_MD) || "No summary available.";
  const rawRecords = safeReadJSON(RECORDS_PATH) || [];
  
  // Sample a few records if there are too many (avoid token limits)
  const sampledRecords = rawRecords.slice(0, 15).map(r => ({
    query: r.raw_text,
    failure: r.failure_point,
    remembered: r.remembered_attributes,
    forgotten: r.forgotten_attributes,
    strategy: r.search_strategy_used
  }));

  const systemPrompt = `You are a Senior Product Manager AI analyzing Google Photos user feedback.
You have access to a dataset of user reviews detailing instances where users failed to retrieve old photos due to fragmented memory.

Here are the identified opportunity clusters:
${clusters}

Here is the executive summary:
${summary}

Here is a sample of the structured raw data (up to 50 records):
${JSON.stringify(sampledRecords)}

Your task is to answer the user's questions strictly based on this provided data. 
Focus on explaining:
- What kinds of old photos users struggle to retrieve
- What information people actually remember
- What information they have forgotten
- How users formulate searches when memory is incomplete
Use formatting like lists and bolding where appropriate to make the answer easy to read.
Do not invent data outside of this context.`;

  try {
    const client = getGroqClient();
    const chatCompletion = await client.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        ...recentMessages
      ],
      model: 'openai/gpt-oss-120b',
      temperature: 0.2
    });
    res.json({ reply: chatCompletion.choices[0]?.message?.content || "No response generated." });
  } catch (error) {
    console.error('Chat API Error:', error);
    res.status(500).json({ error: 'Failed to generate response from Groq API.' });
  }
});

// Serve static frontend files
const CLIENT_DIST = path.join(__dirname, '../client/dist');
app.use(express.static(CLIENT_DIST));

// Start server
app.listen(PORT, () => {
  console.log(`Google Photos Analysis API listening on port ${PORT}`);
});
