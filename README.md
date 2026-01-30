# x402-tools API Documentation

**The ultimate AI agent utility belt.** Clean fetch, screenshot, PDF extraction, data mining, and URL comparison - all in one powerful API.

## 🚀 Quick Start

**Base URL:** `https://your-deployment-url.com`

**Authentication:** Include your API key in every request:
```
X-API-Key: your-api-key-here
```

**Test it works:**
```bash
curl -H "X-API-Key: your-key" https://your-url.com/health
```

## 🔐 Authentication

All endpoints (except `/health`, `/discovery`, and `/`) require API key authentication via the `X-API-Key` header.

**Get an API Key:** Contact the administrator or use `/register` (coming soon for self-service).

**Missing or invalid key returns:**
```json
{
  "error": "Authentication required",
  "message": "API key missing. Include X-API-Key header.",
  "code": "MISSING_API_KEY"
}
```

## 📋 Endpoints

### 🌐 Clean Fetch - `/fetch`
Convert any URL to clean, readable markdown or text.

**Method:** `GET`  
**Rate limit:** 100/min  
**Price:** $0.001 USDC  

**Parameters:**
- `url` (required): Target URL to fetch
- `format` (optional): `markdown` (default) or `text`

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  "https://your-url.com/fetch?url=https://example.com&format=markdown"
```

**Response:**
```json
{
  "title": "Example Domain",
  "byline": "Author name",
  "content": "# Example Domain\n\nThis domain is for use...",
  "excerpt": "Short summary...",
  "length": 1234,
  "url": "https://example.com",
  "timestamp": "2024-01-30T10:00:00.000Z"
}
```

### 📸 Screenshot - `/screenshot`
Capture any URL as a PNG or JPEG image.

**Method:** `GET`  
**Rate limit:** 20/min (heavy endpoint)  
**Price:** $0.005 USDC  

**Parameters:**
- `url` (required): Target URL to screenshot
- `width` (optional): Width in pixels (default: 1280)
- `height` (optional): Height in pixels (default: 720)
- `fullPage` (optional): Capture full page if `true` (default: false)
- `format` (optional): `png` (default) or `jpeg`

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  "https://your-url.com/screenshot?url=https://example.com&width=1920&fullPage=true" \
  --output screenshot.png
```

**Response:** Raw image data (PNG/JPEG)

### 📄 PDF Extract - `/pdf`
Extract text from PDF documents.

**Method:** `POST`  
**Rate limit:** 100/min  
**Price:** $0.002 USDC  

**Body (JSON):**
```json
{
  "base64": "JVBERi0xLjQKMSAwIG9iai...",  // Option 1: Base64 PDF
  "url": "https://example.com/file.pdf"    // Option 2: PDF URL
}
```

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/document.pdf"}' \
  https://your-url.com/pdf
```

**Response:**
```json
{
  "text": "Extracted text content...",
  "pages": 5,
  "info": {
    "Title": "Document Title",
    "Author": "Author Name"
  },
  "metadata": {...},
  "timestamp": "2024-01-30T10:00:00.000Z"
}
```

### 🔍 Data Extract - `/extract`
Mine structured data from any URL: emails, phones, links, prices, meta tags.

**Method:** `GET`  
**Rate limit:** 100/min  
**Price:** $0.005 USDC  

**Parameters:**
- `url` (required): Target URL to extract from
- `types` (optional): Comma-separated list: `emails,phones,links,prices,meta` (default: `emails,phones,links`)

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  "https://your-url.com/extract?url=https://company.com&types=emails,phones,meta"
```

**Response:**
```json
{
  "url": "https://company.com",
  "extracted": {
    "emails": ["contact@company.com", "support@company.com"],
    "phones": ["+1-555-123-4567", "555.987.6543"],
    "meta": {
      "title": "Company Name",
      "description": "Company description...",
      "ogImage": "https://company.com/image.jpg"
    }
  },
  "timestamp": "2024-01-30T10:00:00.000Z"
}
```

### ⚡ Compare URLs - `/compare`
Compare two URLs and analyze differences.

**Method:** `POST`  
**Rate limit:** 20/min (heavy endpoint)  
**Price:** $0.015 USDC  

**Body (JSON):**
```json
{
  "url1": "https://example.com",
  "url2": "https://example.org"
}
```

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"url1": "https://site-v1.com", "url2": "https://site-v2.com"}' \
  https://your-url.com/compare
```

**Response:**
```json
{
  "url1": {
    "title": "Site Version 1",
    "length": 1500,
    "excerpt": "Original site content..."
  },
  "url2": {
    "title": "Site Version 2", 
    "length": 1800,
    "excerpt": "Updated site content..."
  },
  "comparison": {
    "titleMatch": false,
    "lengthDiff": 300,
    "longer": "url2"
  },
  "timestamp": "2024-01-30T10:00:00.000Z"
}
```

## 💰 Pricing & Payments

| Endpoint | Price (USDC) | Rate Limit |
|----------|--------------|------------|
| `/fetch` | $0.001 | 100/min |
| `/screenshot` | $0.005 | 20/min |
| `/pdf` | $0.002 | 100/min |
| `/extract` | $0.005 | 100/min |
| `/compare` | $0.015 | 20/min |

### x402 Payment Flow

When payments are enabled (`ENABLE_PAYMENTS=true`), each API call requires a micro-payment:

1. **Request:** Make API call with valid API key
2. **Payment Prompt:** Receive payment details if balance insufficient
3. **Pay:** Send USDC on Base network to specified address
4. **Execute:** API processes request after payment confirmation
5. **Response:** Get your results

**Payment Details:**
- **Network:** Base (Ethereum L2)
- **Currency:** USDC (6 decimals)
- **Speed:** Near-instant confirmation
- **Fees:** ~$0.0001 (Base network fees)

## 📊 Usage Tracking

### Your Usage Stats - `/usage`
Track your API consumption:

```bash
curl -H "X-API-Key: your-key" https://your-url.com/usage
```

**Returns:**
- Total requests
- Last 24 hours usage
- Endpoint breakdown
- Recent request logs

### Platform Stats - `/stats` (Admin)
Overall platform statistics (admin access required).

## 🚨 Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `MISSING_API_KEY` | No X-API-Key header | Add your API key |
| `INVALID_API_KEY` | Wrong API key | Check your key |
| `RATE_LIMIT_EXCEEDED` | Too many requests | Wait and retry |
| `MISSING_URL` | No URL parameter | Provide valid URL |
| `EXTRACTION_FAILED` | Can't parse content | Try different URL |
| `TIMEOUT` | Request took >60s | Retry with simpler request |
| `INTERNAL_ERROR` | Server error | Contact support |

## 🛡️ Rate Limits

- **Global:** 100 requests/minute per IP
- **Heavy endpoints** (screenshot, compare): 20 requests/minute
- **Headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

When rate limited:
```json
{
  "error": "Too many requests",
  "message": "Rate limit exceeded. Maximum 100 requests per minute.",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

## 🔗 Discovery

For automated service discovery:

```bash
curl https://your-url.com/discovery
```

Returns full API specification with pricing, parameters, and rate limits.

## 💡 Pro Tips

1. **Reuse connections:** Keep your HTTP client alive for better performance
2. **Handle rate limits:** Implement exponential backoff
3. **Monitor usage:** Check `/usage` regularly to track consumption
4. **Cache results:** Some data doesn't change frequently
5. **Use appropriate formats:** `text` format is faster than `markdown` for `/fetch`
6. **Optimize screenshots:** Use smaller dimensions when full quality isn't needed

## 🆘 Support

- **Documentation:** This README
- **Health Check:** `/health` endpoint
- **API Discovery:** `/discovery` endpoint  
- **Usage Stats:** `/usage` endpoint
- **GitHub:** [x402-tools](https://github.com/SiamakSafari/x402-tools)

---

**Built for AI agents, by AI enthusiasts.** Make the web your database. 🚀