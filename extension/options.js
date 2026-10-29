import { DEFAULTS, normalizeEndpoint, permissionOrigin, publicError, validateSettings } from './lib/config.mjs';

const $ = id => document.getElementById(id);
let testPort = null, dirty = false, saving = false, loaded = false;
const fields = ['endpoint', 'api-key', 'model', 'target-language', 'stream', 'draggable', 'close-on-outside-click'];
function readForm() {
  return { endpoint: $('endpoint').value, apiKey: $('api-key').value, model: $('model').value,
    targetLanguage: $('target-language').value, stream: $('stream').checked,
    draggable: $('draggable').checked, closeOnOutsideClick: $('close-on-outside-click').checked };
}
function feedback(message, isError = false) {
  $('feedback').textContent = message; $('feedback').classList.toggle('error', isError); $('feedback').hidden = false;
}
function preview() {
  try {
    const url = normalizeEndpoint($('endpoint').value);
    $('endpoint-preview').textContent = url;
    $('http-note').hidden = !url.startsWith('http:');
  } catch {
    $('endpoint-preview').textContent = $('endpoint').value.trim() ? '请输入有效的 HTTP(S) API 地址' : '填写地址后自动生成';
    $('http-note').hidden = true;
  }
}
function busy(value) {
  saving = value;
  $('save').disabled = value; $('test').disabled = value;
  for (const id of fields) $(id).disabled = value;
}
async function saveSettings() {
  const settings = validateSettings(readForm());
  // Request synchronously from the initiating click/submit, before any await.
  const granted = await chrome.permissions.request({ origins: [permissionOrigin(settings.endpoint)] });
  if (!granted) throw new Error('PERMISSION_DENIED');
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.local.set({ settings });
  // Remove only obsolete API grants, never the temporary activeTab grant.
  const permissions = await chrome.permissions.getAll();
  const retained = permissionOrigin(settings.endpoint);
  const obsolete = (permissions.origins || []).filter(origin => /^https?:\/\//.test(origin) && origin !== retained);
  if (obsolete.length) await chrome.permissions.remove({ origins: obsolete });
  dirty = false; $('saved-state').textContent = '已保存在本地'; $('saved-state').classList.add('saved');
  return settings;
}
function showSaveError(error) {
  feedback(error.message === 'PERMISSION_DENIED' ? '未获得 API 域名访问权限。再次保存时，请允许访问该域名。' : publicError(error).message, true);
}
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); if (saving || !loaded) return;
  busy(true);
  try { await saveSettings(); feedback('配置已保存。现在可以回到网页，选中文字后按快捷键翻译。'); }
  catch (error) { showSaveError(error); }
  finally { busy(false); }
});
$('test').addEventListener('click', async () => {
  if (saving || !loaded || !$('settings-form').reportValidity()) return;
  stopTest(false); busy(true);
  try {
    await saveSettings();
    feedback('配置已保存，正在发送一条短文本测试请求。');
    $('test-result').hidden = false; $('test-output').textContent = '';
    $('test-model').textContent = ''; $('test-timings').textContent = '';
    $('test-status').textContent = '正在连接…'; $('cancel-test').hidden = false;
    const port = chrome.runtime.connect({ name: 'connection-test' }); testPort = port;
    let finished = false;
    const finish = () => { finished = true; $('cancel-test').hidden = true; busy(false); };
    port.onMessage.addListener(message => {
      if (testPort !== port) return;
      if (message.type === 'delta') $('test-output').textContent += message.delta;
      if (message.type === 'done') {
        $('test-status').textContent = '连接成功 ✓'; $('test-output').textContent = message.text;
        $('test-model').textContent = `${message.modelReported ? '实际返回模型' : '配置模型（接口未报告）'}：${message.model}`;
        $('test-timings').textContent = `接口首字 ${ms(message.firstTokenMs)} · 完整返回 ${ms(message.totalMs)}`;
        feedback('测试成功。可以回到网页开始翻译。'); finish();
        port.disconnect(); testPort = null;
      }
      if (message.type === 'error') {
        $('test-status').textContent = '测试未通过'; feedback(message.message, true); finish();
        port.disconnect(); testPort = null;
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (testPort === port && !finished) {
        $('test-status').textContent = '连接已中断'; feedback('测试连接中断，请重试。', true); finish(); testPort = null;
      }
    });
    port.postMessage({ type: 'start' });
  } catch (error) { showSaveError(error); busy(false); $('cancel-test').hidden = true; }
});
function stopTest(show = true) {
  if (!testPort) return;
  const old = testPort; testPort = null; old.disconnect(); busy(false); $('cancel-test').hidden = true;
  if (show) { $('test-status').textContent = '测试已停止'; feedback('已停止接收测试结果。'); }
}
$('cancel-test').addEventListener('click', () => stopTest());
$('toggle-key').addEventListener('click', () => {
  const reveal = $('api-key').type === 'password'; $('api-key').type = reveal ? 'text' : 'password';
  $('toggle-key').textContent = reveal ? '隐藏' : '显示';
  $('toggle-key').setAttribute('aria-label', reveal ? '隐藏 API Key' : '显示 API Key');
  $('toggle-key').setAttribute('aria-pressed', String(reveal));
});
for (const id of fields) $(id).addEventListener('input', () => {
  dirty = true; $('saved-state').textContent = '有未保存的修改'; $('saved-state').classList.remove('saved');
  if (id === 'endpoint') preview();
});
function ms(value) { return Number.isFinite(value) ? `${Math.round(value)} ms` : '—'; }
function showMetrics(data) {
  if (!data) return;
  $('metric-popup').textContent = ms(data.popupMs); $('metric-first').textContent = ms(data.firstTokenMs);
  $('metric-total').textContent = ms(data.totalMs); $('metric-render').textContent = ms(data.renderMs);
  $('metrics-source').textContent = [data.isTest ? '连接测试' : data.cached ? '会话缓存' : '网页翻译', new Date(data.recordedAt).toLocaleTimeString()].join(' · ');
}
async function shortcuts() {
  const commands = await chrome.commands.getAll();
  for (const [name, id] of [['translate-selection', 'current-shortcut']]) {
    const command = commands.find(item => item.name === name), container = $(id);
    container.replaceChildren();
    if (!command?.shortcut) container.textContent = '未绑定 · 请点击修改快捷键';
    else for (const key of command.shortcut.split('+')) {
      const node = document.createElement('kbd'); node.textContent = key; container.append(node);
    }
  }
}
$('open-shortcuts').addEventListener('click', () => {
  const edge = /Edg\//.test(navigator.userAgent);
  chrome.tabs.create({ url: edge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts' });
});
window.addEventListener('focus', () => { void shortcuts().catch(() => {}); });
window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.lastPanelEvent) showPanelDiagnostic(changes.lastPanelEvent.newValue);
  if (area === 'session' && changes.latestMetrics) showMetrics(changes.latestMetrics.newValue);
  if (area === 'local' && changes.settings && loaded && !saving) {
    feedback('配置已在其他设置页更改，请刷新本页后再编辑。', true);
  }
});
async function initialize() {
  busy(true);
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const [{ settings: stored }, { latestMetrics, lastPanelEvent }] = await Promise.all([
      chrome.storage.local.get('settings'), chrome.storage.session.get(['latestMetrics', 'lastPanelEvent'])
    ]);
    const settings = { ...DEFAULTS, ...stored };
    $('endpoint').value = settings.endpoint; $('api-key').value = settings.apiKey; $('model').value = settings.model;
    $('target-language').value = settings.targetLanguage; $('stream').checked = settings.stream;
    $('draggable').checked = settings.draggable; $('close-on-outside-click').checked = settings.closeOnOutsideClick;
    if (stored?.endpoint && stored.model) { $('saved-state').textContent = '已保存在本地'; $('saved-state').classList.add('saved'); }
    preview(); showMetrics(latestMetrics); showPanelDiagnostic(lastPanelEvent); await shortcuts(); loaded = true;
  } catch { feedback('无法读取扩展配置，请重新加载扩展后打开设置页。', true); }
  finally { busy(false); }
}
void initialize();

function showPanelDiagnostic(data) {
  if (!data) return;
  const labels = { received: '已收到菜单，正在打开', opened: '打开接口已成功返回', failed: '未成功' };
  $('panel-diagnostic').textContent = `最近一次 PDF 右键：${labels[data.stage] || data.stage}；选区 ${data.selectionLength} 字符；标签 ${data.menuTabId ?? '未提供'}，窗口 ${data.menuWindowId ?? '未提供'}${data.code ? `；${data.code}` : ''}。`;
}
