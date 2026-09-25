# Implementation Plan — Incomplete-Memory Retrieval Discovery Engine

> Phase-wise plan derived from [architecture.md](file:///c:/Users/rparv/.antigravity-ide/Google%20photos%20review%20analysis/docs/architecture.md) and [context.md](file:///c:/Users/rparv/.antigravity-ide/Google%20photos%20review%20analysis/docs/context.md).

---

## Phase 0 — Project Scaffolding & Configuration

**Duration:** ~1 day
**Goal:** Repository structure, dependency installation, and credential setup.

### Tasks

| # | Task | Output |
|---|------|--------|
| 0.1 | Create the directory tree as defined in architecture §4 (`agents/`, `data/`, `schema/`, `config/`, `analysis/`) | Empty directory skeleton |
| 0.2 | Initialize Node.js project (`npm init`) and install core dependencies: `google-play-scraper`, `app-store-scraper`, `snoowrap`, `googleapis`, `puppeteer`, `groq-sdk`, `ajv`, `dotenv`, `ml-kmeans` | `package.json` + `node_modules/` |
| 0.3 | Create `/config/.env.example` with placeholder keys: `GROQ_API_KEY`, `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_REFRESH_TOKEN` | `.env.example` |
| 0.4 | Add `.gitignore` (ignore `node_modules/`, `config/.env`, `data/`) | `.gitignore` |
| 0.5 | Author `/schema/schema.json` — the single source of truth for structured extraction (fields: `photo_type`, `remembered_attributes`, `forgotten_attributes`, `search_strategy_used`, `failure_point`, `outcome`, `emotional_stakes`, `workaround_used`) | `schema.json` validated with AJV |
| 0.6 | Write a shared utilities module (`agents/utils.js`) — helpers for: reading/writing JSON, writing `_meta.json` sidecars, Groq API wrapper, rate-limit-aware fetch | `agents/utils.js` |

### Exit Criteria

- [ ] `npm install` succeeds without errors
- [ ] `schema.json` passes self-validation via AJV
- [ ] `.env` file populated with real API keys on the dev machine

---

## Phase 1 — Collection Agents (Stage 1)

**Duration:** ~3–4 days
**Goal:** Five independent collectors, each writing raw JSON to `/data/raw/`.

### 1A — Google Play Store Collector

| # | Task | Detail |
|---|------|--------|
| 1A.1 | Implement `agents/collectors/playstore.js` | Use `google-play-scraper.reviews()` with `appId: 'com.google.android.apps.photos'`, `sort: NEWEST`, filtered to 1–3 stars |
| 1A.2 | Pagination loop | Fetch up to 1,000 reviews in batches of 150 with 1s inter-batch delay |
| 1A.3 | Normalize output | Map each review to `{source: "playstore", date, rating, upvotes: null, raw_text, url}` |
| 1A.4 | Write `_meta.json` sidecar | Record count, timestamps, errors |
| 1A.5 | Test | Run collector, verify `/data/raw/playstore.json` contains well-formed records |

### 1B — Apple App Store Collector

| # | Task | Detail |
|---|------|--------|
| 1B.1 | Implement `agents/collectors/appstore.js` | Use `app-store-scraper.reviews()` with page-based pagination |
| 1B.2 | Normalize to same raw record schema | `{source: "appstore", …}` |
| 1B.3 | Write `_meta.json` | — |
| 1B.4 | Test | Verify `/data/raw/appstore.json` |

### 1C — Reddit Collector (Browser-Based)

| # | Task | Detail |
|---|------|--------|
| 1C.1 | Implement `agents/collectors/reddit.js` | Puppeteer-based headless browser automation targeting `old.reddit.com` (no API key required) |
| 1C.2 | Search across 3 subreddits | `r/googlephotos`, `r/GooglePixel`, `r/androidapps` via `old.reddit.com/r/{sub}/search` |
| 1C.3 | Query set | `"can't find old photo"`, `"lost photo"`, `"remember picture"`, `"search photos"`, `"can't find photo"`, `"missing photo"` |
| 1C.4 | Extract per post | Navigate into each post page; extract title, selftext, top 5 comments, score, date, permalink |
| 1C.5 | Rate limiting | 3–5s delay between page loads; skip and log any CAPTCHA/blocked pages (never bypass) |
| 1C.6 | Incremental write | Write to `/data/raw/reddit.json` every 10 posts; write `_meta.json` on completion |
| 1C.7 | Run log | Write `/data/raw/reddit_run_log.json` tracking pages visited, blocked, and errored |
| 1C.8 | Test | Verify record count, schema conformance, and run log accuracy |

### 1D — Google Photos Help Community Collector

| # | Task | Detail |
|---|------|--------|
| 1D.1 | Implement `agents/collectors/helpcommunity.js` | Puppeteer-based headless browser automation |
| 1D.2 | Navigation strategy | Search `support.google.com/photos/community` for relevant terms → paginate results → open each thread → extract question + reply text |
| 1D.3 | Anti-bot measures | Realistic user-agent string, 2–3s delay between page loads |
| 1D.4 | CAPTCHA handling | Log blocked URLs, skip, report skipped count in `_meta.json` |
| 1D.5 | Normalize & write | `/data/raw/helpcommunity.json` + `_meta.json` |
| 1D.6 | Test | Verify output; expect lower yield due to scraping constraints |

### 1E — YouTube Collector (Browser-Based)

| # | Task | Detail |
|---|------|--------|
| 1E.1 | Implement `agents/collectors/youtube.js` | Puppeteer-based headless browser automation (no API key required) |
| 1E.2 | Video ID source | Read video IDs from `/config/youtube_video_ids.json` (curated list of Google Photos tutorial/review videos) |
| 1E.3 | Comment loading | Navigate to each video URL, scroll to lazy-load comments (cap ~200 comments per video) |
| 1E.4 | Comment extraction | Extract comment text, like count, date, video URL |
| 1E.5 | CAPTCHA handling | Skip and log any blocked/unavailable videos (never bypass) |
| 1E.6 | Incremental write | Write to `/data/raw/youtube.json` after each video; write `_meta.json` on completion |
| 1E.7 | Run log | Write `/data/raw/youtube_run_log.json` tracking videos visited, blocked, and errored |
| 1E.8 | Test | Verify records and run log |

### Phase 1 Exit Criteria

- [ ] All 5 collectors run independently and produce valid raw JSON
- [ ] Each `_meta.json` shows `"status": "success"` or `"partial"` with documented errors
- [ ] Combined raw record count ≥ 500

---

## Phase 2 — Orchestrator (Parallel Execution)

**Duration:** ~1 day
**Goal:** A single entry point that runs all collectors in parallel and sequences the remaining stages.

| # | Task | Detail |
|---|------|--------|
| 2.1 | Implement `agents/orchestrator.js` | Top-level async controller |
| 2.2 | Parallel Stage 1 | `Promise.allSettled()` to launch all 5 collectors concurrently |
| 2.3 | Meta-check gate | After Stage 1, read each `_meta.json`; log warnings for `"partial"`, halt on all-failed |
| 2.4 | Sequential Stage 2→3→4 | Chain filter → extract → cluster in sequence |
| 2.5 | Pipeline state tracking | Write `/data/_pipeline_state.json` with start/end times and per-stage status |
| 2.6 | Retry logic | Up to 3 retries per collector with exponential backoff (1s→2s→4s) |
| 2.7 | CLI interface | Accept flags: `--stage <n>` (resume from specific stage), `--sample` (run extraction in sample mode only) |

### Phase 2 Exit Criteria

- [ ] `node agents/orchestrator.js` runs the full pipeline end-to-end
- [ ] `--stage 2` skips collection and starts from filtering
- [ ] `_pipeline_state.json` accurately reflects run status

---

## Phase 3 — Filtering Agent (Stage 2)

**Duration:** ~2 days
**Goal:** Scope-filter raw records down to only incomplete-memory retrieval failures.

| # | Task | Detail |
|---|------|--------|
| 3.1 | Implement `agents/filter.js` | Read all `/data/raw/*.json`, merge into a single array |
| 3.2 | Groq prompt design | System prompt encodes the 3-part scope criteria; user prompt contains a batch of 20 raw texts |
| 3.3 | Structured response format | Groq returns JSON: `[{index, is_in_scope: boolean, scope_reasoning: string}, …]` |
| 3.4 | Batch processing loop | Process records in batches of 20; 1s delay between Groq calls |
| 3.5 | Error handling | Retry failed batches up to 3 times; log persistently failed records |
| 3.6 | Write outputs | `/data/filtered/filtered.json` (in-scope only) and `/data/filtered/rejected.json` (for audit) |
| 3.7 | Write `_meta.json` | Total processed, accepted count, rejected count, error count |

### Prompt Engineering Checkpoints

| Check | Criteria |
|-------|----------|
| Precision | ≤ 5% false positives in a 50-record manual review |
| Recall | ≤ 10% false negatives (scope-matching records incorrectly rejected) |
| Edge cases | Ambiguous records (e.g., "search is broken" without memory-retrieval context) correctly rejected |

### Phase 3 Exit Criteria

- [ ] `filtered.json` contains only in-scope records
- [ ] Manual spot-check of 30 accepted + 30 rejected records confirms accuracy ≥ 90%
- [ ] `rejected.json` exists for debugging

---

## Phase 4 — Structured Extraction Agent (Stage 3)

**Duration:** ~3 days
**Goal:** Extract structured fields from each filtered record per `schema.json`.

### 4A — Sample-Mode Extraction (Quality Gate)

| # | Task | Detail |
|---|------|--------|
| 4A.1 | Implement `agents/extractor.js` with `--sample` flag | When `--sample`, pick 10 random records per source (50 total) |
| 4A.2 | Groq prompt design | System prompt includes full `schema.json`; user prompt contains 5 raw texts per call. **For `query_formulation`:** instruct the model to infer `style` only from explicit search-behavior described in `raw_text`; do not infer a search attempt if the record only describes the memory or frustration, not an action taken. `example_query_paraphrased` must be ≤ 12 words, paraphrased in the model's own words, never verbatim from source. |
| 4A.3 | Response parsing | Parse Groq JSON response; validate each record (including `query_formulation`) against `schema.json` using AJV |
| 4A.4 | Write samples | `/data/structured/samples/sample_{source}.json` |
| 4A.5 | Human review | Manually verify all 50 sample records |

### Quality Review Checklist (per sample record)

- [ ] `remembered_attributes` correctly captures what the user recalls
- [ ] `forgotten_attributes` correctly captures the gap
- [ ] `failure_point` matches the described experience
- [ ] `emotional_stakes` aligns with the tone and content
- [ ] `photo_type` is accurate
- [ ] `query_formulation.style` matches an actual search action described in `raw_text`, not inferred from tone
- [ ] `query_formulation.example_query_paraphrased` is a paraphrase, never verbatim text from source
- [ ] `query_formulation.query_matched_forgotten_gap` is `null` (not guessed) when no search action is described
- [ ] No fields are systematically `null`

> **Decision gate:** If accuracy < 80% on any source, revise the extraction prompt and re-run samples before proceeding.

### 4B — Full-Scale Extraction

| # | Task | Detail |
|---|------|--------|
| 4B.1 | Run extractor without `--sample` flag | Process all records in `/data/filtered/filtered.json` |
| 4B.2 | Batch size | 5 records per Groq call |
| 4B.3 | Validation | Every record validated via AJV (including `query_formulation`); invalid records → `/data/structured/errors.json` |
| 4B.4 | Deduplication | Flag near-duplicate records (same `raw_text` from overlapping sources) |
| 4B.5 | Write output | `/data/structured/records.json` + `_meta.json` |

### Phase 4 Exit Criteria

- [ ] `records.json` contains 500–1,000+ valid, schema-conformant records
- [ ] `errors.json` contains < 5% of total records
- [ ] No field is `null` for > 20% of records
- [ ] Sample quality review passed with ≥ 80% accuracy
- [ ] `query_formulation.style` is `"not_mentioned"` for no more than the expected share of records (i.e. not systematically null — validate this isn't near 100%, which would signal a prompt failure)

---

## Phase 5 — Clustering & Analysis Agent (Stage 4)

**Duration:** ~2–3 days
**Goal:** Group structured records into opportunity clusters and produce the final PM-facing deliverables.

### 5A — Embedding & Clustering

| # | Task | Detail |
|---|------|--------|
| 5A.1 | Implement `agents/clusterer.js` | Read `/data/structured/records.json` |
| 5A.2 | Feature construction | Concatenate `remembered_attributes` + `failure_point` into a feature string per record |
| 5A.3 | Embedding generation | Use Groq to generate text representations; convert to vectors via local `sentence-transformers` or Groq embedding endpoint |
| 5A.4 | Deduplication | Merge near-duplicate records (cosine similarity > 0.95) |
| 5A.5 | Clustering | K-means or hierarchical clustering; target 8–15 clusters (experiment with k values using silhouette score) |
| 5A.6 | Cluster labeling | Use Groq to generate a human-readable label for each cluster based on its centroid records |

### 5B — Ranking & Scoring

| # | Task | Detail |
|---|------|--------|
| 5B.1 | Frequency score | Record count per cluster |
| 5B.2 | Emotional stakes score | Average `emotional_stakes` (low=1, medium=2, high=3) per cluster |
| 5B.3 | Abandonment rate | Proportion of `outcome === "gave_up"` per cluster |
| 5B.4 | Composite opportunity score | Weighted combination: `0.4 × frequency_norm + 0.3 × emotional_norm + 0.3 × abandonment_norm` |
| 5B.5 | Rank clusters | Sort by composite score descending |

### 5C — Deliverable Generation

| # | Task | Detail |
|---|------|--------|
| 5C.1 | Generate `/analysis/clusters.md` | Ranked table: cluster label, size, top remembered/forgotten patterns, representative quotes (paraphrased with source URLs), composite score |
| 5C.2 | Generate `/analysis/summary.md` | Narrative for top 3–5 clusters: what the retrieval gap is, why current search fails, evidence strength, confidence level, and suggested product direction |
| 5C.3 | Use Groq for narrative generation | System prompt: "Write as a senior PM analyst"; temperature 0.3 for coherent but slightly creative prose |

### Cluster Sanity Checks

| Check | Threshold | Action if Failed |
|-------|-----------|-----------------|
| Largest cluster too dominant | > 40% of records | Increase k, re-cluster |
| Cluster too small | < 3 records | Merge into nearest neighbor |
| Duplicate clusters | Two clusters with > 80% content overlap | Merge and relabel |

### Phase 5 Exit Criteria

- [ ] `clusters.md` contains 8–15 ranked opportunity clusters
- [ ] `summary.md` contains a PM-ready narrative for top 3–5 opportunities
- [ ] No cluster violates the sanity checks above
- [ ] All quotes are paraphrased with source URLs (no verbatim reproduction)

---

## Phase 6 — Backend API (Data Serving)

**Duration:** ~1 day
**Goal:** Serve the pipeline output data via a lightweight Express API.

| # | Task | Detail |
|---|------|--------|
| 6.1 | Initialize Backend | Set up Express.js server in `server/` |
| 6.2 | `/api/status` | Expose pipeline status from `_meta.json` files |
| 6.3 | `/api/clusters` | Parse and serve `clusters.md` and `summary.md` |
| 6.4 | `/api/records` | Serve `records.json` with filtering and pagination |
| 6.5 | Unified Deployment | Serve built static frontend (`../client/dist`) for Railway deploy |

### Phase 6 Exit Criteria

- [ ] Backend serves all endpoints correctly
- [ ] Endpoints validate and parse JSON/Markdown successfully

---

## Phase 7 — Minimal Frontend Dashboard

**Duration:** ~2–3 days
**Goal:** Build a functional, clean web interface for PMs to explore the insights (optimized for unified deployment).

| # | Task | Detail |
|---|------|--------|
| 7.1 | Scaffold Frontend | Initialize Vite + React project in `client/` |
| 7.2 | Design System | Setup Vanilla CSS variables for a minimal, clean dark theme (no heavy effects) |
| 7.3 | Executive Summary | Dashboard view for narrative and top-level metrics |
| 7.4 | Opportunity Clusters | Interactive cards for clusters |
| 7.5 | Data Explorer | Rich table for exploring raw and extracted records |

### Phase 7 Exit Criteria

- [ ] Frontend successfully consumes backend APIs
- [ ] Minimal, clean aesthetic is implemented and suitable for production

---

## Phase 8 — Integration Testing & Polish

**Duration:** ~1–2 days
**Goal:** Full end-to-end pipeline validation and documentation.

| # | Task | Detail |
|---|------|--------|
| 8.1 | Full pipeline run | `node agents/orchestrator.js` from scratch — all 5 stages |
| 8.2 | Verify all deliverables exist | `/data/raw/*.json`, `/data/filtered/filtered.json`, `/data/structured/records.json`, `/analysis/clusters.md`, `/analysis/summary.md` |
| 8.3 | Cross-source consistency check | Verify `photo_type` distribution across sources is reasonable |
| 8.4 | Field completeness audit | No field `null` for > 20% of records |
| 8.5 | Pipeline state verification | `_pipeline_state.json` shows all stages as `"success"` |
| 8.6 | Write `README.md` | Setup instructions, environment variables, how to run, expected outputs |
| 8.7 | Error scenario testing | Test with: invalid API key, rate-limited source, malformed LLM response |

### Phase 8 Exit Criteria

- [ ] Pipeline completes end-to-end in a single invocation
- [ ] All deliverables are present and well-formed
- [ ] README enables a new developer to set up and run the pipeline
- [ ] Error scenarios gracefully degrade without crashing

---

## Phase 9 — Interactive Ask AI Chat (Add-on)

**Duration:** ~1 day
**Goal:** Provide an interactive, natural-language interface for PMs to query the dataset using a Groq LLM.

| # | Task | Detail |
|---|------|--------|
| 9.1 | Backend Endpoint | Implement `/api/chat` in Express to accept conversation history |
| 9.2 | Context Injection | Load `records.json` and `clusters.md` as context into the LLM system prompt |
| 9.3 | Token Limit Safety | Truncate conversation history and sample `records.json` to avoid hitting TPM (Tokens Per Minute) limits |
| 9.4 | Frontend Integration | Build `Chat.jsx` component in React to interface with the backend |

### Phase 9 Exit Criteria

- [ ] Users can chat naturally with the AI about the generated data
- [ ] Backend safely proxies requests to Groq without exposing the API key on the client side
- [ ] The app handles token limits gracefully

---

## Timeline Summary

| Phase | Description | Duration | Dependency |
|-------|-------------|----------|------------|
| **0** | Scaffolding & config | 1 day | — |
| **1** | Collection agents (5 collectors) | 3–4 days | Phase 0 |
| **2** | Orchestrator | 1 day | Phase 1 |
| **3** | Filtering agent | 2 days | Phase 2 |
| **4** | Extraction agent + quality gate | 3 days | Phase 3 |
| **5** | Clustering & analysis | 2–3 days | Phase 4 |
| **6** | Backend API (Data Serving) | 1 day | Phase 5 |
| **7** | Minimal Frontend Dashboard | 2–3 days | Phase 6 |
| **8** | Integration testing & polish | 1–2 days | Phase 7 |
| **9** | Interactive Ask AI Chat | 1 day | Phase 6, 7 |
| | **Total** | **~17–22 days** | |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Groq API rate limits throttle extraction | Medium | Medium | Implement exponential backoff; batch sizes tuned to stay within limits |
| Google Help Community blocks scraping | High | Low | This is one of 5 sources; mark as `"partial"` and proceed with remaining 4 |
| YouTube API quota exhausted mid-collection | Medium | Low | Track quota in real-time; prioritize high-value videos first |
| Reddit API credentials rejected | Low | Medium | Fallback to `.json` endpoint (no auth required, lower limits) |
| LLM extraction accuracy < 80% | Medium | High | Iterative prompt engineering on 10-record samples; switch to `llama-3.3-70b-versatile` for complex cases |
| Raw record count < 500 | Medium | Medium | Expand search queries; add pagination depth; consider additional sources (Twitter/X, Quora) |
| Schema drift between sources | Low | High | Single `schema.json` enforced by AJV at extraction time; validation errors logged |

---

## Dependency Matrix

```
Phase 0  ──►  Phase 1  ──►  Phase 2  ──►  Phase 3  ──►  Phase 4  ──►  Phase 5  ──►  Phase 6  ──►  Phase 7  ──►  Phase 8
  │              │
  │              ├── 1A (Play Store)   ─┐
  │              ├── 1B (App Store)    ─┤
  │              ├── 1C (Reddit)       ─┼──► Phase 2 (Orchestrator)
  │              ├── 1D (Help Community)┤
  │              └── 1E (YouTube)      ─┘
  │
  └── schema.json (used by Phase 4)
```

> **Key insight:** All 5 collectors in Phase 1 are independent and can be developed and tested in parallel. Phases 3–5 are strictly sequential because each consumes the previous stage's output.
