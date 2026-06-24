/**
 * sd_download.js v3 - Universal DOI → extract ID → VPN → click → S3 capture
 * Works for: ScienceDirect, Wiley, Nature, and potentially others
 */
const pw = require('./playwright-mcp/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const PREFIXES = JSON.parse(fs.readFileSync(path.join(__dirname, 'webvpn_prefixes.json'), 'utf-8'));
const CSV = path.join(__dirname, 'literature_download_status.csv');
const OUT = __dirname;
const DELAY = 6000;

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
      vals[ni] = filename + '; ' + size + ' bytes';
      lines[i] = vals.map(v => '"' + v + '"').join(',');
      break;
    }
  }
  fs.writeFileSync(CSV, lines.join('\n') + '\n');
}

function safeFilename(title, num) {
  let s = title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 220) { s = s.substring(0, 220); const ls = s.lastIndexOf(' '); if (ls > 150) s = s.substring(0, ls); }
  return String(num).padStart(3, '0') + '_' + s + '.pdf';
}

function getExistingPDFs() {
  const done = new Set();
  for (const f of fs.readdirSync(OUT)) {
    const m = f.match(/^(\d{3})_.*\.pdf$/);
    if (m) done.add(parseInt(m[1]));
  }
  return done;
}

/**
 * Extract article identifier from redirected URL
 */
function extractIdFromUrl(url, prefixKey) {
  if (prefixKey === '10.1016') {
    // ScienceDirect: extract PII
    const m = url.match(/\/pii\/([A-Z0-9]+)/);
    return m ? { type: 'pii', id: m[1] } : null;
  }
  if (prefixKey === '10.1002') {
    // Wiley: extract DOI from URL path
    const m = url.match(/\/doi\/(10\.1002\/[^?#]+)/i);
    return m ? { type: 'doi', id: decodeURIComponent(m[1]) } : null;
  }
  if (prefixKey === '10.1038') {
    // Nature: extract article ID
    const m = url.match(/\/articles\/([^?#]+)/);
    return m ? { type: 'articleId', id: m[1] } : null;
  }
  return null;
}

/**
 * Build VPN article URL from extracted ID
 */
function buildArticleUrl(prefixKey, prefixObj, idInfo) {
  const base = prefixObj.prefix;
  if (!base) return null;

  if (prefixKey === '10.1016' && idInfo.type === 'pii') {
    return base + '/science/article/pii/' + idInfo.id;
  }
  if (prefixKey === '10.1002' && idInfo.type === 'doi') {
    return base + '/doi/' + idInfo.id;
  }
  if (prefixKey === '10.1038' && idInfo.type === 'articleId') {
    return base + '/articles/' + idInfo.id;
  }
  return null;
}

async function downloadOne(context, paper) {
  const num = parseInt(paper.num);
  const numStr = String(num).padStart(3, '0');
  const doi = (paper.doi_url || '').replace('https://doi.org/', '').trim();
  const title = paper.title || '';

  // Determine publisher
  let prefixKey = null, prefixObj = null;
  for (const [k, v] of Object.entries(PREFIXES)) {
    if (doi.startsWith(k) && v.prefix) {
      prefixKey = k; prefixObj = v; break;
    }
  }
  if (!prefixObj) { return 'no_prefix'; }

  const page = await context.newPage();

  try {
    // Step 1: Resolve DOI to get article URL / identifier
    console.log(`[${numStr}] DOI → publisher...`);
    await page.goto('https://doi.org/' + doi, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const redirectUrl = page.url();
    console.log(`[${numStr}] Landed: ${redirectUrl.substring(0, 100)}`);

    const idInfo = extractIdFromUrl(redirectUrl, prefixKey);
    if (!idInfo) {
      console.log(`[${numStr}] Cannot extract ID from: ${redirectUrl.substring(0, 80)}`);
      await page.close();
      return 'no_id';
    }
    console.log(`[${numStr}] ID: ${idInfo.type}=${idInfo.id.substring(0, 50)}`);

    const articleUrl = buildArticleUrl(prefixKey, prefixObj, idInfo);
    if (!articleUrl) {
      console.log(`[${numStr}] Cannot build VPN URL`);
      await page.close();
      return 'no_url';
    }

    // Step 2: Navigate to article page via VPN
    console.log(`[${numStr}] VPN article...`);
    await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const pageTitle = await page.title();
    if (pageTitle.includes('not found') || pageTitle.includes('404') || pageTitle.includes('Error')) {
      console.log(`[${numStr}] VPN page error: ${pageTitle.substring(0, 60)}`);
      await page.close();
      return 'page_error';
    }
    console.log(`[${numStr}] Page: ${pageTitle.substring(0, 60)}`);

    // Step 3: Find and click first PDF/View PDF link
    let s3Page = null;
    const onPage = (p) => { if (!p.url().includes('about:blank') && !s3Page) s3Page = p; };
    context.on('page', onPage);

    // Click first PDF-related link
    const clicked = await page.evaluate((publisher) => {
      const links = document.querySelectorAll('a');
      const keywords = ['view pdf', 'pdf', 'download pdf', 'download article'];

      // ScienceDirect: click first "View PDF"
      if (publisher === '10.1016') {
        for (const a of links) {
          const t = (a.textContent || '').trim().replace(/\xa0/g, ' ');
          if (t === 'View PDF') { a.click(); return 'sd_view_pdf'; }
        }
      }
      // Generic: try various PDF-related text and href patterns
      for (const kw of keywords) {
        for (const a of links) {
          const t = (a.textContent || '').trim().toLowerCase();
          const h = (a.href || '').toLowerCase();
          if (t.includes(kw) && (h.includes('pdf') || h.includes('download'))) {
            a.click(); return kw;
          }
        }
      }
      return null;
    }, prefixKey);

    console.log(`[${numStr}] Clicked: ${clicked}`);

    if (!clicked) {
      context.off('page', onPage);
      console.log(`[${numStr}] No PDF link found`);
      await page.close();
      return 'no_link';
    }

    // Step 4: Wait for S3/PDF tab to open
    await page.waitForTimeout(5000);
    context.off('page', onPage);

    if (!s3Page) {
      // Maybe PDF opened in same page?
      const currentUrl = page.url();
      if (currentUrl.includes('.pdf') || currentUrl.includes('pdfft')) {
        s3Page = page;
      }
    }

    if (!s3Page) {
      console.log(`[${numStr}] No PDF tab opened`);
      await page.close();
      return 'no_tab';
    }

    await s3Page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    await s3Page.waitForTimeout(3000);

    const finalUrl = s3Page.url();
    console.log(`[${numStr}] PDF URL: ${finalUrl.substring(0, 100)}`);

    // Step 5: Download PDF
    if (finalUrl.includes('pdf.sciencedirectassets.com') || finalUrl.includes('.pdf')) {
      const result = await s3Page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { cache: 'force-cache' });
          if (!r.ok) return 'HTTP:' + r.status;
          const b = await r.arrayBuffer();
          const bytes = new Uint8Array(b);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          return btoa(bin);
        } catch (e) { return 'ERR:' + e.message; }
      }, finalUrl);

      if (result.startsWith('HTTP') || result.startsWith('ERR')) {
        console.log(`[${numStr}] Fetch fail: ${result.substring(0, 50)}`);
        if (s3Page !== page) await s3Page.close();
        await page.close();
        return 'fetch_fail';
      }

      const buf = Buffer.from(result, 'base64');
      if (buf.slice(0, 4).toString() !== '%PDF') {
        console.log(`[${numStr}] Not PDF: ${buf.slice(0, 30).toString()}`);
        if (s3Page !== page) await s3Page.close();
        await page.close();
        return 'not_pdf';
      }

      const filename = safeFilename(title, num);
      fs.writeFileSync(path.join(OUT, filename), buf);
      console.log(`[${numStr}] ✅ ${buf.length} bytes -> ${filename}`);
      updateCSV(num, filename, buf.length);
      if (s3Page !== page) await s3Page.close();
      await page.close();
      return 'ok';
    }

    // For Wiley/Nature which may have different PDF download flow
    // Try fetch from page context
    if (finalUrl.includes('onlinelibrary.wiley.com') || finalUrl.includes('nature.com')) {
      const pdfResult = await s3Page.evaluate(async () => {
        // Find PDF download button/link
        const links = document.querySelectorAll('a');
        for (const a of links) {
          const h = (a.href || '').toLowerCase();
          const t = (a.textContent || '').toLowerCase();
          if (h.includes('.pdf') || t.includes('download pdf') || t.includes('pdf')) {
            try {
              const r = await fetch(a.href);
              if (!r.ok) continue;
              const b = await r.arrayBuffer();
              const bytes = new Uint8Array(b);
              let bin = '';
              for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
              // Check if PDF
              if (b.byteLength > 100 && bytes[0] === 0x25 && bytes[1] === 0x50) {
                return { ok: true, data: btoa(bin), size: b.byteLength };
              }
            } catch (e) {}
          }
        }
        return { ok: false };
      });

      if (pdfResult && pdfResult.ok) {
        const buf = Buffer.from(pdfResult.data, 'base64');
        const filename = safeFilename(title, num);
        fs.writeFileSync(path.join(OUT, filename), buf);
        console.log(`[${numStr}] ✅ ${buf.length} bytes -> ${filename}`);
        updateCSV(num, filename, buf.length);
        if (s3Page !== page) await s3Page.close();
        await page.close();
        return 'ok';
      }
    }

    console.log(`[${numStr}] No PDF downloadable from: ${finalUrl.substring(0, 80)}`);
    if (s3Page !== page) await s3Page.close();
    await page.close();
    return 'no_pdf';

  } catch (e) {
    console.log(`[${numStr}] Error: ${e.message.substring(0, 60)}`);
    try { await page.close(); } catch (_) {}
    return 'error';
  }
}

async function main() {
  console.log('=== Universal DOI → VPN → PDF Download ===\n');

  const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  const rows = readCSV();
  const existing = getExistingPDFs();
  const needStatus = ['no_public_pdf_candidate_in_openalex', 'public_pdf_candidate_failed_or_blocked', 'openalex_not_matched', 'manual_access_page_only'];

  // Papers with working VPN prefixes: ScienceDirect, Wiley, Nature
  const papers = rows.filter(r => {
    if (!needStatus.includes(r.status)) return false;
    if (existing.has(parseInt(r.num))) return false;
    const doi = (r.doi_url || '').replace('https://doi.org/', '');
    // Only include publishers with confirmed VPN prefixes
    for (const [k, v] of Object.entries(PREFIXES)) {
      if (doi.startsWith(k) && v.prefix) return true;
    }
    return false;
  });

  console.log(`To download: ${papers.length} papers (${existing.size} already exist)\n`);

  let ok = 0, fail = 0, skipped = 0;
  const start = Date.now();
  const failures = [];

  for (let i = 0; i < papers.length; i++) {
    const p = papers[i];
    const num = parseInt(p.num);
    const numStr = String(num).padStart(3, '0');
    const doi = (p.doi_url || '').replace('https://doi.org/', '');

    // Determine publisher name
    let pubName = '?';
    for (const [k, v] of Object.entries(PREFIXES)) {
      if (doi.startsWith(k)) { pubName = v.name; break; }
    }

    console.log(`\n[${i + 1}/${papers.length}] #${numStr} [${pubName}] ${(p.title || '').substring(0, 45)}`);
    const r = await downloadOne(context, p);

    if (r === 'ok') ok++;
    else if (r === 'no_prefix') skipped++;
    else { fail++; failures.push({ num, doi, pubName, reason: r }); }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`  >>> ${ok} ok, ${fail} fail, ${skipped} skip | ${elapsed}s`);

    // Clean up extra tabs (keep main portal tabs)
    const allPages = context.pages();
    if (allPages.length > 10) {
      for (let j = allPages.length - 1; j >= 0; j--) {
        const u = allPages[j].url();
        if (u === 'about:blank' || u.includes('sciencedirectassets.com')) {
          try { await allPages[j].close(); } catch (_) {}
        }
      }
    }

    if (i < papers.length - 1) await new Promise(r => setTimeout(r, DELAY));
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n=== DONE: ${ok} ok, ${fail} fail, ${skipped} skip | ${elapsed}s ===`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  #${f.num} [${f.pubName}] ${f.reason}: ${f.doi}`));
  }

  await browser.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
