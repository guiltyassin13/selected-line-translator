// Only browser-provided selections enter this module. Never inspect PDF DOM or files.
export function trustedPage(sender, page) {
  if (sender?.id !== chrome.runtime.id || sender.frameId > 0) return false;
  try {
    const url = new URL(sender.url);
    const expected = new URL(chrome.runtime.getURL(page));
    return url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname;
  } catch { return false; }
}
export const panelJobs = new Map();
const panels = new Map();
const closingPanels = new WeakSet();
const notices = new Map();
const touched = new Set();
let invocation = 0, lastEvent = null, diagnosticWrites = Promise.resolve();
function diagnostic(event, stage, code = '') {
  if (lastEvent && lastEvent.requestId !== event.requestId && event.sequence < lastEvent.sequence) return;
  lastEvent = { ...event, stage, code, recordedAt: Date.now() };
  const snapshot = lastEvent;
  diagnosticWrites = diagnosticWrites.catch(() => {}).then(async () => {
    await storageReady;
    await chrome.storage.session.set({ lastPanelEvent: snapshot });
  });
  diagnosticWrites.catch(() => {});
}
function failureCode(error) {
  const message = String(error?.message || '');
  if (/gesture/i.test(message)) return 'OPEN_GESTURE';
  if (/permission|disabled|policy/i.test(message)) return 'OPEN_PERMISSION';
  if (/window|tab/i.test(message)) return 'OPEN_WINDOW';
  return 'OPEN_FAILED';
}
export const panelMessages = {
  NO_SELECTION: '浏览器没有提供选中文字。请重新选中 PDF 中可复制的文字，再点击右键菜单。',
  SOURCE_UNAVAILABLE: '无法确认 PDF 所在标签页，请回到 PDF 后重新右键翻译。',
  OPEN_GESTURE: 'Edge/Chrome 未认可这次右键操作为打开侧栏的手势。请回到 PDF 重新选中文字，再点击右键“翻译选中内容”。',
  OPEN_PERMISSION: '浏览器拒绝打开侧栏，请确认扩展已启用并允许新增的侧栏权限。',
  OPEN_WINDOW: '浏览器未能找到 PDF 所在窗口，请回到 PDF 后重新右键翻译。',
  OPEN_UNAVAILABLE: '当前浏览器未提供侧栏打开接口，请更新 Edge/Chrome 后重试。',
  OPEN_FAILED: '浏览器打开侧栏失败。请在设置页查看最近一次 PDF 右键状态，重新加载扩展后回到 PDF 重试。',
};
const storageReady = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
export const panelReady = storageReady.then(async () => {
  const { panelSelections = {} } = await chrome.storage.session.get('panelSelections');
  for (const [id, job] of Object.entries(panelSelections)) {
    if (!touched.has(Number(id))) panelJobs.set(Number(id), job);
  }
});
let writes = Promise.resolve();
function save() {
  writes = writes.catch(() => {}).then(async () => {
    await panelReady;
    await chrome.storage.session.set({ panelSelections: Object.fromEntries(panelJobs) });
  });
  writes.catch(() => {});
}
function notify(windowId) {
  try { panels.get(windowId)?.postMessage({ type: 'selection', job: panelJobs.get(windowId) || null, notice: notices.get(windowId) || '' }); } catch { /* closed */ }
}
function clear(windowId, active) {
  touched.add(windowId);
  active.get(`panel:${windowId}`)?.controller.abort();
  panelJobs.delete(windowId); save(); notify(windowId);
}
export function clearPanelForTab(tabId, active) {
  const close = id => {
    const port = panels.get(id);
    if (port) closingPanels.add(port);
    clear(id, active);
    // Clearing text alone leaves the global browser panel occupying the next tab.
    void chrome.sidePanel.close({ windowId: id }).catch(() => {});
  };
  for (const [id, job] of panelJobs) if (job.tabId === tabId) close(id);
  void panelReady.then(() => {
    for (const [id, job] of panelJobs) if (job.tabId === tabId) close(id);
  });
}
export function openSelectionPanel(info, tab, active, badge) {
  const validId = id => Number.isInteger(id) && id >= 0;
  const event = { requestId: crypto.randomUUID(), sequence: ++invocation,
    menuTabId: validId(tab?.id) ? tab.id : null, menuWindowId: validId(tab?.windowId) ? tab.windowId : null,
    entryPoint: 'context-menu',
    selectionLength: typeof info?.selectionText === 'string' ? info.selectionText.length : 0 };
  let text = typeof info?.selectionText === 'string' ? info.selectionText : '';
  const completeTab = validId(tab?.id) && validId(tab?.windowId);
  let source = completeTab ? tab : null, job = null;
  function bind(resolved) {
    source = resolved;
    const windowId = resolved.windowId;
    touched.add(windowId); notices.delete(windowId);
    active.get(`panel:${windowId}`)?.controller.abort();
    if (text.trim()) {
      job = { windowId, tabId: resolved.id, requestId: event.requestId, text: text.slice(0, 50001), triggeredAt: Date.now() };
      panelJobs.set(windowId, job);
    } else {
      panelJobs.delete(windowId); notices.set(windowId, panelMessages.NO_SELECTION);
    }
    save(); notify(windowId);
  }
  if (source) bind(source);
  // Native PDF menus can omit the ordinary Tab fields. Open FIRST, then resolve
  // the active source tab; awaiting tabs.query here would lose the user gesture.
  const options = validId(tab?.windowId) ? { windowId: tab.windowId }
    : validId(tab?.id) ? { tabId: tab.id } : { windowId: chrome.windows.WINDOW_ID_CURRENT ?? -2 };
  let opened;
  try {
    if (!chrome.sidePanel?.open) throw new Error('API_UNAVAILABLE');
    opened = chrome.sidePanel.open(options);
  } catch (error) { opened = Promise.reject(error); }
  diagnostic(event, 'received');
  // Attach rejection handling immediately, before doing asynchronous source lookup.
  const outcome = Promise.resolve(opened).then(() => null, error => error);
  return (async () => {
    if (!source) {
      try {
        const [candidate] = await chrome.tabs.query(validId(tab?.windowId)
          ? { active: true, windowId: tab.windowId } : { active: true, lastFocusedWindow: true });
        if (lastEvent?.requestId !== event.requestId) return;
        if (!validId(candidate?.id) || !validId(candidate?.windowId)) throw new Error('missing-source');
        source = candidate;
        bind(candidate);
      } catch {
        diagnostic(event, 'failed', 'SOURCE_UNAVAILABLE');
        await badge(undefined, panelMessages.SOURCE_UNAVAILABLE); return;
      }
    }
    const error = await outcome;
    if (lastEvent?.requestId !== event.requestId) return;
    if (error) {
      const code = error.message === 'API_UNAVAILABLE' ? 'OPEN_UNAVAILABLE' : failureCode(error);
      diagnostic(event, 'failed', code);
      if (!job || panelJobs.get(source.windowId) === job) {
        notices.set(source.windowId, panelMessages[code]); clear(source.windowId, active);
      }
      await badge(source.id, panelMessages[code]);
    } else {
      diagnostic(event, text.trim() ? 'opened' : 'failed', text.trim() ? '' : 'NO_SELECTION');
      await badge(source.id, text.trim() ? '' : panelMessages.NO_SELECTION);
    }
  })();
}
export function connectPanel(port, active) {
  let windowId = null, disconnected = false;
  port.onMessage.addListener(message => {
    if (message?.type === 'dismiss' && panels.get(windowId) === port &&
        message.requestId === panelJobs.get(windowId)?.requestId) {
      clear(windowId, active); return;
    }
    if (message?.type !== 'hello' || windowId !== null || !Number.isInteger(message.windowId)) return;
    windowId = message.windowId;
    panels.set(windowId, port);
    void panelReady.then(async () => {
      if (disconnected || panels.get(windowId) !== port) return;
      const job = panelJobs.get(windowId);
      if (job) {
        const tab = await chrome.tabs.get(job.tabId).catch(() => null);
        if (!tab?.active || tab.windowId !== windowId) {
          clearPanelForTab(job.tabId, active); return;
        }
      } else {
        // Opening this extension from the browser's panel picker on a regular
        // webpage must not leave an empty translation sidebar behind.
        void chrome.sidePanel.close({ windowId }).catch(() => {}); return;
      }
      notify(windowId);
    });
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (panels.get(windowId) === port) {
      panels.delete(windowId);
      // A browser-initiated close already cleared this port's old job. Its
      // delayed disconnect must not erase a newer right-click selection.
      if (!closingPanels.has(port)) clear(windowId, active);
    }
  });
}
chrome.windows.onRemoved.addListener(windowId => {
  touched.add(windowId); panelJobs.delete(windowId); panels.delete(windowId); save();
});
