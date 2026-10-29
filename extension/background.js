import { DEFAULTS, permissionOrigin, publicError, TranslationError, validateSettings, validateText } from './lib/config.mjs';
import { requestTranslation } from './lib/api.mjs';
import { cacheKey, SessionCache } from './lib/cache.mjs';
import { panelJobs, panelReady, openSelectionPanel, connectPanel, clearPanelForTab, trustedPage } from './lib/panel.mjs';
import { selectionMenu, nativePdfFrame, localPdfUrl } from './lib/menu.mjs';

const cache = new SessionCache(chrome.storage.session);
const active = new Map(), triggers = new Map();
// Restrict credentials before any settings read; content scripts never receive them.
const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
storageReady.catch(() => {});

let menuWrites = Promise.resolve();
export function syncContextMenu() {
  menuWrites = menuWrites.catch(() => {}).then(async () => {
    await storageReady;
    const item = selectionMenu();
    await new Promise((resolve, reject) => {
      chrome.contextMenus.removeAll(() => {
        if (chrome.runtime.lastError) { reject(new Error('MENU_REMOVE')); return; }
        chrome.contextMenus.create(item, () => chrome.runtime.lastError ? reject(new Error('MENU_CREATE')) : resolve());
      });
    });
    return item;
  });
  return menuWrites;
}
chrome.runtime.onInstalled.addListener(() => { void syncContextMenu().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void syncContextMenu().catch(() => {}); });
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });

async function badge(tabId, message = '') {
  const scope = Number.isInteger(tabId) && tabId >= 0 ? { tabId } : {};
  await Promise.allSettled([
    chrome.action.setBadgeText({ ...scope, text: message ? '!' : '' }),
    chrome.action.setBadgeBackgroundColor({ ...scope, color: '#a84731' }),
    chrome.action.setTitle({ ...scope, title: message || '选译 · API 与快捷键设置' })
  ]);
}

async function triggerTab(tab, context = {}) {
  if (!tab?.id) return;
  const triggeredAt = Date.now(), generation = (triggers.get(tab.id) || 0) + 1;
  triggers.set(tab.id, generation);
  try {
    if (localPdfUrl(tab.url) || nativePdfFrame({ pageUrl: tab.url })) { await badge(tab.id); return; }
    // This command belongs to ordinary webpages. A file/internal tab can hide
    // its URL from the extension; it must remain inert instead of opening UI.
    if (!/^https?:\/\//.test(tab.url || '')) { await badge(tab.id); return; }
    const [kind] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.contentType });
    if (kind?.result === 'application/pdf') { await badge(tab.id); return; }
    clearPanelForTab(tab.id, active);
    active.get(`tab:${tab.id}`)?.controller.abort();
    if (context.frameId && context.frameUrl && /^https?:/.test(context.frameUrl) && new URL(context.frameUrl).origin !== new URL(tab.url).origin) {
      await badge(tab.id, '首版不支持跨域 iframe，请在普通网页正文中选中文字。');
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    if (triggers.get(tab.id) !== generation) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: payload => globalThis.__selectedLineTranslator.trigger(payload),
      args: [{ selectionText: context.selectionText || '', triggeredAt }]
    });
    await badge(tab.id);
  } catch {
    await badge(tab.id, '此页面不能显示网页浮窗。PDF 请选中文字后点击右键“翻译选中内容”，将自动打开侧栏。');
  }
}

export function handleCommand(command, sourceTab) {
  if (command === 'translate-selection') {
    if (sourceTab) return triggerTab(sourceTab);
    return chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => triggerTab(tab));
  }
  return Promise.resolve();
}
export function handleContextMenu(info, tab) {
  if (info.menuItemId !== 'translate-selection') return Promise.resolve();
  if (typeof info.selectionText !== 'string' || !info.selectionText.trim()) {
    return badge(tab?.id, '浏览器没有提供选中文字，请重新选择可复制的文字后右键翻译。');
  }
  const openPanel = source => {
    const opened = openSelectionPanel(info, source, active, badge);
    if (Number.isInteger(source?.id) && source.id >= 0) {
      triggers.set(source.id, (triggers.get(source.id) || 0) + 1);
      active.get(`tab:${source.id}`)?.controller.abort();
      void chrome.tabs.sendMessage(source.id, { type: 'dismiss-popup' }).catch(() => {});
    }
    return opened;
  };
  // Strong viewer metadata/local filenames can open synchronously. For other
  // documents use an API callback (rather than an awaited Promise) to retain
  // Chromium's extension user-gesture context across the MIME probe.
  if (nativePdfFrame(info) || localPdfUrl(tab?.url || info.pageUrl)) return openPanel(tab);
  const probe = source => new Promise(resolve => {
    if (!Number.isInteger(source?.id) || source.id < 0) {
      resolve(badge(undefined, '无法确认选区所在标签页，请回到原页面重新右键翻译。')); return;
    }
    const generation = (triggers.get(source.id) || 0) + 1;
    triggers.set(source.id, generation);
    chrome.scripting.executeScript({ target: { tabId: source.id }, func: () => document.contentType }, results => {
      const failed = chrome.runtime.lastError;
      if (triggers.get(source.id) !== generation) { resolve(); return; }
      if (failed) {
        resolve(badge(source.id, '无法识别此页面的文档类型，浏览器可能限制了扩展访问。请重新选择文字后重试。')); return;
      }
      resolve(results?.[0]?.result === 'application/pdf' ? openPanel(source) : triggerTab(source, info));
    });
  });
  if (Number.isInteger(tab?.id) && tab.id >= 0) return probe(tab);
  return new Promise(resolve => chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
    if (chrome.runtime.lastError) { resolve(badge(undefined, '无法确认选区所在标签页，请重试。')); return; }
    resolve(localPdfUrl(tabs[0]?.url) ? openPanel(tabs[0]) : probe(tabs[0]));
  }));
}
chrome.commands.onCommand.addListener((command, tab) => { void handleCommand(command, tab).catch(() => badge(tab?.id, '快捷键翻译失败，请重新选择文字后重试。')); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextMenu(info, tab).catch(() => badge(tab?.id, '右键翻译处理失败，请打开设置页查看状态，确认已加载最新版本后重试。'));
});
chrome.tabs.onRemoved.addListener(tabId => {
  clearPanelForTab(tabId, active);
  triggers.delete(tabId);
  active.get(`tab:${tabId}`)?.controller.abort();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.url) {
    triggers.set(tabId, (triggers.get(tabId) || 0) + 1);
    clearPanelForTab(tabId, active);
  }
});
chrome.tabs.onDetached.addListener(tabId => clearPanelForTab(tabId, active));
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => clearPanelForTab(removedTabId, active));
chrome.windows.onRemoved.addListener(windowId => active.get(`panel:${windowId}`)?.controller.abort());

// Browser-level tab activation also works when page visibility events are suppressed.
async function dismissInactivePopups(query, isInactive) {
  await storageReady;
  const { settings } = await chrome.storage.local.get('settings');
  if (settings?.closeOnOutsideClick !== true) return;
  const tabs = await chrome.tabs.query(query);
  await Promise.allSettled(tabs.filter(isInactive).map(tab => chrome.tabs.sendMessage(tab.id, { type: 'dismiss-completed-popup' })));
}
const activations = new Map();
chrome.tabs.onActivated.addListener(({ windowId, tabId }) => {
  const revision = (activations.get(windowId) || 0) + 1;
  activations.set(windowId, revision);
  const job = panelJobs.get(windowId);
  if (job && job.tabId !== tabId) clearPanelForTab(job.tabId, active);
  void panelReady.then(() => {
    if (activations.get(windowId) !== revision) return;
    const restored = panelJobs.get(windowId);
    if (restored && restored.tabId !== tabId) clearPanelForTab(restored.tabId, active);
    else if (!restored) void chrome.sidePanel.close({ windowId }).catch(() => {});
  });
  void dismissInactivePopups({ windowId }, tab => !tab.active).catch(() => {});
});
chrome.windows.onFocusChanged.addListener(windowId => {
  void dismissInactivePopups({ active: true }, tab => tab.windowId !== windowId).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    const { oldValue = {}, newValue = {} } = changes.settings;
    const translationChanged = ['endpoint', 'apiKey', 'model', 'targetLanguage', 'stream']
      .some(field => (oldValue[field] ?? DEFAULTS[field]) !== (newValue[field] ?? DEFAULTS[field]));
    if (!translationChanged) return;
    void cache.clear().catch(() => {});
    for (const request of active.values()) request.controller.abort(new TranslationError('SETTINGS_CHANGED', 'API 配置已更改，请重新翻译。'));
  }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'open-settings') {
    chrome.runtime.openOptionsPage().then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
});

chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  if (port.name === 'sidepanel' && trustedPage(sender, 'sidepanel.html')) {
    connectPanel(port, active); return;
  }
  const isPanel = port.name === 'panel-translation' && trustedPage(sender, 'sidepanel.html');
  const isOptions = trustedPage(sender, 'options.html');
  const isPage = sender?.id === chrome.runtime.id && sender.tab?.id != null && sender.frameId === 0 && /^https?:\/\//.test(sender.url || '');
  if (!(isPanel || (port.name === 'translation' && isPage) || (port.name === 'connection-test' && isOptions))) {
    port.disconnect(); return;
  }
  let key = isOptions ? 'test' : isPanel ? null : `tab:${sender.tab.id}`;
  let request = null, disconnected = false, started = false;
  const post = message => {
    if (!disconnected) {
      try { port.postMessage({ ...message, sentAt: Date.now() }); } catch { request?.controller.abort(); }
    }
  };
  port.onDisconnect.addListener(() => {
    disconnected = true;
    request?.controller.abort();
  });
  port.onMessage.addListener(message => {
    if (message?.type === 'start' && !started) {
      started = true;
      request = { controller: new AbortController(), metrics: null };
      if (!isPanel) {
        active.get(key)?.controller.abort();
        active.set(key, request);
      }
      void run(message, request);
    } else if (message?.type === 'render-metric' && request && Number.isFinite(message.value) && message.value >= 0 && message.value < 10000) {
      request.renderMs = message.value;
      if (request.metrics) {
        request.metrics.renderMs = message.value;
        void chrome.storage.session.set({ latestMetrics: request.metrics }).catch(() => {});
      }
    }
  });

  async function run(message, state) {
    const signal = state.controller.signal;
    // Actual port traffic keeps the worker alive only for the lifetime of this request.
    const heartbeat = setInterval(() => post({ type: 'heartbeat' }), 15000);
    try {
      await storageReady;
      if (isPanel) {
        await panelReady;
        const job = panelJobs.get(message.windowId);
        if (!job || job.requestId !== message.requestId) throw new TranslationError('STALE', '选区已失效，请重新右键选择。');
        const tab = await chrome.tabs.get(job.tabId);
        if (!tab.active || tab.windowId !== job.windowId || panelJobs.get(job.windowId) !== job) throw new TranslationError('STALE', '来源标签页或选区已切换，请重新选择。');
        key = `panel:${job.windowId}`;
        message = { ...message, text: job.text, popupMs: Date.now() - job.triggeredAt };
        signal.throwIfAborted();
        active.get(key)?.controller.abort();
        active.set(key, state);
      }
      signal.throwIfAborted();
      const { settings: stored } = await chrome.storage.local.get('settings');
      // Only these public UI flags go to the page. Credentials stay in the worker.
      post({ type: 'preferences', draggable: stored?.draggable === true, closeOnOutsideClick: stored?.closeOnOutsideClick === true });
      const settings = validateSettings({ ...DEFAULTS, ...stored });
      const text = isOptions ? 'The best way to learn is to stay curious.' : validateText(message.text);
      if (!await chrome.permissions.contains({ origins: [permissionOrigin(settings.endpoint)] })) {
        throw new TranslationError('PERMISSION', '尚未授权访问 API 域名，请在设置中点击“保存配置”完成授权。');
      }
      signal.throwIfAborted();
      const hash = await cacheKey(settings, text);
      const cached = !isOptions && message.force !== true ? await cache.get(hash) : null;
      signal.throwIfAborted();
      post({ type: 'start', targetLanguage: settings.targetLanguage });
      const result = cached || await requestTranslation(settings, text, {
        signal,
        onDelta: (delta, detail) => post({ type: 'delta', delta, ...detail })
      });
      signal.throwIfAborted();
      state.metrics = {
        popupMs: Number.isFinite(message.popupMs) ? Math.max(0, message.popupMs) : null,
        firstTokenMs: cached ? 0 : result.firstTokenMs,
        totalMs: cached ? 0 : result.totalMs,
        renderMs: state.renderMs ?? null,
        model: result.model, modelReported: result.modelReported === true,
        cached: Boolean(cached), isTest: isOptions, recordedAt: Date.now()
      };
      post({ type: 'done', text: result.text, ...state.metrics });
      // Store only complete results. Storage failure never hides a successful translation.
      if (!cached && !isOptions) await cache.put(hash, result).catch(() => {});
      if (!signal.aborted) await chrome.storage.session.set({ latestMetrics: state.metrics }).catch(() => {});
    } catch (error) {
      post({ type: 'error', ...publicError(error) });
    } finally {
      clearInterval(heartbeat);
      if (active.get(key) === state) active.delete(key);
    }
  }
});

