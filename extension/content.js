(() => {
  const BUILD = '1.6.0';
  const previous = globalThis.__selectedLineTranslator;
  if (previous?.version === BUILD) return;
  try { previous?.dispose?.(); } catch { /* invalidated old runtime must not block the new build */ }
  // Old extension worlds can leave their Shadow DOM behind after a reload.
  for (const stale of document.querySelectorAll('selected-line-translator')) {
    if (stale.shadowRoot?.querySelector('.panel[aria-label="选译翻译结果"], .panel[aria-label="opalite翻译结果"]')) { stale.hidden = true; stale.remove(); }
  }
  let host, shadow, panel, source, result, status, timings, copyButton, retryButton, port, resizeObserver;
  let current = null, output = '', generation = 0, repositionFrame = 0, firstPaintMeasured = false;
  let ownerDocument = document, ownerEscape = null, metrics = {}, anchor = null;
  let preferences = { draggable: false, closeOnOutsideClick: false }, translationCompleted = false;
  let dragState = null, manualPosition = null, autoPosition = null;
  const outsideDocuments = new Set();

  const styles = `
    :host { color-scheme: light; }
    * { box-sizing: border-box; }
    .panel { width: min(420px, calc(100vw - 48px)); max-height: min(520px, 72dvh); display: flex; flex-direction: column;
      background: #f6fbff; color: #223e55; border: 1px solid #bfdced; border-radius: 15px; overflow: hidden;
      box-shadow: 0 12px 44px #315e8026, 0 2px 8px #315e8010; font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
    .top { display: flex; align-items: center; gap: 9px; padding: 13px 15px; border-bottom: 1px solid #cde5f4; flex-shrink: 0; }
    .top.draggable { cursor: grab; user-select: none; touch-action: none; }
    .top.dragging { cursor: grabbing; }
    .mark { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 7px; background: #c4e8fb; color: #285d80; font-size: 16px; font-weight: 650; }
    .name { font-weight: 650; font-size: 14px; letter-spacing: .03em; }
    .status { margin-left: auto; font-size: 12px; color: #526f85; }
    button { font: inherit; cursor: pointer; border: 1px solid #bfdced; background: transparent; color: #285d80; border-radius: 7px; padding: 5px 10px; }
    button:hover { background: #e4f3fc; }
    button:focus-visible { outline: 2px solid #397ca8; outline-offset: 2px; }
    button:disabled { cursor: default; opacity: .45; }
    .close { border: 0; font-size: 22px; line-height: 1; padding: 3px 5px; color: #526f85; }
    .body { display: flex; flex-direction: column; overflow: auto; overscroll-behavior: contain; padding: 16px 18px; min-height: 0; }
    .source { margin: 0 0 12px; padding-bottom: 12px; border-bottom: 1px dashed #c9e2f2; color: #526f85; font-size: 12px; line-height: 1.6;
      display: block; flex-shrink: 0; max-height: var(--source-limit, 104px); overflow-y: auto; overflow-x: hidden;
      scrollbar-width: thin; scrollbar-color: #95c6e4 #e4f3fc; scrollbar-gutter: stable; overscroll-behavior: contain; padding-right: 8px;
      overflow-wrap: anywhere; white-space: pre-wrap; }
    .source::-webkit-scrollbar, .result::-webkit-scrollbar { width: 7px; }
    .source::-webkit-scrollbar-track, .result::-webkit-scrollbar-track { background: #e4f3fc; border-radius: 6px; }
    .source::-webkit-scrollbar-thumb, .result::-webkit-scrollbar-thumb { background: #95c6e4; border-radius: 6px; }
    .source:focus-visible, .result:focus-visible { outline: 2px solid #397ca8; outline-offset: 2px; }
    .result { margin: 0; color: #24445e; font-size: 16px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
      min-height: var(--result-min, 0px); max-height: var(--result-limit, 280px); overflow-y: auto; overflow-x: hidden;
      scrollbar-width: thin; scrollbar-color: #95c6e4 #e4f3fc; scrollbar-gutter: stable; overscroll-behavior: contain; padding-right: 5px; }
    .result.loading { color: #526f85; font-size: 14px; }
    .error { margin: 10px 0 0; color: #28577b; font-size: 13px; white-space: pre-wrap; }
    .footer { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid #cde5f4; padding: 11px 15px; flex-shrink: 0; }
    .actions { display: flex; align-items: center; gap: 7px; }
    .settings { margin-left: auto; border-color: transparent; color: #526f85; }
    .timings { font-size: 11px; color: #526f85; font-variant-numeric: tabular-nums; }
    .panel.automatic .footer { gap: 6px; padding: 8px 15px; }
    .panel.automatic .actions button { font-size: 12px; line-height: 1.4; padding: 3px 8px; }
    [hidden] { display: none !important; }
    @media (prefers-reduced-motion: no-preference) { .loading::after { content: ' ·'; animation: breathe 1.2s ease-in-out infinite; } @keyframes breathe { 50% { opacity: .2; } } }
  `;
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, title, handler, className = '') {
    const node = element('button', className, text);
    node.type = 'button'; node.title = title;
    node.setAttribute('aria-label', title);
    node.addEventListener('click', event => { if (event.isTrusted) handler(event); });
    return node;
  }
  function ensureUI() {
    if (host?.isConnected) return;
    host = element('selected-line-translator');
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;margin:0!important;padding:0!important;border:0!important;transform:none!important;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = element('style'); style.textContent = styles;
    panel = element('section', 'panel'); panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'opalite翻译结果');
    const top = element('header', 'top');
    top.addEventListener('pointerdown', beginDrag);
    top.addEventListener('pointermove', moveDrag);
    top.addEventListener('pointerup', endDrag);
    top.addEventListener('pointercancel', endDrag);
    top.addEventListener('lostpointercapture', endDrag);
    status = element('span', 'status', '准备翻译'); status.setAttribute('role', 'status');
    top.append(element('span', 'mark', 'o'), element('span', 'name', 'opalite'), status,
      button('×', '关闭翻译（Esc）', close, 'close'));
    const body = element('div', 'body');
    source = element('p', 'source'); result = element('p', 'result');
    source.tabIndex = 0; source.setAttribute('role', 'region'); source.setAttribute('aria-label', '原文，可滚动查看全文');
    source.title = '在此处使用鼠标滚轮，或聚焦后按方向键，查看完整原文';
    result.tabIndex = 0; result.setAttribute('role', 'region'); result.setAttribute('aria-label', '译文，可滚动查看全文');
    body.append(source, result);
    const error = element('p', 'error'); error.hidden = true; error.setAttribute('role', 'alert'); body.append(error);
    const footer = element('footer', 'footer'), actions = element('div', 'actions');
    copyButton = button('复制译文', '复制译文', copy);
    retryButton = button('重新翻译', '绕过缓存，重新翻译', () => start(current, Date.now(), true));
    actions.append(copyButton, retryButton, button('设置 ↗', '打开 API 设置', () => {
      chrome.runtime.sendMessage({ type: 'open-settings' }).catch(() => showError('扩展已更新，请刷新网页后重试。'));
    }, 'settings'));
    timings = element('div', 'timings');
    footer.append(actions, timings); panel.append(top, body, footer); shadow.append(style, panel);
    // Prevent a site's delegated click handlers from following buttons inside our shadow tree.
    host.addEventListener('click', event => event.stopPropagation());
    document.documentElement.append(host);
    resizeObserver = new ResizeObserver(schedulePosition); resizeObserver.observe(panel);
  }
  function hideError() { const node = shadow.querySelector('.error'); node.textContent = ''; node.hidden = true; }
  function showError(message) {
    status.textContent = '需要处理'; result.classList.remove('loading');
    if (!output) result.textContent = '';
    const node = shadow.querySelector('.error'); node.textContent = message; node.hidden = false;
    retryButton.disabled = !current?.text; schedulePosition();
  }
  function cancel() {
    generation++;
    if (port) { try { port.disconnect(); } catch {} port = null; }
  }
  function close() {
    cancel();
    translationCompleted = false; endDrag(); removeOutsideEvents();
    if (host) { host.hidden = true; host.style.setProperty('display', 'none', 'important'); }
    if (ownerEscape) ownerDocument.removeEventListener('keydown', ownerEscape, true);
    ownerEscape = null;
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('resize', schedulePosition);
    document.removeEventListener('scroll', schedulePosition, true);
    if (ownerDocument !== document) ownerDocument.removeEventListener('scroll', schedulePosition, true);
  }
  function escape(event) {
    if (event.key === 'Escape' && host && !host.hidden) {
      event.preventDefault(); event.stopPropagation(); close();
    }
  }
  function bindOwner(doc) {
    if (ownerEscape) ownerDocument.removeEventListener('keydown', ownerEscape, true);
    if (ownerDocument !== document) ownerDocument.removeEventListener('scroll', schedulePosition, true);
    ownerDocument = doc || document;
    ownerEscape = escape;
    if (ownerDocument !== document) {
      ownerDocument.addEventListener('keydown', ownerEscape, true);
      ownerDocument.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
    }
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', schedulePosition, { passive: true });
    document.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
  }
  function schedulePosition(event) {
    if (event?.type === 'scroll' && host && event.composedPath?.().includes(host)) return;
    if (!repositionFrame) repositionFrame = requestAnimationFrame(() => { repositionFrame = 0; position(); });
  }
  function position() {
    if (!host || host.hidden) return;
    const margin = Math.min(24, innerWidth / 10, innerHeight / 10), gap = 12;
    const width = Math.max(1, innerWidth - margin * 2), height = Math.max(1, innerHeight - margin * 2);
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, Math.max(lo, hi)));
    const automatic = !manualPosition;
    panel.classList.toggle('automatic', automatic);
    const preferredWidth = Math.min(automatic ? 440 : 420, width);
    const readingCap = Math.min(automatic ? 552 : 520, height, innerHeight * (automatic ? .78 : .72));
    const textLength = current?.text?.length || 0;
    const body = shadow.querySelector('.body');
    const scrollOffsets = [source.scrollTop, result.scrollTop, body.scrollTop];
    function size(cap, constrained = false) {
      panel.style.width = preferredWidth + 'px';
      const chromeHeight = shadow.querySelector('.top').offsetHeight + shadow.querySelector('.footer').offsetHeight + 2;
      if (automatic && !constrained && textLength > 350 && output) {
        // A small loading card must not freeze a long translation at two lines.
        // Grow with actual rendered text, up to four readable lines; leave empty
        // output compact. The source uses at most 18% of the automatic height.
        const readableResult = Math.min(result.scrollHeight, 116);
        const base = chromeHeight + 44 + readableResult;
        cap = Math.min(readingCap, Math.max(cap, Math.min(base / .82, base + 88)));
      }
      panel.style.maxHeight = cap + 'px';
      panel.style.setProperty('--source-limit', automatic
        ? Math.min(88, Math.max(40, cap * .18)) + 'px'
        : Math.min(104, Math.max(40, cap * .2)) + 'px');
      const sourceHeight = source.hidden ? 0 : source.getBoundingClientRect().height + 12;
      const resultLimit = Math.max(24, cap - chromeHeight - sourceHeight - 32);
      panel.style.setProperty('--result-limit', resultLimit + 'px');
      // Match v1.1's content-driven height; empty/loading output must not reserve
      // a large blank block just because the original selection is long.
      panel.style.setProperty('--result-min', '0px');
      return panel.getBoundingClientRect();
    }
    let bounds = size(manualPosition ? readingCap : Math.min(readingCap, autoPosition?.ceiling ?? readingCap)), left, top;
    if (manualPosition) ({ left, top } = manualPosition);
    else {
      // Always re-read the live Range. Stabilize the chosen SIDE, never the
      // absolute screen coordinates: document/container scroll must move the card.
      let rectangles = [];
      try { rectangles = anchor?.getRects?.() || [anchor?.getRect?.()].filter(Boolean); } catch {}
      const visible = rectangles.map(r => ({ left: Math.max(margin, r.left), right: Math.min(innerWidth - margin, r.right ?? r.left),
        top: Math.max(margin, r.top), bottom: Math.min(innerHeight - margin, r.bottom) }))
        .filter(r => r.right > r.left && r.bottom > r.top);
      if (!visible.length) {
        ({ left, top } = autoPosition?.last || { left: Math.max(margin, (innerWidth - preferredWidth) / 2), top: Math.max(margin, (innerHeight - bounds.height) / 2) });
      } else {
        const box = visible.reduce((a, r) => ({ left: Math.min(a.left, r.left), right: Math.max(a.right, r.right),
          top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom) }));
        const priorSpace = autoPosition?.side === 'above' ? box.top - gap - margin
          : autoPosition?.side === 'below' ? innerHeight - margin - box.bottom - gap : null;
        if (priorSpace !== null && priorSpace >= Math.max(autoPosition.minimum || 0, (autoPosition.lastHeight || 0) * .86)) {
          bounds = size(Math.min(readingCap, autoPosition.ceiling ?? readingCap, priorSpace));
        } else if (autoPosition?.ceiling < readingCap) bounds = size(readingCap);
        const extent = Math.min(readingCap, Math.max(autoPosition?.extent || 0, bounds.height,
          textLength > 350 ? readingCap : bounds.height + 60));
        const alignedLeft = clamp(box.left, margin, innerWidth - margin - preferredWidth);
        const slots = [
          { side: 'below', available: innerHeight - margin - box.bottom - gap, horizontal: true },
          { side: 'above', available: box.top - gap - margin, horizontal: true },
          { side: 'right', available: height, horizontal: box.right + gap + preferredWidth <= innerWidth - margin },
          { side: 'left', available: height, horizontal: box.left - gap - preferredWidth >= margin }
        ];
        const fits = s => s.horizontal && s.available >= bounds.height;
        const preferred = slots.find(s => s.side === autoPosition?.side && fits(s));
        const chosen = preferred || slots.find(fits)
          || slots.slice(0, 2).find(s => s.available >= bounds.height * .86);
        let side = 'overlay', overlayKey, ceiling = readingCap;
        if (chosen) {
          side = chosen.side;
          const cushion = Math.min(48, Math.max(0, (chosen.available - bounds.height) / 2));
          ceiling = preferred ? Math.min(readingCap, Math.max(autoPosition.ceiling ?? readingCap, bounds.height))
            : Math.min(readingCap, chosen.available - (side === 'above' || side === 'below' ? cushion : 0));
          const cap = Math.min(ceiling, chosen.available);
          // Respect real whitespace in short viewports; the readability floor
          // repairs stale loading limits, not the browser's physical space.
          if (cap < readingCap) bounds = size(cap, true);
          if (side === 'below') { left = alignedLeft; top = box.bottom + gap; }
          if (side === 'above') { left = alignedLeft; top = box.top - gap - bounds.height; }
          if (side === 'right' || side === 'left') {
            left = side === 'right' ? box.right + gap : box.left - gap - preferredWidth;
            top = clamp(box.top, margin, innerHeight - margin - extent);
          }
        } else {
          const overlap = (l, t) => visible.reduce((sum, r) => sum
            + Math.max(0, Math.min(l + preferredWidth, r.right) - Math.max(l, r.left))
            * Math.max(0, Math.min(t + bounds.height, r.bottom) - Math.max(t, r.top)), 0);
          const inset = Math.min(48, Math.max(0, (height - extent) / 4));
          const xs = [box.right + gap, box.left - gap - preferredWidth, box.left + 24, box.right - preferredWidth - 24];
          const ys = [box.top - 24, box.top - gap - extent, box.bottom + gap];
          const overlays = [];
          for (let x = 0; x < xs.length; x++) for (let y = 0; y < ys.length; y++) {
            const l = clamp(xs[x], margin, innerWidth - margin - preferredWidth);
            const t = clamp(ys[y], margin + inset, innerHeight - margin - extent - inset);
            overlays.push({ left: l, top: t, key: x + ':' + y, overlap: overlap(l, t) });
          }
          overlays.sort((a, b) => a.overlap - b.overlap);
          const prior = overlays.find(p => p.key === autoPosition?.overlayKey);
          const best = prior && prior.overlap <= overlays[0].overlap * 1.05 + 1 ? prior : overlays[0];
          ({ left, top } = best); overlayKey = best.key;
        }
        autoPosition = { side, extent, overlayKey, ceiling, minimum: bounds.height * .86, lastHeight: bounds.height };
      }
    }
    left = clamp(left, margin, innerWidth - margin - bounds.width);
    top = clamp(top, margin, innerHeight - margin - bounds.height);
    if (manualPosition) manualPosition = { left, top };
    else autoPosition = { ...autoPosition, last: { left, top } };
    host.style.setProperty('left', left + 'px', 'important');
    host.style.setProperty('top', top + 'px', 'important');
    // Measuring a temporarily larger layout must not pull a reader back from
    // the end of the independently scrolling original/translation regions.
    [source, result, body].forEach((node, i) => { node.scrollTop = scrollOffsets[i]; });
  }
  function beginDrag(event) {
    if (!event.isTrusted || !preferences.draggable || event.button !== 0 || event.target.closest('button')) return;
    const bounds = panel.getBoundingClientRect();
    dragState = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top, handle: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('dragging');
    event.preventDefault();
  }
  function moveDrag(event) {
    if (!event.isTrusted || !dragState || event.pointerId !== dragState.pointerId) return;
    if (!dragState.moved && Math.hypot(event.clientX - dragState.x, event.clientY - dragState.y) < 3) return;
    dragState.moved = true;
    manualPosition = { left: dragState.left + event.clientX - dragState.x, top: dragState.top + event.clientY - dragState.y };
    position();
  }
  function endDrag(event) {
    if (!dragState || (event && event.pointerId !== dragState.pointerId)) return;
    const { handle, pointerId } = dragState; dragState = null;
    handle.classList.remove('dragging');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  }
  function dismissOutside(event) {
    if (!event.isTrusted) return;
    if (event.type === 'pointerdown' && event.composedPath().includes(host)) return;
    if (event.type === 'visibilitychange' && !document.hidden) return;
    dismissCompleted();
  }
  function dismissCompleted() {
    if (preferences.closeOnOutsideClick && translationCompleted && host && !host.hidden) close();
  }
  function removeOutsideEvents() {
    for (const doc of outsideDocuments) doc.removeEventListener('pointerdown', dismissOutside, true);
    outsideDocuments.clear();
    window.removeEventListener('blur', dismissOutside);
    document.removeEventListener('visibilitychange', dismissOutside);
  }
  function applyPreferences(message) {
    preferences = { draggable: message.draggable === true, closeOnOutsideClick: message.closeOnOutsideClick === true };
    const top = shadow.querySelector('.top');
    top.classList.toggle('draggable', preferences.draggable);
    top.title = preferences.draggable ? '拖动标题栏移动浮窗' : '';
    if (!preferences.draggable) { endDrag(); manualPosition = null; schedulePosition(); }
    removeOutsideEvents();
    if (!preferences.closeOnOutsideClick) return;
    function bind(doc, depth = 0) {
      if (!doc || outsideDocuments.has(doc) || depth > 12) return;
      outsideDocuments.add(doc); doc.addEventListener('pointerdown', dismissOutside, true);
      for (const frame of doc.querySelectorAll('iframe,frame')) {
        try { bind(frame.contentDocument, depth + 1); } catch {}
      }
    }
    bind(document);
    window.addEventListener('blur', dismissOutside);
    document.addEventListener('visibilitychange', dismissOutside);
  }
  function frameOffset(doc, rect) {
    let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
    while (doc !== document) {
      const frame = doc.defaultView.frameElement;
      if (!frame) break;
      const box = frame.getBoundingClientRect();
      const scaleX = box.width / (frame.offsetWidth || box.width || 1);
      const scaleY = box.height / (frame.offsetHeight || box.height || 1);
      left = box.left + (left + frame.clientLeft) * scaleX;
      right = box.left + (right + frame.clientLeft) * scaleX;
      top = box.top + (top + frame.clientTop) * scaleY;
      bottom = box.top + (bottom + frame.clientTop) * scaleY;
      doc = frame.ownerDocument;
    }
    return { left, right, top, bottom };
  }
  function readDocument(doc) {
    let focused = doc.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    if (focused?.tagName === 'INPUT' && focused.type === 'password') return { blocked: true, doc };
    if (focused?.tagName === 'IFRAME' || focused?.tagName === 'FRAME') return null;
    if (focused?.tagName === 'TEXTAREA' || focused?.tagName === 'INPUT') {
      try {
        const { selectionStart, selectionEnd } = focused;
        if (selectionStart !== null && selectionEnd > selectionStart) {
          return { text: focused.value.slice(selectionStart, selectionEnd), doc, getRect: () => frameOffset(doc, focused.getBoundingClientRect()),
            getRects: () => [frameOffset(doc, focused.getBoundingClientRect())] };
        }
      } catch {}
      return null;
    }
    const selection = doc.getSelection();
    if (selection?.rangeCount && selection.toString().trim()) {
      const range = selection.getRangeAt(0).cloneRange();
      if (host?.contains(range.commonAncestorContainer) || range.commonAncestorContainer.getRootNode() === shadow) return null;
      return { text: selection.toString(), doc, getRect: () => frameOffset(doc, range.getBoundingClientRect()),
        getRects: () => Array.from(range.getClientRects(), rect => frameOffset(doc, rect)) };
    }
    return null;
  }
  function capture(expected = '') {
    const candidates = [], seen = new Set();
    let blocked = false, unsupported = false;
    function visit(doc, depth = 0, isFocused = true) {
      if (!doc || seen.has(doc) || depth > 12) return;
      seen.add(doc);
      // The focused frame wins over stale selections elsewhere in the page.
      const focused = doc.activeElement;
      if (focused?.tagName === 'IFRAME' || focused?.tagName === 'FRAME') {
        try {
          if (!focused.contentDocument && isFocused) unsupported = true;
          visit(focused.contentDocument, depth + 1, isFocused);
        } catch { if (isFocused) unsupported = true; }
      }
      const selected = readDocument(doc);
      if (selected?.blocked && isFocused) blocked = true;
      else if (selected && !selected.blocked) candidates.push({ ...selected, isFocused });
      for (const frame of doc.querySelectorAll('iframe,frame')) {
        try { visit(frame.contentDocument, depth + 1, false); } catch {}
      }
    }
    visit(document);
    if (blocked) return { text: '', doc: document, blocked: true };
    if (unsupported) return { text: '', doc: document, unsupported: true };
    if (expected) {
      // The native context menu may normalize line breaks, NBSP and zero-width
      // characters differently from Range.toString(). Retain the matching range.
      const comparable = text => text.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]+/gu, '');
      const match = candidates.find(item => item.text.trim() === expected.trim())
        || candidates.find(item => comparable(item.text) === comparable(expected));
      return match ? { ...match, text: expected } : { text: expected, doc: document };
    }
    return candidates.find(item => item.isFocused) || { text: '', doc: document };
  }
  function formatMs(value) { return Number.isFinite(value) ? `${Math.round(value)} ms` : '—'; }
  function updateTimings() {
    timings.textContent = [metrics.cached ? '会话缓存' : '', `响应 ${formatMs(metrics.popupMs)}`,
      metrics.firstTokenMs !== undefined ? `首字 ${formatMs(metrics.firstTokenMs)}` : '',
      metrics.totalMs !== undefined ? `完成 ${formatMs(metrics.totalMs)}` : '',
      metrics.renderMs !== undefined ? `渲染 ${formatMs(metrics.renderMs)}` : ''].filter(Boolean).join(' · ');
  }
  function start(snapshot, triggeredAt, force = false) {
    cancel(); ensureUI(); host.hidden = false; host.style.setProperty('display', 'block', 'important');
    translationCompleted = false; endDrag();
    if (!force) { manualPosition = null; autoPosition = null; }
    current = snapshot; anchor = snapshot; output = ''; firstPaintMeasured = false;
    source.textContent = snapshot?.text || ''; source.hidden = !snapshot?.text;
    source.scrollTop = 0;
    result.scrollTop = 0;
    shadow.querySelector('.body').scrollTop = 0;
    hideError(); copyButton.disabled = true; copyButton.textContent = '复制译文'; retryButton.disabled = !snapshot?.text;
    result.textContent = '正在连接你的模型'; result.className = 'result loading';
    status.textContent = '翻译中';
    metrics = { popupMs: Math.max(0, Date.now() - triggeredAt) }; updateTimings();
    bindOwner(snapshot?.doc); position();
    metrics.popupMs = Math.max(0, Date.now() - triggeredAt); updateTimings();
    if (!snapshot?.text?.trim() || snapshot.blocked || snapshot.unsupported) {
      showError(snapshot?.blocked ? '密码输入框中的内容不会发送翻译。' : snapshot?.unsupported ? '首版不支持跨域 iframe，请在普通网页正文中选择文字。' : '请先选中需要翻译的文字，再按快捷键。'); return;
    }
    const token = generation;
    let connection;
    try { connection = chrome.runtime.connect({ name: 'translation' }); port = connection; }
    catch { showError('扩展已更新，请刷新网页后重试。'); return; }
    let finished = false;
    connection.onMessage.addListener(message => {
      if (generation !== token) return;
      if (message.type === 'preferences') applyPreferences(message);
      if (message.type === 'start') status.textContent = `译为${message.targetLanguage}`;
      if (message.type === 'delta') {
        const receivedAt = performance.now();
        output += message.delta; result.textContent = output; result.classList.remove('loading');
        copyButton.disabled = false; metrics.firstTokenMs = message.firstTokenMs; updateTimings();
        if (!firstPaintMeasured) {
          firstPaintMeasured = true;
          requestAnimationFrame(() => {
            if (generation !== token) return;
            metrics.renderMs = performance.now() - receivedAt;
            updateTimings();
            try { connection.postMessage({ type: 'render-metric', value: metrics.renderMs }); } catch {}
          });
        }
        schedulePosition();
      }
      if (message.type === 'done') {
        translationCompleted = true;
        finished = true; output = message.text; result.textContent = output; result.classList.remove('loading');
        status.textContent = message.cached ? '已从缓存读取' : '翻译完成';
        metrics = { ...message, renderMs: metrics.renderMs ?? message.renderMs };
        copyButton.disabled = false; updateTimings(); schedulePosition();
      }
      if (message.type === 'error') { finished = true; showError(message.message); }
    });
    connection.onDisconnect.addListener(() => {
      // Consume lastError: a sleeping/reloaded worker should produce one clear UI message.
      void chrome.runtime.lastError;
      if (generation === token && !finished) showError('翻译连接已中断，请重试；若刚更新扩展，请先刷新网页。');
    });
    try { connection.postMessage({ type: 'start', text: snapshot.text, force, popupMs: metrics.popupMs }); }
    catch { showError('无法连接扩展后台，请刷新网页后重试。'); }
  }
  async function copy() {
    if (!output) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(output);
      else throw new Error('fallback');
    } catch {
      const area = element('textarea'); area.value = output;
      area.style.cssText = 'position:fixed;opacity:0;left:0;top:0;'; shadow.append(area);
      const previous = document.activeElement;
      area.focus(); area.select();
      const copied = document.execCommand('copy'); area.remove(); previous?.focus?.({ preventScroll: true });
      if (!copied) { showError('浏览器阻止了复制，请选中译文后手动复制。'); return; }
    }
    copyButton.textContent = '已复制 ✓';
    setTimeout(() => { if (copyButton) copyButton.textContent = '复制译文'; }, 1600);
  }
  globalThis.__selectedLineTranslator = {
    version: BUILD,
    dispose() {
      close(); resizeObserver?.disconnect(); host?.remove();
      try { chrome.runtime.onMessage.removeListener?.(onRuntimeMessage); } catch { /* extension reload */ }
      if (repositionFrame) cancelAnimationFrame(repositionFrame);
    },
    readSelection() {
      const snapshot = capture();
      close();
      return { text: snapshot.text || '', blocked: snapshot.blocked === true, unsupported: snapshot.unsupported === true };
    },
    trigger({ selectionText = '', triggeredAt = Date.now() } = {}) {
      const snapshot = capture(selectionText); start(snapshot, triggeredAt);
    }
  };
  function onRuntimeMessage(message, sender) {
    if (sender.id === chrome.runtime.id && message?.type === 'dismiss-completed-popup') dismissCompleted();
    if (sender.id === chrome.runtime.id && message?.type === 'dismiss-popup') close();
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
})();
