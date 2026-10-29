const $ = id => document.getElementById(id);
let job = null, translation = null, control = null, generation = 0, output = '', firstPaint = false;
const windowId = (await chrome.windows.getCurrent()).id;
function stop(label = '已停止') {
  generation++;
  translation?.disconnect(); translation = null;
  $('stop').disabled = true; $('result').setAttribute('aria-busy', 'false');
  if (job) $('status').textContent = label;
}
function show(next) {
  if (next?.requestId === job?.requestId) return;
  stop(); job = next; output = '';
  $('hint').hidden = Boolean(job); $('content').hidden = !job;
  $('source').textContent = job?.text || ''; $('result').textContent = '';
  $('error').hidden = true; $('timings').textContent = ''; $('copy').disabled = true;
  if (job) start();
}
function start(force = false) {
  stop();
  if (!job) return;
  const token = generation, startedAt = performance.now();
  output = ''; firstPaint = false;
  $('result').textContent = ''; $('result').setAttribute('aria-busy', 'true');
  $('error').hidden = true; $('timings').textContent = ''; $('copy').disabled = true;
  $('stop').disabled = false; $('status').textContent = '正在连接…';
  const port = chrome.runtime.connect({ name: 'panel-translation' }); translation = port;
  port.onMessage.addListener(message => {
    if (token !== generation) return;
    if (message.type === 'start') $('status').textContent = `翻译为${message.targetLanguage}`;
    if (message.type === 'delta') {
      output += message.delta; $('result').textContent = output; $('copy').disabled = !output;
      if (!firstPaint) {
        firstPaint = true;
        requestAnimationFrame(() => { if (token === generation) port.postMessage({ type: 'render-metric', value: Math.max(0, Date.now() - message.sentAt) }); });
      }
    }
    if (message.type === 'done') {
      output = message.text; $('result').textContent = output; $('copy').disabled = !output;
      $('status').textContent = message.cached ? '完成 · 会话缓存' : '翻译完成';
      $('timings').textContent = `插件响应 ${message.popupMs ?? Math.round(performance.now() - startedAt)} ms · 接口首字 ${Math.round(message.firstTokenMs)} ms · 完整 ${Math.round(message.totalMs)} ms`;
      $('stop').disabled = true; $('result').setAttribute('aria-busy', 'false');
    }
    if (message.type === 'error') {
      $('error').textContent = message.message; $('error').hidden = false;
      $('status').textContent = '未完成'; $('stop').disabled = true; $('result').setAttribute('aria-busy', 'false');
    }
  });
  port.onDisconnect.addListener(() => {
    if (token === generation && !$('stop').disabled) {
      $('status').textContent = '连接已中断，请重新翻译'; $('stop').disabled = true;
      $('result').setAttribute('aria-busy', 'false');
    }
  });
  port.postMessage({ type: 'start', requestId: job.requestId, windowId, force });
}
function connect() {
  control = chrome.runtime.connect({ name: 'sidepanel' });
  control.onMessage.addListener(message => {
    if (message.type === 'selection') {
      show(message.job);
      $('hint').textContent = message.notice || '在 PDF 中选中文字，右键选择“翻译选中内容”。';
    }
  });
  control.onDisconnect.addListener(() => {
    // A completed result remains readable when an idle worker is suspended.
    if (!$('stop').disabled) stop('后台连接中断，请重新翻译');
    setTimeout(connect, 300);
  });
  control.postMessage({ type: 'hello', windowId });
}
$('stop').addEventListener('click', () => stop());
$('retry').addEventListener('click', () => start(true));
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(output); $('status').textContent = '译文已复制'; }
  catch { $('status').textContent = '复制失败，请选择译文手动复制'; }
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.addEventListener('keydown', event => { if (event.key === 'Escape') stop(); });
function dismiss() {
  const requestId = job?.requestId;
  show(null);
  try { control?.postMessage({ type: 'dismiss', requestId }); } catch { /* worker already stopped */ }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) dismiss(); });
window.addEventListener('pagehide', () => { dismiss(); control?.disconnect(); });
connect();
