'use strict';
const { setTimeout: wait } = require('node:timers/promises');

const CONTENT_READS = new Set(['content.popular', 'content.latest', 'content.search', 'content.details', 'content.pages']);
const HTTP_FAILURES = new Set(['HELPER_HTTP_429', 'HELPER_HTTP_502', 'HELPER_HTTP_503', 'HELPER_HTTP_504']);
const CONNECTION_FAILURES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const cancelled = () => Object.assign(new Error('Content retry cancelled'), { code: 'READ_RETRY_CANCELLED' });
const transient = error => HTTP_FAILURES.has(error?.code) || CONNECTION_FAILURES.has(error?.code)
  || error?.name === 'TimeoutError' || error instanceof TypeError && CONNECTION_FAILURES.has(error.cause?.code);

// Retry only classified ordinary failures, never a parser error or an HTML
// challenge. The caller owns each attempt's gate and verification checkpoint.
class ContentReadRetry {
  #closing = new AbortController();
  constructor({ delays = [250, 750] } = {}) {
    if (!Array.isArray(delays) || delays.length > 2 || delays.some(delay => !Number.isInteger(delay) || delay < 0 || delay > 5000))
      throw new TypeError('Content retry permits at most two bounded delays');
    this.delays = [...delays];
  }
  async run(operation, method, task, { canRetry = () => true, owner } = {}) {
    this.#closing.signal.throwIfAborted();
    // Hydration and writes never retry; do not attach per-request window
    // listeners to those concurrent operations.
    if (!CONTENT_READS.has(operation) || method !== 'GET') return task(0);
    const closingWindow = new AbortController();
    const stop = () => closingWindow.abort(cancelled());
    owner?.once?.('destroyed', stop);
    const signal = AbortSignal.any([this.#closing.signal, closingWindow.signal]);
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        if (owner?.isDestroyed?.()) throw cancelled();
        try { return await task(attempt); }
        catch (error) {
          if (attempt >= this.delays.length || !transient(error) || !canRetry()) throw error;
          try { await wait(this.delays[attempt], undefined, { signal }); }
          catch { signal.throwIfAborted(); throw error; }
          signal.throwIfAborted();
          if (!canRetry()) throw error;
        }
      }
    } finally { owner?.removeListener?.('destroyed', stop); }
  }
  close() { this.#closing.abort(cancelled()); }
}

module.exports = { ContentReadRetry };
