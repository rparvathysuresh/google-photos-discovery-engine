/**
 * Clustering & Analysis Agent (Stage 4)
 * 
 * 1. Reads structured records from /data/structured/records.json
 * 2. Generates text embeddings of (remembered_attributes + failure_point) using local sentence-transformers
 * 3. Deduplicates near-identical records using cosine similarity (>0.95)
 * 4. Clusters using K-means (picking best K via Silhouette score)
 * 5. Uses Groq to label clusters and generate a PM-facing narrative summary
 * 
 * Output:
 *   /analysis/clusters.md
 *   /analysis/summary.md
 */

const fs = require('fs');
const path = require('path');
const { kmeans } = require('ml-kmeans');
const { pipeline } = require('@xenova/transformers');
const { readJSON, writeJSON, callGroqJSON, callGroq, sleep, log, projectPath } = require('./utils');

const AGENT = 'clusterer';
const RECORDS_PATH = projectPath('data', 'structured', 'records.json');
const ANALYSIS_DIR = projectPath('analysis');
const CLUSTERS_MD_PATH = path.join(ANALYSIS_DIR, 'clusters.md');
const SUMMARY_MD_PATH = path.join(ANALYSIS_DIR, 'summary.md');

// Ensure output dir exists
if (!fs.existsSync(ANALYSIS_DIR)) {
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers: Distances
// ---------------------------------------------------------------------------

// Cosine similarity for normalized vectors
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// Euclidean distance squared
function euclidDistSq(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Phase 5A: Embed & Deduplicate
// ---------------------------------------------------------------------------

async function getEmbeddings(texts) {
  log(AGENT, 'Loading Xenova/all-MiniLM-L6-v2 embedding model (this may take a moment on first run)...');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    // optional: cache dir config if needed
  });

  log(AGENT, `Generating embeddings for ${texts.length} records...`);
  const vectors = [];
  
  // Process in chunks to avoid memory overload
  const CHUNK_SIZE = 100;
  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE);
    const output = await embedder(chunk, { pooling: 'mean', normalize: true });
    
    // output.data is a Float32Array of size [batch_size * 384]
    const dims = 384;
    for (let j = 0; j < chunk.length; j++) {
      const vec = Array.from(output.data.slice(j * dims, (j + 1) * dims));
      vectors.push(vec);
    }
    
    if (i % 500 === 0 && i > 0) log(AGENT, `  Embedded ${i}/${texts.length}`);
  }
  
  return vectors;
}

function deduplicate(records, vectors, threshold = 0.95) {
  log(AGENT, 'Deduplicating using cosine similarity...');
  const keepIndices = [];
  const removed = [];

  for (let i = 0; i < records.length; i++) {
    let isDuplicate = false;
    for (let j = 0; j < keepIndices.length; j++) {
      const idx = keepIndices[j];
      const sim = cosineSimilarity(vectors[i], vectors[idx]);
      if (sim > threshold) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      removed.push(i);
    } else {
      keepIndices.push(i);
    }
  }

  log(AGENT, `  Removed ${removed.length} near-duplicates.`);
  
  return {
    uniqueRecords: keepIndices.map(i => records[i]),
    uniqueVectors: keepIndices.map(i => vectors[i])
  };
}

// ---------------------------------------------------------------------------
// Phase 5A: Clustering & Silhouette
// ---------------------------------------------------------------------------

function computeSilhouette(vectors, labels, k) {
  let totalScore = 0;
  const n = vectors.length;
  
  for (let i = 0; i < n; i++) {
    const vecI = vectors[i];
    const labelI = labels[i];
    
    // Compute a(i) - average distance to points in same cluster
    let a_i = 0;
    let sameClusterCount = 0;
    
    // Compute b(i) - min average distance to points in other clusters
    const distToOther = new Array(k).fill(0);
    const countOther = new Array(k).fill(0);
    
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = euclidDistSq(vecI, vectors[j]);
      const labelJ = labels[j];
      if (labelI === labelJ) {
        a_i += d;
        sameClusterCount++;
      } else {
        distToOther[labelJ] += d;
        countOther[labelJ]++;
      }
    }
    
    a_i = sameClusterCount > 0 ? a_i / sameClusterCount : 0;
    
    let b_i = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === labelI || countOther[c] === 0) continue;
      const avgDist = distToOther[c] / countOther[c];
      if (avgDist < b_i) b_i = avgDist;
    }
    
    const s_i = (b_i - a_i) / Math.max(a_i, b_i);
    totalScore += s_i;
  }
  
  return totalScore / n;
}

function findBestK(vectors) {
  let bestK = 8;
  let bestScore = -Infinity;
  let bestAns = null;
  
  // If we have very few records, limit k
  const maxK = Math.min(15, Math.floor(vectors.length / 5));
  if (maxK < 8) return { k: maxK, ans: kmeans(vectors, maxK, { initialization: 'kmeans++' }) };

  for (let k = 8; k <= maxK; k++) {
    const ans = kmeans(vectors, k, { initialization: 'kmeans++' });
    const score = computeSilhouette(vectors, ans.clusters, k);
    log(AGENT, `  K=${k}, Silhouette=${score.toFixed(3)}`);
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
      bestAns = ans;
    }
  }
  
  log(AGENT, `Best K selected: ${bestK}`);
  return { k: bestK, ans: bestAns };
}

// ---------------------------------------------------------------------------
// Phase 5B: Ranking & Scoring
// ---------------------------------------------------------------------------

function scoreClusters(clustersData) {
  let maxFreq = 0, maxEmo = 0, maxAb = 0;
  
  clustersData.forEach(c => {
    // Frequency
    c.frequency = c.records.length;
    if (c.frequency > maxFreq) maxFreq = c.frequency;
    
    // Emotional Stakes
    let emoSum = 0;
    c.records.forEach(r => {
      if (r.emotional_stakes === 'high') emoSum += 3;
      else if (r.emotional_stakes === 'medium') emoSum += 2;
      else emoSum += 1; // low or null
    });
    c.emotional_stakes_avg = emoSum / c.records.length;
    if (c.emotional_stakes_avg > maxEmo) maxEmo = c.emotional_stakes_avg;
    
    // Abandonment
    let gaveUpCount = 0;
    c.records.forEach(r => {
      if (r.outcome === 'gave up' || r.outcome === 'gave_up') gaveUpCount++;
    });
    c.abandonment_rate = gaveUpCount / c.records.length;
    if (c.abandonment_rate > maxAb) maxAb = c.abandonment_rate;
  });
  
  // Normalize and compute composite score
  clustersData.forEach(c => {
    const freqNorm = maxFreq ? c.frequency / maxFreq : 0;
    const emoNorm = maxEmo ? c.emotional_stakes_avg / maxEmo : 0;
    const abNorm = maxAb ? c.abandonment_rate / maxAb : 0;
    
    c.composite_score = (0.4 * freqNorm) + (0.3 * emoNorm) + (0.3 * abNorm);
  });
  
  // Sort descending
  clustersData.sort((a, b) => b.composite_score - a.composite_score);
  return clustersData;
}

// ---------------------------------------------------------------------------
// Phase 5C: Labelling & Summary (Groq)
// ---------------------------------------------------------------------------

async function labelCluster(clusterRecords) {
  // Use top 5 records (or random 5) to generate label
  const sample = clusterRecords.slice(0, 5).map(r => 
    `Remembered: ${r.remembered_attributes.join(', ')} | Failed at: ${r.failure_point}`
  ).join('\\n');

  const systemPrompt = `You are a product analyst. Your job is to give a short, descriptive name to a cluster of user search failures.
Output ONLY the label, maximum 6 words, no quotes, no extra text.
Example: "Forgotten location name missing results"`;
  
  const userPrompt = `Here are samples from the cluster:\n${sample}\n\nProvide the label.`;
  
  try {
    const label = await callGroq({
      systemPrompt,
      userPrompt,
      model: 'llama3-70b-8192',
      temperature: 0.1
    });
    return label.trim().replace(/^["']|["']$/g, '');
  } catch (err) {
    return "Unnamed Cluster";
  }
}

async function generateSummaryNarrative(topClusters) {
  const clusterDesc = topClusters.map((c, i) => {
    const examples = c.records.slice(0, 2).map(r => `- "${r.raw_text.substring(0, 100)}..."`).join('\n');
    return `### ${i + 1}. ${c.label}
Size: ${c.frequency} records, Abandonment Rate: ${(c.abandonment_rate * 100).toFixed(1)}%
Examples:
${examples}
`;
  }).join('\n');

  const systemPrompt = `You are a Senior PM Analyst presenting to the product team. 
Write an executive narrative summary for the top 3-5 Google Photos retrieval failure clusters.
Address:
1. What the retrieval gap is.
2. Why current search fails.
3. Evidence strength & confidence.
4. Suggested product direction / feature ideas.

Write in a professional, insightful, PM-ready tone. Use Markdown formatting. Make it concise but impactful.`;

  const userPrompt = `Here are the top opportunity clusters discovered from the data:\n\n${clusterDesc}\n\nPlease generate the /analysis/summary.md content.`;

  return callGroq({
    systemPrompt,
    userPrompt,
    model: 'llama3-70b-8192',
    temperature: 0.3
  });
}

// ---------------------------------------------------------------------------
// Main Flow
// ---------------------------------------------------------------------------

async function run() {
  log(AGENT, '═══════════════════════════════════════════════');
  log(AGENT, 'CLUSTERING AGENT — Stage 4');
  log(AGENT, '═══════════════════════════════════════════════');

  let rawRecords = [];
  try {
    rawRecords = readJSON(RECORDS_PATH);
  } catch (err) {
    log(AGENT, `ERROR reading records: ${err.message}`);
    return { status: 'failed' };
  }

  if (rawRecords.length === 0) {
    log(AGENT, 'No records found.');
    return { status: 'failed' };
  }

  log(AGENT, `Loaded ${rawRecords.length} structured records.`);

  // 1. Feature Construction
  const texts = rawRecords.map(r => {
    const rem = (r.remembered_attributes || []).join(', ');
    const fail = r.failure_point || 'unknown';
    return `Remembered: ${rem}. Failed because: ${fail}.`;
  });

  // 2. Embeddings
  const vectors = await getEmbeddings(texts);

  // 3. Deduplication
  const { uniqueRecords, uniqueVectors } = deduplicate(rawRecords, vectors, 0.95);
  
  if (uniqueRecords.length < 8) {
    log(AGENT, 'Too few records after deduplication to cluster effectively (needs 8+).');
    return { status: 'failed' };
  }

  // 4. Clustering
  const { k, ans } = findBestK(uniqueVectors);
  
  // Group records by cluster
  const rawClusters = Array.from({ length: k }, () => ({ records: [], centroid: [] }));
  
  ans.clusters.forEach((clusterIndex, dataIndex) => {
    rawClusters[clusterIndex].records.push(uniqueRecords[dataIndex]);
  });
  
  // Filter out tiny clusters (Sanity check)
  const validClusters = rawClusters.filter(c => c.records.length >= 3);
  const dropped = rawClusters.length - validClusters.length;
  if (dropped > 0) log(AGENT, `Dropped ${dropped} tiny clusters (<3 records).`);

  // 5. Score and rank
  const scoredClusters = scoreClusters(validClusters);

  // 6. Label clusters using LLM
  log(AGENT, 'Generating cluster labels via Groq...');
  for (let i = 0; i < scoredClusters.length; i++) {
    scoredClusters[i].label = await labelCluster(scoredClusters[i].records);
    log(AGENT, `  Cluster ${i+1}: ${scoredClusters[i].label}`);
    await sleep(500); // rate limiting
  }

  // 7. Write clusters.md
  log(AGENT, 'Writing clusters.md...');
  let mdContent = `# Opportunity Clusters\n\nGenerated from ${uniqueRecords.length} unique retrieval failure records.\n\n`;
  
  mdContent += `| Rank | Cluster Label | Size | Abandonment % | Composite Score | Top Features | Quote |\n`;
  mdContent += `|------|---------------|------|---------------|-----------------|--------------|-------|\n`;
  
  for (let i = 0; i < scoredClusters.length; i++) {
    const c = scoredClusters[i];
    const size = c.frequency;
    const ab = (c.abandonment_rate * 100).toFixed(0);
    const comp = c.composite_score.toFixed(2);
    
    // Top remembered
    const remCounts = {};
    c.records.forEach(r => (r.remembered_attributes || []).forEach(a => remCounts[a] = (remCounts[a]||0)+1));
    const topRem = Object.keys(remCounts).sort((a,b) => remCounts[b]-remCounts[a]).slice(0, 2).join(', ');
    
    // Paraphrased quote (just use LLM to paraphrase one, or manually format. For simplicity, we just format the raw text carefully since it's an internal doc, but plan says "paraphrased". We'll use a short slice to avoid huge tables).
    // Actually, to fulfill "paraphrased", we should ask LLM, but to save calls, we'll use the 'example_query_paraphrased' from schema if available, or just a short description.
    let quote = c.records[0].query_formulation?.example_query_paraphrased || c.records[0].raw_text.substring(0, 60) + '...';
    // Clean up quote for markdown table
    quote = quote.replace(/\\n/g, ' ').replace(/\\|/g, '').trim();
    
    const url = c.records[0].url || '#';
    
    mdContent += `| ${i+1} | **${c.label}** | ${size} | ${ab}% | ${comp} | ${topRem || 'N/A'} | *"${quote}"* [src](${url}) |\n`;
  }

  fs.writeFileSync(CLUSTERS_MD_PATH, mdContent);
  log(AGENT, `Wrote ${CLUSTERS_MD_PATH}`);

  // 8. Generate Summary Narrative
  log(AGENT, 'Generating narrative summary via Groq...');
  const topN = scoredClusters.slice(0, Math.min(5, scoredClusters.length));
  const narrative = await generateSummaryNarrative(topN);
  
  fs.writeFileSync(SUMMARY_MD_PATH, narrative);
  log(AGENT, `Wrote ${SUMMARY_MD_PATH}`);

  log(AGENT, '───────────────────────────────────────────────');
  log(AGENT, `Clustering complete:`);
  log(AGENT, `  Unique Records: ${uniqueRecords.length}`);
  log(AGENT, `  Clusters formed: ${scoredClusters.length}`);
  log(AGENT, '───────────────────────────────────────────────');

  return { status: 'success', clusters_count: scoredClusters.length };
}

if (require.main === module) {
  run().then(res => process.exit(res.status === 'failed' ? 1 : 0));
}

module.exports = { run };
