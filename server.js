import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
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

// Security middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request timeout middleware (60 seconds)
app.use((req, res, next) => {
  req.setTimeout(60000, () => {
    const err = new Error('Request timeout');
    err.code = 'TIMEOUT';
    res.status(408).json({ error: 'Request timeout after 60 seconds' });
  });
  next();
});

// In-memory storage for usage tracking
const usage = new Map(); // key: API key, value: { requests: number, lastUsed: Date }
const logs = []; // Array of request logs
const MAX_LOGS = 10000; // Keep last 10k logs in memory

// API Key Authentication Middleware
const API_KEYS = process.env.API_KEYS ? process.env.API_KEYS.split(',').map(key => key.trim()) : [];
const PUBLIC_ENDPOINTS = ['/health', '/discovery', '/', '/register', '/usage', '/stats'];

const authenticateApiKey = (req, res, next) => {
  // Skip authentication for public endpoints
  if (PUBLIC_ENDPOINTS.includes(req.path)) {
    return next();
  }

  const apiKey = req.header('X-API-Key');
  
  if (!apiKey) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'API key missing. Include X-API-Key header.',
      code: 'MISSING_API_KEY'
    });
  }

  if (!API_KEYS.includes(apiKey)) {
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Invalid API key',
      code: 'INVALID_API_KEY'
    });
  }

  req.apiKey = apiKey;
  next();
};

// Request logging middleware
const logRequest = (req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      endpoint: req.path,
      method: req.method,
      apiKey: req.apiKey || 'public',
      responseTime,
      status: res.statusCode,
      ip: req.ip,
      userAgent: req.get('User-Agent') || 'unknown'
    };
    
    // Add to logs array (keep it under MAX_LOGS)
    logs.push(logEntry);
    if (logs.length > MAX_LOGS) {
      logs.shift(); // Remove oldest log
    }
    
    // Update usage tracking for authenticated requests
    if (req.apiKey) {
      if (!usage.has(req.apiKey)) {
        usage.set(req.apiKey, { requests: 0, lastUsed: null });
      }
      const stats = usage.get(req.apiKey);
      stats.requests++;
      stats.lastUsed = new Date();
    }
    
    console.log(`${logEntry.timestamp} - ${logEntry.method} ${logEntry.endpoint} - ${logEntry.status} - ${responseTime}ms - ${logEntry.apiKey}`);
  });
  
  next();
};

app.use(logRequest);

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded. Maximum 100 requests per minute.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const heavyEndpointLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute for heavy endpoints
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded for heavy endpoint. Maximum 20 requests per minute.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

// Apply API key authentication
app.use(authenticateApiKey);

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

// Error handling middleware
const handleError = (error, req, res, next) => {
  console.error('Error:', error);
  
  // Don't leak stack traces in production
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  const errorResponse = {
    error: 'Internal server error',
    message: error.message,
    code: 'INTERNAL_ERROR'
  };
  
  if (isDevelopment) {
    errorResponse.stack = error.stack;
  }
  
  res.status(500).json(errorResponse);
};

// ============ PUBLIC ENDPOINTS ============

// Landing page
app.get('/', (req, res) => {
  const indexPath = path.join(process.cwd(), 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      name: 'x402-tools',
      version: '2.0.0',
      description: 'AI-agent utilities: Clean Fetch, Screenshot, PDF extraction, Data extraction, URL comparison',
      documentation: 'https://github.com/SiamakSafari/x402-tools',
      endpoints: ['/fetch', '/screenshot', '/pdf', '/extract', '/compare'],
      authentication: 'API key required (X-API-Key header)',
      contact: 'Get API key at /register'
    });
  }
});

// Health check (free)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '2.0.0',
    services: ['fetch', 'screenshot', 'pdf', 'extract', 'compare'],
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Register endpoint (placeholder for future self-service)
app.get('/register', (req, res) => {
  res.json({
    message: 'API key registration',
    status: 'coming_soon',
    description: 'Self-service API key generation will be available soon.',
    contact: 'For now, contact the administrator to get an API key.',
    documentation: 'https://github.com/SiamakSafari/x402-tools#authentication'
  });
});

// Usage stats endpoint (authenticated)
app.get('/usage', (req, res) => {
  if (!req.apiKey) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'This endpoint requires a valid API key'
    });
  }

  const userStats = usage.get(req.apiKey) || { requests: 0, lastUsed: null };
  const userLogs = logs.filter(log => log.apiKey === req.apiKey);
  
  // Calculate stats
  const last24h = userLogs.filter(log => 
    new Date(log.timestamp) > new Date(Date.now() - 24 * 60 * 60 * 1000)
  ).length;
  
  const lastHour = userLogs.filter(log => 
    new Date(log.timestamp) > new Date(Date.now() - 60 * 60 * 1000)
  ).length;
  
  const endpointBreakdown = userLogs.reduce((acc, log) => {
    acc[log.endpoint] = (acc[log.endpoint] || 0) + 1;
    return acc;
  }, {});

  res.json({
    apiKey: req.apiKey.substring(0, 8) + '...', // Masked for security
    totalRequests: userStats.requests,
    last24Hours: last24h,
    lastHour: lastHour,
    lastUsed: userStats.lastUsed,
    endpointBreakdown,
    recentRequests: userLogs.slice(-10) // Last 10 requests
  });
});

// Admin stats endpoint
app.get('/stats', (req, res) => {
  // Simple admin check - in production, add proper admin authentication
  const isAdmin = req.apiKey && API_KEYS[0] === req.apiKey; // First API key is admin
  
  if (!isAdmin) {
    return res.status(403).json({
      error: 'Admin access required',
      message: 'This endpoint requires admin privileges'
    });
  }

  const totalRequests = logs.length;
  const uniqueApiKeys = new Set(logs.map(log => log.apiKey)).size;
  const last24h = logs.filter(log => 
    new Date(log.timestamp) > new Date(Date.now() - 24 * 60 * 60 * 1000)
  ).length;

  const endpointStats = logs.reduce((acc, log) => {
    if (!acc[log.endpoint]) {
      acc[log.endpoint] = { count: 0, avgResponseTime: 0, totalTime: 0 };
    }
    acc[log.endpoint].count++;
    acc[log.endpoint].totalTime += log.responseTime;
    acc[log.endpoint].avgResponseTime = acc[log.endpoint].totalTime / acc[log.endpoint].count;
    return acc;
  }, {});

  const errorRate = logs.filter(log => log.status >= 400).length / totalRequests;

  res.json({
    platform: {
      totalRequests,
      uniqueApiKeys,
      last24Hours: last24h,
      errorRate: (errorRate * 100).toFixed(2) + '%',
      uptime: process.uptime()
    },
    endpoints: endpointStats,
    memory: process.memoryUsage(),
    recentLogs: logs.slice(-20) // Last 20 logs
  });
});

// Discovery endpoint for x402 Bazaar
app.get('/discovery', (req, res) => {
  res.json({
    name: 'x402-tools',
    description: 'AI-agent utilities: Clean Fetch, Screenshot, PDF extraction, Data extraction, URL comparison',
    version: '2.0.0',
    authentication: 'API key required (X-API-Key header)',
    rateLimit: '100 requests/minute (global), 20 requests/minute (heavy endpoints)',
    endpoints: [
      {
        path: '/fetch',
        method: 'GET',
        description: 'Convert URL to clean markdown/text',
        price: FETCH_PRICE,
        currency: 'USDC',
        rateLimit: '100/minute',
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
        rateLimit: '20/minute',
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
        rateLimit: '100/minute',
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
        rateLimit: '100/minute',
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
        rateLimit: '20/minute',
        body: {
          url1: { type: 'string', required: true },
          url2: { type: 'string', required: true }
        }
      }
    ]
  });
});

// ============ AUTHENTICATED ENDPOINTS ============

// Clean Fetch - URL to markdown/text
app.get('/fetch', async (req, res) => {
  try {
    const { url, format = 'markdown' } = req.query;
    
    if (!url) {
      return res.status(400).json({ 
        error: 'Bad request',
        message: 'URL parameter required',
        code: 'MISSING_URL'
      });
    }

    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (compatible; x402-tools/2.0)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const html = await page.content();
    await page.close();

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      return res.status(422).json({ 
        error: 'Unprocessable content',
        message: 'Could not extract content from URL',
        code: 'EXTRACTION_FAILED'
      });
    }

    const result = {
      title: article.title,
      byline: article.byline,
      content: format === 'text' ? article.textContent : article.content,
      excerpt: article.excerpt,
      length: article.length,
      url: url,
      timestamp: new Date().toISOString()
    };

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Screenshot API - URL to PNG
app.get('/screenshot', heavyEndpointLimiter, async (req, res, next) => {
  try {
    const { 
      url, 
      width = 1280, 
      height = 720, 
      fullPage = false,
      format = 'png'
    } = req.query;
    
    if (!url) {
      return res.status(400).json({ 
        error: 'Bad request',
        message: 'URL parameter required',
        code: 'MISSING_URL'
      });
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
    next(error);
  }
});

// PDF to Text - Extract text from PDF
app.post('/pdf', async (req, res, next) => {
  try {
    const { base64, url } = req.body;
    
    let pdfBuffer;
    
    if (base64) {
      pdfBuffer = Buffer.from(base64, 'base64');
    } else if (url) {
      const response = await fetch(url);
      pdfBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      return res.status(400).json({ 
        error: 'Bad request',
        message: 'Either base64 or url required',
        code: 'MISSING_PDF_SOURCE'
      });
    }

    const data = await pdf(pdfBuffer);

    res.json({
      text: data.text,
      pages: data.numpages,
      info: data.info,
      metadata: data.metadata,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

// Extract structured data from URL
app.get('/extract', async (req, res, next) => {
  try {
    const { url, types = 'emails,phones,links' } = req.query;
    
    if (!url) {
      return res.status(400).json({ 
        error: 'Bad request',
        message: 'URL parameter required',
        code: 'MISSING_URL'
      });
    }

    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (compatible; x402-tools/2.0)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const html = await page.content();
    const pageUrl = page.url();
    await page.close();

    const typesArray = types.split(',').map(t => t.trim().toLowerCase());
    const result = { 
      url: pageUrl, 
      extracted: {},
      timestamp: new Date().toISOString()
    };

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
    next(error);
  }
});

// Compare two URLs
app.post('/compare', heavyEndpointLimiter, async (req, res, next) => {
  try {
    const { url1, url2 } = req.body;
    
    if (!url1 || !url2) {
      return res.status(400).json({ 
        error: 'Bad request',
        message: 'Both url1 and url2 required',
        code: 'MISSING_URLS'
      });
    }

    const browser = await getBrowser();
    
    // Fetch first URL
    const page1 = await browser.newPage();
    await page1.setUserAgent('Mozilla/5.0 (compatible; x402-tools/2.0)');
    await page1.goto(url1, { waitUntil: 'networkidle2', timeout: 30000 });
    const html1 = await page1.content();
    await page1.close();

    // Fetch second URL
    const page2 = await browser.newPage();
    await page2.setUserAgent('Mozilla/5.0 (compatible; x402-tools/2.0)');
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
      },
      timestamp: new Date().toISOString()
    };

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Error handling middleware (should be last)
app.use(handleError);

// Graceful shutdown handler
const gracefulShutdown = async () => {
  console.log('Received shutdown signal, closing server gracefully...');
  
  if (browser) {
    await browser.close();
  }
  
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => {
  console.log(`x402-tools v2.0.0 running on port ${PORT}`);
  console.log(`Payment mode: ${process.env.ENABLE_PAYMENTS === 'true' ? 'ENABLED' : 'DISABLED (testing)'}`);
  console.log(`API keys configured: ${API_KEYS.length}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});