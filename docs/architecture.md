# Architecture: Incomplete-Memory Retrieval Discovery Engine

## 1. System Overview

The system is a **multi-agent research pipeline** composed of specialized,
loosely-coupled agents that communicate through a shared filesystem
(`/data/` and `/analysis/`). Each agent reads from well-defined inputs and
writes to well-defined outputs, making the pipeline restartable at any stage.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          ORCHESTRATOR                                   │
│  Launches agents, manages parallelism, monitors health, retries failures│
└──────┬──────────────────────┬───────────────────────┬───────────────────┘
       │                      │                       │
       ▼                      ▼                       ▼
 ┌───────────┐         ┌───────────┐           ┌───────────┐
 │ STAGE 1   │         │ STAGE 1   │    ...    │ STAGE 1   │
 │ Collector │         │ Collector │           │ Collector │
 │ (Play)    │         │ (Reddit)  │           │ (YouTube) │
 └─────┬─────┘         └─────┬─────┘           └─────┬─────┘
       │                      │                       │
       ▼                      ▼                       ▼
  /data/raw/             /data/raw/              /data/raw/
  playstore.json         reddit.json             youtube.json
       │                      │                       │
       └──────────┬───────────┘───────────────────────┘
                  ▼
         ┌────────────────┐
         │    STAGE 2     │
         │ Filtering Agent│
         └───────┬────────┘
                 ▼
          /data/filtered/
          filtered.json
                 │
                 ▼
        ┌─────────────────┐
        │     STAGE 3     │
        │ Extraction Agent│
        │ (reads schema)  │
        └────────┬────────┘
                 ▼
         /data/structured/
         records.json
                 │
                 ▼
       ┌──────────────────┐
       │     STAGE 4      │
       │ Clustering Agent │
       └────────┬─────────┘
                ▼
        /analysis/clusters.md
        /analysis/summary.md
```

---

## 2. Agent Specifications

### 2.1 Orchestrator

| Property | Detail |
|----------|--------|
| **Role** | Top-level controller that launches, monitors, and sequences all agents |
| **Concurrency model** | Stage 1 collectors run **in parallel** (one process/thread per source); stages 2–4 run **sequentially** |
| **Retry policy** | Up to 3 retries per collector with exponential backoff; log failures without blocking other collectors |
| **Checkpointing** | Each stage writes a `_meta.json` sidecar (timestamp, record count, errors) so the pipeline can resume from the last successful stage |

### 2.2 Collection Agents (Stage 1)

Five independent collectors, each responsible for a single data source.

#### 2.2.1 Google Play Store Collector

| Property | Detail |
|----------|--------|
| **Library** | `google-play-scraper` (npm) |
| **Target** | App ID `com.google.android.apps.photos` |
| **Filters** | Rating 1–3 stars, sort by "most relevant" |
| **Pagination** | Fetch up to 1,000 reviews in batches of 150 |
| **Rate limiting** | 1-second delay between paginated requests |
| **Output** | `/data/raw/playstore.json` |

#### 2.2.2 Apple App Store Collector

| Property | Detail |
|----------|--------|
| **Library** | `app-store-scraper` (npm) |
| **Target** | Google Photos iOS app |
| **Filters** | Rating 1–3 stars |
| **Pagination** | Fetch up to 1,000 reviews, paginated by page number |
| **Rate limiting** | 1-second delay between pages |
| **Output** | `/data/raw/appstore.json` |

#### 2.2.3 Reddit Collector

| Property | Detail |
|----------|--------|
| **Method** | Puppeteer headless browser automation (no API key required) |
| **Target** | `old.reddit.com/r/{sub}/search` — old Reddit has a simpler, more scrapeable DOM |
| **Subreddits** | `r/googlephotos`, `r/GooglePixel`, `r/androidapps` |
| **Search queries** | `"can't find old photo"`, `"lost photo"`, `"remember picture"`, `"search photos"`, `"can't find photo"`, `"missing photo"` |
| **Data extracted** | Post title, selftext, top 5 comments, score, date, permalink |
| **Rate limiting** | 3–5s delay between page loads; CAPTCHA/blocked pages are skipped and logged (never bypassed) |
| **Incremental write** | Saves to `/data/raw/reddit.json` every 10 posts |
| **Run log** | `/data/raw/reddit_run_log.json` — pages visited, blocked, errored |
| **Output** | `/data/raw/reddit.json` |

#### 2.2.4 Google Photos Help Community Collector

| Property | Detail |
|----------|--------|
| **Method** | Browser subagent (headless browser automation) |
| **Target** | `support.google.com/photos/community` |
| **Strategy** | Search for relevant terms → navigate into threads → extract question + replies |
| **Search queries** | Same query set as Reddit collector |
| **Anti-bot handling** | Use realistic user-agent, throttle navigation (2–3 sec between page loads) |
| **Output** | `/data/raw/helpcommunity.json` |

#### 2.2.5 YouTube Collector (Browser-Based)

| Property | Detail |
|----------|--------|
| **Method** | Puppeteer headless browser automation (no API key required) |
| **Video source** | Curated list of video IDs in `/config/youtube_video_ids.json` |
| **Comment loading** | Navigate to each video URL, scroll to lazy-load comments (cap ~200 per video, max 30 scroll attempts) |
| **Data extracted** | Comment text, like count, date, video URL |
| **CAPTCHA handling** | Blocked/unavailable videos are skipped and logged (never bypassed) |
| **Incremental write** | Saves to `/data/raw/youtube.json` after each video |
| **Run log** | `/data/raw/youtube_run_log.json` — videos visited, blocked, errored |
| **Output** | `/data/raw/youtube.json` |

---

### 2.3 Filtering Agent (Stage 2)

| Property | Detail |
|----------|--------|
| **Input** | All files in `/data/raw/*.json` (merged into a single stream) |
| **Classification method** | Groq-hosted LLM zero-shot classification using the Scope criteria as the system prompt |
| **Scope criteria** | The record must describe a user who (a) knows a photo/video exists, (b) cannot recall enough detail to search precisely, and (c) failed, struggled, or used a workaround |
| **Batch size** | Process 20 records per LLM call to amortize latency |
| **Output fields** | Original record + `is_in_scope: boolean` + `scope_reasoning: string` |
| **Output** | `/data/filtered/filtered.json` (only `is_in_scope === true` records) |
| **Rejection log** | `/data/filtered/rejected.json` (for audit and debugging) |

---

### 2.4 Structured Extraction Agent (Stage 3)

| Property | Detail |
|----------|--------|
| **Input** | `/data/filtered/filtered.json` |
| **Schema source of truth** | `/schema/schema.json` — the agent **must** read this file at startup and use it as the extraction template |
| **Extraction method** | Groq-hosted LLM structured output (JSON mode) with the schema embedded in the prompt |
| **Batch size** | 5 records per LLM call (structured extraction is more token-intensive) |
| **Quality gate** | Before full-scale extraction, run on a **10-record sample per source** and output to `/data/structured/samples/` for human review |
| **Validation** | Every extracted record is validated against `schema.json` using JSON Schema validation; invalid records are logged to `/data/structured/errors.json` |
| **Output** | `/data/structured/records.json` |

---

### 2.5 Clustering / Comparison Agent (Stage 4)

| Property | Detail |
|----------|--------|
| **Input** | `/data/structured/records.json` |
| **Embedding strategy** | Concatenate `remembered_attributes` + `failure_point` into a text string → generate embeddings via a text embedding model |
| **Clustering algorithm** | Hierarchical or K-means clustering; target 8–15 clusters (tunable) |
| **Ranking dimensions** | Each cluster is scored on: (1) frequency (record count), (2) average `emotional_stakes`, (3) proportion of `gave_up` outcomes |
| **Deduplication** | Near-duplicate records (cosine similarity > 0.95) are merged before clustering |
| **Output — clusters.md** | Ranked table with: cluster label, size, top remembered/forgotten attribute patterns, representative quotes (paraphrased, with source URLs), and a composite opportunity score |
| **Output — summary.md** | Narrative summary of the top 3–5 clusters written for a PM audience: what the retrieval gap is, why current search fails, evidence strength, and suggested product direction |

### 2.6 Backend API (Stage 5 / Phase 6)

| Property | Detail |
|----------|--------|
| **Goal** | Serve the pipeline output data to the frontend via a REST API |
| **Input** | `/data/structured/records.json`, `/analysis/clusters.md`, `/analysis/summary.md`, `_meta.json` files |
| **Framework** | Express.js |
| **Endpoints** | `/api/status`, `/api/clusters`, `/api/records`, `/api/chat` |

---

### 2.7 Minimal Frontend Dashboard (Stage 6 / Phase 7)

| Property | Detail |
|----------|--------|
| **Goal** | Provide a clean, minimal web interface for PMs to explore insights (optimized for unified Railway deploy) |
| **Framework** | React via Vite |
| **Styling** | Vanilla CSS (minimal dark theme, clean typography) |
| **Views** | Executive Summary, Opportunity Clusters, Data Explorer, Ask AI (Interactive Chat) |

---

## 3. Data Schema

### 3.1 Raw Record Schema (`/data/raw/*.json`)

```json
{
  "source": "playstore | appstore | reddit | helpcommunity | youtube",
  "date": "ISO 8601 date string",
  "rating": "number | null (not applicable for reddit/youtube)",
  "upvotes": "number | null (not applicable for app stores)",
  "raw_text": "string — original user text",
  "url": "string — permalink to the source"
}
```

### 3.2 Filtered Record Schema (`/data/filtered/filtered.json`)

Extends raw record with:

```json
{
  "...raw_record_fields",
  "is_in_scope": true,
  "scope_reasoning": "string — one-sentence explanation of why this record matches scope"
}
```

### 3.3 Structured Record Schema (`/data/structured/records.json`)

Defined in `/schema/schema.json`. Each record contains:

```json
{
  "id": "string — unique identifier (source + index)",
  "source": "string",
  "url": "string",
  "date": "string",
  "raw_text": "string",
  "photo_type": "screenshot | document | person | place | event | receipt | food | pet | other",
  "remembered_attributes": [
    "time period | people present | emotion/context | device | visual details | occasion"
  ],
  "forgotten_attributes": [
    "exact date | place name | album | search keywords"
  ],
  "search_strategy_used": "keyword search | manual scroll | search by person | search by location | gave up before trying",
  "failure_point": "no results | too many results | couldn't formulate query | wrong result surfaced | app limitation",
  "outcome": "found | found by accident | gave up",
  "emotional_stakes": "low | medium | high",
  "workaround_used": "none | third-party app | asked someone | manual scroll"
}
```

---

## 4. Directory Structure

```
project-root/
├── docs/
│   ├── problemstatement.txt      # Original problem statement
│   ├── context.md                # Processed project context
│   └── architecture.md           # This file
│
├── schema/
│   └── schema.json               # Single source of truth for extraction schema
│
├── agents/
│   ├── orchestrator.js            # Pipeline controller
│   ├── collectors/
│   │   ├── playstore.js
│   │   ├── appstore.js
│   │   ├── reddit.js
│   │   ├── helpcommunity.js
│   │   └── youtube.js
│   ├── filter.js                  # Scope-filtering agent
│   ├── extractor.js               # Structured extraction agent
│   └── clusterer.js               # Clustering / comparison agent
│
├── data/
│   ├── raw/                       # Stage 1 output
│   │   ├── playstore.json
│   │   ├── appstore.json
│   │   ├── reddit.json
│   │   ├── helpcommunity.json
│   │   └── youtube.json
│   ├── filtered/                  # Stage 2 output
│   │   ├── filtered.json
│   │   └── rejected.json
│   └── structured/                # Stage 3 output
│       ├── records.json
│       ├── errors.json
│       └── samples/               # 10-record QA samples per source
│           ├── sample_playstore.json
│           ├── sample_appstore.json
│           ├── sample_reddit.json
│           ├── sample_helpcommunity.json
│           └── sample_youtube.json
│
├── analysis/                      # Stage 4 output
│   ├── clusters.md
│   └── summary.md
│
├── server/                        # Backend API (Express)
│   └── index.js
│
├── client/                        # Frontend Dashboard (Vite + React)
│   ├── src/
│   └── index.html
│
├── config/
│   └── .env                       # API keys: GROQ_API_KEY, YOUTUBE_API_KEY, REDDIT_CLIENT_ID, etc.
│
├── package.json
└── README.md
```

---

## 5. Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Runtime** | Node.js 20+ | Native async/await, strong npm ecosystem for scrapers |
| **Backend API** | Express.js | Lightweight web framework to serve data to the frontend |
| **Frontend Framework** | React (via Vite) | Fast development experience and modern component architecture |
| **Frontend Styling** | Vanilla CSS | Clean, minimal dark theme optimized for utility |
| **Play Store scraping** | `google-play-scraper` | Well-maintained, no API key needed |
| **App Store scraping** | `app-store-scraper` | Companion to Play Store scraper |
| **Reddit scraping** | Puppeteer (headless Chromium) | Browser-based scraping of `old.reddit.com`; no API key required |
| **YouTube scraping** | Puppeteer (headless Chromium) | Browser-based comment scraping; video IDs from config file; no API key required |
| **Browser automation** | Headless Chromium via Puppeteer | Used for Reddit, YouTube, and Google Help Community collectors |
| **LLM (filtering & extraction)** | Groq (`llama-3.3-70b-versatile`) | Ultra-fast inference via Groq LPU; structured JSON output mode; temperature 0 for deterministic extraction |
| **Embeddings** | Groq (`llama-3.3-70b-versatile` for text → embedding extraction) or a dedicated embedding model via Groq | Groq's low-latency inference makes embedding generation fast; fallback to local `sentence-transformers` if embedding endpoint is unavailable |
| **Clustering** | Python (`scikit-learn`) or in-process JS (`ml-kmeans`) | Standard K-means / hierarchical clustering |
| **Schema validation** | `ajv` (npm) | Fast JSON Schema validation |
| **Configuration** | `dotenv` | Load API keys from `.env` |

---

## 6. Data Flow & Inter-Agent Communication

Agents communicate exclusively through the **filesystem**. There is no message queue or RPC layer — simplicity is prioritized given the batch-processing nature of the workload.

### Flow Protocol

1. Each agent reads from a known input path and writes to a known output path.
2. Each agent writes a `_meta.json` sidecar alongside its output:
   ```json
   {
     "agent": "collector-playstore",
     "started_at": "ISO 8601",
     "completed_at": "ISO 8601",
     "record_count": 847,
     "errors": [],
     "status": "success"
   }
   ```
3. The orchestrator checks for the presence and `status` field of each `_meta.json` before advancing to the next stage.
4. If a `_meta.json` reports `"status": "partial"`, the orchestrator may still proceed but logs a warning.

### Idempotency

- Collectors overwrite their output file on each run (idempotent).
- Filtering and extraction agents can be re-run safely; they overwrite outputs.
- The orchestrator tracks run state in `/data/_pipeline_state.json`.

---

## 7. Error Handling & Resilience

| Failure Mode | Handling Strategy |
|-------------|-------------------|
| API rate limit hit | Exponential backoff (1s → 2s → 4s → ... up to 60s), then pause and retry |
| API key invalid / quota exhausted | Log error, mark source as `"status": "failed"` in `_meta.json`, continue with remaining sources |
| Browser automation blocked (CAPTCHA) | Log the URL, skip the page, continue to next thread; report skipped count in `_meta.json` |
| LLM call fails (timeout, 5xx) | Retry up to 3 times with 5s backoff; on persistent failure, write unprocessed records to an error log |
| Malformed LLM output (invalid JSON) | Re-prompt once with stricter instructions; if still invalid, log to `errors.json` and skip record |
| Schema validation failure | Record logged to `/data/structured/errors.json` with the validation error details; not included in `records.json` |

---

## 8. Quality Assurance

### 8.1 Sample-Based Verification (Mandatory before Scale)

Before running the extraction agent at full scale, a **10-record sample per source** (50 records total) must be extracted and reviewed:

1. Orchestrator runs the extractor in `--sample` mode → outputs to `/data/structured/samples/`
2. A human reviewer (or a QA LLM pass) checks:
   - Are `remembered_attributes` and `forgotten_attributes` correctly identified?
   - Is `failure_point` accurately classified?
   - Does `emotional_stakes` align with the raw text?
3. If accuracy < 80% on any source, the extraction prompt is revised and re-sampled.

### 8.2 Cross-Source Consistency

After full extraction, run a consistency check:
- Distribution of `photo_type` across sources should be roughly similar (unless source-specific bias is expected).
- No field should be `null` for > 20% of records (indicates a prompt issue).

### 8.3 Cluster Sanity Check

- No single cluster should contain > 40% of all records (indicates under-clustering).
- No cluster should have < 3 records (indicates noise; merge into nearest neighbor).

---

## 9. Scaling Considerations

| Dimension | Current Target | Scaling Path |
|-----------|---------------|--------------|
| **Record volume** | 500–1,000 records | Increase pagination depth; add new sources (Twitter/X, Quora) |
| **LLM throughput** | Sequential batches | Parallel batch calls with rate-limit-aware concurrency pool (Groq supports high-throughput requests) |
| **Cost** | ~$0.50–2 for Groq Llama 3.3 70B extraction of 1,000 records | Groq's pricing is significantly lower than proprietary models; use `llama-3.1-8b-instant` for filtering (cheaper/faster) and `llama-3.3-70b-versatile` for extraction |
| **Storage** | Local filesystem | Cloud storage (GCS/S3) if pipeline runs in CI/CD |
| **Scheduling** | Manual one-shot run | Static dataset (no automated re-collection scheduled) |

---

## 10. Security & Compliance

- **API keys** (including `GROQ_API_KEY`) are stored in `/config/.env` and loaded via `dotenv`. The `.env` file is `.gitignore`'d.
- **No verbatim text reproduction** at scale in final deliverables — raw text is stored in intermediate data files but analysis outputs (clusters.md, summary.md) use **paraphrased quotes with source URLs**.
- **Platform ToS compliance**: All collectors respect published rate limits and use official APIs where available.
- **Data retention**: Raw data is treated as ephemeral research material. No PII extraction is performed; usernames are stripped from records during collection.
