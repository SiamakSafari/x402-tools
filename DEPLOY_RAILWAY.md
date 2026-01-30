# Deploying x402-tools to Railway

## What This Is

**x402-tools** is an Express.js API server that provides AI-agent utilities behind x402 micropayments (USDC on Base). Endpoints:

| Endpoint | What it does | Price |
|----------|-------------|-------|
| `GET /fetch` | URL → clean markdown/text (via Puppeteer + Readability) | $0.001 |
| `GET /screenshot` | URL → PNG/JPEG screenshot (via Puppeteer) | $0.005 |
| `POST /pdf` | PDF → extracted text (via pdf-parse) | $0.002 |
| `GET /extract` | URL → structured data (emails, phones, links, prices, meta) | $0.005 |
| `POST /compare` | Compare two URLs | $0.015 |
| `GET /health` | Health check (free) | free |
| `GET /discovery` | x402 Bazaar service discovery (free) | free |

**Key dependency:** Uses **Puppeteer + Chromium** for `/fetch`, `/screenshot`, `/extract`, and `/compare`. This is the main deployment constraint.

---

## Pre-Existing Config Files

| File | Status | Notes |
|------|--------|-------|
| `Dockerfile` | ✅ Exists | Installs Chromium via apt, sets `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` |
| `railway.toml` | ✅ Created | Points to Dockerfile, sets healthcheck on `/health` |
| `.env.example` | ✅ Exists | Template for env vars |
| `.gitignore` | ❌ Missing | You should add one (see below) |

---

## Step-by-Step Deployment

### 1. Add a `.gitignore` (if not already)

```
node_modules/
.env
```

### 2. Push to GitHub

```bash
cd x402-tools
git init
git add -A
git commit -m "Initial commit: x402-tools"
# Create repo on GitHub, then:
git remote add origin git@github.com:YOUR_USERNAME/x402-tools.git
git push -u origin main
```

### 3. Create Railway Project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo**
3. Select the `x402-tools` repo
4. Railway will detect the `Dockerfile` via `railway.toml` and start building

### 4. Set Environment Variables

In Railway dashboard → your service → **Variables** tab, add:

| Variable | Value | Required |
|----------|-------|----------|
| `PORT` | `3402` | ✅ (Railway also sets its own `PORT`, but this ensures consistency) |
| `ENABLE_PAYMENTS` | `false` | ✅ Set to `true` when ready to charge |
| `WALLET_ADDRESS` | `0xYour...Address` | ⚠️ Required if payments enabled |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | Optional (this is the default) |

> **Note:** Railway auto-injects a `PORT` env var. The app uses `process.env.PORT || 3402`, so it will pick up Railway's assigned port automatically. You can skip setting `PORT` manually — Railway handles it.

### 5. Expose the Service

1. In Railway → your service → **Settings** → **Networking**
2. Click **Generate Domain** to get a `*.up.railway.app` URL
3. Or add a custom domain if you have one

### 6. Verify Deployment

```bash
# Health check
curl https://YOUR-APP.up.railway.app/health

# Test fetch endpoint
curl "https://YOUR-APP.up.railway.app/fetch?url=https://example.com"

# Test screenshot
curl "https://YOUR-APP.up.railway.app/screenshot?url=https://example.com" --output test.png
```

---

## Gotchas & Things to Watch

### 🔴 Chromium / Puppeteer

This is the #1 deployment risk. The Dockerfile handles it by:
- Installing `chromium` via apt (not downloading via Puppeteer)
- Setting `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`
- Setting `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
- Using `--no-sandbox --disable-setuid-sandbox` flags in `server.js`

If Railway builds fail with Chromium errors, check that the Dockerfile's apt packages are still correct for the base image (`node:20-slim` = Debian Bookworm).

### 🟡 Memory Usage

Puppeteer + Chromium is memory-hungry. Railway's free tier (512MB) might not be enough under load. The app keeps a single browser instance alive (`getBrowser()` reuses it), which helps, but:
- Each open page consumes ~50-100MB
- Under concurrent requests, memory can spike
- **Recommendation:** Use at least the **Hobby plan** ($5/mo) or a 1GB+ instance

### 🟡 Cold Starts

The first request after deploy will be slow (~5-10s) because Puppeteer needs to launch Chromium. Subsequent requests reuse the browser instance. The healthcheck in `railway.toml` helps Railway know when the app is ready.

### 🟡 Timeout on Heavy Pages

`/fetch`, `/screenshot`, `/extract`, and `/compare` all use a 30-second Puppeteer timeout (`waitUntil: 'networkidle2'`). Some heavy pages may time out. This is a server-side setting, not a Railway issue.

### 🟡 No `.dockerignore`

There's no `.dockerignore`. Consider adding one to speed up builds:

```
node_modules
.env
.git
```

### 🟢 Payments Are Off by Default

`ENABLE_PAYMENTS=false` means all endpoints work without x402 payment headers. Good for testing. Flip to `true` + set `WALLET_ADDRESS` when ready to monetize.

### 🟢 No Database Needed

The app is stateless. No DB, no Redis, no persistent storage. Pure compute. Makes Railway deployment simple.

---

## Quick Reference: Railway CLI (If Available Later)

```bash
# Login
railway login

# Link to project
railway link

# Deploy
railway up

# Check logs
railway logs

# Set env var
railway variables set ENABLE_PAYMENTS=true
```

---

## Architecture Summary

```
Client → Railway (public URL)
           → Express server (port from $PORT)
              → Puppeteer/Chromium (for /fetch, /screenshot, /extract, /compare)
              → pdf-parse (for /pdf)
              → x402 middleware (optional, for payment gating)
                 → x402.org facilitator (verifies USDC payments on Base)
```

**Dependencies:** express, puppeteer, @mozilla/readability, jsdom, pdf-parse, cors, dotenv, @x402/core, @x402/evm, @x402/express
