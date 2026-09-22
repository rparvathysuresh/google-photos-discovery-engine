/**
 * Google Photos Help Community Collector
 * 
 * Uses Puppeteer to navigate the Google Photos Help Community,
 * search for retrieval-failure threads, and extract question + reply text.
 * 
 * Output: /data/raw/helpcommunity.json
 */

const puppeteer = require('puppeteer');
const { writeJSON, writeMeta, sleep, log, projectPath } = require('../utils');

const AGENT = 'collector-helpcommunity';
const OUTPUT_PATH = projectPath('data', 'raw', 'helpcommunity.json');
const BASE_URL = 'https://support.google.com/photos/community';
const DELAY_MS = 2500; // 2–3s between page loads for anti-bot
const MAX_THREADS = 50;
const MAX_TEXT_LENGTH = 2000;

const SEARCH_QUERIES = [
  "can't find photo",
  'missing photo search',
  'find old photo',
  'lost photo',
  'search not working',
  'remember photo',
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Launch a Puppeteer browser instance.
 */
async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--user-agent=${USER_AGENT}`,
    ],
  });
}

/**
 * Search the Help Community and collect thread URLs.
 * @param {import('puppeteer').Page} page
 * @param {string} query
 * @returns {Promise<Array<{url: string, title: string}>>}
 */
async function searchCommunity(page, query) {
  const threads = [];

  try {
    const searchUrl = `https://support.google.com/photos/community/search?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(DELAY_MS);

    // Try to extract thread links from search results
    const results = await page.evaluate(() => {
      const items = [];
      // Google Community uses various selectors; try common patterns
      const links = document.querySelectorAll('a[href*="/photos/thread/"], a[href*="/photos/community/"]');
      links.forEach((link) => {
        const href = link.getAttribute('href');
        const text = (link.textContent || '').trim();
        if (href && text && text.length > 10) {
          const fullUrl = href.startsWith('http') ? href : `https://support.google.com${href}`;
          items.push({ url: fullUrl, title: text.substring(0, 200) });
        }
      });
      return items;
    });

    threads.push(...results);
  } catch (error) {
    log(AGENT, `Search for "${query}" failed: ${error.message}`);
  }

  return threads;
}

/**
 * Extract thread content (question + replies) from a thread page.
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function extractThread(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(DELAY_MS);

    // Check for CAPTCHA or unusual page state
    const pageContent = await page.content();
    if (pageContent.includes('captcha') || pageContent.includes('unusual traffic')) {
      log(AGENT, `CAPTCHA detected on ${url} — skipping`);
      return null;
    }

    // Extract text content from the thread
    const text = await page.evaluate(() => {
      const parts = [];

      // Try to get the main question/post
      const questionEl = document.querySelector(
        '[class*="thread-question"], [class*="post-content"], .scTailwindLegalStatementnqNr6d, article, .main-content'
      );
      if (questionEl) {
        parts.push(questionEl.textContent.trim());
      }

      // Try to get replies
      const replyEls = document.querySelectorAll(
        '[class*="thread-reply"], [class*="reply-content"], .scTailwindLegalStatement, .reply'
      );
      replyEls.forEach((el, i) => {
        if (i < 5) { // Max 5 replies
          parts.push(el.textContent.trim());
        }
      });

      // Fallback: get all paragraph text if nothing specific matched
      if (parts.length === 0) {
        const paragraphs = document.querySelectorAll('p, [role="main"] div');
        paragraphs.forEach((p) => {
          const text = p.textContent.trim();
          if (text.length > 30) parts.push(text);
        });
      }

      return parts.join('\n\n---\n\n');
    });

    return text || null;
  } catch (error) {
    log(AGENT, `Thread extraction failed for ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Normalize a Help Community thread into the raw record schema.
 */
function normalizeThread(url, title, text) {
  let fullText = title || '';
  if (text) fullText += '\n\n' + text;

  if (fullText.length > MAX_TEXT_LENGTH) {
    fullText = fullText.substring(0, MAX_TEXT_LENGTH) + '…';
  }

  return {
    source: 'helpcommunity',
    date: new Date().toISOString(), // Thread dates are hard to extract; use collection date
    rating: null,
    upvotes: null,
    raw_text: fullText.trim(),
    url: url,
  };
}

/**
 * Collect threads from the Google Photos Help Community.
 */
async function collect() {
  const startedAt = new Date().toISOString();
  log(AGENT, 'Starting Help Community collection');

  const allRecords = [];
  const errors = [];
  const skippedUrls = [];
  const seenUrls = new Set();
  let browser = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Discover threads across all search queries
    const allThreads = [];
    for (const query of SEARCH_QUERIES) {
      log(AGENT, `Searching for "${query}"…`);
      const threads = await searchCommunity(page, query);
      log(AGENT, `  Found ${threads.length} threads`);

      for (const thread of threads) {
        if (!seenUrls.has(thread.url)) {
          seenUrls.add(thread.url);
          allThreads.push(thread);
        }
      }
      await sleep(DELAY_MS);
    }

    log(AGENT, `Discovered ${allThreads.length} unique threads. Extracting content…`);

    // Extract content from each thread (up to MAX_THREADS)
    const threadsToProcess = allThreads.slice(0, MAX_THREADS);
    for (let i = 0; i < threadsToProcess.length; i++) {
      const thread = threadsToProcess[i];
      log(AGENT, `Extracting thread ${i + 1}/${threadsToProcess.length}: ${thread.title.substring(0, 60)}…`);

      const text = await extractThread(page, thread.url);

      if (text === null) {
        skippedUrls.push(thread.url);
        continue;
      }

      const record = normalizeThread(thread.url, thread.title, text);
      if (record.raw_text.length > 20) {
        allRecords.push(record);
      }
    }

    // Write output
    writeJSON(OUTPUT_PATH, allRecords);
    log(AGENT, `Wrote ${allRecords.length} records to ${OUTPUT_PATH}`);

    // Write meta
    const status = allRecords.length === 0 ? 'failed' : errors.length > 0 || skippedUrls.length > 0 ? 'partial' : 'success';
    writeMeta(OUTPUT_PATH, {
      agent: AGENT,
      record_count: allRecords.length,
      status,
      errors,
      started_at: startedAt,
      threads_discovered: allThreads.length,
      threads_extracted: allRecords.length,
      threads_skipped: skippedUrls.length,
      skipped_urls: skippedUrls,
    });

    log(AGENT, `Collection complete. Status: ${status}, Records: ${allRecords.length}, Skipped: ${skippedUrls.length}`);
    return { status, count: allRecords.length };

  } catch (fatalError) {
    log(AGENT, `FATAL: ${fatalError.message}`);
    errors.push(fatalError.message);
    writeJSON(OUTPUT_PATH, allRecords);
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
