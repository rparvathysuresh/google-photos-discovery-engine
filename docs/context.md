# Project Context: Google Photos — Incomplete-Memory Retrieval Discovery Engine

## Goal

Build a multi-agent research pipeline that discovers, structures, and compares
the reasons users fail to retrieve a photo they remember but cannot precisely
describe in Google Photos. The output is not a sentiment summary — it is a
structured, queryable dataset of retrieval attempts that lets a PM identify
and rank distinct opportunity areas backed by real user evidence.

## Scope

Do **NOT** analyze general search complaints (slowness, bugs, UI). **ONLY** analyze
cases where the user:

1. Knows a photo/video exists
2. Cannot recall enough specific detail (date, location, album, exact words) to search for it directly
3. Either failed, struggled, or found a workaround

## Pipeline

### 1. Collection Agents (run in parallel, one per source)

| Source | Method | Notes |
|--------|--------|-------|
| **Google Play Store** | `google-play-scraper` | Reviews for "Google Photos" (1–3 star + "most relevant") |
| **Apple App Store** | `app-store-scraper` | Reviews for Google Photos |
| **Reddit** | Reddit API | Subreddits: `r/googlephotos`, `r/GooglePixel`, `r/androidapps` — search terms like "can't find old photo", "remember picture", "lost photo", "search photos" |
| **Google Photos Help Community** | Browser subagent | Navigate `support.google.com` and extract thread text |
| **YouTube** | YouTube Data API | Comments on Google Photos tutorial/review videos |

**Output:** Raw JSON records `{source, date, rating/upvotes, raw_text, url}`

### 2. Filtering Agent

From the raw pool, keep **only** records matching the Scope above (incomplete-memory retrieval failure). Discard general bugs/UI complaints.

### 3. Structured Extraction Agent

For each kept record, extract the following fields:

| Field | Values |
|-------|--------|
| `photo_type` | screenshot, document, person, place, event, receipt, food, pet, other |
| `remembered_attributes` | List: time period, people present, emotion/context, device, visual details, occasion |
| `forgotten_attributes` | List: exact date, place name, album, search keywords |
| `search_strategy_used` | keyword search, manual scroll, search by person, search by location, gave up before trying |
| `failure_point` | no results, too many results, couldn't formulate query, wrong result surfaced, app limitation |
| `outcome` | found, found by accident, gave up |
| `emotional_stakes` | low / medium / high — flag cases involving loss, health, nostalgia, or milestones |
| `workaround_used` | none, third-party app, asked someone, manual scroll |

Save as a single `schema.json` used consistently by every extraction pass.

### 4. Clustering / Comparison Agent

- Embed and group records by `(remembered_attributes + failure_point)` combinations.
- Produce a **ranked table of opportunity clusters** by:
  - Frequency
  - Emotional stakes
  - Whether existing keyword search already solves it (it shouldn't, by Scope)

## Deliverables

| Path | Description |
|------|-------------|
| `/data/raw/*.json` | Raw data per source |
| `/data/structured/records.json` | Schema-conformant records (~500–1000+ target) |
| `/analysis/clusters.md` | Ranked opportunity areas with supporting quote references (URLs, not full reproduced text) and counts per cluster |
| `/analysis/summary.md` | Top 3–5 opportunity areas a Google Photos PM could act on, each with: cluster size, example remembered/forgotten pattern, why current search fails it, and confidence in the evidence |

## Constraints

- **Platform ToS & rate limits:** Use official APIs where they exist (Reddit, YouTube). Do not republish scraped review text verbatim at scale in the final report — cite by source + link and paraphrase.
- **Schema consistency:** Every extraction agent must read `schema.json` as its source of truth so data stays consistent across all five collection sources.
- **Quality verification:** Verify extraction quality on a 10-record sample per source before scaling up.
