/**
 * YouTube Collector (Browser-Based)
 * 
 * Uses Puppeteer to navigate to YouTube videos listed in
 * /config/youtube_video_ids.json, scrolls to lazy-load comments,
 * and extracts comment text, likes, date, and video URL.
 * 
 * No API key required.
 * 
 * Output: /data/raw/youtube.json
 *         /data/raw/youtube_run_log.json
 */

const puppeteer = require('puppeteer');
const { writeJSON, writeMeta, sleep, log, projectPath, readJSON } = require('../utils');

const AGENT = 'collector-youtube';
const OUTPUT_PATH = projectPath('data', 'raw', 'youtube.json');
const RUN_LOG_PATH = projectPath('data', 'raw', 'youtube_run_log.json');
const VIDEO_IDS_PATH = projectPath('config', 'youtube_video_ids.json');
const MAX_TEXT_LENGTH = 2000;
const PAGE_DELAY_MS = 3000;
const SCROLL_DELAY_MS = 2000;
const MAX_COMMENTS_PER_VIDEO = 200;
const MAX_SCROLL_ATTEMPTS = 30; // Safety cap to avoid infinite scrolling

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Browser Helpers
// ---------------------------------------------------------------------------

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
    ],
  });
}

/**
 * Check if the page is blocked or shows an error.
 */
async function isPageBlocked(page) {
  const content = await page.content();
  return (
    content.includes('confirm you\'re not a robot') ||
    content.includes('unusual traffic') ||
    content.includes('captcha') ||
    content.includes('This page isn\'t available') ||
    content.includes('Video unavailable')
  );
}

// ---------------------------------------------------------------------------
// Comment Extraction
// ---------------------------------------------------------------------------

/**
 * Scroll down to lazy-load YouTube comments.
 * YouTube loads comments dynamically as the user scrolls.
 * 
 * @param {import('puppeteer').Page} page
 * @param {number} targetCommentCount
 * @returns {Promise<number>} Number of comments loaded
 */
async function scrollToLoadComments(page, targetCommentCount) {
  let previousCount = 0;
  let scrollAttempts = 0;
  let staleRounds = 0;

  // First, scroll past the video to trigger comment section loading
  await page.evaluate(() => window.scrollTo(0, 600));
  await sleep(SCROLL_DELAY_MS);
  await page.evaluate(() => window.scrollTo(0, 1200));
  await sleep(SCROLL_DELAY_MS);

  while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
    scrollAttempts++;

    // Count currently loaded comments
    const currentCount = await page.evaluate(() => {
      return document.querySelectorAll('ytd-comment-thread-renderer, ytd-comment-renderer').length;
    });

    if (currentCount >= targetCommentCount) {
      log(AGENT, `    Loaded ${currentCount} comments (target reached)`);
      return currentCount;
    }

    if (currentCount === previousCount) {
      staleRounds++;
      if (staleRounds >= 3) {
        log(AGENT, `    No new comments after ${staleRounds} scrolls. Loaded ${currentCount} total.`);
        return currentCount;
      }
    } else {
      staleRounds = 0;
    }

    previousCount = currentCount;

    // Scroll down
    await page.evaluate(() => window.scrollBy(0, 1500));
    await sleep(SCROLL_DELAY_MS);
  }

  const finalCount = await page.evaluate(() => {
    return document.querySelectorAll('ytd-comment-thread-renderer, ytd-comment-renderer').length;
  });

  log(AGENT, `    Reached max scroll attempts. Loaded ${finalCount} comments.`);
  return finalCount;
}

/**
 * Extract comments from the currently loaded YouTube page.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array<{text: string, likes: number, date: string}>>}
 */
async function extractComments(page) {
  return page.evaluate(() => {
    const comments = [];
    const commentEls = document.querySelectorAll('ytd-comment-thread-renderer');

    commentEls.forEach((el) => {
      // Comment text
      const contentEl = el.querySelector('#content-text');
      const text = contentEl ? contentEl.textContent.trim() : '';

      // Like count
      const likeEl = el.querySelector('#vote-count-middle');
      let likes = 0;
      if (likeEl) {
        const likeText = likeEl.textContent.trim();
        const parsed = parseInt(likeText.replace(/[^0-9]/g, ''), 10);
        if (!isNaN(parsed)) likes = parsed;
      }

      // Date
      const dateEl = el.querySelector('.published-time-text a, #header-author yt-formatted-string a');
      const date = dateEl ? dateEl.textContent.trim() : '';

      if (text.length > 0) {
        comments.push({ text, likes, date });
      }
    });

    return comments;
  });
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeComment(comment, videoId) {
  let text = (comment.text || '').trim();
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.substring(0, MAX_TEXT_LENGTH) + '…';
  }

  return {
    source: 'youtube',
    date: comment.date || null, // Relative dates like "2 months ago" — best effort
    rating: null,
    upvotes: comment.likes || 0,
    raw_text: text,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

async function collect() {
  const startedAt = new Date().toISOString();
  log(AGENT, 'Starting YouTube collection (browser-based)');

  const allRecords = [];
  const errors = [];
  const runLog = {
    agent: AGENT,
    started_at: startedAt,
    completed_at: null,
    visited: 0,
    blocked: 0,
    errors: 0,
    pages: [],
  };

  let browser = null;

  try {
    // Load video IDs from config
    let videoIds;
    try {
      videoIds = readJSON(VIDEO_IDS_PATH);
    } catch (error) {
      log(AGENT, `ERROR: Could not read ${VIDEO_IDS_PATH}: ${error.message}`);
      log(AGENT, 'Create config/youtube_video_ids.json with an array of video IDs.');
      writeJSON(OUTPUT_PATH, []);
      writeMeta(OUTPUT_PATH, {
        agent: AGENT,
        record_count: 0,
        status: 'failed',
        errors: [`Config file missing: ${error.message}`],
        started_at: startedAt,
      });
      return { status: 'failed', count: 0 };
    }

    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      log(AGENT, 'ERROR: youtube_video_ids.json is empty or not an array.');
      writeJSON(OUTPUT_PATH, []);
      writeMeta(OUTPUT_PATH, {
        agent: AGENT,
        record_count: 0,
        status: 'failed',
        errors: ['No video IDs configured'],
        started_at: startedAt,
      });
      return { status: 'failed', count: 0 };
    }

    log(AGENT, `Loaded ${videoIds.length} video IDs from config`);

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    // Process each video
    for (let i = 0; i < videoIds.length; i++) {
      const videoId = videoIds[i];
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const logEntry = { url: videoUrl, status: 'pending', timestamp: new Date().toISOString() };

      log(AGENT, `Processing video ${i + 1}/${videoIds.length}: ${videoId}`);

      try {
        await page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(PAGE_DELAY_MS);

        if (await isPageBlocked(page)) {
          log(AGENT, `  BLOCKED on video ${videoId} — skipping`);
          logEntry.status = 'blocked';
          runLog.pages.push(logEntry);
          runLog.blocked++;
          continue;
        }

        logEntry.status = 'visited';
        runLog.pages.push(logEntry);
        runLog.visited++;

        // Scroll to load comments
        log(AGENT, `  Scrolling to load comments (target: ${MAX_COMMENTS_PER_VIDEO})…`);
        const loadedCount = await scrollToLoadComments(page, MAX_COMMENTS_PER_VIDEO);

        if (loadedCount === 0) {
          log(AGENT, `  No comments loaded for video ${videoId} (comments may be disabled)`);
          logEntry.comments_loaded = 0;
          continue;
        }

        // Extract comments
        const comments = await extractComments(page);
        logEntry.comments_loaded = comments.length;

        // Normalize and add to records
        const normalized = comments
          .map((c) => normalizeComment(c, videoId))
          .filter((r) => r.raw_text.length > 10);

        allRecords.push(...normalized);
        log(AGENT, `  Extracted ${normalized.length} comments from video ${videoId}`);

        // Write incrementally after each video
        writeJSON(OUTPUT_PATH, allRecords);
        log(AGENT, `  Incremental save: ${allRecords.length} total records`);

      } catch (videoError) {
        log(AGENT, `  Error processing video ${videoId}: ${videoError.message}`);
        logEntry.status = 'error';
        logEntry.error = videoError.message;
        runLog.pages.push(logEntry);
        runLog.errors++;
        errors.push(`Video ${videoId}: ${videoError.message}`);
      }

      // Delay between videos
      await sleep(PAGE_DELAY_MS);
    }

    // Final write
    writeJSON(OUTPUT_PATH, allRecords);
    log(AGENT, `Wrote ${allRecords.length} records to ${OUTPUT_PATH}`);

    // Write run log
    runLog.completed_at = new Date().toISOString();
    writeJSON(RUN_LOG_PATH, runLog);

    // Write meta
    const status = allRecords.length === 0 ? 'failed' : runLog.blocked > 0 || errors.length > 0 ? 'partial' : 'success';
    writeMeta(OUTPUT_PATH, {
      agent: AGENT,
      record_count: allRecords.length,
      status,
      errors,
      started_at: startedAt,
      videos_configured: videoIds.length,
      videos_visited: runLog.visited,
      videos_blocked: runLog.blocked,
      videos_errored: runLog.errors,
    });

    log(AGENT, `Collection complete. Status: ${status}, Records: ${allRecords.length}, Blocked: ${runLog.blocked}`);
    return { status, count: allRecords.length };

  } catch (fatalError) {
    log(AGENT, `FATAL: ${fatalError.message}`);
    errors.push(fatalError.message);
    writeJSON(OUTPUT_PATH, allRecords);
    runLog.completed_at = new Date().toISOString();
    writeJSON(RUN_LOG_PATH, runLog);
    writeMeta(OUTPUT_PATH, {
      agent: AGENT,
      record_count: allRecords.length,
      status: 'failed',
      errors,
      started_at: startedAt,
    });
    return { status: 'failed', count: allRecords.length };

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
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
