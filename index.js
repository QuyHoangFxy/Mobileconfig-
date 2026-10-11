const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Vượt Link4m
async function bypassLink4m(url) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'vi,en;q=0.9'
    },
    maxRedirects: 5,
    timeout: 15000
  });
  const $ = cheerio.load(response.data);
  const selectors = ['#btn6', 'a#btn6', 'a.get-link', 'a#continue', 'a.btn-primary'];
  for (const sel of selectors) {
    const link = $(sel).attr('href');
    if (link && link.startsWith('http') && !link.includes('link4m.com')) return link;
  }
  throw new Error('Không tìm thấy link gốc từ Link4m.');
}

// Vượt Layma
async function bypassLayma(url) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    maxRedirects: 5,
    timeout: 15000
  });
  const $ = cheerio.load(response.data);
  const selectors = ['a#btn6', 'a.get-link', 'a#continue', 'a.btn-primary'];
  for (const sel of selectors) {
    const link = $(sel).attr('href');
    if (link && link.startsWith('http') && !link.includes('layma.net')) return link;
  }
  throw new Error('Không tìm thấy link gốc từ Layma.');
}

// Vượt Site2s
async function bypassSite2s(url) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    maxRedirects: 5,
    timeout: 15000
  });
  const $ = cheerio.load(response.data);
  const selectors = ['a#btn6', 'a.get-link', 'a[href*="http"]:not([href*="site2s"])'];
  for (const sel of selectors) {
    const link = $(sel).attr('href');
    if (link && link.startsWith('http') && !link.includes('site2s.com')) return link;
  }
  throw new Error('Không tìm thấy link gốc từ Site2s.');
}

// API chính
app.post('/api/bypass', async (req, res) => {
  const { service, url } = req.body;
  try {
    let finalUrl;
    if (service === 'Link4m') finalUrl = await bypassLink4m(url);
    else if (service === 'Layma.net') finalUrl = await bypassLayma(url);
    else if (service === 'Site2s.com') finalUrl = await bypassSite2s(url);
    else return res.status(400).json({ success: false, error: `Chưa hỗ trợ: ${service}` });
    res.json({ success: true, finalUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server chạy tại port ${PORT}`));