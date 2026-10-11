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
const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT) || 90000;
const MAX_URL_LENGTH = parseInt(process.env.MAX_URL_LENGTH) || 2000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 30;
const BROWSER_IDLE_MS = 300000;
const API_KEY = process.env.API_KEY || '';
const BLOCKED_IPS = (process.env.BLOCKED_IPS || '').split(',').filter(Boolean);

console.log('[INFO] NODE_ENV=' + NODE_ENV);
console.log('[INFO] LOG_LEVEL=' + LOG_LEVEL);
console.log('[INFO] TIMEOUT_MS=' + TIMEOUT_MS);
console.log('[INFO] RATE_LIMIT_MAX=' + RATE_LIMIT_MAX);
console.log('[INFO] API_KEY=' + (API_KEY ? 'BẬT' : 'TẮT'));

const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const currentLevel = levels[LOG_LEVEL] !== undefined ? levels[LOG_LEVEL] : 3;

const log = {
  error: (msg, ...a) => currentLevel >= 1 && console.error('[ERROR] ' + msg, ...a),
  warn:  (msg, ...a) => currentLevel >= 2 && console.warn('[WARN] ' + msg, ...a),
  info:  (msg, ...a) => currentLevel >= 3 && console.log('[INFO] ' + msg, ...a),
  debug: (msg, ...a) => currentLevel >= 4 && console.log('[DEBUG] ' + msg, ...a),
  timing: (msg) => currentLevel >= 3 && console.log('[TIMING] ' + msg)
};

class BypassError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BypassError';
    this.code = code || 'UNKNOWN';
  }
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
};

const ipRequests = new Map();
const RATE_WINDOW_MS = 60000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  if (!ipRequests.has(ip)) {
    ipRequests.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }

  const record = ipRequests.get(ip);
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + RATE_WINDOW_MS;
    return next();
  }

  record.count++;
  if (record.count > RATE_LIMIT_MAX) {
    log.warn('Rate limit exceeded: ' + ip);
    return res.status(429).json({
      success: false,
      error: 'Quá nhiều yêu cầu. Vui lòng đợi 1 phút.'
    });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipRequests.entries()) {
    if (now > record.resetAt) ipRequests.delete(ip);
  }
}, 300000);

function blockBadIPs(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  if (BLOCKED_IPS.length > 0 && BLOCKED_IPS.indexOf(ip) !== -1) {
    log.warn('Blocked IP: ' + ip);
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
}

function checkApiKey(req, res, next) {
  if (!API_KEY) return next();
  const clientKey = req.headers['x-api-key'] || req.query.key;
  if (clientKey !== API_KEY) {
    log.warn('Sai API key từ IP: ' + (req.ip || 'unknown'));
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

let browserInstance = null;
let browserLastUsed = 0;
let browserLaunching = null;

async function getBrowser() {
  if (!puppeteer) {
    throw new BypassError('Puppeteer chưa cài được.', 'NO_PUPPETEER');
  }

  const now = Date.now();

  if (browserInstance && browserInstance.connected) {
    if (now - browserLastUsed > BROWSER_IDLE_MS) {
      log.info('Đóng browser idle...');
      try { await browserInstance.close(); } catch (e) {}
      browserInstance = null;
    } else {
      browserLastUsed = now;
      return browserInstance;
    }
  }

  if (browserLaunching) return browserLaunching;

  const tLaunch = Date.now();
  log.info('Launching browser...');

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

  try {
    browserInstance = await browserLaunching;
    browserLastUsed = Date.now();
    log.timing('Browser launched in ' + (Date.now() - tLaunch) + 'ms');
    return browserInstance;
  } catch (err) {
    browserLaunching = null;
    browserInstance = null;
    throw new BypassError('Không khởi động được browser: ' + err.message, 'LAUNCH_FAILED');
  } finally {
    browserLaunching = null;
  }
}

async function bypassLink4m(url) {
  log.info('Link4m: ' + url);
  const t0 = Date.now();

  const browser = await getBrowser();
  log.timing('Browser ready: ' + (Date.now() - t0) + 'ms');

  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 800, height: 600 });
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].indexOf(type) !== -1) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const t1 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    log.timing('Page loaded: ' + (Date.now() - t1) + 'ms');

    const t2 = Date.now();
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
    log.timing('Link found: ' + (Date.now() - t2) + 'ms');

    const finalUrl = await handle.jsonValue();
    if (!finalUrl) throw new BypassError('Không tìm thấy link đích.', 'NOT_FOUND');

    log.info('Link4m OK total: ' + (Date.now() - t0) + 'ms');
    return finalUrl;

  } finally {
    try { await page.close(); } catch (e) {}
  }
}

async function bypassGeneric(url, excludeDomain, siteName) {
  log.info(siteName + ': ' + url);
  const t0 = Date.now();

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

  log.timing(siteName + ' HTTP ' + response.status + ' in ' + (Date.now() - t0) + 'ms');

  if (response.status === 403) {
    throw new BypassError(siteName + ' đã bật Cloudflare (403).', 'FORBIDDEN');
  }
  if (response.status === 404) {
    throw new BypassError('Link không tồn tại hoặc hết hạn.', 'NOT_FOUND');
  }
  if (response.status >= 400) {
    throw new BypassError(siteName + ' HTTP ' + response.status, 'HTTP_ERROR');
  }

  const $ = cheerio.load(response.data);
  const selectors = ['a#btn6', 'a.get-link', 'a#continue', 'a.btn-primary'];

  for (let i = 0; i < selectors.length; i++) {
    const link = $(selectors[i]).attr('href');
    if (link && link.indexOf('http') === 0 && link.indexOf(excludeDomain) === -1) {
      log.info(siteName + ' OK: ' + (Date.now() - t0) + 'ms');
      return link;
    }
  }

  const allLinks = $('a[href]');
  for (let i = 0; i < allLinks.length; i++) {
    const href = $(allLinks[i]).attr('href');
    if (href && href.indexOf('http') === 0 && href.indexOf(excludeDomain) === -1) {
      log.info(siteName + ' OK (fallback): ' + (Date.now() - t0) + 'ms');
      return href;
    }
  }

  throw new BypassError('Không tìm thấy link đích trong ' + siteName + '.', 'SELECTOR');
}

async function bypassLayma(url) {
  return bypassGeneric(url, 'layma.net', 'Layma.net');
}

async function bypassSite2s(url) {
  return bypassGeneric(url, 'site2s.com', 'Site2s.com');
}

const app = express();

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.post('/api/bypass', blockBadIPs, rateLimit, checkApiKey, async function (req, res) {
  try {
    const body = req.body || {};
    const service = body.service;
    const url = body.url;

    if (typeof service !== 'string' || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'Dữ liệu không hợp lệ.' });
    }
    if (url.length > MAX_URL_LENGTH) {
      return res.status(400).json({ success: false, error: 'URL quá dài.' });
    }
    if (url.indexOf('https://') !== 0) {
      return res.status(400).json({ success: false, error: 'URL phải bắt đầu bằng https://' });
    }

    log.info('Request: ' + service + ' -> ' + url);
    const tReq = Date.now();

    let finalUrl;

    if (service === 'Link4m') {
      finalUrl = await bypassLink4m(url);
    } else if (service === 'Layma.net') {
      finalUrl = await bypassLayma(url);
    } else if (service === 'Site2s.com') {
      finalUrl = await bypassSite2s(url);
    } else {
      return res.status(400).json({ success: false, error: 'Chưa hỗ trợ: ' + service });
    }

    log.timing('Total request: ' + (Date.now() - tReq) + 'ms');
    return res.json({ success: true, finalUrl: finalUrl });

  } catch (err) {
    if (err instanceof BypassError) {
      log.warn(err.code + ': ' + err.message);
      return res.status(422).json({ success: false, error: err.message, code: err.code });
    }
    log.error('Unknown: ' + (err && err.message ? err.message : 'unknown'));
    if (err && err.stack) log.debug(err.stack);
    return res.status(500).json({
      success: false,
      error: 'Lỗi server: ' + (err && err.message ? err.message : 'không xác định')
    });
  }
});

app.get('/health', function (req, res) {
  res.json({
    status: 'ok',
    env: NODE_ENV,
    uptime: Math.floor(process.uptime()),
    puppeteer: !!puppeteer,
    stealth: stealthLoaded,
    browserReady: !!(browserInstance && browserInstance.connected),
    rateLimitActive: RATE_LIMIT_MAX > 0,
    apiKeyActive: !!API_KEY,
    blockedIPs: BLOCKED_IPS.length,
    timestamp: new Date().toISOString()
  });
});

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function warmUp() {
  if (!puppeteer) {
    log.warn('Warm-up skipped: no puppeteer');
    return;
  }
  try {
    log.info('Warming up browser...');
    const t = Date.now();
    await getBrowser();
    log.timing('Browser warmed up in ' + (Date.now() - t) + 'ms');
  } catch (e) {
    log.warn('Warm-up failed: ' + e.message);
  }
}

const server = app.listen(PORT, function () {
  log.info('===========================================');
  log.info('Server chạy tại port ' + PORT);
  log.info('Puppeteer: ' + (puppeteer ? 'BẬT' : 'TẮT'));
  log.info('Rate limit: ' + RATE_LIMIT_MAX + ' req/min/IP');
  log.info('API Key: ' + (API_KEY ? 'BẬT' : 'TẮT'));
  log.info('Blocked IPs: ' + BLOCKED_IPS.length);
  log.info('===========================================');
  setTimeout(warmUp, 3000);
});

process.on('SIGTERM', async function () {
  log.info('Đang tắt server...');
  if (browserInstance) {
    try { await browserInstance.close(); } catch (e) {}
  }
  server.close(function () { process.exit(0); });
});

process.on('uncaughtException', function (err) {
  log.error('Uncaught: ' + err.message);
});

process.on('unhandledRejection', function (err) {
  log.error('Rejection: ' + err);
});
