import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { createRequire } from 'module';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

// x402 - conditionally import if payments enabled
let paymentMiddleware = null;
if (process.env.ENABLE_PAYMENTS === 'true') {
  try {
    const x402 = await import('@x402/express');
    paymentMiddleware = x402.paymentMiddleware;
  } catch (e) {
    console.warn('x402 middleware not available:', e.message);
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Pricing in USDC (6 decimals)
const FETCH_PRICE = '1000';      // $0.001
const SCREENSHOT_PRICE = '5000'; // $0.005  
const PDF_PRICE = '2000';        // $0.002 per request
const SUMMARIZE_PRICE = '10000'; // $0.01 per summary
const EXTRACT_PRICE = '5000';    // $0.005 per extraction
const COMPARE_PRICE = '15000';   // $0.015 per comparison

// x402 payment configuration
const paymentConfig = {
  'GET /fetch': {
    price: FETCH_PRICE,
    network: 'base',
    currency: 'USDC',
    description: 'Clean Fetch - Convert any URL to clean markdown/text',
  },
  'GET /screenshot': {
    price: SCREENSHOT_PRICE,
    network: 'base',
    currency: 'USDC',
    description: 'Screenshot API - Capture any URL as PNG image',
  },
  'POST /pdf': {
    price: PDF_PRICE,
    network: 'base',
    currency: 'USDC',
    description: 'PDF to Text - Extract text from PDF documents',
  },
  'GET /extract': {
    price: EXTRACT_PRICE,
    network: 'base',
    currency: 'USDC',
    description: 'Extract structured data (emails, phones, links, prices) from URL',
  },
  'POST /compare': {
    price: COMPARE_PRICE,
    network: 'base',
    currency: 'USDC',
    description: 'Compare two URLs and return differences',
  },
};

// Apply x402 payment middleware
if (process.env.ENABLE_PAYMENTS === 'true' && paymentMiddleware) {
  app.use(paymentMiddleware(paymentConfig, {
    facilitatorUrl: process.env.FACILITATOR_URL || 'https://x402.org/facilitator',
    walletAddress: process.env.WALLET_ADDRESS,
  }));
}

// Browser instance (reused for performance)
let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browser;
}

// ============ ENDPOINTS ============

// Health check (free)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', services: ['fetch', 'screenshot', 'pdf', 'extract', 'compare'] });
});

// Clean Fetch - URL to markdown/text
app.get('/fetch', async (req, res) => {
  try {
    const { url, format = 'markdown' } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (compatible; x402-tools/1.0)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const html = await page.content();
    await page.close();

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      return res.status(422).json({ error: 'Could not extract content from URL' });
    }

    const result = {
      title: article.title,
      byline: article.byline,
      content: format === 'text' ? article.textContent : article.content,
      excerpt: article.excerpt,
      length: article.length,
      url: url,
    };

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Screenshot API - URL to PNG
app.get('/screenshot', async (req, res) => {
  try {
    const { 
      url, 
      width = 1280, 
      height = 720, 
      fullPage = false,
      format = 'png'
    } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setViewport({ 
      width: parseInt(width), 
      height: parseInt(height) 
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const screenshot = await page.screenshot({ 
      type: format === 'jpeg' ? 'jpeg' : 'png',
      fullPage: fullPage === 'true',
    });
    
    await page.close();

    res.set('Content-Type', `image/${format === 'jpeg' ? 'jpeg' : 'png'}`);
    res.send(screenshot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PDF to Text - Extract text from PDF
app.post('/pdf', async (req, res) => {
  try {
    const { base64, url } = req.body;
    
    let pdfBuffer;
    
    if (base64) {
      pdfBuffer = Buffer.from(base64, 'base64');
    } else if (url) {
      const response = await fetch(url);
      pdfBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      return res.status(400).json({ error: 'Either base64 or url required' });
    }

    const data = await pdf(pdfBuffer);

    res.json({
      text: data.text,
      pages: data.numpages,
      info: data.info,
      metadata: data.metadata,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Extract structured data from URL
app.get('/extract', async (req, res) => {
  try {
    const { url, types = 'emails,phones,links' } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (compatible; x402-tools/1.0)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const html = await page.content();
    const pageUrl = page.url();
    await page.close();

    const typesArray = types.split(',').map(t => t.trim().toLowerCase());
    const result = { url: pageUrl, extracted: {} };

    // Extract emails
    if (typesArray.includes('emails')) {
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const emails = [...new Set(html.match(emailRegex) || [])];
      result.extracted.emails = emails;
    }

    // Extract phone numbers
    if (typesArray.includes('phones')) {
      const phoneRegex = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
      const phones = [...new Set(html.match(phoneRegex) || [])];
      result.extracted.phones = phones;
    }

    // Extract links
    if (typesArray.includes('links')) {
      const dom = new JSDOM(html, { url });
      const links = [...dom.window.document.querySelectorAll('a[href]')]
        .map(a => a.href)
        .filter(href => href.startsWith('http'))
        .slice(0, 100); // Limit to 100 links
      result.extracted.links = [...new Set(links)];
    }

    // Extract prices
    if (typesArray.includes('prices')) {
      const priceRegex = /\$[\d,]+(?:\.\d{2})?|\d+(?:\.\d{2})?\s*(?:USD|EUR|GBP)/gi;
      const prices = [...new Set(html.match(priceRegex) || [])];
      result.extracted.prices = prices;
    }

    // Extract meta tags
    if (typesArray.includes('meta')) {
      const dom = new JSDOM(html, { url });
      const doc = dom.window.document;
      const meta = {
        title: doc.title,
        description: doc.querySelector('meta[name="description"]')?.content,
        keywords: doc.querySelector('meta[name="keywords"]')?.content,
        ogTitle: doc.querySelector('meta[property="og:title"]')?.content,
        ogDescription: doc.querySelector('meta[property="og:description"]')?.content,
        ogImage: doc.querySelector('meta[property="og:image"]')?.content,
        twitterCard: doc.querySelector('meta[name="twitter:card"]')?.content,
      };
      result.extracted.meta = meta;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Compare two URLs
app.post('/compare', async (req, res) => {
  try {
    const { url1, url2 } = req.body;
    
    if (!url1 || !url2) {
      return res.status(400).json({ error: 'Both url1 and url2 required' });
    }

    const browser = await getBrowser();
    
    // Fetch first URL
    const page1 = await browser.newPage();
    await page1.setUserAgent('Mozilla/5.0 (compatible; x402-tools/1.0)');
    await page1.goto(url1, { waitUntil: 'networkidle2', timeout: 30000 });
    const html1 = await page1.content();
    await page1.close();

    // Fetch second URL
    const page2 = await browser.newPage();
    await page2.setUserAgent('Mozilla/5.0 (compatible; x402-tools/1.0)');
    await page2.goto(url2, { waitUntil: 'networkidle2', timeout: 30000 });
    const html2 = await page2.content();
    await page2.close();

    // Parse both
    const dom1 = new JSDOM(html1, { url: url1 });
    const dom2 = new JSDOM(html2, { url: url2 });
    
    const reader1 = new Readability(dom1.window.document.cloneNode(true));
    const reader2 = new Readability(dom2.window.document.cloneNode(true));
    
    const article1 = reader1.parse();
    const article2 = reader2.parse();

    // Compare
    const result = {
      url1: { 
        title: article1?.title,
        length: article1?.length,
        excerpt: article1?.excerpt,
      },
      url2: {
        title: article2?.title,
        length: article2?.length,
        excerpt: article2?.excerpt,
      },
      comparison: {
        titleMatch: article1?.title === article2?.title,
        lengthDiff: (article2?.length || 0) - (article1?.length || 0),
        longer: (article2?.length || 0) > (article1?.length || 0) ? 'url2' : 'url1',
      }
    };

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Discovery endpoint for x402 Bazaar
app.get('/discovery', (req, res) => {
  res.json({
    name: 'x402-tools',
    description: 'AI-agent utilities: Clean Fetch, Screenshot, PDF extraction, Data extraction, URL comparison',
    version: '1.1.0',
    endpoints: [
      {
        path: '/fetch',
        method: 'GET',
        description: 'Convert URL to clean markdown/text',
        price: FETCH_PRICE,
        currency: 'USDC',
        params: {
          url: { type: 'string', required: true },
          format: { type: 'string', enum: ['markdown', 'text'], default: 'markdown' }
        }
      },
      {
        path: '/screenshot',
        method: 'GET', 
        description: 'Capture URL as PNG/JPEG image',
        price: SCREENSHOT_PRICE,
        currency: 'USDC',
        params: {
          url: { type: 'string', required: true },
          width: { type: 'number', default: 1280 },
          height: { type: 'number', default: 720 },
          fullPage: { type: 'boolean', default: false },
          format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' }
        }
      },
      {
        path: '/pdf',
        method: 'POST',
        description: 'Extract text from PDF document',
        price: PDF_PRICE,
        currency: 'USDC',
        body: {
          base64: { type: 'string', description: 'Base64-encoded PDF' },
          url: { type: 'string', description: 'URL to PDF file' }
        }
      },
      {
        path: '/extract',
        method: 'GET',
        description: 'Extract structured data from URL (emails, phones, links, prices, meta)',
        price: EXTRACT_PRICE,
        currency: 'USDC',
        params: {
          url: { type: 'string', required: true },
          types: { type: 'string', default: 'emails,phones,links', description: 'Comma-separated: emails,phones,links,prices,meta' }
        }
      },
      {
        path: '/compare',
        method: 'POST',
        description: 'Compare two URLs and analyze differences',
        price: COMPARE_PRICE,
        currency: 'USDC',
        body: {
          url1: { type: 'string', required: true },
          url2: { type: 'string', required: true }
        }
      }
    ]
  });
});

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => {
  console.log(`x402-tools running on port ${PORT}`);
  console.log(`Payment mode: ${process.env.ENABLE_PAYMENTS === 'true' ? 'ENABLED' : 'DISABLED (testing)'}`);
});
