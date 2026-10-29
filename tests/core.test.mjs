import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEndpoint, permissionOrigin, validateSettings, publicError, validateText } from '../extension/lib/config.mjs';
import { requestTranslation, consumeSSE } from '../extension/lib/api.mjs';
import { cacheKey, SessionCache } from '../extension/lib/cache.mjs';
import { startMockServer } from '../tools/mock-server.mjs';

const base = { endpoint: 'https://example.com/v1', model: 'mock', apiKey: 'fake-key', stream: true, targetLanguage: '简体中文' };
test('legacy menu preference is ignored and removed on save without partitioning cache', async () => {
  for (const contextMenuMode of ['popup', 'sidepanel', null, 'unknown']) {
    assert.equal(Object.hasOwn(validateSettings({ ...base, contextMenuMode }), 'contextMenuMode'), false);
  }
  assert.equal(await cacheKey({ ...base, contextMenuMode: 'popup' }, 'same text'), await cacheKey({ ...base, contextMenuMode: 'sidepanel' }, 'same text'));
});
test('endpoint normalization handles root, prefixes, full endpoints, trailing slash and local ports', () => {
  assert.equal(normalizeEndpoint('https://example.com'), 'https://example.com/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://example.com/custom/v1/'), 'https://example.com/custom/v1/chat/completions');
  assert.equal(normalizeEndpoint('http://127.0.0.1:8765/v1/chat/completions/'), 'http://127.0.0.1:8765/v1/chat/completions');
  assert.equal(permissionOrigin('http://127.0.0.1:8765/v1'), 'http://127.0.0.1/*');
  for (const value of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'https://key@host/v1', 'https://host?key=secret', 'https://host/#secret', 'https://host/v1/responses']) assert.throws(() => normalizeEndpoint(value));
});
test('settings and selection validation rejects malformed inputs without rejecting keyless local APIs', () => {
  assert.equal(validateSettings({ ...base, apiKey: '' }).apiKey, '');
  assert.throws(() => validateSettings({ ...base, model: '' }));
  assert.throws(() => validateSettings({ ...base, apiKey: 'fake\nheader' }));
  assert.throws(() => validateSettings({ ...base, stream: 'true' }));
  assert.throws(() => validateText('   '));
  assert.throws(() => validateText('x'.repeat(50001)));
});
test('new popup switches default off for old settings, persist independently and reject non-booleans', () => {
  const legacy = validateSettings(base);
  assert.equal(legacy.draggable, false);
  assert.equal(legacy.closeOnOutsideClick, false);
  const enabled = validateSettings({ ...base, draggable: true, closeOnOutsideClick: true });
  assert.equal(enabled.draggable, true);
  assert.equal(enabled.closeOnOutsideClick, true);
  for (const field of ['draggable', 'closeOnOutsideClick']) {
    assert.throws(() => validateSettings({ ...base, [field]: 'true' }));
  }
});
test('SSE decoder preserves split Unicode, CRLF, comments, multiline data and EOF events', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata: 第一\r\ndata: second\r\n\r\ndata: final');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events = [];
  await consumeSSE(stream, value => events.push(value));
  assert.deepEqual(events, ['第一\nsecond', 'final']);
});
test('SSE DONE ends consumption without waiting for a server EOF', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); } });
  await consumeSSE(stream, value => value !== '[DONE]');
});
test('mock API: streaming/non-streaming, privacy, cancellation, failures, truncation and metrics', async t => {
  const mock = await startMockServer(); t.after(() => mock.close());
  const settings = { ...base, endpoint: `${mock.url}/v1` };
  let deltas = [];
  const streamed = await requestTranslation(settings, 'Stay curious.', { onDelta: text => deltas.push(text) });
  assert.equal(streamed.text, deltas.join('')); assert.ok(deltas.length > 2);
  assert.equal(streamed.model, 'mock-actual'); assert.ok(streamed.firstTokenMs >= 0); assert.ok(streamed.totalMs >= streamed.firstTokenMs);
  const request = mock.state.requests[0];
  assert.deepEqual(Object.keys(request.data).sort(), ['messages', 'model', 'stream']);
  assert.equal(request.hasAuth, true); assert.equal(request.data.messages[1].content, 'Stay curious.');
  const nonstream = await requestTranslation({ ...settings, stream: false }, 'Stay curious.'); assert.equal(nonstream.text, streamed.text);
  const fallback = await requestTranslation({ ...settings, model: 'json-fallback' }, 'Stay curious.'); assert.equal(fallback.text, streamed.text);
  for (const status of [400, 401, 402, 403, 404, 429, 500]) {
    await assert.rejects(requestTranslation({ ...settings, model: `error-${status}` }, 'hello'), error => {
      assert.equal(error.code, `HTTP_${status}`); assert.ok(!error.message.includes('PRIVATE_PROVIDER')); return true;
    });
  }
  for (const [model, code] of [['bad-json', 'FORMAT'], ['truncated', 'TRUNCATED'], ['incomplete', 'INCOMPLETE']]) {
    await assert.rejects(requestTranslation({ ...settings, model }, 'hello'), error => error.code === code);
  }
  const controller = new AbortController();
  await assert.rejects(requestTranslation({ ...settings, model: 'slow' }, 'hello', { signal: controller.signal, onDelta: () => controller.abort() }), error => error.name === 'AbortError');
  await assert.rejects(requestTranslation({ ...settings, model: 'timeout' }, 'hello', { idleTimeoutMs: 30 }), error => error.code === 'TIMEOUT');
  const beforeRedirect = mock.state.requests.length;
  await assert.rejects(requestTranslation({ ...settings, model: 'redirect' }, 'hello'));
  assert.equal(mock.state.requests.length, beforeRedirect + 1, 'redirect is never followed');
});
test('network and provider errors cannot echo secret-bearing exception messages', () => {
  const error = publicError(new Error('Bearer PRIVATE_SECRET'));
  assert.equal(error.code, 'NETWORK'); assert.ok(!error.message.includes('PRIVATE_SECRET'));
});
test('cache partitions endpoint, model, target, stream and API credentials', async () => {
  const original = await cacheKey(base, 'hello');
  assert.equal(await cacheKey({ ...base, draggable: true, closeOnOutsideClick: true }, 'hello'), original, 'UI switches do not change translation cache identity');
  for (const changed of [{ endpoint: 'https://other/v1' }, { model: 'other' }, { targetLanguage: 'English' }, { apiKey: 'another-key' }, { stream: false }]) {
    assert.notEqual(await cacheKey({ ...base, ...changed }, 'hello'), original);
  }
  assert.notEqual(await cacheKey(base, 'other'), original);
  assert.ok(!original.includes('fake-key'));
});
test('session cache survives worker instance changes, concurrent writes and bounded eviction', async () => {
  const state = {};
  const storage = { async get() { return structuredClone(state); }, async set(values) { Object.assign(state, structuredClone(values)); }, async remove(key) { delete state[key]; } };
  const cache = new SessionCache(storage, { maxEntries: 2 });
  await Promise.all([cache.put('a', { text: 'one' }), cache.put('b', { text: 'two' }), cache.put('c', { text: 'three' })]);
  assert.equal(await cache.get('a'), null); assert.equal((await cache.get('b')).text, 'two');
  assert.equal((await new SessionCache(storage).get('c')).text, 'three');
  await cache.clear(); assert.equal(await cache.get('c'), null);
  const tiny = new SessionCache(storage, { maxBytes: 30 });
  await tiny.put('large', { text: 'x'.repeat(100) }); assert.equal(await tiny.get('large'), null);
});
