import { PROMPT_VERSION } from './config.mjs';

export async function cacheKey(settings, text) {
  const data = JSON.stringify([PROMPT_VERSION, settings.endpoint, settings.apiKey, settings.model, settings.targetLanguage, settings.stream, text]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class SessionCache {
  constructor(storage, { maxEntries = 100, maxBytes = 1500000 } = {}) {
    this.storage = storage;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.queue = Promise.resolve();
  }
  async get(key) {
    await this.queue;
    const { translationCache = {} } = await this.storage.get('translationCache');
    return translationCache[key] || null;
  }
  put(key, value) {
    const operation = this.queue.then(async () => {
      const { translationCache = {} } = await this.storage.get('translationCache');
      delete translationCache[key];
      translationCache[key] = value;
      const keys = Object.keys(translationCache);
      while (keys.length && (keys.length > this.maxEntries || new TextEncoder().encode(JSON.stringify(translationCache)).length > this.maxBytes)) {
        delete translationCache[keys.shift()];
      }
      await this.storage.set({ translationCache });
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  clear() {
    const operation = this.queue.then(() => this.storage.remove('translationCache'));
    this.queue = operation.catch(() => {});
    return operation;
  }
}
