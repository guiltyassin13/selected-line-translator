// Register exactly one selection item, so Chromium does not group our entries.
export function selectionMenu() {
  return {
    id: 'translate-selection',
    title: '翻译选中内容',
    contexts: ['selection']
  };
}

// Viewer component identities, not arbitrary extension pages or URL substrings.
export function nativePdfFrame(info = {}) {
  return [info.frameUrl, info.pageUrl, info.srcUrl].some(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'chrome-extension:' &&
        url.host === 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
    } catch { return false; }
  });
}

export function localPdfUrl(value) {
  try { const url = new URL(value); return url.protocol === 'file:' && /\.pdf$/i.test(decodeURIComponent(url.pathname)); }
  catch { return false; }
}
