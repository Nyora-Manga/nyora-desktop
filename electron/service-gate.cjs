'use strict';

// A native backup preview and commit must see a quiet application. Already
// accepted service calls drain; subsequent calls fail visibly until it closes.
class ServiceGate {
  #active = new Set();
  #exclusive = false;
  #exclusiveDone;
  #closing = false;
  run(operation) {
    if (this.#closing) return Promise.reject(new Error('Nyora is closing'));
    if (this.#exclusive) return Promise.reject(new Error('A backup operation is in progress. Finish or cancel its dialog, then try again.'));
    const pending = Promise.resolve().then(operation);
    this.#active.add(pending);
    return pending.finally(() => this.#active.delete(pending));
  }
  async exclusive(operation) {
    if (this.#closing) throw new Error('Nyora is closing');
    if (this.#exclusive) throw new Error('Another backup operation is already in progress');
    this.#exclusive = true;
    this.#exclusiveDone = Promise.withResolvers();
    try {
      await Promise.allSettled([...this.#active]);
      return await operation();
    } finally { this.#exclusive = false; this.#exclusiveDone.resolve(); this.#exclusiveDone = undefined; }
  }
  async close() {
    this.#closing = true;
    await Promise.allSettled([...this.#active, this.#exclusiveDone?.promise]);
  }
}
module.exports = { ServiceGate };
