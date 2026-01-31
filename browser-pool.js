/**
 * BrowserPool - Manages concurrent Puppeteer page access with request queuing.
 * Prevents crashes under load by limiting concurrent pages and queuing excess requests.
 */
import puppeteer from 'puppeteer';

export class BrowserPool {
  constructor(options = {}) {
    this.maxConcurrent = parseInt(options.maxConcurrent || process.env.MAX_CONCURRENT || 3);
    this.maxQueueSize = parseInt(options.maxQueueSize || process.env.MAX_QUEUE_SIZE || 50);
    this.pageTimeout = parseInt(options.pageTimeout || process.env.PAGE_TIMEOUT || 30000);

    this.browser = null;
    this.activeRequests = 0;
    this.queue = []; // { resolve, reject, enqueueTime }
    this.completedWaitTimes = []; // rolling window for avg calc
    this.maxWaitTimeSamples = 100;
    this.totalProcessed = 0;
    this.totalTimedOut = 0;
    this.shuttingDown = false;
  }

  async getBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
    return this.browser;
  }

  /**
   * Acquire a page from the pool. Returns a page and a release function.
   * If all slots are busy, the request is queued.
   * Rejects with 503 if queue is full.
   */
  acquire() {
    if (this.shuttingDown) {
      return Promise.reject(new PoolError('Server is shutting down', 503));
    }

    if (this.activeRequests < this.maxConcurrent) {
      return this._createPage();
    }

    // Queue the request
    if (this.queue.length >= this.maxQueueSize) {
      const estimatedWait = this._estimateWaitTime();
      const err = new PoolError(
        `Queue full (${this.queue.length}/${this.maxQueueSize}). Estimated wait: ${Math.round(estimatedWait / 1000)}s. Try again later.`,
        503
      );
      err.estimatedWaitMs = estimatedWait;
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, enqueueTime: Date.now() };
      this.queue.push(entry);
    });
  }

  async _createPage() {
    this.activeRequests++;
    try {
      const browser = await this.getBrowser();
      const page = await browser.newPage();

      // Set up timeout auto-kill
      const timeoutHandle = setTimeout(() => {
        console.warn(`[BrowserPool] Page exceeded timeout (${this.pageTimeout}ms), force-closing`);
        this.totalTimedOut++;
        page.close().catch(() => {});
      }, this.pageTimeout);

      const release = async () => {
        clearTimeout(timeoutHandle);
        try { await page.close(); } catch {}
        this.activeRequests--;
        this.totalProcessed++;
        this._processQueue();
      };

      return { page, release };
    } catch (err) {
      this.activeRequests--;
      this._processQueue();
      throw err;
    }
  }

  _processQueue() {
    if (this.queue.length === 0 || this.activeRequests >= this.maxConcurrent) return;

    const entry = this.queue.shift();
    const waitTime = Date.now() - entry.enqueueTime;
    this._recordWaitTime(waitTime);

    this._createPage().then(entry.resolve).catch(entry.reject);
  }

  _recordWaitTime(ms) {
    this.completedWaitTimes.push(ms);
    if (this.completedWaitTimes.length > this.maxWaitTimeSamples) {
      this.completedWaitTimes.shift();
    }
  }

  _estimateWaitTime() {
    if (this.completedWaitTimes.length === 0) {
      // No data yet — estimate based on page timeout and queue depth
      return (this.queue.length / this.maxConcurrent) * (this.pageTimeout / 2);
    }
    const avg = this.completedWaitTimes.reduce((a, b) => a + b, 0) / this.completedWaitTimes.length;
    return avg * (this.queue.length / this.maxConcurrent + 1);
  }

  get avgWaitMs() {
    if (this.completedWaitTimes.length === 0) return 0;
    return Math.round(
      this.completedWaitTimes.reduce((a, b) => a + b, 0) / this.completedWaitTimes.length
    );
  }

  get stats() {
    return {
      active_requests: this.activeRequests,
      queue_depth: this.queue.length,
      max_concurrent: this.maxConcurrent,
      max_queue_size: this.maxQueueSize,
      page_timeout_ms: this.pageTimeout,
      avg_wait_ms: this.avgWaitMs,
      total_processed: this.totalProcessed,
      total_timed_out: this.totalTimedOut,
    };
  }

  /**
   * Graceful shutdown: reject new requests, drain existing queue, close browser.
   */
  async shutdown() {
    this.shuttingDown = true;
    console.log(`[BrowserPool] Shutting down. Active: ${this.activeRequests}, Queued: ${this.queue.length}`);

    // Reject all queued requests
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      entry.reject(new PoolError('Server is shutting down', 503));
    }

    // Wait for active requests to finish (with a timeout)
    const drainTimeout = this.pageTimeout + 5000;
    const start = Date.now();
    while (this.activeRequests > 0 && Date.now() - start < drainTimeout) {
      await new Promise(r => setTimeout(r, 200));
    }

    if (this.activeRequests > 0) {
      console.warn(`[BrowserPool] ${this.activeRequests} requests still active after drain timeout, force-closing`);
    }

    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
    }

    console.log('[BrowserPool] Shutdown complete');
  }
}

export class PoolError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'PoolError';
    this.statusCode = statusCode;
  }
}
