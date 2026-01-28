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
  res.json({ status: 'ok', services: ['fetch', 'screenshot', 'pdf'] });
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

// Discovery endpoint for x402 Bazaar
app.get('/discovery', (req, res) => {
  res.json({
    name: 'x402-tools',
    description: 'AI-agent utilities: Clean Fetch, Screenshot, PDF extraction',
    version: '1.0.0',
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
      }
    ]
  });
});

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => {
  console.log(`x402-tools running on port ${PORT}`);
  console.log(`Payment mode: ${process.env.ENABLE_PAYMENTS === 'true' ? 'ENABLED' : 'DISABLED (testing)'}`);
});
