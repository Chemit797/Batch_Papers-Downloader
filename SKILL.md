---
name: literature-download
description: Trigger when the user needs to batch download academic papers (PDFs) from DOIs, RIS/BibTeX files, or a reading list — especially for literature reviews, systematic reviews, meta-analyses, or building a paper collection. Also trigger when the user mentions "download papers", "get PDFs", "collect literature", "pull references", or any variation of bulk academic PDF acquisition.
---

# Literature Batch Download — Multi-Tier Strategy

Systematic bulk downloading of academic PDFs using a 4-tier graceful degradation strategy: **OpenAlex OA → Sci-Hub → institutional VPN/Playwright → manual fallback**.

## Core Principle: Degrade Gracefully

**Never rely on a single method.** Execute in order — each tier catches what the previous tier couldn't.

```
Tier 1: OpenAlex OA direct links     → Free, fastest, legal (30-40% expected)
Tier 2: Sci-Hub                      → Closed-access主力 (50-60% more)
Tier 3: Institutional VPN + Browser  → Last resort paywall breaker (5-10%)
Tier 4: Manual fallback              → Chinese journals, edge cases (1-5%)
```

## Phase 0: Input Processing

### Acceptable inputs
- A `.ris` file (exported from PubMed, Web of Science, Scopus, EndNote, Zotero)
- A `.bib` file (BibTeX)
- A CSV with columns: `num, doi, title`
- A plain text list of DOIs (one per line)
- A folder path containing PDFs already partially downloaded (resume mode)

### MANDATORY: DOI sanitization (do NOT skip this step)

Before ANY download attempt, clean every DOI:
```
Remove: surrounding quotes, angle brackets < >, parentheses, trailing punctuation
Fix:   URL-encoded characters → decode (%28 → (, %29 → ))
Flag:  DOIs NOT matching 10.XXXX/YYYY pattern for manual review
       Old papers (pre-2000) often have non-standard DOIs
```

Create a **single CSV** (`progress.csv`) as the source of truth:
```csv
num,status,title,doi,sanitized_doi,method,note
1,pending,"Paper Title Here","10.xxx/yyy","10.xxx/yyy",,
2,pending,"Another Paper","10.aaa/bbb","10.aaa/bbb",,
```

**Status values** (strict enum):
| Status | Meaning |
|:---|:---|
| `pending` | Initial state, not yet processed |
| `oa_matched` | OpenAlex found an OA copy, download pending |
| `downloaded_oa` | Successfully downloaded via OpenAlex |
| `downloaded_scihub` | Successfully downloaded via Sci-Hub |
| `downloaded_vpn` | Successfully downloaded via VPN + browser |
| `downloaded_manual` | Manually retrieved |
| `failed_doi_malformed` | DOI cannot be resolved by any service |
| `failed_not_found` | No source has this paper |
| `failed_paywall` | Behind paywall, VPN couldn't access |
| `failed_captcha` | Blocked by CAPTCHA or anti-bot |

## Phase 1: OpenAlex OA Matching (TIER 1 — run first)

```javascript
// Query OpenAlex for each DOI
const url = `https://api.openalex.org/works/doi:${doi}`;
const resp = await fetch(url);
const data = await resp.json();

if (data.open_access) {
  // oa_status: 'gold' | 'green' | 'hybrid' | 'bronze' | 'closed'
  // Check: data.open_access.oa_url  (often a direct PDF)
  // Check: data.best_oa_location?.pdf_url
  // For green OA: often PMC links like https://www.ncbi.nlm.nih.gov/pmc/...
}
```

**Rules:**
- `gold` / `hybrid` → almost always has a direct PDF URL → download immediately
- `green` → check the repository URL (PMC, institutional repo); may need to navigate one level
- `bronze` → publisher-hosted free; usually a direct PDF
- `closed` → no OA available → mark `oa_closed`, move to Tier 2
- If OpenAlex can't match the DOI at all → mark `failed_doi_malformed`, move to Tier 4

**Publishers that are ALWAYS gold OA** (openalex will confirm):
MDPI, Frontiers, PLOS, BMC/SpringerOpen, eLife, PeerJ

## Phase 2: Sci-Hub (TIER 2 — main force)

For all papers marked `oa_closed` from Phase 1:

```javascript
// Maintain a list of active Sci-Hub domains (they rotate frequently)
const SCIHUB_MIRRORS = [
  'https://sci-hub.se',
  'https://sci-hub.ru',
  'https://sci-hub.st',
];

// For each DOI, try mirrors in sequence
async function scihubDownload(doi) {
  for (const mirror of SCIHUB_MIRRORS) {
    const pdfUrl = `${mirror}/${doi}`;
    // Navigate, find the embedded PDF iframe or direct link
    // The PDF is typically in an <iframe> or <embed> with src ending .pdf
  }
}
```

**Sci-Hub coverage notes:**
- ✅ Excellent: papers 2000–2022 from major publishers (Elsevier, Springer, Wiley, ACS, Oxford, Nature)
- ⚠️ Spotty: papers before ~1995, very obscure journals
- ❌ Missing: papers published in the last 6–12 months, some Nature 2023+, Chinese journals
- ❌ Skipped: book chapters, conference proceedings without DOI

**Verification after download:**
- Check file header: first 4 bytes must be `%PDF`
- Check file size: > 10KB (anything smaller is likely an error page or HTML)
- Update CSV: `downloaded_scihub` + file size

## Phase 3: Institutional VPN + Playwright Browser (TIER 3)

For papers that Sci-Hub couldn't get. **This is expensive and slow — only use when necessary.**

### Prerequisites (tell the user):
```
1. Institution VPN must be CONNECTED (e.g., XMU VPN, CARSI)
2. Chrome must be running with: --remote-debugging-port=9222
3. The user must already be LOGGED IN to the publisher via the VPN
4. headless: false is recommended (to handle unexpected CAPTCHA)
```

### Publisher prefix configuration

Maintain a `publisher_prefixes.json`:
```json
{
  "10.1007": {
    "name": "Springer",
    "prefix": "https://webvpn.xxx.edu.cn/https/...",
    "articlePath": "/article/{doi}",
    "pdfPattern": "a[href*='.pdf']"
  },
  "10.1016": {
    "name": "Elsevier/ScienceDirect",
    "prefix": "https://webvpn.xxx.edu.cn/https/...",
    "articlePath": "/science/article/pii/{doi_suffix}",
    "pdfPattern": "a[href*='/science/article/pii/']"
  }
}
```

### Browser automation pattern (Playwright via CDP):

```javascript
const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.contexts()[0].newPage();

// Navigate to article page via VPN prefix
await page.goto(vpnPrefix + articlePath, { waitUntil: 'domcontentloaded' });

// Detect paywall
const blocked = await page.evaluate(() => {
  const body = document.body.innerText.toLowerCase();
  return ['buy article', 'get access', 'purchase', 'subscribe', 'log in']
    .some(w => body.includes(w));
});
if (blocked) return { status: 'failed_paywall' };

// Find and fetch PDF (in-page fetch preserves VPN session)
const pdfBase64 = await page.evaluate(async (pdfUrl) => {
  const resp = await fetch(pdfUrl);
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}, pdfUrl);

// Verify PDF header
const buf = Buffer.from(pdfBase64, 'base64');
if (buf.slice(0, 4).toString() !== '%PDF') return { status: 'failed' };
```

### Critical rules for Tier 3:
1. **Test 1-2 papers per publisher before batch running** — each publisher has different page structure
2. **Delay ≥ 5 seconds between papers** — avoid triggering anti-bot
3. **Keep headless: false** — you need to see CAPTCHAs
4. **The user must be at the keyboard** — CAPTCHAs and VPN re-login require human intervention

## Phase 4: Manual Fallback (TIER 4)

For the remaining 1-5%:
- Chinese journals → CNKI, 万方, 维普 (need separate access)
- Pre-1995 papers without digital DOIs → scan by library
- Truly uncrackable paywalls → inter-library loan or contact authors

Mark these in CSV with specific reasons for future reference.

## File Naming Convention

```
{3-digit-num}_{title_truncated}.pdf

Rules:
- Title truncated to 230 chars max (filesystem limit)
- Remove characters: < > : " / \ | ? *
- Replace multiple spaces with single space
- Trim at last complete word if truncated
```

## Resume / Incremental Mode

If the user provides a folder with existing PDFs:
1. Scan for `{num}_*.pdf` files
2. Cross-reference with CSV
3. Mark already-downloaded as `downloaded_*` in CSV
4. Only process `pending` entries

## Publisher Quick Reference

| DOI prefix | Publisher | Typical OA | Best method |
|:---|:---|:---|:---|
| `10.3390/` | MDPI | Gold | OpenAlex direct |
| `10.3389/` | Frontiers | Gold | OpenAlex direct |
| `10.1186/` | BMC/SpringerOpen | Gold | OpenAlex direct |
| `10.1371/` | PLOS | Gold | OpenAlex direct |
| `10.1038/` | Nature | Closed/Hybrid | Sci-Hub |
| `10.1007/` | Springer | Closed/Hybrid | Sci-Hub |
| `10.1016/` | Elsevier | Closed/Hybrid | Sci-Hub |
| `10.1002/` | Wiley | Closed/Hybrid | Sci-Hub (watch malformed DOIs) |
| `10.1021/` | ACS | Mostly closed | Sci-Hub |
| `10.1128/` | ASM | Green (2yr embargo) | OpenAlex PMC after 2yr |
| `10.1093/` | Oxford | Mixed | Sci-Hub |
| `10.1073/` | PNAS | Mixed | Sci-Hub |
| `10.13345/` | 中文期刊(生物工程学报) | Closed | Manual (CNKI) |

## Journal-specific Tricks

**ASM Journals (AEM, JB, AAC, etc.):**
- After 2-year embargo → PubMed Central full text available
- Construct: `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmcid}/pdf/`

**Nature Publishing:**
- Some papers have a free "SharedIt" link → check OpenAlex `best_oa_location`
- 2023+ papers increasingly blocked on Sci-Hub

**ScienceDirect (Elsevier):**
- Rarely OA unless the author paid for gold
- The `/science/article/pii/` path pattern is reliable for VPN navigation

**Wiley Online Library:**
- DOIs often contain garbled characters from RIS export
- Always check: `10.1002/(ISSN)1521-3773` style DOIs may need manual fixing

## Output at Session End

Produce a summary table:
```
| Status | Count |
|:---|---:|
| Downloaded (OA) | XX |
| Downloaded (Sci-Hub) | XX |
| Downloaded (VPN) | XX |
| Failed — DOI malformed | XX |
| Failed — Not found | XX |
| Failed — Paywall | XX |
| **Total** | **XX** |
```

And a list of failed papers with specific reasons + recommended next action for each.

## Important Constraints

1. **Respect rate limits** — OpenAlex: 10 req/s max; Sci-Hub: 1 req/5s; VPN: 1 req/8s minimum
2. **Verify every PDF** — check `%PDF` header; don't trust file extensions
3. **Keep the CSV updated** after every single download (not batch at end)
4. **Save progress.json** for resume capability on long sessions
5. **Never guess** — if a DOI can't be resolved, mark it `failed` and explain why; don't invent a different paper
