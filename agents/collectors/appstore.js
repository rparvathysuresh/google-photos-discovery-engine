/**
 * Apple App Store Collector
 * 
 * Fetches reviews for Google Photos on iOS (1–3 star)
 * using the app-store-scraper library.
 * 
 * Output: /data/raw/appstore.json
 */

const store = require('app-store-scraper');
const { writeJSON, writeMeta, sleep, log, projectPath } = require('../utils');

const AGENT = 'collector-appstore';
const APP_ID = 293622097; // Google Photos iOS app ID
const MAX_PAGES = 10;
const DELAY_MS = 1000;
const OUTPUT_PATH = projectPath('data', 'raw', 'appstore.json');

/**
 * Normalize an app-store-scraper review into the raw record schema.
 */
function normalizeReview(review) {
  return {
    source: 'appstore',
    date: review.updated ? new Date(review.updated).toISOString() : null,
    rating: review.score || null,
    upvotes: null,
    raw_text: (review.text || review.title || '').trim(),
    url: review.url || `https://apps.apple.com/app/google-photos/id${APP_ID}`,
  };
}

/**
 * Collect reviews from the Apple App Store.
 */
async function collect() {
  const startedAt = new Date().toISOString();
  log(AGENT, `Starting collection for App ID ${APP_ID}`);

  const allReviews = [];
  const errors = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      log(AGENT, `Fetching page ${page}/${MAX_PAGES} (${allReviews.length} reviews so far)…`);

      try {
        const reviews = await store.reviews({
          id: APP_ID,
          sort: store.sort.RECENT,
          page,
          country: 'us',
        });

        if (!reviews || reviews.length === 0) {
          log(AGENT, 'No more reviews returned. Stopping pagination.');
          break;
        }

        // Filter to 1–3 star reviews
        const filtered = reviews.filter((r) => r.score >= 1 && r.score <= 3);
        const normalized = filtered.map(normalizeReview).filter((r) => r.raw_text.length > 0);
        allReviews.push(...normalized);

        log(AGENT, `Page ${page}: ${reviews.length} fetched, ${filtered.length} in 1–3 stars, ${normalized.length} with text`);

        // Rate-limit delay
        await sleep(DELAY_MS);
      } catch (pageError) {
        const msg = `Page ${page} failed: ${pageError.message}`;
        log(AGENT, `ERROR: ${msg}`);
        errors.push(msg);

        if (errors.length >= 3) {
          log(AGENT, 'Too many page errors. Stopping early.');
          break;
        }
        await sleep(DELAY_MS * 2);
      }
    }

    // Write output
    writeJSON(OUTPUT_PATH, allReviews);
    log(AGENT, `Wrote ${allReviews.length} reviews to ${OUTPUT_PATH}`);

    // Write meta
    const status = allReviews.length === 0 ? 'failed' : errors.length > 0 ? 'partial' : 'success';
    writeMeta(OUTPUT_PATH, {
      agent: AGENT,
      record_count: allReviews.length,
      status,
      errors,
      started_at: startedAt,
      pages_fetched: Math.min(MAX_PAGES, allReviews.length > 0 ? MAX_PAGES : 0),
    });

    log(AGENT, `Collection complete. Status: ${status}, Records: ${allReviews.length}`);
    return { status, count: allReviews.length };

  } catch (fatalError) {
    log(AGENT, `FATAL: ${fatalError.message}`);
    writeJSON(OUTPUT_PATH, []);
    writeMeta(OUTPUT_PATH, {
      agent: AGENT,
      record_count: 0,
      status: 'failed',
      errors: [fatalError.message],
      started_at: startedAt,
    });
    return { status: 'failed', count: 0 };
  }
}

// Allow running standalone
if (require.main === module) {
  collect().then((result) => {
    console.log('Result:', result);
    process.exit(result.status === 'failed' ? 1 : 0);
  });
}

module.exports = { collect };
