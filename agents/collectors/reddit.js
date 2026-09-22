/**
 * Reddit Collector (Browser-Based)
 * 
 * Uses Puppeteer to scrape old.reddit.com search results for posts about
 * Google Photos retrieval failures. No API keys required.
 * 
 * Output: /data/raw/reddit.json
 *         /data/raw/reddit_run_log.json
 */

const puppeteer = require('puppeteer');
const { writeJSON, writeMeta, sleep, log, projectPath } = require('../utils');

const AGENT = 'collector-reddit';
const OUTPUT_PATH = projectPath('data', 'raw', 'reddit.json');
const RUN_LOG_PATH = projectPath('data', 'raw', 'reddit_run_log.json');
const MAX_TEXT_LENGTH = 2000;
const PAGE_DELAY_MS = 4000; // 3–5s between pages (use 4s as midpoint)

const SUBREDDITS = ['googlephotos', 'GooglePixel', 'androidapps'];

const SEARCH_QUERIES = [
  "can't find old photo",
  'lost photo',
  'remember picture',
  'search photos',
  "can't find photo",
  'missing photo',
];

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
    ],
  });
}

/**
 * Check if the page is blocked (CAPTCHA, rate limit, error page).
 */
async function isPageBlocked(page) {
  const content = await page.content();
  const blocked =
    content.includes('whoa there, pardner') ||
    content.includes('Too Many Requests') ||
    content.includes('captcha') ||
    content.includes('Our CDN was unable') ||
    content.includes('you are doing that too much');
  return blocked;
}

// ---------------------------------------------------------------------------
// Search Result Scraping
// ---------------------------------------------------------------------------

/**
 * Search a subreddit on old.reddit.com and extract post links.
 * @param {import('puppeteer').Page} page
 * @param {string} subreddit
 * @param {string} query
 * @param {object} runLog
 * @returns {Promise<Array<{url: string, title: string}>>}
 */
async function searchSubreddit(page, subreddit, query, runLog) {
  const searchUrl = `https://old.reddit.com/r/${subreddit}/search?q=${encodeURIComponent(query)}&restrict_sr=on&sort=relevance&t=all`;
  const logEntry = { url: searchUrl, status: 'pending', timestamp: new Date().toISOString() };

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(PAGE_DELAY_MS);

    if (await isPageBlocked(page)) {
      log(AGENT, `  BLOCKED on search page for r/${subreddit} "${query}" — skipping`);
      logEntry.status = 'blocked';
      runLog.pages.push(logEntry);
      runLog.blocked++;
      return [];
    }

    logEntry.status = 'visited';
    runLog.pages.push(logEntry);
    runLog.visited++;

    // Extract post links from old.reddit.com search results
    const posts = await page.evaluate(() => {
      const results = [];
      const searchResults = document.querySelectorAll('.search-result, .search-result-link');

      // Old reddit search results
      searchResults.forEach((el) => {
        const linkEl = el.querySelector('a.search-title, a.search-link, a[href*="/comments/"]');
        if (linkEl) {
          results.push({
            url: linkEl.href,
            title: (linkEl.textContent || '').trim(),
          });
        }
      });

      // Fallback: general link extraction from results
      if (results.length === 0) {
        document.querySelectorAll('#siteTable .thing .title a.title, .sitetable .thing .title a').forEach((a) => {
          if (a.href && a.href.includes('/comments/')) {
            results.push({
              url: a.href,
              title: (a.textContent || '').trim(),
            });
          }
        });
      }

      return results;
    });

    return posts;
  } catch (error) {
    log(AGENT, `  Error searching r/${subreddit} "${query}": ${error.message}`);
    logEntry.status = 'error';
    logEntry.error = error.message;
    runLog.pages.push(logEntry);
    runLog.errors++;
    return [];
  }
}

// ---------------------------------------------------------------------------
// Post Content Extraction
// ---------------------------------------------------------------------------

/**
 * Navigate to a Reddit post page and extract title, body, comments, metadata.
 * @param {import('puppeteer').Page} page
 * @param {string} postUrl
 * @param {object} runLog
 * @returns {Promise<object|null>}
 */
async function extractPost(page, postUrl, runLog) {
  // Ensure we use old.reddit.com for consistent DOM
  const oldUrl = postUrl.replace('www.reddit.com', 'old.reddit.com')
                        .replace('://reddit.com', '://old.reddit.com');

  const logEntry = { url: oldUrl, status: 'pending', timestamp: new Date().toISOString() };

  try {
    await page.goto(oldUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(PAGE_DELAY_MS);

    if (await isPageBlocked(page)) {
      log(AGENT, `  BLOCKED on post ${oldUrl} — skipping`);
      logEntry.status = 'blocked';
      runLog.pages.push(logEntry);
      runLog.blocked++;
      return null;
    }

    logEntry.status = 'visited';
    runLog.pages.push(logEntry);
    runLog.visited++;

    const postData = await page.evaluate(() => {
      // Title
      const titleEl = document.querySelector('.title a.title, [data-event-action="title"]');
      const title = titleEl ? titleEl.textContent.trim() : '';

      // Post body (selftext)
      const bodyEl = document.querySelector('.usertext-body .md, .expando .md');
      let body = bodyEl ? bodyEl.textContent.trim() : '';
      if (body === '[removed]' || body === '[deleted]') body = '';

      // Score/upvotes
      const scoreEl = document.querySelector('.score.unvoted, .midcol .unvoted, [class*="score"]');
      let score = 0;
      if (scoreEl) {
        const parsed = parseInt(scoreEl.getAttribute('title') || scoreEl.textContent, 10);
        if (!isNaN(parsed)) score = parsed;
      }

      // Date
      const timeEl = document.querySelector('time, .live-timestamp, [datetime]');
      let date = null;
      if (timeEl) {
        date = timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || null;
      }

      // Top-level comments (first 5)
      const commentEls = document.querySelectorAll('.comment .usertext-body .md');
      const comments = [];
      commentEls.forEach((el, i) => {
        if (i < 5) {
          const text = el.textContent.trim();
          if (text && text !== '[removed]' && text !== '[deleted]') {
            comments.push(text);
          }
        }
      });

      // Permalink
      const permalink = window.location.pathname;

      return { title, body, score, date, comments, permalink };
    });

    return postData;
  } catch (error) {
    log(AGENT, `  Error extracting post ${oldUrl}: ${error.message}`);
    logEntry.status = 'error';
    logEntry.error = error.message;
    runLog.pages.push(logEntry);
    runLog.errors++;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizePost(postData, postUrl) {
  let fullText = postData.title || '';
  if (postData.body) fullText += '\n\n' + postData.body;
  if (postData.comments.length > 0) {
    fullText += '\n\n[Comments]\n' + postData.comments.join('\n---\n');
  }

  if (fullText.length > MAX_TEXT_LENGTH) {
    fullText = fullText.substring(0, MAX_TEXT_LENGTH) + '…';
  }

  let date = null;
  if (postData.date) {
    try {
      date = new Date(postData.date).toISOString();
    } catch {
      date = null;
    }
  }

  return {
    source: 'reddit',
    date,
    rating: null,
    upvotes: postData.score || 0,
    raw_text: fullText.trim(),
    url: postUrl.replace('old.reddit.com', 'www.reddit.com'),
  };
}

// ---------------------------------------------------------------------------
// Main Collection
// ---------------------------------------------------------------------------

async function collect() {
  const startedAt = new Date().toISOString();
  log(AGENT, 'Starting Reddit collection (browser-based, old.reddit.com)');

  const allRecords = [];
  const seenUrls = new Set();
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
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    // Phase 1: Discover post URLs from search results
    const discoveredPosts = [];

    for (const subreddit of SUBREDDITS) {
      for (const query of SEARCH_QUERIES) {
        log(AGENT, `Searching r/${subreddit} for "${query}"…`);
        const posts = await searchSubreddit(page, subreddit, query, runLog);
        log(AGENT, `  Found ${posts.length} posts`);

        for (const post of posts) {
          if (!seenUrls.has(post.url)) {
            seenUrls.add(post.url);
            discoveredPosts.push(post);
          }
        }
      }
    }

    log(AGENT, `Discovered ${discoveredPosts.length} unique posts. Extracting content…`);

    // Phase 2: Visit each post and extract content
    for (let i = 0; i < discoveredPosts.length; i++) {
      const post = discoveredPosts[i];
      log(AGENT, `Extracting post ${i + 1}/${discoveredPosts.length}: ${post.title.substring(0, 50)}…`);

      const postData = await extractPost(page, post.url, runLog);

      if (postData) {
        const record = normalizePost(postData, post.url);
        if (record.raw_text.length > 20) {
          allRecords.push(record);

          // Write incrementally every 10 posts
          if (allRecords.length % 10 === 0) {
            writeJSON(OUTPUT_PATH, allRecords);
            log(AGENT, `  Incremental save: ${allRecords.length} records`);
          }
        }
      }
    }

    // Final write
    writeJSON(OUTPUT_PATH, allRecords);
    log(AGENT, `Wrote ${allRecords.length} records to ${OUTPUT_PATH}`);

    // Write run log
    runLog.completed_at = new Date().toISOString();
    writeJSON(RUN_LOG_PATH, runLog);

    // Write meta
    const status = allRecords.length === 0 ? 'failed' : runLog.blocked > 0 ? 'partial' : 'success';
    writeMeta(OUTPUT_PATH, {
      agent: AGENT,
      record_count: allRecords.length,
      status,
      errors,
      started_at: startedAt,
      posts_discovered: discoveredPosts.length,
      posts_extracted: allRecords.length,
      pages_visited: runLog.visited,
      pages_blocked: runLog.blocked,
      pages_errored: runLog.errors,
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
