const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

let puppeteer = null;
let stealthLoaded = false;

try {
  puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  stealthLoaded = true;
  console.log('[OK] Puppeteer + Stealth loaded');
} catch (e) {
  console.log('[WARN] Puppeteer not available');
}

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 60000;
const BROWSER_IDLE_MS = 30000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.7'
};

class BypassError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BypassError';
    this.code = code || 'UNKNOWN';
  }
}

let browserInstance = null;
let browserLastUsed = 0;
let browserLaunching = null;

// ============================================================
// HÀM QUAN TRỌNG: TỰ ĐỘNG TẢI CHROME NẾU CHƯA CÓ
// ============================================================
async function ensureChromeInstalled() {
  const fs = require('fs');
  const path = require('path');

  const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(process.cwd(), '.cache', 'puppeteer');

  console.log('[INFO] Kiểm tra Chrome tại: ' + cacheDir);

  if (fs.existsSync(cacheDir)) {
    const dirs = fs.readdirSync(cacheDir).filter(d => d.startsWith('chrome'));
    if (dirs.length > 0) {
      console.log('[OK] Chrome đã có sẵn: ' + dirs.join(', '));
      return true;
    }
  }

  console.log('[INFO] Chrome chưa có, đang tải (~350MB, có thể mất 3-5 phút)...');

  try {
    const { execSync } = require('child_process');
    execSync('npx puppeteer browsers install chrome', {
      stdio: 'inherit',
      timeout: 600000
    });
    console.log('[OK] Chrome đã tải xong');
    return true;
  } catch (err) {
    console.error('[ERROR] Không tải được Chrome: ' + err.message);
    return false;
  }
}

async function getBrowser() {
  if (!puppeteer) {
    throw new BypassError('Puppeteer chưa cài.', 'NO_PUPPETEER');
  }

  const now = Date.now();

  if (browserInstance && browserInstance.connected) {
    if (now - browserLastUsed > BROWSER_IDLE_MS) {
      try { await browserInstance.close(); } catch (e) {}
      browserInstance = null;
    } else {
      browserLastUsed = now;
      return browserInstance;
    }
  }

  if (browserLaunching) return browserLaunching;

  browserLaunching = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-blink-features=AutomationControlled',
      '--window-size=800,600',
      '--disable-features=TranslateUI',
      '--js-flags=--max-old-space-size=128'
    ]
  });

  try {
    browserInstance = await browserLaunching;
    browserLastUsed = Date.now();
    console.log('[OK] Browser launched');
    return browserInstance;
  } catch (err) {
    browserLaunching = null;
    browserInstance = null;
    throw new BypassError('Không khởi động được browser: ' + err.message, 'LAUNCH_FAILED');
  } finally {
    browserLaunching = null;
  }
}

// ============================================================
// CÁC HÀM BYPASS (giữ nguyên)
// ============================================================
async function bypassLink4m(url) {
  console.log('[INFO] Link4m: ' + url);

  // Đảm bảo Chrome đã có trước khi launch
  await ensureChromeInstalled();

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 800, height: 600 });
    await page.setUserAgent(HEADERS['User-Agent']);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].indexOf(type) !== -1) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

    const handle = await page.waitForFunction(
      function () {
        var selectors = ['#btn6', 'a#btn6', 'a.get-link', 'a#continue', 'a.btn-primary', 'a.btn'];
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el && el.href && el.href.indexOf('http') === 0 && el.href.indexOf('link4m') === -1) {
            return el.href;
          }
        }
        return null;
      },
      { timeout: TIMEOUT_MS, polling: 1000 }
    );

    const finalUrl = await handle.jsonValue();
    if (!finalUrl) throw new BypassError('Không tìm thấy link đích.', 'NOT_FOUND');

    console.log('[OK] Link4m: ' + finalUrl);
    return finalUrl;

  } finally {
    try { await page.close(); } catch (e) {}
  }
}

async function bypassGeneric(url, excludeDomain, siteName) {
  console.log('[INFO] ' + siteName + ': ' + url);

  let response;
  try {
    response = await axios.get(url, {
      headers: Object.assign({}, HEADERS, { 'Referer': 'https://www.google.com/' }),
      maxRedirects: 5,
      timeout: 20000,
      validateStatus: function (s) { return s < 500; }
    });
  } catch (err) {
    throw new BypassError('Không kết nối được ' + siteName + ': ' + err.message, 'NETWORK');
  }

  if (response.status === 403) throw new BypassError(siteName + ' chặn (403).', 'FORBIDDEN');
  if (response.status === 404) throw new BypassError('Link không tồn tại.', 'NOT_FOUND');
  if (response.status >= 400) throw new BypassError(siteName + ' HTTP ' + response.status, 'HTTP_ERROR');

  const $ = cheerio.load(response.data);
  const selectors = ['a#btn6', 'a.get-link', 'a#continue', 'a.btn-primary'];

  for (let i = 0; i < selectors.length; i++) {
    const link = $(selectors[i]).attr('href');
    if (link && link.indexOf('http') === 0 && link.indexOf(excludeDomain) === -1) return link;
  }

  const allLinks = $('a[href]');
  for (let i = 0; i < allLinks.length; i++) {
    const href = $(allLinks[i]).attr('href');
    if (href && href.indexOf('http') === 0 && href.indexOf(excludeDomain) === -1) return href;
  }

  throw new BypassError('Không tìm thấy link đích.', 'SELECTOR');
}

const bypassLayma = (url) => bypassGeneric(url, 'layma.net', 'Layma.net');
const bypassSite2s = (url) => bypassGeneric(url, 'site2s.com', 'Site2s.com');

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/bypass', async function (req, res) {
  try {
    const body = req.body || {};
    const service = body.service;
    const url = body.url;

    if (typeof service !== 'string' || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'Dữ liệu không hợp lệ.' });
    }
    if (url.indexOf('https://') !== 0) {
      return res.status(400).json({ success: false, error: 'URL phải bắt đầu bằng https://' });
    }

    console.log('[INFO] Request: ' + service + ' -> ' + url);

    let finalUrl;
    if (service === 'Link4m') finalUrl = await bypassLink4m(url);
    else if (service === 'Layma.net') finalUrl = await bypassLayma(url);
    else if (service === 'Site2s.com') finalUrl = await bypassSite2s(url);
    else return res.status(400).json({ success: false, error: 'Chưa hỗ trợ: ' + service });

    return res.json({ success: true, finalUrl: finalUrl });

  } catch (err) {
    if (err instanceof BypassError) {
      return res.status(422).json({ success: false, error: err.message, code: err.code });
    }
    console.error('[ERROR] ' + err.message);
    return res.status(500).json({ success: false, error: 'Lỗi: ' + err.message });
  }
});

app.get('/health', function (req, res) {
  res.json({ status: 'ok', puppeteer: !!puppeteer });
});

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, function () {
  console.log('[OK] Server chạy tại port ' + PORT);
});

process.on('SIGTERM', async function () {
  if (browserInstance) {
    try { await browserInstance.close(); } catch (e) {}
  }
  server.close(function () { process.exit(0); });
});
