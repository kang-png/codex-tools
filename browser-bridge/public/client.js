const $ = id => document.getElementById(id);
const frame = $('mirror');
let csrf = '', revision = -1, epoch = '', loggedIn = false, polling = false, frameReady = false;
let doc, sourceStyle, mobileStyle, lastCss = '', cssRevision = '', actionQueue = Promise.resolve();
const mirrored = new Map(), editing = new Set(), pendingText = new Map();
const htmlAttributes = new Map();
const styleNodes = new Map();
let inputTimer, layoutObserver;
let wakePoll, activeUntil = 0;
let pollPending = false, events, eventsReady = false;
let pendingActions = 0, pollController;
const threadPositions = new Map(), programmaticScrolls = new WeakMap();
const watchedLayoutNodes = new WeakSet();
let activeLayer = null, closingLayer = null, layerHistory = 0, expectedHistoryDepth = null, lastLayers = null, uploadBusy = false, uploadError = '';
let sidebarNavigating = false;

async function api(path, data, signal) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    signal,
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CBB-CSRF': csrf },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw new Error(result.error || '请求失败');
  }
  return result;
}
function showLogin() { loggedIn = false; activeLayer = null; events?.close(); eventsReady = false; wakePoll?.(); $('login').hidden = false; $('app').hidden = true; frame.src = 'about:blank'; }
async function showApp() {
  const session = await api('/api/session');
  if (!session.authenticated) return showLogin();
  csrf = session.csrf; loggedIn = true; $('login').hidden = true; $('app').hidden = false;
  frameReady = false;
  frame.onload = () => {
    if (!loggedIn || frame.contentWindow.location.pathname !== '/mirror') return;
    doc = frame.contentDocument; mirrored.clear(); htmlAttributes.clear(); styleNodes.clear(); lastCss = ''; cssRevision = ''; revision = -1; epoch = '';
    sourceStyle = doc.createElement('style'); mobileStyle = doc.createElement('link'); mobileStyle.rel = 'stylesheet'; mobileStyle.href = '/mobile.css';
    doc.head.append(sourceStyle, mobileStyle);
    threadPositions.clear(); layoutObserver?.disconnect(); layoutObserver = new ResizeObserver(() => { updateComposerSpace(); restoreThreads(threadPositions); });
    mobileStyle.onload = () => { updateComposerSpace(); restoreThreads(threadPositions); };
    installEvents(); frameReady = true; loadTargets(); connectEvents(); poll();
  };
  frame.src = '/mirror';
}
function status(message) { $('status').textContent = message; }
async function loadTargets() {
  try {
    const result = await api('/api/targets'); $('targets').replaceChildren();
    for (const target of result.targets) {
      const option = document.createElement('option'); option.value = target.targetId; option.textContent = target.title || target.url;
      option.selected = target.targetId === result.selected; $('targets').append(option);
    }
  } catch (error) { status(error.message); }
}
function patch(record, existing) {
  if (record.ref) return mirrored.get(record.id);
  let node = mirrored.get(record.id) || existing;
  if (record.tag === '#text') {
    if (!node || node.nodeType !== Node.TEXT_NODE) node = doc.createTextNode(record.text);
    else if (node.textContent !== record.text) node.textContent = record.text;
    mirrored.set(record.id, node); return node;
  }
  if (!node || node.nodeType !== Node.ELEMENT_NODE || node.localName !== record.tag) node = doc.createElementNS(record.ns || 'http://www.w3.org/1999/xhtml', record.tag);
  mirrored.set(record.id, node);
  for (const attribute of [...node.attributes]) if (attribute.name !== 'data-cbb-id' && !(attribute.name in record.attrs)) node.removeAttribute(attribute.name);
  for (const [name, value] of Object.entries(record.attrs)) {
    if (/^on/i.test(name) || name === 'srcdoc') continue;
    if (node.getAttribute(name) !== value) { try { node.setAttribute(name, value); } catch { /* Invalid source attributes are omitted. */ } }
  }
  if (node.dataset.cbbId !== record.id) node.dataset.cbbId = record.id;
  if (editing.has(record.id)) return node;
  if (record.value !== undefined && node.value !== record.value) node.value = record.value;
  if (record.checked !== undefined) node.checked = record.checked;
  patchChildren(node, record.children);
  if (record.shadow) {
    const shadow = node.shadowRoot || node.attachShadow({ mode: 'open' });
    if (!node._cbbShadowStyle) {
      node._cbbShadowStyle = doc.createElement('style'); node._cbbShadowStyle.dataset.cbbLocal = 'shadow-style';
      shadow.append(node._cbbShadowStyle); shadow.addEventListener('scroll', handleScroll, true);
    }
    patchChildren(shadow, record.shadow.children);
    if (node._cbbShadowStyle.textContent !== record.shadow.css) node._cbbShadowStyle.textContent = record.shadow.css;
  }
  return node;
}
function patchChildren(node, records) {
  let cursor = node.firstChild;
  for (const child of records) {
    const childNode = patch(child);
    if (childNode !== cursor) node.insertBefore(childNode, cursor);
    cursor = childNode.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; if (!cursor.dataset?.cbbLocal) node.removeChild(cursor); cursor = next; }
}
function render(snapshot) {
  const positions = captureThreads();
  for (const [name, value] of Object.entries(snapshot.htmlAttrs)) if (!/^on/i.test(name) && htmlAttributes.get(name) !== value) {
    doc.documentElement.setAttribute(name, value); htmlAttributes.set(name, value);
  }
  if (snapshot.css !== undefined && lastCss !== snapshot.css) { sourceStyle.textContent = snapshot.css; lastCss = snapshot.css; }
  if (snapshot.styles) {
    for (const sheet of snapshot.styles.sheets) {
      if (!styleNodes.has(sheet.id)) { const node = doc.createElement('style'); node.textContent = sheet.css; styleNodes.set(sheet.id, node); }
    }
    let cursor = sourceStyle.nextSibling;
    for (const id of snapshot.styles.order) {
      const node = styleNodes.get(id);
      if (node !== cursor) doc.head.insertBefore(node, cursor || mobileStyle);
      cursor = node.nextSibling;
    }
    const active = new Set(snapshot.styles.order);
    for (const [id, node] of styleNodes) if (!active.has(id)) { node.remove(); styleNodes.delete(id); }
    if (sourceStyle.textContent) sourceStyle.textContent = '';
    lastCss = '';
  }
  cssRevision = snapshot.cssRevision;
  const body = patch(snapshot.tree, doc.body);
  if (body !== doc.body) doc.body.replaceWith(body);
  const live = new Set();
  function visit(node) { live.add(node.id); if (node.ref) return; for (const child of node.children || []) visit(child); for (const child of node.shadow?.children || []) visit(child); }
  visit(snapshot.tree);
  if (snapshot.baseRevision !== undefined) { for (const id of snapshot.removed) mirrored.delete(id); }
  else for (const id of mirrored.keys()) if (!live.has(id)) mirrored.delete(id);
  revision = snapshot.revision;
  epoch = snapshot.epoch || '';
  for (const node of doc.querySelectorAll('[data-thread-scroll-footer],.thread-scroll-container,.thread-scroll-container > :first-child')) if (!watchedLayoutNodes.has(node)) { watchedLayoutNodes.add(node); layoutObserver.observe(node); }
  updateComposerSpace();
  updateLayers(snapshot.layers);
  restoreThreads(positions);
}
function threadKey(node) { return node.closest('[data-app-shell-active-page]')?.dataset.cbbId || node.dataset.cbbId; }
function threadAnchor(node) {
  const box = node.getBoundingClientRect();
  for (const y of [12, 40, 90, 150]) {
    if (y >= node.clientHeight) break;
    const hit = doc.elementFromPoint(Math.min(box.right - 8, box.left + Math.max(20, box.width * .35)), box.top + y);
    if (!hit || !node.contains(hit) || hit === node) continue;
    const anchor = hit.closest('p,li,pre,h1,h2,h3,[data-turn-key]') || hit;
    if (!node.contains(anchor) || !anchor.dataset.cbbId) continue;
    const turn = anchor.closest('[data-turn-key]');
    return { id: anchor.dataset.cbbId, offset: anchor.getBoundingClientRect().top - box.top,
      turnKey: turn?.getAttribute('data-turn-key'), turnOffset: turn ? turn.getBoundingClientRect().top - box.top : 0 };
  }
  return null;
}
function readThread(node, follow) {
  return { key: threadKey(node), id: node.dataset.cbbId, top: node.scrollTop,
    follow: follow ?? node.scrollHeight - node.clientHeight - node.scrollTop < 48, anchor: threadAnchor(node) || threadPositions.get(threadKey(node))?.anchor || null };
}
function captureThreads() {
  const positions = new Map();
  for (const node of doc.querySelectorAll('.thread-scroll-container')) if (node.clientHeight && node.clientWidth) {
    const key = threadKey(node), previous = threadPositions.get(key);
    positions.set(key, readThread(node, previous?.follow));
  }
  return positions;
}
function setThreadTop(node, top) {
  node.scrollTop = Math.max(0, top);
  programmaticScrolls.set(node, { top: node.scrollTop, left: node.scrollLeft });
}
function restoreThreads(positions) {
  if (!doc) return;
  for (const node of doc.querySelectorAll('.thread-scroll-container')) {
    if (!node.clientHeight || !node.clientWidth) continue;
    const key = threadKey(node);
    let saved = positions.get(key) || threadPositions.get(key);
    if (!saved && positions.size) {
      const keys = new Set([...node.querySelectorAll('[data-turn-key]')].map(n => n.getAttribute('data-turn-key')));
      saved = [...positions.values()].find(state => state.anchor?.turnKey && keys.has(state.anchor.turnKey));
    }
    if (!saved || saved.follow) setThreadTop(node, node.scrollHeight - node.clientHeight);
    else {
      const anchor = saved.anchor && mirrored.get(saved.anchor.id);
      const turn = saved.anchor?.turnKey && [...node.querySelectorAll('[data-turn-key]')].find(n => n.getAttribute('data-turn-key') === saved.anchor.turnKey);
      const target = anchor?.isConnected && node.contains(anchor) ? anchor : turn;
      if (target) setThreadTop(node, node.scrollTop + target.getBoundingClientRect().top - node.getBoundingClientRect().top - (target === anchor ? saved.anchor.offset : saved.anchor.turnOffset));
      else setThreadTop(node, saved.top);
    }
    threadPositions.set(key, readThread(node, saved?.follow ?? true));
  }
}
function updateLayers(layers) {
  lastLayers = layers;
  const menus = layers?.menus || (layers?.menu ? [layers.menu] : []);
  if (!menus.length) sidebarNavigating = false;
  if (!sidebarNavigating && menus.some(menu => menu.sidebar)) doc.documentElement.setAttribute('data-cbb-drawer', 'open');
  const drawer = doc.documentElement.hasAttribute('data-cbb-drawer');
  const stack = [...(layers?.panel ? [{ kind: 'panel', ...layers.panel }] : []), ...(drawer ? [{ kind: 'drawer', id: 'cbb-drawer', title: '会话列表' }] : []), ...menus.map(menu => ({ kind: 'menu', ...menu }))];
  activeLayer = stack.at(-1) || null;
  if (closingLayer && closingLayer !== activeLayer?.id) closingLayer = null;
  $('sidebar').textContent = activeLayer ? '‹' : '☰';
  const backLabel = activeLayer?.kind === 'menu' ? '返回上一级' : activeLayer ? '返回聊天' : '展开会话列表';
  $('sidebar').setAttribute('aria-label', backLabel);
  $('sidebar').title = backLabel;
  $('sidebar').disabled = !!closingLayer;
  $('targets').hidden = !!activeLayer;
  $('layer-title').hidden = !activeLayer;
  $('layer-title').textContent = activeLayer?.title || '';
  let backdrop = doc.getElementById('cbb-menu-backdrop');
  if (activeLayer?.kind === 'menu' && !backdrop) {
    backdrop = doc.createElement('div'); backdrop.id = 'cbb-menu-backdrop'; backdrop.dataset.cbbLocal = 'menu-backdrop'; doc.body.append(backdrop);
  } else if (activeLayer?.kind !== 'menu') backdrop?.remove();
  let drawerBackdrop = doc.getElementById('cbb-drawer-backdrop');
  if (drawer && !drawerBackdrop) { drawerBackdrop = doc.createElement('div'); drawerBackdrop.id = 'cbb-drawer-backdrop'; drawerBackdrop.dataset.cbbLocal = 'drawer-backdrop'; doc.body.append(drawerBackdrop); }
  else if (!drawer) drawerBackdrop?.remove();
  for (const node of doc.querySelectorAll('[data-cbb-floating-menu],[data-cbb-composer-menu]')) {
    const index = menus.findIndex(menu => menu.id === node.dataset.cbbId);
    node.toggleAttribute('data-cbb-menu-active', index === menus.length - 1 && index >= 0);
  }
  if (!closingLayer && expectedHistoryDepth === null && stack.length > layerHistory) {
    for (let depth = layerHistory + 1; depth <= stack.length; depth++) history.pushState({ cbbDepth: depth }, '');
    layerHistory = stack.length;
  } else if (stack.length < layerHistory) {
    expectedHistoryDepth = stack.length; history.go(stack.length - layerHistory); layerHistory = stack.length;
  }
}
async function closeLayer() {
  const layer = activeLayer;
  if (!layer || closingLayer) return;
  if (layer.kind === 'drawer') { doc.documentElement.removeAttribute('data-cbb-drawer'); updateLayers(lastLayers); return; }
  closingLayer = layer.id; $('sidebar').disabled = true;
  try {
    await flushText();
    if (layer.closeId) await enqueue({ type: 'click', id: layer.closeId });
    else await enqueue({ type: 'key', id: layer.triggerId || layer.id, key: layer.closeKey || 'Escape' });
  } catch (error) { closingLayer = null; $('sidebar').disabled = false; status(error.message); }
}
window.addEventListener('popstate', event => {
  const depth = Number(event.state?.cbbDepth) || 0;
  if (expectedHistoryDepth === depth) { expectedHistoryDepth = null; layerHistory = depth; updateLayers(lastLayers); return; }
  expectedHistoryDepth = null; layerHistory = depth;
  if (activeLayer) closeLayer();
});
function updateComposerSpace() {
  if (!doc) return;
  const heights = [...doc.querySelectorAll('[data-thread-scroll-footer]')].map(node => node.getBoundingClientRect().height).filter(height => height > 0);
  const value = `${Math.ceil(Math.max(0, ...heights)) + 8}px`;
  if (doc.documentElement.style.getPropertyValue('--cbb-composer-space') !== value) doc.documentElement.style.setProperty('--cbb-composer-space', value);
}
function receive(snapshot) {
  if (!snapshot?.tree || !frameReady || !loggedIn) return;
  if (snapshot.epoch === epoch && snapshot.revision <= revision) return;
  if (snapshot.styles) {
    const incoming = new Set(snapshot.styles.sheets.map(sheet => sheet.id));
    if ((snapshot.styles.baseRevision && snapshot.styles.baseRevision !== cssRevision) || snapshot.styles.order.some(id => !styleNodes.has(id) && !incoming.has(id))) {
      revision = -1; cssRevision = ''; kickPoll(); return;
    }
  }
  if (snapshot.baseRevision !== undefined) {
    let missing = false;
    function check(node) { if (node.ref) { if (!mirrored.has(node.id)) missing = true; return; } for (const child of node.children || []) check(child); for (const child of node.shadow?.children || []) check(child); }
    check(snapshot.tree);
    if (snapshot.epoch !== epoch || snapshot.baseRevision !== revision || missing) { revision = -1; kickPoll(); return; }
  }
  render(snapshot);
  activeUntil = performance.now() + 2500;
}
function kickPoll() { pollPending = true; activeUntil = performance.now() + 2500; wakePoll?.(); }
function connectEvents() {
  events?.close(); eventsReady = false;
  if (typeof EventSource !== 'function') return;
  events = new EventSource('/api/events');
  events.onopen = () => { eventsReady = true; kickPoll(); };
  events.onmessage = kickPoll;
  events.onerror = () => { eventsReady = false; kickPoll(); };
}
function pausePoll(ms) {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); if (wakePoll === finish) wakePoll = null; resolve(); };
    const timer = setTimeout(finish, ms); wakePoll = finish;
  });
}
async function poll() {
  if (polling) return; polling = true;
  try {
    while (loggedIn && frameReady) {
      if (pendingActions) { await pausePoll(10000); continue; }
      pollPending = false;
      let wait;
      try {
        pollController = new AbortController();
        const snapshot = await api(`/api/snapshot?delta=1&revision=${revision}&epoch=${encodeURIComponent(epoch)}&cssRevision=${cssRevision}`, undefined, pollController.signal);
        receive(snapshot);
        if (!uploadBusy && !uploadError) status('');
      } catch (error) { if (error.name !== 'AbortError') { status(error.message); wait = 2000; } }
      finally { pollController = null; }
      if (pollPending && !wait) continue;
      await pausePoll(wait || (document.hidden ? 3000 : eventsReady ? 10000 : performance.now() < activeUntil ? 160 : 900));
    }
  } finally { polling = false; }
}
function enqueue(message) {
  pendingActions++; pollController?.abort();
  kickPoll();
  const result = actionQueue.then(async () => {
    const result = await api('/api/action', { ...message, view: { delta: true, revision, epoch, cssRevision } });
    receive(result.snapshot); kickPoll(); return result;
  });
  actionQueue = result.catch(error => { status(error.message); }).finally(() => { pendingActions--; kickPoll(); });
  return result;
}
function editorFor(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (element.matches('textarea,input:not([type="file"]):not([type="checkbox"]):not([type="radio"])')) return element;
  const candidate = element.closest('[contenteditable]');
  return candidate?.isContentEditable ? candidate : null;
}
function eventElement(event) { return event.composedPath().find(node => node.nodeType === Node.ELEMENT_NODE) || event.target; }
async function flushText() {
  clearTimeout(inputTimer);
  const entries = [...pendingText.entries()]; pendingText.clear();
  for (const [id, text] of entries) await enqueue({ type: 'text', id, text });
}
function installEvents() {
  doc.addEventListener('focusin', event => { const editor = editorFor(eventElement(event)); if (editor) editing.add(editor.dataset.cbbId); });
  doc.addEventListener('focusout', event => {
    const editor = editorFor(eventElement(event));
    if (editor) flushText().finally(() => { editing.delete(editor.dataset.cbbId); });
  });
  doc.addEventListener('input', event => {
    const editor = editorFor(eventElement(event)); if (!editor || editor.type === 'password') return;
    pendingText.set(editor.dataset.cbbId, editor.isContentEditable ? editor.innerText : editor.value);
    clearTimeout(inputTimer); inputTimer = setTimeout(() => { if (!event.isComposing) flushText().catch(() => {}); }, 180);
  });
  doc.addEventListener('compositionend', () => { flushText().catch(() => {}); });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && activeLayer) { event.preventDefault(); closeLayer(); return; }
    const editor = editorFor(eventElement(event));
    if (editor && !event.isComposing && ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Escape')) {
      event.preventDefault();
      flushText().then(() => enqueue({ type: 'key', id: editor.dataset.cbbId, key: event.key })).catch(() => {});
    }
  });
  doc.addEventListener('click', event => {
    const element = eventElement(event);
    if (element.dataset?.cbbLocal === 'menu-backdrop') { event.preventDefault(); closeLayer(); return; }
    if (element.dataset?.cbbLocal === 'drawer-backdrop') { event.preventDefault(); doc.documentElement.removeAttribute('data-cbb-drawer'); updateLayers(lastLayers); return; }
    if (element.closest('[data-cbb-upload-item]')) { event.preventDefault(); $('upload-files').click(); return; }
    const target = element.closest('button,a,input,[role="button"],[role="tab"],[role^="menuitem"],summary') || element.closest('[data-cbb-id]');
    if (!target || editorFor(target) || target.tagName === 'SELECT' || target.tagName === 'OPTION') return;
    event.preventDefault();
    flushText().then(() => enqueue({ type: 'click', id: target.dataset.cbbId })).catch(() => {});
    const navigation = target.closest('[data-sidebar-destination],[data-app-action-sidebar-thread-id],a[href]');
    if ((target.closest('[data-cbb-sidebar]') || activeLayer?.sidebar) && navigation && !target.closest('[aria-haspopup]')) { sidebarNavigating = true; doc.documentElement.removeAttribute('data-cbb-drawer'); updateLayers(lastLayers); }
  }, true);
  doc.addEventListener('change', event => { if (event.target.tagName === 'SELECT') enqueue({ type: 'change', id: event.target.dataset.cbbId, value: event.target.value }).catch(() => {}); });
  doc.addEventListener('scroll', handleScroll, true);
}
const scrollTimers = new WeakMap(), handledScrolls = new WeakSet();
function handleScroll(event) {
  if (handledScrolls.has(event)) return; handledScrolls.add(event);
  const target = eventElement(event); if (!target.dataset?.cbbId) return;
  const expected = programmaticScrolls.get(target);
  if (expected && Math.abs(target.scrollTop - expected.top) < 2 && Math.abs(target.scrollLeft - expected.left) < 2) return;
  programmaticScrolls.delete(target);
  if (target.matches('.thread-scroll-container')) threadPositions.set(threadKey(target), readThread(target));
  const range = target.scrollHeight - target.clientHeight; if (range <= 0) return;
  clearTimeout(scrollTimers.get(target));
  scrollTimers.set(target, setTimeout(() => {
    if (!target.isConnected) return;
    const maximum = target.scrollHeight - target.clientHeight, ratio = maximum > 0 ? Math.max(0, Math.min(1, target.scrollTop / maximum)) : 1;
    const anchor = target.matches('.thread-scroll-container') && ratio < .999 ? threadAnchor(target) : null;
    enqueue({ type: 'scroll', id: target.dataset.cbbId, ratio, ...(anchor ? { anchor: { id: anchor.id, turnKey: anchor.turnKey, offset: Math.max(0, Math.min(1, anchor.offset / target.clientHeight)) } } : {}) }).catch(() => {});
  }, 160));
}
$('upload-files').addEventListener('change', async () => {
  const files = [...$('upload-files').files];
  if (!files.length) return;
  uploadBusy = true; uploadError = '';
  try {
    await closeLayer();
    for (const file of files) {
      if (file.size > 64 * 1024 * 1024) throw new Error('单个附件不能超过 64 MB');
      status(`正在上传 ${file.name}…`);
      const response = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-CBB-CSRF': csrf, 'X-CBB-Filename': encodeURIComponent(file.name) }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '上传失败');
    }
    status('附件已添加到 Codex 输入框');
  } catch (error) { uploadError = error.message; status(error.message); }
  finally { uploadBusy = false; $('upload-files').value = ''; }
});
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').textContent = '';
  try { await api('/api/login', { password: $('password').value }); $('password').value = ''; await showApp(); }
  catch (error) { $('login-error').textContent = error.message; }
});
$('logout').onclick = async () => { await api('/api/logout', {}); showLogin(); };
$('refresh').onclick = () => { revision = -1; kickPoll(); loadTargets(); };
$('targets').onchange = async () => { try { await flushText(); editing.clear(); await api('/api/target', { targetId: $('targets').value }); revision = -1; epoch = ''; kickPoll(); } catch (error) { status(error.message); } };
$('sidebar').onclick = () => { if (activeLayer) { closeLayer(); return; } if (doc) { doc.documentElement.setAttribute('data-cbb-drawer', 'open'); updateLayers(lastLayers); } };
document.addEventListener('visibilitychange', () => { if (!document.hidden) kickPoll(); });
showApp().catch(error => { $('login-error').textContent = error.message; });
