/**
 * quick_download.js - 只下载已验证可用的出版商
 * Springer (25) + ASM (5) + PNAS (2) = 32 papers
 */
const pw = require('./playwright-mcp/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const PREFIXES = {
  springer: 'https://webvpn.YOUR_INSTITUTION.edu.cn/https/REPLACE_WITH_YOUR_SPRINGER_PREFIX',
  asm: 'https://webvpn.YOUR_INSTITUTION.edu.cn/https/REPLACE_WITH_YOUR_ASM_PREFIX',
  pnas: 'https://webvpn.YOUR_INSTITUTION.edu.cn/https/REPLACE_WITH_YOUR_PNAS_PREFIX',
};

const CSV = path.join(__dirname, 'literature_download_status.csv');
const OUT = __dirname;
const DELAY = 3000;

// CSV
function readCSV() {
  const text = fs.readFileSync(CSV, 'utf-8');
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = []; let inQ = false, cur = '';
    for (const ch of lines[i]) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    vals.push(cur.trim());
    const row = {};
    headers.forEach((h, k) => row[h] = (vals[k] || '').replace(/^"|"$/g, ''));
    rows.push(row);
  }
  return rows;
}

function updateCSV(num, filename, size) {
  let text = fs.readFileSync(CSV, 'utf-8');
  const lines = text.split(/\r?\n/);
  const h = lines[0].split(',').map(x => x.trim().replace(/^"|"$/g, ''));
  const si = h.indexOf('status'), ni = h.indexOf('note');
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/^"?(\d+)"?,/);
    if (m && parseInt(m[1]) === num) {
      const vals = [];
      let inQ = false, cur = '';
      for (const ch of lines[i]) {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; continue; }
        cur += ch;
      }
      vals.push(cur.trim());
      vals[si] = 'downloaded_valid_pdf';
      vals[ni] = `${filename}; ${size} bytes`;
      lines[i] = vals.map(v => `"${v}"`).join(',');
      break;
    }
  }
  fs.writeFileSync(CSV, lines.join('\n') + '\n');
}

function safeFilename(title, num) {
  let s = title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 220) {
    s = s.substring(0, 220);
    const ls = s.lastIndexOf(' ');
    if (ls > 150) s = s.substring(0, ls);
  }
  return `${String(num).padStart(3, '0')}_${s}.pdf`;
}

// Get existing PDFs to avoid re-downloading
function getExistingPDFs() {
  const files = fs.readdirSync(OUT);
  const done = new Set();
  for (const f of files) {
    const m = f.match(/^(\d{3})_.*\.pdf$/);
    if (m) done.add(parseInt(m[1]));
  }
  return done;
}

async function downloadOne(page, prefix, articlePath, pdfPathPattern, paper) {
  const num = parseInt(paper.num);
  const numStr = String(num).padStart(3, '0');
  const doi = (paper.doi_url || '').replace('https://doi.org/', '');
  const title = paper.title || '';

  // Navigate to article page
  const articleUrl = prefix + articlePath.replace('{doi}', doi);
  console.log(`[${numStr}] Loading...`);

  try {
    await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch(e) {
    console.log(`[${numStr}] ❌ Page error: ${e.message.substring(0,50)}`);
    return 'fail';
  }

  const pageTitle = await page.title().catch(() => '?');
  if (pageTitle.includes('not found') || pageTitle.includes('404') || pageTitle.includes('Error')) {
    console.log(`[${numStr}] ❌ 404/Error: ${pageTitle.substring(0,60)}`);
    return 'fail';
  }

  // Find PDF link
  const pdfPath = await page.evaluate((pattern) => {
    const links = document.querySelectorAll('a');
    for (const a of links) {
      const h = (a.href || '').toLowerCase();
      const t = (a.textContent || '').toLowerCase();
      // Look for PDF download links
      if (h.includes('.pdf') || h.includes('/pdf')) {
        if (t.includes('pdf') || t.includes('download') || h.includes('/pdf/')) {
          try { const u = new URL(a.href); return u.pathname + u.search; } catch(e) {}
        }
      }
      // Also try links with text "PDF" or "Download PDF"
      if ((t.includes('pdf') || t.includes('download pdf')) && h.length > 0) {
        try { const u = new URL(a.href); return u.pathname + u.search; } catch(e) {}
      }
    }
    return null;
  });

  if (!pdfPath) {
    console.log(`[${numStr}] ❌ No PDF link`);
    return 'fail';
  }

  // Download via in-page fetch
  const pdfUrl = prefix + pdfPath;
  const result = await page.evaluate(async (url) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return 'HTTP:' + resp.status;
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    } catch(e) { return 'ERR:' + e.message; }
  }, pdfUrl);

  if (result.startsWith('HTTP') || result.startsWith('ERR')) {
    console.log(`[${numStr}] ❌ Fetch fail: ${result}`);
    return 'fail';
  }

  const buf = Buffer.from(result, 'base64');
  if (buf.slice(0,4).toString() !== '%PDF') {
    console.log(`[${numStr}] ❌ Not PDF: ${buf.slice(0,50).toString()}`);
    return 'fail';
  }

  const filename = safeFilename(title, num);
  const filepath = path.join(OUT, filename);
  fs.writeFileSync(filepath, buf);
  console.log(`[${numStr}] ✅ ${buf.length} bytes -> ${filename}`);
  updateCSV(num, filename, buf.length);
  return 'ok';
}

async function main() {
  console.log('=== Quick Download: Springer + ASM + PNAS ===\n');

  let browser;
  try {
    browser = await pw.chromium.connectOverCDP('http://127.0.0.1:9222');
  } catch(e) {
    console.error('Chrome CDP not accessible! Start Chrome with --remote-debugging-port=9222');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page = await context.newPage();
  const rows = readCSV();
  const existing = getExistingPDFs();

  // Filter papers
  const needStatus = ['no_public_pdf_candidate_in_openalex', 'public_pdf_candidate_failed_or_blocked', 'openalex_not_matched', 'manual_access_page_only'];
  const papers = rows.filter(r => {
    if (!needStatus.includes(r.status)) return false;
    if (existing.has(parseInt(r.num))) return false;
    const doi = (r.doi_url || '').replace('https://doi.org/', '');
    return doi.startsWith('10.1007') || doi.startsWith('10.1023') || doi.startsWith('10.1128') || doi.startsWith('10.1073');
  });

  console.log(`To download: ${papers.length} papers (${existing.size} already exist)\n`);

  let ok = 0, fail = 0;
  const start = Date.now();

  for (let i = 0; i < papers.length; i++) {
    const p = papers[i];
    const num = parseInt(p.num);
    const doi = (p.doi_url || '').replace('https://doi.org/', '');
    const numStr = String(num).padStart(3, '0');

    // Determine publisher
    let prefix, articlePath;
    if (doi.startsWith('10.1007') || doi.startsWith('10.1023')) {
      prefix = PREFIXES.springer;
      articlePath = '/article/{doi}';
    } else if (doi.startsWith('10.1128')) {
      prefix = PREFIXES.asm;
      articlePath = '/doi/{doi}';
    } else if (doi.startsWith('10.1073')) {
      prefix = PREFIXES.pnas;
      articlePath = '/doi/{doi}';
    } else {
      continue;
    }

    console.log(`\n[${i+1}/${papers.length}] #${numStr} - ${(p.title||'').substring(0,50)}`);
    const result = await downloadOne(page, prefix, articlePath, null, p);
    if (result === 'ok') ok++; else fail++;

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`Progress: ${ok} done, ${fail} fail | ${elapsed}s`);

    if (i < papers.length - 1) await new Promise(r => setTimeout(r, DELAY));
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n=== DONE: ${ok} ok, ${fail} fail | ${elapsed}s ===`);

  await page.close();
  await browser.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
