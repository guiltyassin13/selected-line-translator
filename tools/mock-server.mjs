import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { textPDF, imagePDF } from '../tests/pdf-fixtures.mjs';

export async function startMockServer({ port = 0 } = {}) {
  const state = { requests: [], aborted: 0, pdfRequests: [] };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.url.startsWith('/pdf/')) {
      state.pdfRequests.push(req.url);
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/pdf/denied.pdf') { res.writeHead(403).end(); return; }
      if (path === '/pdf/html.pdf') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Sign in first</html>'); return; }
      if (path === '/pdf/redirect.pdf') { res.writeHead(302, { Location: '/pdf/sample.pdf' }).end(); return; }
      if (path === '/pdf/large.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 200 * 1024 * 1024 }).end(); return; }
      const bytes = path === '/pdf/image.pdf' ? imagePDF() : path === '/pdf/broken.pdf' ? Buffer.from('%PDF-1.7 broken') : textPDF({
        pages: path === '/pdf/long.pdf' ? 80 : path === '/pdf/chinese.pdf' ? 1 : 3,
        chinese: path === '/pdf/chinese.pdf', encrypted: path === '/pdf/encrypted.pdf'
      });
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length }); res.end(bytes); return;
    }
    if (req.url === '/fixture' || req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(await readFile(new URL('../tests/fixture.html', import.meta.url))); return;
    }
    if (req.url === '/frame') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><meta charset="utf-8"><body style="font:18px/1.8 sans-serif"><p id="frame-text">Reading connects us with new ideas.</p><textarea id="frame-input">This is a selection inside a frame.</textarea></body></html>'); return;
    }
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    let data;
    try { data = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    // Fake credentials only: never run this mock with a real key.
    state.requests.push({ url: req.url, data, hasAuth: Boolean(req.headers.authorization) });
    const model = data.model;
    if (/^error-\d+$/.test(model)) {
      res.writeHead(Number(model.slice(6)), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_MESSAGE_DO_NOT_DISPLAY' } })); return;
    }
    if (model === 'redirect') { res.writeHead(307, { Location: '/v1/chat/completions' }).end(); return; }
    if (model === 'bad-json') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{invalid'); return; }
    const text = data.messages?.[1]?.content || '';
    const translation = ['long-result', 'growing-result'].includes(model) ? Array.from({length:60}, (_,i)=>`第${i+1}段：这是用于检查浮窗阅读尺寸与独立滚动的长译文。`).join('\n') : data.messages?.[0]?.content.includes('into English') ? 'Stay curious about the world.' :
      text.includes('best way') ? '学习最好的方式，就是保持好奇。' : text.includes('connects') ? '阅读让我们接触新的想法。' : '对世界保持好奇。\n阅读让理解不断生长。';
    if (!data.stream || model === 'json-fallback') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: `${model}-actual`, choices: [{ message: { content: translation }, finish_reason: 'stop' }] })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    let ended = false;
    res.on('close', () => { if (!ended) state.aborted++; });
    const interval = model === 'slow' ? 200 : 12;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    if (model === 'timeout') {
      await new Promise(resolve => { const timer = setTimeout(resolve, 28000); res.once('close', () => { clearTimeout(timer); resolve(); }); });
      if (!res.destroyed) res.end(); return;
    }
    const chunks = model === 'growing-result' ? translation.match(/[\s\S]{1,45}/g) : Array.from(translation);
    for (const char of chunks) {
      await pause(interval);
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ model: `${model}-actual`, choices: [{ delta: { content: char } }] })}\r\n\r\n`);
    }
    if (model === 'incomplete') { ended = true; res.end(); return; }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: model === 'truncated' ? 'length' : 'stop' }] })}\n\n`);
    ended = true; res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    server, state, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await startMockServer({ port: 8765 });
  console.log(`模拟 API: ${mock.url}/v1，模型填 mock，密钥填 mock-key（仅测试用）。`);
  console.log(`选区测试页: ${mock.url}/fixture`);
  console.log('按 Ctrl+C 停止。');
}
