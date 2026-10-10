'use strict';
const problem = code => Object.assign(new Error({
  COOKIE_SAVE_FAILED: 'Could not save this source session',
  COOKIE_SAVE_BUSY: 'Source cookies are still changing; saving will continue automatically',
  COOKIE_RESET_FAILED: 'Could not reset this source session',
  COOKIE_RESET_IN_PROGRESS: 'This source session is being reset',
  COOKIE_PERSISTENCE_CLOSED: 'This source session is closing',
}[code]), { code });

// One instance belongs to one main-owned Chromium Session. Cookie values,
// domains and partition keys never leave this class. Saving changes no expiry:
// session cookies remain session cookies, even after a successful disk flush.
class CookiePersistence {
  #state = { state: 'idle' };
  #version = 0;
  #savedVersion = 0;
  #pending;
  #timer;
  #resetting = false;
  #resetPending;
  #closed = false;
  #closePending;
  #failureRetries = 0;
  constructor(ses, { debounceMs = 100, now = Date.now } = {}) {
    if (!ses?.cookies || typeof ses.cookies.on !== 'function' || typeof ses.cookies.removeListener !== 'function' ||
        typeof ses.cookies.flushStore !== 'function' || typeof ses.cookies.get !== 'function' ||
        typeof ses.flushStorageData !== 'function') throw new TypeError('A Chromium source session is required');
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || typeof now !== 'function') throw new TypeError('Invalid cookie persistence options');
    this.session = ses;
    this.options = { debounceMs, now };
    this.changed = () => {
      if (this.#closed || this.#resetting) return;
      this.#version++;
      this.#failureRetries = 0;
      this.#state = { state: 'saving' };
      this.#schedule();
    };
    ses.cookies.on('changed', this.changed);
  }

  status() { return { ...this.#state }; }

  #cancelTimer() { clearTimeout(this.#timer); this.#timer = undefined; }

  #schedule(delay = this.options.debounceMs) {
    if (this.#timer || this.#closed || this.#resetting) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#start(true).catch(() => {}); // Failure is observable through status(); no raw error logging.
    }, delay);
    this.#timer.unref?.();
  }

  save() {
    if (this.#closed) return Promise.reject(problem('COOKIE_PERSISTENCE_CLOSED'));
    if (this.#resetting) return Promise.reject(problem('COOKIE_RESET_IN_PROGRESS'));
    this.#cancelTimer();
    this.#failureRetries = 0;
    return this.#start(true);
  }

  #start(force) {
    if (this.#pending) return this.#pending;
    if (force && this.#version === this.#savedVersion) this.#version++;
    const pending = this.#flush().finally(() => { if (this.#pending === pending) this.#pending = undefined; });
    this.#pending = pending;
    return pending;
  }

  async #flush() {
    this.#state = { state: 'saving' };
    try {
      for (let pass = 0; pass < 3 && !this.#resetting; pass++) {
        const version = this.#version;
        await this.session.cookies.flushStore();
        await this.session.flushStorageData();
        const cookies = await this.session.cookies.get({});
        if (this.#resetting) throw problem('COOKIE_RESET_IN_PROGRESS');
        // Changes during either flush or the metadata read require another flush.
        if (version !== this.#version) continue;
        const now = this.options.now();
        let persistentCookies = 0, sessionCookies = 0;
        for (const cookie of cookies) {
          const expiry = cookie.expirationDate;
          if (Number.isFinite(expiry) && expiry <= now / 1000) continue;
          if (cookie.session === true || !Number.isFinite(expiry)) sessionCookies++;
          else persistentCookies++;
        }
        this.#savedVersion = version;
        this.#failureRetries = 0;
        this.#cancelTimer();
        this.#state = { state: 'saved', savedAt: now, persistentCookies, sessionCookies };
        return this.status();
      }
      if (this.#resetting) throw problem('COOKIE_RESET_IN_PROGRESS');
      this.#schedule();
      throw problem('COOKIE_SAVE_BUSY');
    } catch (error) {
      if (this.#resetting) throw problem('COOKIE_RESET_IN_PROGRESS');
      if (error?.code === 'COOKIE_SAVE_BUSY') throw error;
      this.#state = { state: 'failed' };
      // Retry transient native storage failures without a Save button. Bound
      // attempts and back off; a later cookie change starts a new retry budget.
      if (this.#failureRetries < 3 && !this.#closed) {
        const delay = this.options.debounceMs * (2 ** this.#failureRetries++);
        this.#schedule(Math.max(1, delay));
      }
      throw problem('COOKIE_SAVE_FAILED');
    }
  }

  reset(clear) {
    if (this.#closed) return Promise.reject(problem('COOKIE_PERSISTENCE_CLOSED'));
    if (this.#resetting) return Promise.reject(problem('COOKIE_RESET_IN_PROGRESS'));
    if (typeof clear !== 'function') return Promise.reject(new TypeError('A trusted source clear operation is required'));
    this.#resetting = true;
    this.#failureRetries = 0;
    this.#cancelTimer();
    this.#state = { state: 'idle' };
    const pending = (async () => {
      await this.#pending?.catch(() => {});
      try {
        await clear();
        this.#savedVersion = this.#version;
        this.#state = { state: 'idle' };
        return this.status();
      } catch {
        this.#state = { state: 'failed' };
        throw problem('COOKIE_RESET_FAILED');
      } finally { this.#resetting = false; }
    })();
    this.#resetPending = pending;
    return pending;
  }

  close() {
    if (this.#closePending) return this.#closePending;
    this.#closed = true;
    this.#cancelTimer();
    this.session.cookies.removeListener('changed', this.changed);
    this.#closePending = (async () => {
      if (this.#resetting) await this.#resetPending;
      await this.#pending?.catch(() => {});
      if (this.#version !== this.#savedVersion) await this.#start(false);
      return this.status();
    })();
    return this.#closePending;
  }
}
module.exports = { CookiePersistence };
