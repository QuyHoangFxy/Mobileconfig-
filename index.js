const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

let puppeteer = null;
let stealthPluginLoaded = false;
try {
  puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  stealthPluginLoaded = true;
  console.log('[OK] Puppeteer + Stealth đã sẵn sàng');
} catch (e) {
  console.log('[WARN] Puppeteer chưa cài được. Sẽ dùng axios cho tất cả.');
}

const CONFIG = Object.freeze({
  PORT: process.env.PORT || 3000,
  TIMEOUT_MS: 60000,
  BROWSER_IDLE_MS: 30000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
});

const BROWSER_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0'
});

const log = {
  info:  (msg, ...a) => CONFIG.LOG_LEVEL !== 'silent' && console.log(`[INFO] ${msg}`, ...a),
  warn:  (msg, ...a) => CONFIG.LOG_LEVEL !== 'silent' && console.warn(`[WARN] ${msg}`, ...a),
  error: (msg, ...a) => console.error(`[ERROR] ${msg}`, ...a)
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

async function getBrowser() {
  if (!puppeteer) {
    throw new BypassError('Puppeteer chưa được cài. Chỉ dùng được Layma/Site2s.', 'NO_PUPPETEER');
  }

  const now = Date.now();

  if (browserInstance && browserInstance.connected) {
    if (now - browserLastUsed > CONFIG.BROWSER_IDLE_MS) {
      log.info('Đóng browser idle, tạo mới...');
      try { await browserInstance.close(); } catch (_) {}
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
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--js-flags=--max-old-space-size=128'
    ]
  });

  browserInstance = await browserLaunching;
  browserLaunching = null;
  browserLastUsed = Date.now();
  log.info('Browser đã khởi động');
  return browserInstance;
}

async function bypassLink4m(url) {
  log.info(`Link4m: ${url}`);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 800, height: 600 });
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    log.info('Link4m: đang tải trang...');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.TIMEOUT_MS });

    log.info('Link4m: chờ nút "Lấy link"...');
    const finalUrl = await page.waitForFunction(
      () => {
        const selectors = ['#btn6', 'a#btn6', 'a.get-link', 'a#continue', 'a.btn-primary', 'a.btn'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.href && el.href.startsWith('http') && !el.href.includes('link4m')) {
            return el.href;
          }
        }
        return null;
      },
      { timeout: CONFIG.TIMEOUT_MS, polling: 1000 }
    ).then(h => h.jsonValue());

    if (!finalUrl) throw new BypassError('Không tìm thấy link đích.', 'NOT_FOUND');

    log.info(`Link4m: OK → ${finalUrl}`);
    return finalUrl;

  } finally {
    try { await page.close(); } catch (_) {}
  }
}

async function bypassGeneric(url, excludeDomain, siteName) {
  log.info(`${siteName}: ${url}`);

  let response;
  try {
    response = await axios.get(url, {
      headers: { ...BROWSER_HEADERS, 'Referer': 'https://www.google.com/' },
      maxRedirects: 5,
      timeout: 15000,
      validateStatus: (s) => s < 500
    });
  } catch (err) {
    throw new BypassError(`Không kết nối được ${siteName}: ${err.message}`, 'NETWORK');
  }

  log.info(`${siteName}: HTTP ${response.status}`);

  if (response.status === 403) {
    throw new BypassError(`${siteName} đã bật Cloudflare (403).`, 'FORBIDDEN');
  }
  if (response.status === 404) {
    throw new BypassError(`Link ${siteName} không tồn tại.`, 'NOT_FOUND');
  }
  if (response.status >= 400) {
    throw new BypassError(`${siteName} trả về HTTP ${response.status}.`, 'HTTP_ERROR');
  }

  const $ = cheerio.load(response.data);
  const selectors = [
    'a#btn6', 'a.get-link', 'a#continue', 'a.btn-primary',
    `a[href*="http"]:not([href*="${excludeDomain}"])`
  ];

  for (const sel of selectors) {
    const link = $(sel).attr('href');
    if (link && link.startsWith('http') && !link.includes(excludeDomain)) {
      log.info(`${siteName}: OK → ${link}`);
      return link;
    }
  }

  throw new BypassError(`Không tìm thấy link đích trong ${siteName}.`, 'SELECTOR');
}

const bypassLayma = (url) => bypassGeneric(url, 'layma.net', 'Layma.net');
const bypassSite2s = (url) => bypassGeneric(url, 'site2s.com', 'Site2s.com');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/bypass', async (req, res) => {
  const { service, url } = req.body || {};

  if (typeof service !== 'string' || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'Dữ liệu không hợp lệ.' });
  }
  if (url.length > 2000) {
    return res.status(400).json({ success: false, error: 'URL quá dài.' });
  }
  if (!url.startsWith('https://')) {
    return res.status(400).json({ success: false, error: 'URL phải bắt đầu bằng https://' });
  }

  log.info(`Yêu cầu: ${service} → ${url}`);

  try {
    let finalUrl;
    switch (service) {
      case 'Link4m':      finalUrl = await bypassLink4m(url); break;
      case 'Layma.net':   finalUrl = await bypassLayma(url); break;
      case 'Site2s.com':  finalUrl = await bypassSite2s(url); break;
      default:
        return res.status(400).json({
          success: false,
          error: `Chưa hỗ trợ: ${service}. Hiện có: Link4m, Layma.net, Site2s.com`
        });
    }
    res.json({ success: true, finalUrl });

  } catch (err) {
    if (err instanceof BypassError) {
      log.warn(`Thất bại [${err.code}]: ${err.message}`);
      return res.status(422).json({ success: false, error: err.message, code: err.code });
    }
    log.error('Lỗi không xác định:', err.message);
    res.status(500).json({ success: false, error: 'Lỗi server không xác định.' });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    puppeteer: !!puppeteer,
    stealth: stealthPluginLoaded
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(CONFIG.PORT, () => {
  log.info(`Server chạy tại port ${CONFIG.PORT}`);
  log.info(`Puppeteer: ${puppeteer ? 'BẬT' : 'TẮT'}`);
});

process.on('SIGTERM', async () => {
  log.info('Đang tắt server...');
  if (browserInstance) {
    try { await browserInstance.close(); } catch (_) {}
  }
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  log.error('Lỗi không bắt được:', err.message);
});

process.on('unhandledRejection', (err) => {
  log.error('Promise bị reject:', err);
});
