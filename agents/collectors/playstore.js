/**
 * Google Play Store Collector
 * 
 * Fetches reviews for Google Photos (1–3 star, sorted by most relevant)
 * using the google-play-scraper library.
 * 
 * Output: /data/raw/playstore.json
 */

const gplay = require('google-play-scraper');
const { writeJSON, writeMeta, sleep, log, projectPath } = require('../utils');

const AGENT = 'collector-playstore';
const APP_ID = 'com.google.android.apps.photos';
const BATCH_SIZE = 150;
const MAX_REVIEWS = 1000;
const DELAY_MS = 1000;
const OUTPUT_PATH = projectPath('data', 'raw', 'playstore.json');

/**
 * Normalize a google-play-scraper review into the raw record schema.
 */
function normalizeReview(review) {
  return {
    source: 'playstore',
    date: review.date ? new Date(review.date).toISOString() : null,
    rating: review.score || null,
    upvotes: review.thumbsUp || 0,
    raw_text: (review.text || '').trim(),
    url: review.url || `https://play.google.com/store/apps/details?id=${APP_ID}&reviewId=${review.id}`,
  };
}

/**
 * Collect reviews from the Google Play Store.
 */
async function collect() {
  const startedAt = new Date().toISOString();
  log(AGENT, `Starting collection for ${APP_ID}`);

  const allReviews = [];
  const errors = [];
  let nextToken = undefined;
  let batchNum = 0;

  try {
    while (allReviews.length < MAX_REVIEWS) {
      batchNum++;
      log(AGENT, `Fetching batch ${batchNum} (${allReviews.length} reviews so far)…`);

      try {
        const result = await gplay.reviews({
          appId: APP_ID,
          sort: gplay.sort.RELEVANCE,
          num: BATCH_SIZE,
          paginate: true,
          nextPaginationToken: nextToken,
        });

        const reviews = result.data || [];
        if (reviews.length === 0) {
          log(AGENT, 'No more reviews returned. Stopping pagination.');
          break;
        }

        // Filter to 1–3 star reviews
        const filtered = reviews.filter((r) => r.score >= 1 && r.score <= 3);
        const normalized = filtered.map(normalizeReview).filter((r) => r.raw_text.length > 0);
        allReviews.push(...normalized);

        log(AGENT, `Batch ${batchNum}: ${reviews.length} fetched, ${filtered.length} in 1–3 stars, ${normalized.length} with text`);

        nextToken = result.nextPaginationToken;
        if (!nextToken) {
          log(AGENT, 'No more pagination tokens. Collection complete.');
          break;
        }

        // Rate-limit delay
        await sleep(DELAY_MS);
      } catch (batchError) {
        const msg = `Batch ${batchNum} failed: ${batchError.message}`;
        log(AGENT, `ERROR: ${msg}`);
        errors.push(msg);

        // If 3 consecutive batch errors, stop
        if (errors.length >= 3) {
          log(AGENT, 'Too many batch errors. Stopping early.');
          break;
        }
        await sleep(DELAY_MS * 2);
      }
    }

    // Truncate to MAX_REVIEWS
    const finalReviews = allReviews.slice(0, MAX_REVIEWS);

    // Write output
    writeJSON(OUTPUT_PATH, finalReviews);
    log(AGENT, `Wrote ${finalReviews.length} reviews to ${OUTPUT_PATH}`);

    // Write meta
    const status = errors.length > 0 ? 'partial' : 'success';
    writeMeta(OUTPUT_PATH, {
      agent: AGENT,
      record_count: finalReviews.length,
      status,
      errors,
      started_at: startedAt,
      batches_fetched: batchNum,
    });

    log(AGENT, `Collection complete. Status: ${status}, Records: ${finalReviews.length}`);
    return { status, count: finalReviews.length };

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
