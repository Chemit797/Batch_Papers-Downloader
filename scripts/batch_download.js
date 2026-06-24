/**
 * batch_download.js
 * 通过 WebVPN CDP 批量下载论文 PDF
 * 需要: Chrome 运行在 --remote-debugging-port=9222，且已登录 WebVPN
 */

const pw = require('./playwright-mcp/node_modules/playwright');
const fs = require('fs');
const path = require('path');

// ============================================================
const CONFIG = {
  CSV: path.join(__dirname, 'literature_download_status.csv'),
  OUT: __dirname,
  CDP: 'http://127.0.0.1:9222',
  DELAY: 3000,          // 篇间延迟 ms
  TIMEOUT: 30000,       // 页面加载超时
  MAX_RETRIES: 2,
};

const PREFIXES = JSON.parse(fs.readFileSync(path.join(__dirname, 'webvpn_prefixes.json'), 'utf-8'));

// ============================================================
// CSV
// ============================================================
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = [];
    let inQ = false, cur = '';
    for (const ch of lines[i]) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { values.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    values.push(cur.trim());
    const row = {};
    headers.forEach((h, k) => row[h] = (values[k] || '').replace(/^"|"$/g, ''));
    rows.push(row);
  }
  return rows;
}

function updateCSV(num, filename, size) {
  let text = fs.readFileSync(CONFIG.CSV, 'utf-8');
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/^"?(\d+)"?,/);
    if (m && parseInt(m[1]) === num) {
      const vals = parseLine(lines[i]);
      const h = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const si = h.indexOf('status'), ni = h.indexOf('note');
      vals[si] = 'downloaded_valid_pdf';
      vals[ni] = `${filename}; ${size} bytes`;
      lines[i] = vals.map(v => `"${v}"`).join(',');
      break;
    }
  }
  fs.writeFileSync(CONFIG.CSV, lines.join('\n') + '\n');
}

function parseLine(line) {
  const v = []; let inQ = false, cur = '';
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { v.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  v.push(cur.trim());
  return v;
}

// ============================================================
// Progress
// ============================================================
function loadProgress() {
  const f = path.join(__dirname, 'batch_progress.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  return {};
}
function saveProgress(p) {
  fs.writeFileSync(path.join(__dirname, 'batch_progress.json'), JSON.stringify(p, null, 2));
}

// ============================================================
// Sanitize
// ============================================================
function safeFilename(title, num, maxLen) {
  let s = title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) {
    s = s.substring(0, maxLen);
    const ls = s.lastIndexOf(' ');
    if (ls > maxLen * 0.6) s = s.substring(0, ls);
  }
  return `${String(num).padStart(3, '0')}_${s}.pdf`;
}

// ============================================================
// Download logic
// ============================================================
async function downloadPDF(page, prefixObj, paper) {
  const num = parseInt(paper.num);
  const numStr = String(num).padStart(3, '0');
  const doi = (paper.doi_url || '').replace('https://doi.org/', '');
  const title = paper.title || '';

  if (!prefixObj || !prefixObj.prefix) {
    return { status: 'skipped', reason: 'no prefix' };
  }

  const base = prefixObj.prefix;

  // Build article URL
  let articlePath = prefixObj.articlePath.replace('{doi}', doi);
  // Handle Nature's {doi_suffix} pattern
  if (articlePath.includes('{doi_suffix}')) {
    const suffix = doi.replace('10.1038/', '');
    articlePath = articlePath.replace('{doi_suffix}', suffix);
  }

  const articleUrl = base + articlePath;
  console.log(`[${numStr}] Loading article page...`);

  try {
    await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.TIMEOUT });
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log(`[${numStr}] Page load error: ${e.message}`);
    return { status: 'failed', reason: 'page load: ' + e.message };
  }

  const pageTitle = await page.title().catch(() => '?');
  console.log(`[${numStr}] Page: ${pageTitle.substring(0, 60)}`);

  // Check for paywall
  const isBlocked = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    const blocked = ['buy article', 'get access', 'purchase', 'subscribe', 'log in'];
    return blocked.some(w => body.toLowerCase().includes(w));
  });
  if (isBlocked) {
    console.log(`[${numStr}] PAYWALL - maybe not subscribed`);
    return { status: 'failed', reason: 'paywall' };
  }

  // Find PDF link
  const pdfPath = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="pdf"], a:has-text("PDF"), a:has-text("Download")');
    for (const a of links) {
      const href = (a.href || '').toLowerCase();
      const text = (a.textContent || '').toLowerCase();
      if (href.includes('.pdf') || text.includes('pdf') || text.includes('download pdf')) {
        try {
          const u = new URL(a.href);
          return u.pathname + u.search;
        } catch(e) { return null; }
      }
    }
    return null;
  });

  if (!pdfPath) {
    console.log(`[${numStr}] No PDF link found on page`);
    return { status: 'failed', reason: 'no pdf link' };
  }

  console.log(`[${numStr}] PDF path: ${pdfPath.substring(0, 80)}`);

  // Download via fetch in page context (uses VPN session)
  const pdfUrl = base + pdfPath;
  console.log(`[${numStr}] Fetching PDF...`);

  const result = await page.evaluate(async (url) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return 'HTTP:' + resp.status;
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++)
        binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    } catch(e) {
      return 'ERROR:' + e.message;
    }
  }, pdfUrl);

  if (result.startsWith('ERROR') || result.startsWith('HTTP')) {
    console.log(`[${numStr}] Fetch failed: ${result}`);
    return { status: 'failed', reason: result };
  }

  // Save
  const buf = Buffer.from(result, 'base64');
  if (buf.slice(0, 4).toString() !== '%PDF') {
    console.log(`[${numStr}] NOT a PDF! Header: ${buf.slice(0, 100).toString().substring(0, 80)}`);
    return { status: 'failed', reason: 'not pdf' };
  }

  const filename = safeFilename(title, num, 230);
  const filepath = path.join(CONFIG.OUT, filename);
  fs.writeFileSync(filepath, buf);

  console.log(`[${numStr}] ✅ DOWNLOADED: ${buf.length} bytes -> ${filename}`);
  updateCSV(num, filename, buf.length);
  return { status: 'completed', filename, size: buf.length };
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('=== Batch PDF Download via WebVPN ===\n');

  // Connect to Chrome
  let browser;
  try {
    browser = await pw.chromium.connectOverCDP(CONFIG.CDP);
  } catch (e) {
    console.error('Cannot connect to Chrome! Is it running with --remote-debugging-port=9222 ?');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page = await context.newPage();

  // Load data
  const rows = parseCSV(fs.readFileSync(CONFIG.CSV, 'utf-8'));
  const progress = loadProgress();

  // Filter: papers needing download, with known publisher prefix
  const needStatus = ['no_public_pdf_candidate_in_openalex', 'public_pdf_candidate_failed_or_blocked', 'openalex_not_matched', 'manual_access_page_only'];
  let papers = rows.filter(r => {
    if (!needStatus.includes(r.status)) return false;
    if (progress['num_' + r.num] === 'done') return false;
    // Check if we have a prefix for this DOI
    const doi = (r.doi_url || '').replace('https://doi.org/', '');
    for (const [prefix, obj] of Object.entries(PREFIXES)) {
      if (doi.startsWith(prefix) && obj.prefix) return true;
    }
    return false;
  });

  console.log(`Papers to download: ${papers.length}\n`);

  let done = 0, fail = 0;
  const start = Date.now();

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    const num = parseInt(paper.num);
    const numStr = String(num).padStart(3, '0');
    const doi = (paper.doi_url || '').replace('https://doi.org/', '');

    // Find matching prefix
    let prefixObj = null;
    for (const [pref, obj] of Object.entries(PREFIXES)) {
      if (doi.startsWith(pref)) { prefixObj = obj; break; }
    }

    console.log(`\n[${i + 1}/${papers.length}] #${numStr} - ${prefixObj?.name || '?'} - ${(paper.title || '').substring(0, 50)}`);

    const result = await downloadPDF(page, prefixObj, paper);

    if (result.status === 'completed') {
      done++;
      progress['num_' + num] = 'done';
    } else {
      fail++;
      console.log(`[${numStr}] ❌ ${result.reason}`);
    }
    saveProgress(progress);

    // Stats
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`Progress: ${done} done, ${fail} failed | ${elapsed}s`);

    // Delay between papers
    if (i < papers.length - 1) {
      await new Promise(r => setTimeout(r, CONFIG.DELAY));
    }
  }

  // Summary
  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n=== DONE ===`);
  console.log(`Done: ${done} | Failed: ${fail} | Time: ${elapsed}s`);

  await page.close();
  await browser.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
