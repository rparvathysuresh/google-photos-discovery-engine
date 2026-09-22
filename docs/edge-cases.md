# Edge Cases & Corner Scenarios

> Comprehensive catalog of edge cases across every pipeline stage. Each entry includes the scenario, why it's problematic, and the recommended handling strategy.

---

## 1. Collection Stage Edge Cases

### 1.1 Data Availability & Access

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| C-01 | **Google Play Store returns 0 reviews** for the filtered criteria (1–3 stars) | No raw data from this source | Log warning in `_meta.json`; pipeline continues with remaining sources. Do not fail the entire run. |
| C-02 | **App Store scraper returns reviews in a non-English language** | Filtering and extraction prompts are English-tuned; non-English text will produce garbage extractions | Detect language using a heuristic (character set / Groq classification). Either discard non-English records or add a translation step before filtering. |
| C-03 | **Reddit post has been deleted or removed by moderators** | `.json` endpoint returns `[removed]` or `[deleted]` as selftext | Check for placeholder text (`[removed]`, `[deleted]`, `""`) and discard these records during normalization. |
| C-04 | **Reddit search returns the same post across multiple subreddits** (crosspost) | Duplicate records inflate counts | Deduplicate by canonical Reddit permalink (`reddit.com/r/{sub}/comments/{id}`) during collection. |
| C-05 | **YouTube video has comments disabled** | `commentThreads.list` returns 0 results or a `commentsDisabled` error | Catch the error, skip the video, log the `videoId` in `_meta.json`, move to next video. |
| C-06 | **YouTube API quota exhausted mid-collection** | Collection stops partway through the video list | Track quota consumption in real-time. Prioritize videos with higher view counts. Write partial results with `"status": "partial"` in `_meta.json`. |
| C-07 | **Google Help Community page structure changes** (DOM update) | Puppeteer selectors break; extraction returns empty or garbled text | Use resilient selectors (data attributes > CSS classes). Log extraction failures per page. Alert if > 50% of pages fail. |
| C-08 | **Google Help Community presents a CAPTCHA or cookie consent wall** | Browser automation blocked | Log the URL, skip, continue. Report skipped count. Consider rotating user-agent strings or adding manual cookie injection. |
| C-09 | **A single Play Store / App Store review is extremely long** (> 5,000 chars) | May exceed Groq context window when batched with other records | Truncate individual reviews to 2,000 characters at collection time. Log truncation in record metadata. |
| C-10 | **Timestamp formats differ across sources** | Reddit uses epoch seconds, Play Store uses ISO strings, YouTube uses RFC 3339 | Normalize all dates to ISO 8601 (`YYYY-MM-DDTHH:mm:ssZ`) during the collection normalization step. |

### 1.2 Rate Limiting & Network

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| C-11 | **HTTP 429 (Too Many Requests) from any source** | Temporary block | Exponential backoff: 1s → 2s → 4s → 8s → … up to 60s. Max 5 retries per request. |
| C-12 | **Network timeout / DNS failure** | Transient connectivity loss | Retry up to 3 times with 5s delay. If persistent, mark source as failed and continue. |
| C-13 | **Reddit OAuth token expires mid-collection** | Subsequent requests return 401 | Implement automatic token refresh via `snoowrap`'s built-in refresh logic. If refresh fails, fall back to unauthenticated `.json` endpoints. |
| C-14 | **SSL certificate error on `support.google.com`** | Puppeteer connection refused | Do NOT set `--ignore-certificate-errors`. Log and skip source. |

---

## 2. Filtering Stage Edge Cases

### 2.1 Scope Boundary Ambiguity

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| F-01 | **Record mentions "can't find my photo" but the root cause is accidental deletion, not memory failure** | Falls outside scope (not a retrieval-from-memory problem) but contains trigger keywords | Filtering prompt must explicitly distinguish: "photo exists but user can't describe it" vs. "photo was deleted/lost/corrupted." Include negative examples in the prompt. |
| F-02 | **Record describes BOTH a general bug AND a memory-retrieval failure** | Partially in scope | Accept the record (in-scope signal is present). The extraction agent will focus on the retrieval aspect. |
| F-03 | **Record is sarcastic or ironic** — e.g., "Great job Google, I definitely found my photo... NOT" | LLM may misinterpret sentiment and classify as "found" | Include sarcasm/irony examples in the filtering prompt. Instruct the LLM to interpret intent, not literal text. |
| F-04 | **Record is a feature request, not a failure report** — e.g., "I wish Google Photos could search by color" | Not a retrieval failure; it's aspirational | Reject. The prompt must distinguish between "I tried and failed" (in-scope) vs. "I wish it could do X" (out-of-scope), unless the request clearly stems from a retrieval failure experience. |
| F-05 | **Record describes a third-party app solving the problem** — e.g., "I couldn't find it in Google Photos but found it using [other app]" | In scope? The user DID experience a retrieval failure in Google Photos | Accept. The workaround is a valid data point (`workaround_used: "third-party app"`). |
| F-06 | **Record is in a language other than English** (survived collection) | Groq may hallucinate extraction fields | Reject during filtering with `scope_reasoning: "non-English text"`. Alternatively, translate first if multilingual coverage is desired. |
| F-07 | **Record is extremely short** — e.g., "search sucks" (2 words) | Not enough signal to determine if it's a memory-retrieval failure | Reject. Set a minimum text length threshold (e.g., > 20 characters) as a pre-filter before sending to Groq. |
| F-08 | **Record is extremely long** — e.g., a 3,000-word Reddit post with multiple topics | The retrieval failure may be buried in paragraph 12 | Accept if any part matches scope. The extraction agent must locate the relevant segment within the text. |

### 2.2 LLM Classification Failures

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| F-09 | **Groq returns a malformed JSON response for a batch** | Entire batch of 20 records is unprocessable | Re-prompt with stricter JSON instructions. If still malformed after 1 retry, split the batch in half and retry each half. Last resort: process records individually. |
| F-10 | **Groq returns `is_in_scope: true` for every record in a batch** | Likely a prompt issue (too permissive) | Log the anomaly. If > 90% acceptance rate across all batches, flag for prompt review. Expected acceptance rate: 10–30%. |
| F-11 | **Groq returns `is_in_scope: false` for every record in a batch** | Likely a prompt issue (too restrictive) or a genuinely off-topic batch | Log. If overall rejection rate > 95%, flag for prompt review. |
| F-12 | **Groq classifies the same record differently across retries** | Non-deterministic output despite temperature 0 | Use `temperature: 0` and `seed` parameter (if supported). Accept the first successful classification. |

---

## 3. Extraction Stage Edge Cases

### 3.1 Schema Field Ambiguity

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| E-01 | **User describes multiple photos in one review** — e.g., "I can't find my wedding photos OR my vacation pics" | One record, multiple retrieval failures with different attributes | Extract the **primary** (most detailed) failure. If both are equally detailed, create two structured records from one raw record, each with a unique `id` suffix (`-a`, `-b`). |
| E-02 | **`photo_type` is ambiguous** — e.g., "a picture of the receipt from my birthday dinner" | Is it `receipt`, `event`, or `food`? | Pick the **most specific** type. Hierarchy: if the user explicitly calls it a receipt, use `receipt`. If context is about the event, use `event`. Document this priority in the prompt. |
| E-03 | **User doesn't mention any search strategy** — "I just can't find it" | `search_strategy_used` has no evidence | Set to `"gave up before trying"` if no strategy is described. Do NOT hallucinate a strategy. |
| E-04 | **User mentions a strategy not in the schema enum** — e.g., "I asked Google Assistant to find it" | Value doesn't fit the predefined set | Map to the closest match. "Asked Google Assistant" → `"keyword search"` (voice-initiated). Add a `notes` field if needed, or extend the enum. |
| E-05 | **`emotional_stakes` is unclear** — "I need to find that photo" | No explicit mention of loss, health, nostalgia, or milestones | Default to `"medium"`. Only use `"high"` when explicit emotional context is present. Only use `"low"` when the user is clearly casual (e.g., "trying to find a meme I saved"). |
| E-06 | **`remembered_attributes` is empty** — user says "I know it's in there somewhere" but gives no detail | The user has incomplete memory but can't articulate what they remember | Set `remembered_attributes: []` and `forgotten_attributes: ["exact date", "place name", "album", "search keywords"]`. This IS the data — it represents the extreme end of memory failure. |
| E-07 | **`outcome` is ambiguous** — "I eventually found something similar but I'm not sure it's the right one" | Not clearly `found` or `gave_up` | Use `"found by accident"` as the closest match. The uncertainty itself is signal. |
| E-08 | **Record mentions a workaround that isn't in the enum** — e.g., "I searched my Google Drive instead" | `workaround_used` doesn't cover this | Map to `"third-party app"` (Google Drive being a different product) or extend the enum. Document the mapping decision. |

### 3.2 Extraction Quality

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| E-09 | **Groq hallucinates attributes not present in the raw text** | Fabricated data corrupts the dataset | Instruct the prompt: "Extract ONLY information explicitly stated in the text. If a field cannot be determined, use the default value." Validate during the 10-record sample review. |
| E-10 | **AJV validation rejects a record due to an unexpected enum value** | Groq generated a value like `"scenic photo"` instead of `"place"` | Log to `errors.json`. Optionally re-prompt for that specific record with stricter enum instructions. |
| E-11 | **Batch contains a mix of very short and very long records** | Short records may "contaminate" the LLM's attention, causing it to under-extract from long records | Consider sorting by length and batching similar-length records together. |
| E-12 | **Schema changes mid-project** (e.g., new `photo_type` value added) | Previously extracted records don't conform to the updated schema | All records must be re-extracted after schema changes. Version `schema.json` and track which version each record was extracted against. |

---

## 4. Clustering Stage Edge Cases

### 4.1 Clustering Quality

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| CL-01 | **All records cluster into 1–2 mega-clusters** | Under-clustering; no useful differentiation | Increase k (number of clusters). If still collapsing, the feature string (`remembered_attributes + failure_point`) may be too homogeneous — consider adding `photo_type` or `search_strategy_used` to the feature vector. |
| CL-02 | **Clusters are too granular** (30+ clusters with 2–5 records each) | Over-clustering; too noisy for PM consumption | Decrease k. Apply a minimum cluster size threshold (≥ 3 records) and merge small clusters into the nearest neighbor. |
| CL-03 | **Two clusters are semantically identical but separated due to wording differences** | "Couldn't find holiday photos" and "can't locate vacation pictures" end up in different clusters | Use embedding similarity (cosine > 0.80) between cluster centroids to detect and merge near-duplicate clusters. |
| CL-04 | **A single source dominates a cluster** — e.g., a cluster is 95% Reddit posts | Source bias may skew the cluster's perceived importance | Report source distribution per cluster. Consider weighting records inversely by source frequency to prevent any single source from dominating. |
| CL-05 | **Embedding model produces identical vectors for very different texts** | Clustering becomes meaningless for those records | Check for zero-variance embeddings. If detected, fall back to TF-IDF vectorization for those records. |

### 4.2 Scoring & Ranking

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| CL-06 | **All clusters have roughly equal composite scores** | No clear prioritization for the PM | Report the flat distribution transparently. Consider introducing additional ranking dimensions (e.g., recency, source diversity). |
| CL-07 | **A high-emotional-stakes cluster has very few records** (e.g., 5 records about health photos) | Small sample but high impact — risky to rank highly | Report with a **low confidence** flag. Recommend further targeted data collection for this cluster before acting on it. |
| CL-08 | **Composite score is dominated by one dimension** (e.g., one cluster is huge but emotionally low-stakes) | The scoring formula may over-weight frequency | Normalize each dimension to [0, 1] independently before combining. Expose individual dimension scores alongside the composite score in `clusters.md`. |

---

## 5. Cross-Cutting Edge Cases

### 5.1 Data Integrity

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| X-01 | **Same user posts the same complaint on Reddit AND the Google Help Community** | Duplicate record from different sources, inflating cluster counts | Deduplicate by fuzzy text match (e.g., Jaccard similarity > 0.85 on tokenized text) during the extraction or clustering stage. |
| X-02 | **A record's URL is dead by the time the report is generated** | The PM can't verify the source | Archive URLs at collection time (e.g., `web.archive.org` snapshot or local raw text cache). Include a note that URLs may expire. |
| X-03 | **Raw text contains personally identifiable information (PII)** — real names, email addresses, phone numbers | Privacy risk in stored data and generated reports | Strip PII during collection normalization: regex for emails, phone numbers. For names, rely on the paraphrasing requirement in `summary.md` (no verbatim quotes). |
| X-04 | **Total raw record count is far below 500** | Insufficient data for meaningful clustering | Expand search queries, increase pagination depth, add new sources (Twitter/X, Quora, HackerNews). If still below 200, report findings as qualitative, not quantitative. |
| X-05 | **Total raw record count exceeds 10,000** | LLM processing cost and time explodes | Apply stratified sampling: cap at 2,000 records per source. Alternatively, use a cheaper/faster model (`llama-3.1-8b-instant`) for filtering and reserve `llama-3.3-70b-versatile` for extraction. |

### 5.2 Pipeline & System

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| X-06 | **Pipeline crashes mid-extraction** (e.g., machine shuts down) | Partial `records.json` with some records extracted and some not | The orchestrator's `_pipeline_state.json` tracks the last successful batch. On restart with `--stage 3`, the extractor reads the state and resumes from the last checkpoint. |
| X-07 | **Groq API is completely down for an extended period** | All LLM-dependent stages (2, 3, 4 labeling) are blocked | Queue requests with a circuit-breaker pattern. After 5 consecutive failures in 10 minutes, pause for 30 minutes and retry. Provide a manual override to skip LLM stages and output raw data only. |
| X-08 | **`schema.json` file is missing or corrupted** | Extraction agent cannot determine what to extract | Validate `schema.json` at orchestrator startup (Phase 0 exit criterion). If missing, abort pipeline immediately with a clear error. |
| X-09 | **Disk space exhausted during collection** | Partial writes, corrupted JSON files | Monitor available disk space before each write. Set a minimum threshold (e.g., 100 MB). Alert and pause collection if below threshold. |
| X-10 | **Two pipeline runs execute concurrently** | File overwrites, data corruption | Use a lockfile (`/data/.pipeline.lock`). Orchestrator checks for lock at startup; if locked, refuse to start and warn the user. |

### 5.3 Output & Reporting

| ID | Scenario | Problem | Handling |
|----|----------|---------|----------|
| X-11 | **Groq generates a summary that inadvertently reproduces a review verbatim** | Violates the "no verbatim reproduction" constraint | Post-process `summary.md` and `clusters.md`: compare every quoted segment against raw texts using substring match. Flag any match > 20 consecutive words for manual paraphrasing. |
| X-12 | **Generated `clusters.md` contains a cluster labeled vaguely** — e.g., "Miscellaneous" | PM can't act on a vaguely labeled cluster | Force the labeling prompt to produce labels with the format: `"[Photo Type] + [Failure Pattern]"` — e.g., "Person Photos — Can't Formulate Query for Face." |
| X-13 | **`summary.md` recommendations are generic** — e.g., "improve search" | Not actionable for a PM | The summary prompt must require: (1) a specific failure pattern, (2) what the user tried, (3) why it failed, and (4) a concrete product suggestion. Reject and re-prompt if any element is missing. |

---

## 6. Edge Case Quick Reference by Stage

```
COLLECTION  ──► C-01 to C-14  (14 cases)
FILTERING   ──► F-01 to F-12  (12 cases)
EXTRACTION  ──► E-01 to E-12  (12 cases)
CLUSTERING  ──► CL-01 to CL-08 (8 cases)
CROSS-CUT   ──► X-01 to X-13  (13 cases)
                               ─────────
                         TOTAL: 59 edge cases
```

---

## 7. Priority Matrix

| Priority | IDs | Rationale |
|----------|-----|-----------|
| **P0 — Must handle before any run** | C-10, F-07, F-09, E-09, X-08, X-10 | Data corruption, pipeline crashes, or hallucinated data if not handled |
| **P1 — Must handle before production run** | C-01, C-03, C-05, C-09, F-01, F-04, E-01, E-06, E-10, X-01, X-03, X-06, X-11 | Scope integrity, deduplication, PII, and pipeline resilience |
| **P2 — Should handle for quality** | C-02, C-04, C-06, F-02, F-03, F-05, E-02, E-03, E-05, E-07, CL-01, CL-02, CL-03, CL-04, CL-06, X-04, X-05, X-12, X-13 | Improves extraction accuracy and cluster usefulness |
| **P3 — Nice to have** | C-07, C-08, C-11, C-12, C-13, C-14, F-06, F-08, F-10, F-11, F-12, E-04, E-08, E-11, E-12, CL-05, CL-07, CL-08, X-02, X-07, X-09 | Handles rare scenarios or adds robustness for edge-of-edge cases |
