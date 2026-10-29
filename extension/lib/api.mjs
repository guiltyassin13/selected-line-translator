import { buildMessages, httpError, TranslationError, validateSettings, validateText } from './config.mjs';

const malformed = () => new TranslationError('FORMAT', '接口返回格式不兼容，请检查是否为 Chat Completions 接口。');
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('') : '';

// SSE decoding is incremental: UTF-8 characters and CRLF can span network chunks.
export async function consumeSSE(body, onEvent) {
  if (!body) throw malformed();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = [], stopped = false, skipLF = false;
  function line(value) {
    if (!value) {
      if (data.length) {
        stopped = onEvent(data.join('\n')) === false;
        data = [];
      }
    } else if (value === 'data' || value.startsWith('data:')) {
      data.push(value === 'data' ? '' : value.slice(5).replace(/^ /, ''));
    }
  }
  function feed(chunk) {
    for (const character of chunk) {
      if (skipLF) { skipLF = false; if (character === '\n') continue; }
      if (character === '\r' || character === '\n') {
        line(buffer); buffer = ''; skipLF = character === '\r';
        if (stopped) break;
      } else buffer += character;
      if (buffer.length > 1024 * 1024) throw malformed();
    }
  }
  try {
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) {
        feed(decoder.decode());
        if (buffer) line(buffer);
        if (!stopped) line('');
        break;
      }
      feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function requestTranslation(rawSettings, rawText, {
  signal, onDelta = () => {}, fetchImpl = fetch, now = () => performance.now(), idleTimeoutMs = 25000, totalTimeoutMs = 120000
} = {}) {
  const settings = validateSettings(rawSettings), text = validateText(rawText);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  let timeout = false, idleTimer;
  const expire = () => { timeout = true; controller.abort(new DOMException('Timeout', 'AbortError')); };
  const refresh = () => { clearTimeout(idleTimer); idleTimer = setTimeout(expire, idleTimeoutMs); };
  const totalTimer = setTimeout(expire, totalTimeoutMs);
  const start = now();
  let firstTokenMs = null, output = '', model = settings.model, modelReported = false, finishReason = null, doneMarker = false;
  function append(delta) {
    if (!delta) return;
    controller.signal.throwIfAborted();
    if (firstTokenMs === null) firstTokenMs = now() - start;
    output += delta;
    if (output.length > 250000) throw new TranslationError('TOO_LARGE', '接口返回内容过长，翻译已停止。');
    onDelta(delta, { firstTokenMs, model });
  }
  refresh();
  try {
    const response = await fetchImpl(settings.endpoint, {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
      body: JSON.stringify({ model: settings.model, messages: buildMessages(text, settings.targetLanguage), stream: settings.stream })
    });
    if (!response.ok) {
      // Never echo the provider's response: it may contain credentials or source text.
      void response.body?.cancel().catch(() => {});
      throw httpError(response.status);
    }
    refresh();
    const type = response.headers.get('content-type') || '';
    if (type.includes('text/event-stream') || (settings.stream && !type.includes('json'))) {
      await consumeSSE(response.body, data => {
        refresh();
        if (data.trim() === '[DONE]') { doneMarker = true; return false; }
        let event;
        try { event = JSON.parse(data); } catch { throw malformed(); }
        if (!event || typeof event !== 'object') throw malformed();
        if (event.error) throw new TranslationError('PROVIDER', '接口返回服务错误，请检查模型、密钥权限和账户额度。');
        if (typeof event.model === 'string' && event.model) { model = event.model.slice(0, 200); modelReported = true; }
        const choice = event.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        append(contentText(choice?.delta?.content));
      });
      if (!doneMarker && !finishReason) throw new TranslationError('INCOMPLETE', '连接提前结束，译文可能不完整。请手动重试。');
    } else {
      let data;
      try { data = await response.json(); } catch (error) { if (controller.signal.aborted) throw error; throw malformed(); }
      if (!data || typeof data !== 'object') throw malformed();
      if (data.error) throw new TranslationError('PROVIDER', '接口返回服务错误，请检查模型、密钥权限和账户额度。');
      if (typeof data.model === 'string' && data.model) { model = data.model.slice(0, 200); modelReported = true; }
      finishReason = data.choices?.[0]?.finish_reason;
      append(contentText(data.choices?.[0]?.message?.content));
    }
    controller.signal.throwIfAborted();
    if (finishReason === 'length') throw new TranslationError('TRUNCATED', '模型输出达到长度上限，译文不完整。请减少选中内容后重试。');
    if (finishReason === 'content_filter') throw new TranslationError('FILTERED', '服务商未返回完整译文，请检查所选内容或更换模型。');
    if (!output.trim()) throw new TranslationError('EMPTY_RESPONSE', '接口没有返回译文，请检查模型是否支持文本翻译。');
    return { text: output, model, modelReported, firstTokenMs, totalMs: now() - start };
  } catch (error) {
    if (timeout) throw new TranslationError('TIMEOUT', '接口长时间未响应，翻译已停止。请手动重试或选择更快的模型。');
    if (controller.signal.aborted) throw controller.signal.reason || new DOMException('Cancelled', 'AbortError');
    throw error;
  } finally {
    clearTimeout(idleTimer); clearTimeout(totalTimer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
