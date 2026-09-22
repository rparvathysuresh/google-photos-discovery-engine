# Google Photos Review Analysis

A multi-agent, pipeline-driven research tool for discovering incomplete-memory retrieval failures from Google Photos user feedback. This tool scrapes data from five distinct sources, filters for relevance, extracts structured insights using LLMs, and clusters the results into opportunity areas for PMs.

## Overview

The pipeline operates in 5 sequential stages, followed by a backend API and a minimal React frontend dashboard to view the results.

- **Phase 1: Collection** (Play Store, App Store, Reddit, Google Help Community, YouTube)
- **Phase 2: Filtering** (LLM-based relevance filtering)
- **Phase 3: Extraction** (Structured JSON extraction of attributes and failure points)
- **Phase 4: Clustering** (Local embeddings and K-Means clustering)
- **Frontend Dashboard**: A clean, minimal Vite + React application to explore the data.

## Prerequisites

- Node.js v20+
- A [Groq](https://groq.com/) API key for `llama-3.3-70b-versatile` inference.

## Environment Variables

Copy the provided `.env.example` to `.env` in the `config/` directory:

```bash
cp config/.env.example config/.env
```

Add your keys:
- `GROQ_API_KEY=your_groq_api_key_here`

*(Note: API keys for Reddit and YouTube are no longer required as they have been migrated to Puppeteer-based browser scraping).*

## Running the Pipeline

You can run the entire pipeline end-to-end, or step-by-step:

```bash
# Run the complete pipeline (Stages 1-4)
npm run pipeline

# Or run individual stages:
npm run collect    # Stage 1: Scrape all sources
npm run filter     # Stage 2: Filter for relevant feedback
npm run extract    # Stage 3: Extract structured schemas
npm run cluster    # Stage 4: Generate opportunity clusters
```

*Note: You can run extraction in a 10-record sample mode to verify prompts using `npm run extract:sample`.*

## Bypassing Scraper CAPTCHAs

Because the Puppeteer scrapers for Reddit, YouTube, and the Google Help Community are prone to triggering automated bot defenses (CAPTCHAs), a fallback mock data generation script is provided.

If the pipeline fails at Stage 1 and you just want to test the analytical and frontend components of this system:
```bash
# Generate 150 highly realistic mock records
node agents/generate-mock-data.js
```
You can then immediately view the dashboard or run `npm run cluster` (Stage 4) to regenerate the insights!

## Running the Web Dashboard & AI Chat (Unified Deployment)

The project includes a minimal, utility-focused web dashboard built with React and Express. It features an **"Ask AI" Chat Interface** that allows you to query the scraped dataset using natural language. It is configured to run easily locally or be deployed directly to Railway.

```bash
# 1. Install dependencies and build the React frontend
npm run build

# 2. Start the Express server (serves the API, AI Chat, and static frontend)
npm start
```

Navigate to `http://localhost:3001` to view the Executive Summary, Opportunity Clusters, and the Data Explorer.

## Output Artifacts

- **`/data/raw/`**: Unprocessed JSON records from all 5 sources.
- **`/data/filtered/`**: Relevance-filtered records.
- **`/data/structured/records.json`**: The final structured dataset.
- **`/analysis/clusters.md`**: Ranked opportunity clusters with metrics.
- **`/analysis/summary.md`**: LLM-generated narrative summary for PMs.

## Error Handling & Rate Limits

- The pipeline includes exponential backoff for LLM rate limits.
- If scraping is interrupted, the orchestrator logs the state in `/data/_pipeline_state.json`. You can safely re-run the pipeline to pick up from the last completed stage.
