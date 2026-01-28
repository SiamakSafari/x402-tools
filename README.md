# x402-tools

AI-agent utilities powered by x402 micropayments.

## Services

| Endpoint | Method | Description | Price |
|----------|--------|-------------|-------|
| `/fetch` | GET | Convert URL to clean markdown/text | $0.001 |
| `/screenshot` | GET | Capture URL as PNG/JPEG | $0.005 |
| `/pdf` | POST | Extract text from PDF | $0.002 |
| `/extract` | GET | Extract emails, phones, links, prices, meta from URL | $0.005 |
| `/compare` | POST | Compare two URLs and analyze differences | $0.015 |

## Quick Start

```bash
# Install dependencies
npm install

# Run in test mode (no payments)
npm start

# Test endpoints
curl "http://localhost:3402/fetch?url=https://example.com"
curl "http://localhost:3402/screenshot?url=https://example.com" --output screenshot.png
curl -X POST "http://localhost:3402/pdf" -H "Content-Type: application/json" -d '{"url":"https://example.com/doc.pdf"}'
```

## Configuration

Copy `.env.example` to `.env` and configure:

```
PORT=3402
ENABLE_PAYMENTS=true          # Enable x402 payments
WALLET_ADDRESS=0x...          # Your Base wallet for receiving USDC
FACILITATOR_URL=https://x402.org/facilitator
```

## Endpoints

### GET /fetch

Convert any URL to clean, readable content.

**Parameters:**
- `url` (required) - URL to fetch
- `format` - `markdown` (default) or `text`

**Response:**
```json
{
  "title": "Page Title",
  "content": "Clean markdown content...",
  "excerpt": "Brief excerpt...",
  "length": 1234,
  "url": "https://example.com"
}
```

### GET /screenshot

Capture a webpage as an image.

**Parameters:**
- `url` (required) - URL to capture
- `width` - Viewport width (default: 1280)
- `height` - Viewport height (default: 720)
- `fullPage` - Capture full page (default: false)
- `format` - `png` (default) or `jpeg`

**Response:** Binary image data

### POST /pdf

Extract text from a PDF document.

**Body (JSON):**
- `base64` - Base64-encoded PDF, OR
- `url` - URL to PDF file

**Response:**
```json
{
  "text": "Extracted text content...",
  "pages": 5,
  "info": {...},
  "metadata": {...}
}
```

### GET /extract

Extract structured data from any URL.

**Parameters:**
- `url` (required) - URL to extract from
- `types` - Comma-separated data types (default: `emails,phones,links`)
  - `emails` - Email addresses
  - `phones` - Phone numbers
  - `links` - All hyperlinks
  - `prices` - Price values ($XX.XX format)
  - `meta` - Meta tags (title, description, OpenGraph, Twitter)

**Response:**
```json
{
  "url": "https://example.com",
  "extracted": {
    "emails": ["contact@example.com"],
    "phones": ["555-123-4567"],
    "links": ["https://example.com/about"],
    "prices": ["$99.99", "$149.00"],
    "meta": {
      "title": "Example",
      "description": "...",
      "ogImage": "..."
    }
  }
}
```

### POST /compare

Compare two URLs and analyze differences.

**Body (JSON):**
- `url1` (required) - First URL
- `url2` (required) - Second URL

**Response:**
```json
{
  "url1": { "title": "...", "length": 1234, "excerpt": "..." },
  "url2": { "title": "...", "length": 2345, "excerpt": "..." },
  "comparison": {
    "titleMatch": false,
    "lengthDiff": 1111,
    "longer": "url2"
  }
}
```

### GET /discovery

x402 Bazaar discovery endpoint. Returns service metadata for automatic agent discovery.

### GET /health

Health check endpoint (free, no payment required).

## Deployment

### Railway/Render/Fly.io

1. Push to GitHub
2. Connect repo to platform
3. Set environment variables
4. Deploy

### Docker

```dockerfile
FROM node:20-slim

# Install Chromium dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3402
CMD ["npm", "start"]
```

## x402 Integration

When `ENABLE_PAYMENTS=true`, all endpoints require x402 payment:

1. Client calls endpoint → receives HTTP 402
2. Client pays via x402 protocol (USDC on Base)
3. Client retries with payment proof → receives response

AI agents using `@x402/fetch` or `@x402/axios` handle this automatically.

## License

MIT
