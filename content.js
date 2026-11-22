(() => {
  'use strict';

  const VERSION = '1.0.0';
  if (globalThis.__SCROLLFRAME__?.version === VERSION) return;

  const token = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() :
    Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const isTop = window === window.top;
  const MESSAGE = '__scrollframe_capture_v1__';
  const DEFERRED_PROPERTIES = new Set(['scroll-behavior', 'scroll-snap-type', 'overflow-anchor', 'transition-property']);
  const WATCHDOG_MS = 5 * 60 * 1000;
  const scrollableOverflow = /^(auto|scroll|overlay)$/;
  const clippingOverflow = /^(auto|scroll|overlay|hidden|clip)$/;
  let nextId = 1;
  const elementIds = new WeakMap();
  const regions = new Map();
  const frames = new Map();
  let transaction = null;
  let hiddenRepeated = new Map();
  let pickerEnabled = false;
  let pickedElement = null;
  let ui = null;
  let overlaysHidden = false;
  let captureStatusVisible = false;
  let captureKeysRegistered = false;
  let watchdogTimer = null;
  let lastDispatchAt = Date.now();

  const viewport = () => ({ width: innerWidth, height: innerHeight });
  const pageElement = () => document.scrollingElement || document.documentElement;
  const number = value => Number.parseFloat(value) || 0;
  const rectangle = (x, y, width, height) => ({
    x, y, width: Math.max(0, width), height: Math.max(0, height)
  });

  function parentElement(element) {
    return element.parentElement || element.getRootNode()?.host || null;
  }

  function* ancestors(element, includeSelf = true) {
    let current = includeSelf ? element : parentElement(element);
    while (current) {
      yield current;
      current = parentElement(current);
    }
  }

  function* allElements(root = document) {
    for (const element of root.querySelectorAll('*')) {
      if (element.hasAttribute('data-scrollframe-ui')) continue;
      yield element;
      if (element.shadowRoot) yield* allElements(element.shadowRoot);
    }
  }

  function isOurElement(element) {
    if (!(element instanceof Element)) return false;
    for (const ancestor of ancestors(element)) {
      if (ancestor.hasAttribute('data-scrollframe-ui')) return true;
    }
    return false;
  }

  function intersect(a, b, horizontal = true, vertical = true) {
    const left = horizontal ? Math.max(a.x, b.x) : a.x;
    const top = vertical ? Math.max(a.y, b.y) : a.y;
    const right = horizontal ? Math.min(a.x + a.width, b.x + b.width) : a.x + a.width;
    const bottom = vertical ? Math.min(a.y + a.height, b.y + b.height) : a.y + a.height;
    return rectangle(left, top, right - left, bottom - top);
  }

  function scales(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: element.offsetWidth ? rect.width / element.offsetWidth : 1,
      y: element.offsetHeight ? rect.height / element.offsetHeight : 1
    };
  }

  // The scroll viewport includes padding, but excludes borders and scrollbars.
  function clientBox(element) {
    const rect = element.getBoundingClientRect();
    const scale = scales(element);
    return rectangle(
      rect.left + element.clientLeft * scale.x,
      rect.top + element.clientTop * scale.y,
      element.clientWidth * scale.x,
      element.clientHeight * scale.y
    );
  }

  // A frame's child viewport occupies its content box, excluding padding too.
  function frameBox(element) {
    const box = clientBox(element);
    const style = getComputedStyle(element);
    const scale = scales(element);
    const left = number(style.paddingLeft) * scale.x;
    const right = number(style.paddingRight) * scale.x;
    const top = number(style.paddingTop) * scale.y;
    const bottom = number(style.paddingBottom) * scale.y;
    return rectangle(box.x + left, box.y + top, box.width - left - right, box.height - top - bottom);
  }

  function clipBox(element, box) {
    let clip = intersect(box, rectangle(0, 0, innerWidth, innerHeight));
    for (const ancestor of ancestors(element, false)) {
      // Root overflow clips at the viewport, not at the root element's
      // document-space bounding rectangle after the window has scrolled.
      if (ancestor === pageElement() || ancestor === document.documentElement) continue;
      const style = getComputedStyle(ancestor);
      const clipX = clippingOverflow.test(style.overflowX);
      const clipY = clippingOverflow.test(style.overflowY);
      if (clipX || clipY) clip = intersect(clip, clientBox(ancestor), clipX, clipY);
    }
    return clip;
  }

  function isRendered(element) {
    if (!element.isConnected || !element.getClientRects().length || isOurElement(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' && style.contentVisibility !== 'hidden';
  }

  function isScrollable(element) {
    if (!(element instanceof HTMLElement) || !isRendered(element)) return false;
    if (/^(TEXTAREA|SELECT|OPTION)$/.test(element.tagName)) return false;
    const style = getComputedStyle(element);
    return (scrollableOverflow.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) ||
      (scrollableOverflow.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1);
  }

  function idFor(element) {
    if (element === pageElement() || element === document.documentElement) return 'document';
    let id = elementIds.get(element);
    if (!id) {
      id = 'region-' + nextId++;
      elementIds.set(element, id);
      regions.set(id, element);
    }
    return id;
  }

  function resolve(id = 'document') {
    if (id === 'document') return pageElement();
    const element = regions.get(id);
    if (!element?.isConnected) throw new Error('This scrolling region is no longer on the page. Select it again.');
    return element;
  }

  function labelFor(element) {
    const named = element.getAttribute('aria-label') || element.getAttribute('title');
    if (named) return named.replace(/\s+/g, ' ').trim().slice(0, 100);
    let name = element.tagName.toLowerCase();
    if (element.id) name += '#' + element.id;
    else if (element.getAttribute('role')) name += ' [' + element.getAttribute('role') + ']';
    else if (element.classList.length) name += '.' + Array.from(element.classList).slice(0, 2).join('.');
    return name.slice(0, 100);
  }

  function scan() {
    for (const [id, element] of regions) {
      if (!element.isConnected) regions.delete(id);
    }
    for (const [frameToken, element] of frames) {
      if (!element.isConnected) frames.delete(frameToken);
    }
    const page = pageElement();
    const pageWidth = Math.max(page.scrollWidth, page.clientWidth);
    const pageHeight = Math.max(page.scrollHeight, page.clientHeight);
    const results = [{
      id: 'document', label: 'Whole page', kind: 'page',
      scrollWidth: pageWidth, scrollHeight: pageHeight,
      clientWidth: document.documentElement.clientWidth || innerWidth,
      clientHeight: document.documentElement.clientHeight || innerHeight, order: 0,
      rect: rectangle(0, 0, innerWidth, innerHeight),
      hasScroll: pageWidth > innerWidth + 1 || pageHeight > innerHeight + 1
    }];
    let order = 0;
    for (const element of allElements()) {
      order++;
      if (element === page || element === document.documentElement || !isScrollable(element)) continue;
      results.push({
        id: idFor(element), label: labelFor(element), kind: 'element',
        scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth, clientHeight: element.clientHeight,
        order, rect: clientBox(element), hasScroll: true
      });
    }
    return results;
  }

  function beginTransaction() {
    if (!transaction) {
      transaction = {
        styles: new Map(), positions: new Map(),
        windowPosition: { x: scrollX, y: scrollY }, target: null
      };
      syncCaptureKeys();
      refreshWatchdog();
    }
    return transaction;
  }

  function setStyle(element, property, value) {
    const tx = beginTransaction();
    let snapshot = tx.styles.get(element);
    if (!snapshot) {
      const originalAttribute = element.getAttribute('style');
      const originalProperties = new Map(Array.from(element.style, property => [property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property)
      }]));
      snapshot = { originalAttribute, originalProperties, properties: new Map() };
      tx.styles.set(element, snapshot);
    }
    if (!snapshot.properties.has(property)) {
      snapshot.properties.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property)
      });
    }
    element.style.setProperty(property, value, 'important');
  }

  function restoreProperty(element, property, snapshot) {
    if (snapshot.value) element.style.setProperty(property, snapshot.value, snapshot.priority);
    else element.style.removeProperty(property);
  }

  function rememberChain(element) {
    const tx = beginTransaction();
    for (const ancestor of ancestors(element)) {
      if (!tx.positions.has(ancestor)) {
        tx.positions.set(ancestor, { x: ancestor.scrollLeft, y: ancestor.scrollTop });
      }
      setStyle(ancestor, 'scroll-behavior', 'auto');
      setStyle(ancestor, 'scroll-snap-type', 'none');
      setStyle(ancestor, 'overflow-anchor', 'none');
    }
    // The document scroller is not always an element's composed ancestor.
    const page = pageElement();
    if (!tx.positions.has(page)) tx.positions.set(page, { x: page.scrollLeft, y: page.scrollTop });
    setStyle(page, 'scroll-behavior', 'auto');
    setStyle(page, 'scroll-snap-type', 'none');
    setStyle(page, 'overflow-anchor', 'none');
  }

  function fitDimension(element, dimension, maximum) {
    const vertical = dimension === 'height';
    const viewportSize = vertical ? innerHeight : innerWidth;
    let available = Math.min(Number(maximum) || viewportSize - 16, viewportSize - 8);
    for (const ancestor of ancestors(element, false)) {
      if (ancestor === pageElement() || ancestor === document.documentElement) continue;
      const style = getComputedStyle(ancestor);
      if (clippingOverflow.test(vertical ? style.overflowY : style.overflowX)) {
        available = Math.min(available, clientBox(ancestor)[dimension]);
      }
    }
    available = Math.max(64, available);
    const rect = element.getBoundingClientRect();
    if (rect[dimension] <= available + 1) return false;
    const style = getComputedStyle(element);
    const scale = scales(element)[vertical ? 'y' : 'x'] || 1;
    const verticalExtras =
      number(style.borderTopWidth) + number(style.borderBottomWidth) +
      number(style.paddingTop) + number(style.paddingBottom);
    const horizontalExtras =
      number(style.borderLeftWidth) + number(style.borderRightWidth) +
      number(style.paddingLeft) + number(style.paddingRight);
    const extras = style.boxSizing === 'border-box' ? 0 : vertical ? verticalExtras : horizontalExtras;
    const cssSize = Math.max(1, available / scale - extras) + 'px';
    setStyle(element, 'transition-property', 'none');
    setStyle(element, 'min-' + dimension, '0px');
    setStyle(element, dimension, cssSize);
    setStyle(element, 'max-' + dimension, cssSize);
    return true;
  }

  function twoFrames() {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 250);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
  }

  async function settle(milliseconds = 80) {
    await twoFrames();
    const duration = Math.max(0, Math.min(Number(milliseconds) || 0, 5000));
    if (duration) await new Promise(resolve => setTimeout(resolve, duration));
  }

  function horizontalPosition(element, raw, contentWidth, clientWidth) {
    const maximum = Math.max(0, contentWidth - clientWidth);
    const rtl = getComputedStyle(element).direction === 'rtl';
    return { position: rtl ? Math.max(0, maximum + raw) : raw, maximum, rtl };
  }

  function measure({ id = 'document' } = {}) {
    const element = resolve(id);
    const page = id === 'document';
    const clientWidth = page ? document.documentElement.clientWidth || innerWidth : element.clientWidth;
    const clientHeight = page ? document.documentElement.clientHeight || innerHeight : element.clientHeight;
    const contentWidth = Math.max(clientWidth, element.scrollWidth);
    const contentHeight = Math.max(clientHeight, element.scrollHeight);
    const box = page ? rectangle(0, 0, clientWidth, clientHeight) : clientBox(element);
    const rawX = page ? window.scrollX : element.scrollLeft;
    const horizontal = horizontalPosition(element, rawX, contentWidth, clientWidth);
    const scale = page ? { x: 1, y: 1 } : scales(element);
    return {
      box, clip: page ? box : clipBox(element, box),
      scrollX: horizontal.position, scrollY: page ? window.scrollY : element.scrollTop,
      rawScrollX: rawX, contentWidth, contentHeight, clientWidth, clientHeight,
      viewport: viewport(), scaleX: scale.x, scaleY: scale.y
    };
  }

  async function prepare({ id = 'document', maxHeight, maxWidth, hideFixed = true } = {}) {
    const element = resolve(id);
    const tx = beginTransaction();
    tx.target = element;
    tx.hideFixed = hideFixed;
    rememberChain(element);
    // A reserved gutter can disagree with the native scroll range when
    // scrollbars are overlaid or suppressed. Use the actual scroll viewport.
    setStyle(element, 'scrollbar-gutter', 'auto');
    if (id !== 'document') {
      fitDimension(element, 'width', maxWidth);
      fitDimension(element, 'height', maxHeight);
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    await settle(60);
    return measure({ id });
  }

  async function scrollRegion({ id = 'document', x, y, settleMs = 80 } = {}) {
    const element = resolve(id);
    const before = measure({ id });
    const targetX = Number.isFinite(Number(x)) ? Number(x) : before.scrollX;
    const targetY = Number.isFinite(Number(y)) ? Number(y) : before.scrollY;
    const horizontal = horizontalPosition(element, before.rawScrollX, before.contentWidth, before.clientWidth);
    const left = horizontal.rtl ? targetX - horizontal.maximum : targetX;
    const options = { left, top: targetY, behavior: 'instant' };
    if (id === 'document') window.scrollTo(options);
    else element.scrollTo(options);
    await settle(settleMs);
    return measure({ id });
  }

  function announce() {
    if (!isTop) window.parent.postMessage({ channel: MESSAGE, type: 'announce', token }, '*');
    return { token, isTop };
  }

  window.addEventListener('message', event => {
    if (!event.data || event.data.channel !== MESSAGE) return;
    if (event.data.type === 'request-announce' && event.source === window.parent && !isTop) {
      announce();
      return;
    }
    if (event.data.type !== 'announce' || typeof event.data.token !== 'string') return;
    for (const element of allElements()) {
      if (!/^(IFRAME|FRAME)$/.test(element.tagName)) continue;
      if (element.contentWindow === event.source) {
        frames.set(event.data.token, element);
        break;
      }
    }
  });

  async function frameInfo({ token: childToken, fit = false, ensureVisible = fit, maxHeight, maxWidth } = {}) {
    let element = frames.get(childToken);
    if (!element?.isConnected) {
      for (const frame of allElements()) {
        if (/^(IFRAME|FRAME)$/.test(frame.tagName)) {
          frame.contentWindow?.postMessage({ channel: MESSAGE, type: 'request-announce' }, '*');
        }
      }
      await settle(60);
      element = frames.get(childToken);
    }
    if (!element?.isConnected) throw new Error('The embedded frame could not be located. Reload the capture panel and try again.');
    if (fit || ensureVisible) {
      rememberChain(element);
      if (fit) {
        fitDimension(element, 'width', maxWidth);
        fitDimension(element, 'height', maxHeight);
      }
      if (ensureVisible) element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      await settle(60);
    }
    const rect = frameBox(element);
    const scale = scales(element);
    let order = 0;
    for (const current of allElements()) {
      order++;
      if (current === element) break;
    }
    return { rect, clip: clipBox(element, rect), viewport: viewport(), scaleX: scale.x, scaleY: scale.y, order };
  }

  function hideRepeated({ enabled = true } = {}) {
    if (!enabled) {
      for (const [element, snapshot] of hiddenRepeated) restoreProperty(element, 'visibility', snapshot);
      hiddenRepeated.clear();
      return { hidden: 0 };
    }
    if (!transaction || transaction.hideFixed === false) return { hidden: 0 };
    const protectedElements = new Set(ancestors(transaction.target || pageElement()));
    const maximumArea = innerWidth * innerHeight * 0.25;
    for (const element of allElements()) {
      if (element === document.body || element === document.documentElement) continue;
      if (protectedElements.has(element) || hiddenRepeated.has(element) || !isRendered(element)) continue;
      const style = getComputedStyle(element);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width * rect.height > maximumArea || (rect.height > 160 && rect.width > 120)) continue;
      if (!intersect(rectangle(rect.x, rect.y, rect.width, rect.height), rectangle(0, 0, innerWidth, innerHeight)).height) continue;
      hiddenRepeated.set(element, {
        value: element.style.getPropertyValue('visibility'),
        priority: element.style.getPropertyPriority('visibility')
      });
      setStyle(element, 'visibility', 'hidden');
    }
    return { hidden: hiddenRepeated.size };
  }

  async function restore() {
    hideRepeated({ enabled: false });
    const tx = transaction;
    if (!tx) return { restored: true };
    for (const [element, snapshot] of tx.styles) {
      for (const [property, original] of snapshot.properties) {
        if (!DEFERRED_PROPERTIES.has(property)) restoreProperty(element, property, original);
      }
    }
    await twoFrames();
    for (const [element, position] of tx.positions) {
      if (!element.isConnected) continue;
      element.scrollLeft = position.x;
      element.scrollTop = position.y;
    }
    window.scrollTo({ left: tx.windowPosition.x, top: tx.windowPosition.y, behavior: 'instant' });
    for (const [element, snapshot] of tx.styles) {
      for (const [property, original] of snapshot.properties) {
        if (DEFERRED_PROPERTIES.has(property)) restoreProperty(element, property, original);
      }
    }
    // Preserve the original attribute, including its absence and formatting,
    // when the page has not changed unrelated inline declarations meanwhile.
    for (const [element, snapshot] of tx.styles) {
      const currentProperties = Array.from(element.style);
      const unchanged = currentProperties.length === snapshot.originalProperties.size &&
        currentProperties.every(property => {
          const original = snapshot.originalProperties.get(property);
          return original && element.style.getPropertyValue(property) === original.value &&
            element.style.getPropertyPriority(property) === original.priority;
        });
      if (unchanged) {
        if (snapshot.originalAttribute === null) element.removeAttribute('style');
        else element.setAttribute('style', snapshot.originalAttribute);
      }
    }
    transaction = null;
    syncCaptureKeys();
    refreshWatchdog();
    return { restored: true };
  }

  function refreshWatchdog() {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    if (!transaction && !captureStatusVisible) return;
    const remaining = Math.max(0, WATCHDOG_MS - (Date.now() - lastDispatchAt));
    watchdogTimer = setTimeout(() => {
      if (Date.now() - lastDispatchAt < WATCHDOG_MS) {
        refreshWatchdog();
        return;
      }
      // Restore the page even if the extension worker disappeared mid-capture.
      cleanup().catch(() => {});
    }, remaining);
  }

  function captureKey(event) {
    if (event.key !== 'Escape' || pickerEnabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send({ type: 'STOP_CAPTURE' });
  }

  function syncCaptureKeys() {
    const needed = Boolean(transaction || captureStatusVisible);
    if (needed && !captureKeysRegistered) {
      document.addEventListener('keydown', captureKey, true);
      captureKeysRegistered = true;
    } else if (!needed && captureKeysRegistered) {
      document.removeEventListener('keydown', captureKey, true);
      captureKeysRegistered = false;
    }
  }

  function send(message) {
    try {
      const result = chrome.runtime.sendMessage({ ...message, token });
      if (result?.catch) result.catch(() => {});
    } catch (_) { /* The extension may have been reloaded while this page stayed open. */ }
  }

  function ensureUI() {
    if (ui?.host.isConnected) return ui;
    const host = document.createElement('div');
    host.setAttribute('data-scrollframe-ui', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{color-scheme:light}*{box-sizing:border-box}.highlight{position:fixed;pointer-events:none;border:3px solid #38bdf8;background:rgba(56,189,248,.08);border-radius:6px;display:none}.panel{position:fixed;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:12px 16px;border-radius:12px;background:#102033;color:#fff;box-shadow:0 8px 32px #0005;font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;pointer-events:auto;display:none}.picker{top:16px}.status{bottom:16px;min-width:280px}.heading{font-weight:600}.detail{font-size:12px;color:#bfcee0;margin-top:4px}button{margin-left:16px;padding:5px 10px;border:1px solid #6c8298;border-radius:6px;background:#25394f;color:#fff;font:inherit;cursor:pointer}.row{display:flex;align-items:center;justify-content:space-between;gap:8px}';
    shadow.append(style);
    const highlight = document.createElement('div');
    highlight.className = 'highlight';
    const pickerPanel = document.createElement('div');
    pickerPanel.className = 'panel picker';
    const prompt = document.createElement('span');
    prompt.textContent = 'Click the scrolling content to capture. Esc cancels.';
    const pickerCancel = document.createElement('button');
    pickerCancel.type = 'button';
    pickerCancel.textContent = 'Cancel';
    pickerCancel.addEventListener('click', () => cancelPicker());
    pickerPanel.append(prompt, pickerCancel);
    const statusPanel = document.createElement('div');
    statusPanel.className = 'panel status';
    statusPanel.setAttribute('role', 'status');
    statusPanel.setAttribute('aria-live', 'polite');
    const row = document.createElement('div');
    row.className = 'row';
    const heading = document.createElement('div');
    heading.className = 'heading';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Stop';
    cancel.addEventListener('click', () => send({ type: 'STOP_CAPTURE' }));
    const detail = document.createElement('div');
    detail.className = 'detail';
    row.append(heading, cancel);
    statusPanel.append(row, detail);
    shadow.append(highlight, pickerPanel, statusPanel);
    document.documentElement.append(host);
    ui = { host, highlight, pickerPanel, statusPanel, heading, detail };
    host.style.setProperty('visibility', overlaysHidden ? 'hidden' : 'visible', 'important');
    return ui;
  }

  function nearestScrollable(element) {
    for (const ancestor of ancestors(element)) {
      if (isScrollable(ancestor)) return ancestor;
    }
    return pageElement();
  }

  function eventElement(event) {
    return event.composedPath().find(node => node instanceof Element) || event.target;
  }

  function updateHighlight(event) {
    const element = eventElement(event);
    if (!(element instanceof Element) || isOurElement(element)) return;
    pickedElement = nearestScrollable(element);
    const selectedUI = ensureUI();
    const measured = measure({ id: idFor(pickedElement) });
    const rect = measured.clip;
    selectedUI.highlight.style.cssText = 'display:block;left:' + rect.x + 'px;top:' + rect.y +
      'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';
  }

  function pickClick(event) {
    if (!pickerEnabled || isOurElement(eventElement(event))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = eventElement(event);
    if (!(element instanceof Element)) return;
    const selected = nearestScrollable(element);
    const regionId = idFor(selected);
    disablePicker();
    send({ type: 'REGION_PICKED', regionId });
  }

  function blockPickerPointer(event) {
    if (isOurElement(eventElement(event))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function cancelPicker() {
    disablePicker();
    send({ type: 'PICK_CANCEL' });
  }

  function pickerKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelPicker();
  }

  function pickerLeave(event) {
    if (!event.relatedTarget && ui) ui.highlight.style.display = 'none';
  }

  function disablePicker() {
    pickerEnabled = false;
    pickedElement = null;
    document.removeEventListener('pointermove', updateHighlight, true);
    document.removeEventListener('pointerdown', blockPickerPointer, true);
    document.removeEventListener('pointerup', blockPickerPointer, true);
    document.removeEventListener('click', pickClick, true);
    document.removeEventListener('keydown', pickerKey, true);
    document.removeEventListener('pointerout', pickerLeave, true);
    if (ui) {
      ui.highlight.style.display = 'none';
      ui.pickerPanel.style.display = 'none';
    }
  }

  function picker({ enabled = true } = {}) {
    disablePicker();
    if (!enabled) return { enabled: false };
    pickerEnabled = true;
    const selectedUI = ensureUI();
    if (isTop) selectedUI.pickerPanel.style.display = 'block';
    document.addEventListener('pointermove', updateHighlight, true);
    document.addEventListener('pointerdown', blockPickerPointer, true);
    document.addEventListener('pointerup', blockPickerPointer, true);
    document.addEventListener('click', pickClick, true);
    document.addEventListener('keydown', pickerKey, true);
    document.addEventListener('pointerout', pickerLeave, true);
    return { enabled: true };
  }

  function status({ text = '', detail = '' } = {}) {
    if (!isTop) return { shown: false };
    const selectedUI = ensureUI();
    selectedUI.heading.textContent = String(text);
    selectedUI.detail.textContent = String(detail);
    selectedUI.statusPanel.style.display = text ? 'block' : 'none';
    captureStatusVisible = Boolean(text);
    syncCaptureKeys();
    refreshWatchdog();
    return { shown: Boolean(text) };
  }

  function hud({ hidden = true } = {}) {
    overlaysHidden = Boolean(hidden);
    if (ui) ui.host.style.setProperty('visibility', overlaysHidden ? 'hidden' : 'visible', 'important');
    return { hidden: overlaysHidden };
  }

  async function cleanup() {
    disablePicker();
    captureStatusVisible = false;
    await restore();
    ui?.host.remove();
    ui = null;
    overlaysHidden = false;
    syncCaptureKeys();
    refreshWatchdog();
    return { cleaned: true };
  }

  async function dispatch(command, payload = {}) {
    lastDispatchAt = Date.now();
    refreshWatchdog();
    switch (command) {
      case 'hello': return { token, title: document.title, url: location.href, viewport: viewport(), isTop };
      case 'announce': return announce();
      case 'scan': return scan();
      case 'frameInfo': return frameInfo(payload);
      case 'prepare': return prepare(payload);
      case 'measure': return measure(payload);
      case 'scroll': return scrollRegion(payload);
      case 'hideRepeated': return hideRepeated(payload);
      case 'restore': return restore();
      case 'picker': return picker(payload);
      case 'status': return status(payload);
      case 'hud': return hud(payload);
      case 'cleanup': return cleanup();
      default: throw new Error('Unknown ScrollFrame command: ' + String(command));
    }
  }

  globalThis.__SCROLLFRAME__ = Object.freeze({ version: VERSION, dispatch });
})();
