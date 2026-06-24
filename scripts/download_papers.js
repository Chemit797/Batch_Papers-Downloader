/**
 * download_papers.js
 * 通过厦大 VPN + Playwright 批量下载闭源期刊 PDF
 *
 * 用法:
 *   node download_papers.js                        # 正常模式：逐篇下载全部待处理论文
 *   node download_papers.js --test-publishers      # 测试模式：每类出版商只测1篇
 *   node download_papers.js --test-one 4           # 测试模式：只下载指定 num 的论文
 *   node download_papers.js --from 10              # 从第10篇开始继续下载
 */

const { chromium } = require('./playwright-mcp/node_modules/playwright');
const fs = require('fs');
const path = require('path');

// ============================================================
// 配置
// ============================================================
const CONFIG = {
  PROJECT_DIR: __dirname,
  CSV_PATH: path.join(__dirname, 'literature_download_status.csv'),
  OUTPUT_DIR: __dirname,
  PROGRESS_FILE: path.join(__dirname, 'download_progress.json'),
  LOG_FILE: path.join(__dirname, 'download_log.txt'),
  SCREENSHOT_DIR: path.join(__dirname, 'screenshots_failed'),
  HEADLESS: false,                // false = 可见浏览器 (方便处理 CAPTCHA)
  DELAY_BETWEEN_PAPERS_MS: 5000,  // 篇间延迟
  NAVIGATION_TIMEOUT_MS: 30000,
  DOWNLOAD_TIMEOUT_MS: 60000,
  MAX_RETRIES: 3,
  MAX_FILENAME_LEN: 240,
};

// ============================================================
// 日志
// ============================================================
const LOG_LINES = [];
function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `[${ts}] ${msg}`;
  console.log(line);
  LOG_LINES.push(line);
}
function flushLog() {
  fs.writeFileSync(CONFIG.LOG_FILE, LOG_LINES.join('\n') + '\n', 'utf-8');
}

// ============================================================
// CSV 解析 (手写，无外部依赖)
// ============================================================
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = [];
    let inQuotes = false;
    let current = '';
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { values.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    values.push(current.trim());
    const row = {};
    headers.forEach((h, k) => { row[h] = (values[k] || '').replace(/^"|"$/g, ''); });
    rows.push(row);
  }
  return rows;
}

function readCSV() {
  const text = fs.readFileSync(CONFIG.CSV_PATH, 'utf-8');
  return parseCSV(text);
}

function updateCSVRow(num, newStatus, noteContent) {
  const text = fs.readFileSync(CONFIG.CSV_PATH, 'utf-8');
  const lines = text.split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const statusIdx = headers.indexOf('status');
  const noteIdx = headers.indexOf('note');
  const numIdx = headers.indexOf('num');

  for (let i = 1; i < lines.length; i++) {
    // Parse just the num field
    const match = lines[i].match(/^"?(\d+)"?,/);
    if (match && match[1] === String(num)) {
      const values = parseCSVLine(lines[i]);
      values[statusIdx] = newStatus;
      values[noteIdx] = noteContent;
      lines[i] = values.map(v => `"${v}"`).join(',');
      break;
    }
  }

  // Write to temp file then rename (atomic)
  const tmpPath = CONFIG.CSV_PATH + '.tmp';
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf-8');
  fs.renameSync(tmpPath, CONFIG.CSV_PATH);
  log(`CSV updated: #${num} -> ${newStatus}`);
}

function parseCSVLine(line) {
  const values = [];
  let inQuotes = false;
  let current = '';
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { values.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  values.push(current.trim());
  return values;
}

// ============================================================
// 进度文件 (断点续传)
// ============================================================
function loadProgress() {
  try {
    if (fs.existsSync(CONFIG.PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.PROGRESS_FILE, 'utf-8'));
    }
  } catch (e) { log('Warning: could not read progress file, starting fresh'); }
  return { last_updated: null, papers: {} };
}

function saveProgress(progress) {
  progress.last_updated = new Date().toISOString();
  // Also scan existing PDFs and auto-mark them completed
  autoDetectCompletedPDFs(progress);
  fs.writeFileSync(CONFIG.PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf-8');
}

function autoDetectCompletedPDFs(progress) {
  const files = fs.readdirSync(CONFIG.OUTPUT_DIR);
  for (const f of files) {
    const match = f.match(/^(\d{3})_.*\.pdf$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      // Find DOI for this num from the CSV
      const key = `num_${num}`;
      if (!progress.papers[key]) {
        progress.papers[key] = { num, status: 'completed', pdf_path: f, source: 'auto-detected' };
      } else if (progress.papers[key].status !== 'completed') {
        progress.papers[key].status = 'completed';
        progress.papers[key].pdf_path = f;
      }
    }
  }
}

// ============================================================
// 出版商策略
// ============================================================
const PUBLISHER_STRATEGIES = {
  // Elsevier / ScienceDirect
  '10.1016': {
    name: 'ScienceDirect',
    selectors: [
      'a[href*="/pdfft"]',
      'a[href$="/pdf"]',
      'a.pdf-download-btn',
      'a.link-button[aria-label*="PDF"]',
      'a[data-track-action="Download PDF"]',
      'a:has-text("View PDF")',
      'a:has-text("Download PDF")',
    ],
    paywallCheck: async (page) => {
      const btn = await page.$('.get-access-button, a:has-text("Get Access"), a:has-text("Purchase PDF"), .purchase-access');
      return !!btn;
    },
  },

  // Springer / SpringerLink
  '10.1007': {
    name: 'SpringerLink',
    selectors: [
      'a[href*="/content/pdf/"]',
      'a[data-test="pdf-link"]',
      '.c-pdf-download__link',
      'a[data-track-action="pdf download"]',
      'a:has-text("Download PDF")',
      'a:has-text("PDF")',
    ],
    paywallCheck: async (page) => {
      const btn = await page.$('.buybox, [data-test="buybox"], a:has-text("Buy article")');
      return !!btn;
    },
  },
  '10.1023': { // Old Springer DOI
    name: 'SpringerLink (old)',
    selectors: [
      'a[href*="/content/pdf/"]',
      'a:has-text("Download PDF")',
      'a:has-text("PDF")',
    ],
    paywallCheck: null,
  },

  // ACS
  '10.1021': {
    name: 'ACS',
    selectors: [
      'a[href*="/doi/pdf/"]',
      'a.pdfLink',
      '.pdf-button',
      'a:has-text("PDF")',
      '#pdfLink',
      '.article-pdf-link',
    ],
    paywallCheck: async (page) => {
      const btn = await page.$('.get-access, a:has-text("Purchase"), .access-options');
      return !!btn;
    },
  },

  // Wiley
  '10.1002': {
    name: 'Wiley',
    selectors: [
      'a[href*="/doi/pdfdirect/"]',
      'a[href*="/doi/pdf/"]',
      '.pdf-download',
      'a[title="PDF"]',
      'a.pdf-link',
      'a:has-text("PDF")',
    ],
    paywallCheck: async (page) => {
      const btn = await page.$('.purchase, a:has-text("Purchase"), .access-banner');
      return !!btn;
    },
  },

  // Nature
  '10.1038': {
    name: 'Nature',
    selectors: [
      'a[data-track-action="download pdf"]',
      'a[data-track-label="PDF"]',
      'a[href*=".pdf"][data-track]',
      'a:has-text("Download PDF")',
      '.c-article-tools__pdf-link',
    ],
    paywallCheck: async (page) => {
      const btn = await page.$('.article-paywall, a[data-track-action="buy article"]');
      return !!btn;
    },
  },
  '10.1039': { // RSC (similar to Nature)
    name: 'RSC',
    selectors: [
      'a[href*="/articlepdf/"]',
      'a[href*=".pdf"]',
      'a:has-text("PDF")',
    ],
    paywallCheck: null,
  },

  // ASM
  '10.1128': {
    name: 'ASM',
    selectors: [
      'a[href*="/doi/pdf/"]',
      '.pdf-toolbar-link',
      'a[href$=".full.pdf"]',
      'a:has-text("PDF")',
    ],
    paywallCheck: null,
  },

  // MDPI (Open Access, but previously blocked)
  '10.3390': {
    name: 'MDPI',
    selectors: [
      'a[href$=".pdf"]',
      'a[href*="/pdf"]',
      'a:has-text("Download PDF")',
      'a:has-text("PDF Version")',
    ],
    paywallCheck: null,
    // MDPI has direct PDF links
    directPdfPattern: true,
  },

  // PNAS
  '10.1073': {
    name: 'PNAS',
    selectors: [
      'a[href*="/doi/pdf/"]',
      'a[href$=".full.pdf"]',
      '.article-tools__pdf-link',
      'a:has-text("PDF")',
    ],
    paywallCheck: null,
  },

  // PLOS (should be OA)
  '10.1371': {
    name: 'PLOS',
    selectors: [
      'a[href*="type=printable"]',
      'a[href$=".pdf"]',
      'a[data-ga-action="download_pdf"]',
      'a:has-text("Download PDF")',
    ],
    paywallCheck: null,
  },

  // BMC / BioMed Central (should be OA)
  '10.1186': {
    name: 'BMC',
    selectors: [
      'a[href$=".pdf"]',
      'a[data-track-action="Download PDF"]',
      'a:has-text("Download PDF")',
    ],
    paywallCheck: null,
  },

  // Frontiers (should be OA)
  '10.3389': {
    name: 'Frontiers',
    selectors: [
      'a[href$=".pdf"]',
      'a:has-text("Download PDF")',
      '.download-pdf-link',
    ],
    paywallCheck: null,
  },

  // Science/AAAS
  '10.1126': {
    name: 'Science',
    selectors: [
      'a[href*="/doi/pdf/"]',
      'a:has-text("PDF")',
      '.article-tools__link--pdf',
    ],
    paywallCheck: null,
  },

  // Oxford Academic
  '10.1093': {
    name: 'Oxford',
    selectors: [
      'a[href*="/article-pdf/"]',
      'a[href$=".pdf"]',
      'a:has-text("PDF")',
    ],
    paywallCheck: null,
  },

  // Taylor & Francis
  '10.1080': {
    name: 'Taylor & Francis',
    selectors: [
      'a[href*="/doi/pdf/"]',
      'a:has-text("PDF")',
      'a.download-pdf',
    ],
    paywallCheck: null,
  },

  // SCIRP / Hans (Chinese OA publishers)
  '10.12677': { name: 'SCIRP', selectors: ['a[href$=".pdf"]', 'a:has-text("PDF")', 'a:has-text("下载")'], paywallCheck: null },
  '10.4236': { name: 'SCIRP', selectors: ['a[href$=".pdf"]', 'a:has-text("PDF")', 'a:has-text("下载")'], paywallCheck: null },

  // ASBMB / JBC
  '10.1074': { name: 'JBC', selectors: ['a[href*="/doi/pdf/"]', 'a:has-text("PDF")'], paywallCheck: null },

  // Bentham
  '10.2174': { name: 'Bentham', selectors: ['a[href$=".pdf"]', 'a:has-text("PDF")'], paywallCheck: null },

  // Korean JMB
  '10.4014': { name: 'JMB', selectors: ['a[href$=".pdf"]', 'a:has-text("PDF")'], paywallCheck: null },

  // Chinese Journal of Biotechnology
  '10.13345': { name: '生物工程学报', selectors: ['a[href$=".pdf"]', 'a:has-text("PDF")', 'a:has-text("下载")', 'a:has-text("全文")'], paywallCheck: null },

  // Food Innovation
  '10.48130': { name: 'FIA', selectors: ['a[href$=".pdf"]', 'a:has-text("PDF")'], paywallCheck: null },

  // 通用回退
  '__generic__': {
    name: 'Generic',
    selectors: [
      'a[href$=".pdf"]',
      'a[href*="/pdf/"]',
      'a:has-text("PDF")',
      'a:has-text("Download PDF")',
      'a:has-text("View PDF")',
      'a:has-text("Download")',
      'a:has-text("全文")',
      '[data-type="pdf"]',
      '.pdf-link',
      '#pdfLink',
      'a[aria-label*="PDF" i]',
      'a[title*="PDF" i]',
    ],
    paywallCheck: null,
  },
};

// ============================================================
// 工具函数
// ============================================================
function getStrategy(doi) {
  for (const [prefix, strategy] of Object.entries(PUBLISHER_STRATEGIES)) {
    if (prefix === '__generic__') continue;
    if (doi && doi.startsWith(prefix)) return { ...strategy, prefix };
  }
  return { ...PUBLISHER_STRATEGIES['__generic__'], prefix: 'generic' };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFilename(title, maxLen) {
  // Remove characters that are invalid in Windows filenames
  let s = title.replace(/[<>:"/\\|?*]/g, '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Replace Unicode en/em dashes
  s = s.replace(/[‒-―]/g, '-');
  // Truncate
  if (s.length > maxLen) {
    s = s.substring(0, maxLen);
    // Try to cut at a word boundary
    const lastSpace = s.lastIndexOf(' ');
    if (lastSpace > maxLen * 0.6) s = s.substring(0, lastSpace);
  }
  return s;
}

async function takeScreenshot(page, num, label) {
  if (!fs.existsSync(CONFIG.SCREENSHOT_DIR)) {
    fs.mkdirSync(CONFIG.SCREENSHOT_DIR, { recursive: true });
  }
  const filepath = path.join(CONFIG.SCREENSHOT_DIR, `${String(num).padStart(3, '0')}_${label}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  log(`Screenshot saved: ${filepath}`);
  return filepath;
}

function validatePDF(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 5000) {
      return { valid: false, reason: `File too small: ${buf.length} bytes` };
    }
    const header = buf.slice(0, 5).toString();
    if (!header.startsWith('%PDF')) {
      const preview = buf.slice(0, 500).toString('utf-8');
      if (preview.includes('<!DOCTYPE') || preview.includes('<html') || preview.includes('<HTML')) {
        return { valid: false, reason: 'File is HTML, likely paywall/login page' };
      }
      return { valid: false, reason: `Not a PDF (header: ${JSON.stringify(header)})` };
    }
    return { valid: true, size: buf.length };
  } catch (e) {
    return { valid: false, reason: `Cannot read file: ${e.message}` };
  }
}

// ============================================================
// 核心下载逻辑
// ============================================================
async function downloadPaper(page, paper, progress) {
  const num = parseInt(paper.num, 10);
  const numStr = String(num).padStart(3, '0');
  const doi = paper.doi_url ? paper.doi_url.replace('https://doi.org/', '') : '';
  const doiUrl = paper.doi_url || `https://doi.org/${doi}`;
  const title = paper.title || '';
  const strategy = getStrategy(doi);

  log(`[#${numStr}] ===== ${title.substring(0, 80)} =====`);
  log(`[#${numStr}] Publisher: ${strategy.name} | DOI: ${doi}`);

  const progressKey = `num_${num}`;
  if (progress.papers[progressKey] && progress.papers[progressKey].status === 'completed') {
    log(`[#${numStr}] Already completed, skipping.`);
    return { status: 'skipped', reason: 'already completed' };
  }

  progress.papers[progressKey] = {
    num, title, doi, status: 'in_progress',
    started_at: new Date().toISOString(), retries: 0,
  };
  saveProgress(progress);

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      log(`[#${numStr}] Attempt ${attempt}/${CONFIG.MAX_RETRIES}`);

      // 导航到 DOI
      await page.goto(doiUrl, {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.NAVIGATION_TIMEOUT_MS,
      });

      // 等待页面稳定
      try {
        await page.waitForLoadState('networkidle', { timeout: 15000 });
      } catch (e) {
        log(`[#${numStr}] Network idle timeout (soft), current URL: ${page.url()}`);
      }

      const finalUrl = page.url();
      log(`[#${numStr}] Final URL: ${finalUrl.substring(0, 100)}`);

      // 检查是否被重定向到非预期位置
      if (finalUrl.includes('doi.org') && !finalUrl.includes('doi.org/10.')) {
        log(`[#${numStr}] DOI resolution may have stalled`);
      }

      // 检查付费墙
      if (strategy.paywallCheck) {
        const isPaywalled = await strategy.paywallCheck(page);
        if (isPaywalled) {
          await takeScreenshot(page, num, 'paywall');
          throw new Error('PAYWALL_DETECTED: VPN may not be active or this journal is not subscribed');
        }
      }

      // 尝试直接 PDF URL 模式 (MDPI)
      if (strategy.directPdfPattern && paper.candidate_pdf_links) {
        const pdfLink = paper.candidate_pdf_links.split(';')
          .find(l => l.includes('mdpi.com') || l.includes('.pdf'));
        if (pdfLink) {
          try {
            log(`[#${numStr}] Trying direct PDF URL: ${pdfLink.trim()}`);
            const result = await downloadViaDirectURL(page, pdfLink.trim(), numStr, title);
            if (result) {
              progress.papers[progressKey].status = 'completed';
              progress.papers[progressKey].pdf_path = result.filename;
              progress.papers[progressKey].bytes = result.size;
              saveProgress(progress);
              return { status: 'completed', filename: result.filename, size: result.size };
            }
          } catch (e) {
            log(`[#${numStr}] Direct URL failed: ${e.message}, trying selectors...`);
          }
        }
      }

      // 尝试选择器
      let downloaded = false;
      for (const selector of strategy.selectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            log(`[#${numStr}] Found element with selector: ${selector}`);
            const result = await clickAndDownload(page, selector, numStr, title);
            if (result) {
              downloaded = true;
              progress.papers[progressKey].status = 'completed';
              progress.papers[progressKey].pdf_path = result.filename;
              progress.papers[progressKey].bytes = result.size;
              saveProgress(progress);
              return { status: 'completed', filename: result.filename, size: result.size };
            }
          }
        } catch (e) {
          log(`[#${numStr}] Selector "${selector}" failed: ${e.message}`);
        }
      }

      // 如果所有选择器都失败，尝试更激进的方法
      if (!downloaded) {
        log(`[#${numStr}] No selector matched. Trying text-based search...`);
        try {
          const result = await page.evaluate(() => {
            const links = document.querySelectorAll('a');
            for (const a of links) {
              const text = (a.textContent || '').toLowerCase();
              const href = (a.href || '').toLowerCase();
              if ((text.includes('pdf') || text.includes('download')) && href.includes('pdf')) {
                return a.href;
              }
            }
            return null;
          });
          if (result) {
            log(`[#${numStr}] Found PDF link via JS: ${result}`);
            const dlResult = await downloadViaDirectURL(page, result, numStr, title);
            if (dlResult) {
              progress.papers[progressKey].status = 'completed';
              progress.papers[progressKey].pdf_path = dlResult.filename;
              progress.papers[progressKey].bytes = dlResult.size;
              saveProgress(progress);
              return { status: 'completed', filename: dlResult.filename, size: dlResult.size };
            }
          }
        } catch (e) {
          log(`[#${numStr}] JS search failed: ${e.message}`);
        }

        throw new Error('NO_PDF_FOUND: No download button or link matched');
      }

    } catch (err) {
      log(`[#${numStr}] ERROR: ${err.message}`);
      progress.papers[progressKey].retries = attempt;
      progress.papers[progressKey].last_error = err.message;
      saveProgress(progress);

      if (attempt < CONFIG.MAX_RETRIES) {
        const waitMs = CONFIG.DELAY_BETWEEN_PAPERS_MS * attempt;
        log(`[#${numStr}] Retrying in ${waitMs / 1000}s...`);
        await sleep(waitMs);
      }
    }
  }

  // 所有重试失败
  await takeScreenshot(page, num, 'failed');
  progress.papers[progressKey].status = 'failed';
  progress.papers[progressKey].last_error = 'All retries exhausted';
  saveProgress(progress);
  return { status: 'failed', reason: progress.papers[progressKey].last_error };
}

async function clickAndDownload(page, selector, numStr, title) {
  const downloadPromise = page.waitForEvent('download', { timeout: CONFIG.DOWNLOAD_TIMEOUT_MS });

  // 点击
  await page.click(selector);

  const download = await downloadPromise;
  const suggestedName = download.suggestedFilename();

  // 构建目标文件名
  const ext = path.extname(suggestedName) || '.pdf';
  const safeTitle = sanitizeFilename(title, CONFIG.MAX_FILENAME_LEN - 8);
  let filename = `${numStr}_${safeTitle}${ext}`;
  // 确保不超长
  if (filename.length > 255) {
    filename = `${numStr}_${safeTitle.substring(0, 200)}${ext}`;
  }

  const targetPath = path.join(CONFIG.OUTPUT_DIR, filename);
  await download.saveAs(targetPath);

  // 验证 PDF
  const validation = validatePDF(targetPath);
  if (!validation.valid) {
    log(`[#${numStr}] PDF validation failed: ${validation.reason}`);
    // 删除无效文件
    fs.unlinkSync(targetPath);
    return null;
  }

  log(`[#${numStr}] Downloaded: ${validation.size} bytes -> ${filename}`);
  updateCSVRow(parseInt(numStr, 10), 'downloaded_valid_pdf',
    `${filename}; ${validation.size} bytes`);

  return { filename, size: validation.size };
}

async function downloadViaDirectURL(page, url, numStr, title) {
  // 导航到 PDF URL 并等待下载事件
  const downloadPromise = page.waitForEvent('download', { timeout: CONFIG.DOWNLOAD_TIMEOUT_MS });

  await page.goto(url, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});

  try {
    const download = await downloadPromise;
    const safeTitle = sanitizeFilename(title, CONFIG.MAX_FILENAME_LEN - 8);
    const filename = `${numStr}_${safeTitle}.pdf`;
    const targetPath = path.join(CONFIG.OUTPUT_DIR, filename);
    await download.saveAs(targetPath);

    const validation = validatePDF(targetPath);
    if (!validation.valid) {
      log(`[#${numStr}] Direct URL PDF validation failed: ${validation.reason}`);
      fs.unlinkSync(targetPath);
      return null;
    }

    log(`[#${numStr}] Direct download: ${validation.size} bytes -> ${filename}`);
    updateCSVRow(parseInt(numStr, 10), 'downloaded_valid_pdf',
      `${filename}; ${validation.size} bytes`);
    return { filename, size: validation.size };
  } catch (e) {
    return null;
  }
}

// ============================================================
// 等待用户处理 CAPTCHA
// ============================================================
async function checkForCaptcha(page) {
  const captchaIndicators = [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    '#captcha',
    '.g-recaptcha',
    'div[class*="cf-turnstile"]',
    '[data-sitekey]',
    'iframe[title*="captcha" i]',
    'iframe[title*="reCAPTCHA" i]',
  ];

  for (const selector of captchaIndicators) {
    const el = await page.$(selector);
    if (el) {
      return selector;
    }
  }
  return null;
}

async function waitForUserIfCaptcha(page, num) {
  const captcha = await checkForCaptcha(page);
  if (captcha) {
    log(`[#${String(num).padStart(3, '0')}] ⚠ CAPTCHA detected! Selector: ${captcha}`);
    console.log('\n========================================');
    console.log('  CAPTCHA 检测到! 请在浏览器中手动完成验证');
    console.log('  完成后按 Enter 继续...');
    console.log('========================================\n');

    // Wait for user input
    await new Promise(resolve => {
      process.stdin.once('data', () => resolve());
    });

    // Wait for page to recover after captcha
    await sleep(3000);
    return true;
  }
  return false;
}

// ============================================================
// 主循环
// ============================================================
async function main() {
  log('========== download_papers.js 启动 ==========');
  log(`输出目录: ${CONFIG.OUTPUT_DIR}`);
  log(`Headless: ${CONFIG.HEADLESS}`);

  // 解析命令行参数
  const args = process.argv.slice(2);
  const modeTestPublishers = args.includes('--test-publishers');
  const testOneIdx = args.indexOf('--test-one');
  const testOneNum = testOneIdx >= 0 ? parseInt(args[testOneIdx + 1], 10) : null;
  const fromIdx = args.indexOf('--from');
  const fromNum = fromIdx >= 0 ? parseInt(args[fromIdx + 1], 10) : null;

  // 加载数据
  const rows = readCSV();
  log(`从 CSV 加载了 ${rows.length} 条记录`);

  // 筛选需要下载的论文
  const needDownload = rows.filter(r => {
    const status = r.status || '';
    return [
      'no_public_pdf_candidate_in_openalex',
      'public_pdf_candidate_failed_or_blocked',
      'openalex_not_matched',
      'manual_access_page_only',
    ].includes(status);
  });

  log(`需要下载的论文: ${needDownload.length} 篇`);

  // 测试模式过滤
  let papers = needDownload;
  if (testOneNum) {
    papers = needDownload.filter(r => parseInt(r.num, 10) === testOneNum);
    log(`测试模式 --test-one ${testOneNum}: 仅下载 ${papers.length} 篇`);
  } else if (modeTestPublishers) {
    // 每类出版商只取第一篇
    const publisherSeen = new Set();
    papers = [];
    for (const p of needDownload) {
      const doi = (p.doi_url || '').replace('https://doi.org/', '');
      const s = getStrategy(doi);
      if (!publisherSeen.has(s.prefix)) {
        publisherSeen.add(s.prefix);
        papers.push(p);
      }
    }
    log(`测试模式 --test-publishers: 每类出版商1篇，共 ${papers.length} 篇`);
  } else if (fromNum) {
    papers = needDownload.filter(r => parseInt(r.num, 10) >= fromNum);
    log(`从 num=${fromNum} 开始，剩余 ${papers.length} 篇`);
  }

  if (papers.length === 0) {
    log('没有需要下载的论文，退出。');
    flushLog();
    return;
  }

  // 加载进度
  const progress = loadProgress();

  // 启动浏览器
  log('启动 Chromium...');
  const userDataDir = path.join(CONFIG.PROJECT_DIR, 'browser_profile');
  const browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: CONFIG.HEADLESS,
    acceptDownloads: true,
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await browserContext.newPage();

  // 处理可能弹出的 cookie 弹窗
  page.on('dialog', async dialog => {
    log(`Dialog: ${dialog.message()}`);
    await dialog.accept();
  });

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const startTime = Date.now();

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    const num = parseInt(paper.num, 10);

    log(`\n--- [${i + 1}/${papers.length}] Paper #${num} ---`);

    // 检查是否已完成
    const progressKey = `num_${num}`;
    if (progress.papers[progressKey] && progress.papers[progressKey].status === 'completed') {
      skipped++;
      log(`[#${String(num).padStart(3, '0')}] 已在进度文件中标记完成，跳过`);
      continue;
    }

    // 检查 CAPTCHA
    const hadCaptcha = await waitForUserIfCaptcha(page, num);
    if (hadCaptcha) {
      log(`[#${String(num).padStart(3, '0')}] CAPTCHA 已处理后继续`);
    }

    // 下载
    const result = await downloadPaper(page, paper, progress);

    if (result.status === 'completed') {
      completed++;
      // CSV 在 downloadPaper 中已更新
    } else if (result.status === 'skipped') {
      skipped++;
    } else {
      failed++;
    }

    // 进度报告
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`进度: ${completed} 完成, ${failed} 失败, ${skipped} 跳过 | 耗时: ${elapsed}s`);

    // 速率限制延迟
    if (i < papers.length - 1) {
      await sleep(CONFIG.DELAY_BETWEEN_PAPERS_MS);
    }

    // 定期 flush 日志
    if (i % 5 === 0) flushLog();
  }

  // 总结
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const elapsedMin = Math.floor(elapsed / 60);
  const elapsedSec = elapsed % 60;
  log('\n========== 下载完成 ==========');
  log(`总计: ${papers.length} 篇 | 完成: ${completed} | 失败: ${failed} | 跳过: ${skipped}`);
  log(`耗时: ${elapsedMin}m ${elapsedSec}s`);

  await browserContext.close();
  flushLog();

  console.log('\n===================================');
  console.log(`  完成: ${completed} | 失败: ${failed} | 跳过: ${skipped}`);
  console.log(`  详细日志: ${CONFIG.LOG_FILE}`);
  console.log(`  进度文件: ${CONFIG.PROGRESS_FILE}`);
  console.log('===================================');
}

main().catch(err => {
  console.error('Fatal error:', err);
  log(`FATAL: ${err.message}`);
  flushLog();
  process.exit(1);
});
