(() => {
  if (window.__codexBrowserBridge?.version === 10) return;
  window.__codexBrowserBridge?.dispose?.();
  let nextId = 0, dirty = true, stylesDirty = true, sheetCount = -1, sidebar = null;
  const virtualRows = new Set(), virtualLists = new Set(), virtualSpacers = new Set();
  const observedShadows = new Set(), uploadItems = new Set(), floatingMenus = new Set();
  let composerMenu = null, rightPanel = null;
  const ids = new WeakMap(), nodes = new Map();
  const ignored = new Set(['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'META', 'BASE', 'OBJECT', 'EMBED']);
  const idFor = node => {
    let id = ids.get(node);
    if (!id) { id = String(++nextId); ids.set(node, id); }
    nodes.set(id, node);
    return id;
  };
  const markDirty = () => {
    const notify = !dirty;
    dirty = true;
    // Notify only on the clean -> dirty transition. Renderer timers can be
    // throttled when the desktop window is in the background or minimized.
    if (notify && typeof window.__cbbSnapshotChanged === 'function') window.__cbbSnapshotChanged('changed');
  };
  const observer = new MutationObserver(records => {
    markDirty();
    for (const record of records) {
      if (['STYLE', 'LINK'].includes(record.target.tagName) || [...record.addedNodes].some(node => node.nodeType === 1 && (['STYLE', 'LINK'].includes(node.tagName) || node.querySelector?.('style,link[rel="stylesheet"]')))) stylesDirty = true;
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  for (const name of ['input', 'change', 'scroll', 'load']) document.addEventListener(name, markDirty, true);
  function serialize(node, seen) {
    if (node.nodeType === Node.TEXT_NODE) {
      const id = idFor(node); seen.add(id);
      return { id, tag: '#text', text: node.textContent };
    }
    if (node.nodeType !== Node.ELEMENT_NODE || ignored.has(node.tagName) || (node.tagName === 'INPUT' && node.type === 'hidden')) return null;
    const id = idFor(node); seen.add(id);
    const attrs = {};
    for (const attr of node.attributes) {
      if (/^on/i.test(attr.name) || ['nonce', 'srcdoc', 'integrity', 'autofocus'].includes(attr.name)) continue;
      if (node.tagName === 'INPUT' && node.type === 'password' && attr.name === 'value') continue;
      attrs[attr.name] = attr.value;
    }
    if (node === sidebar) attrs['data-cbb-sidebar'] = '';
    if (node === composerMenu) attrs['data-cbb-composer-menu'] = '';
    if (floatingMenus.has(node)) attrs['data-cbb-floating-menu'] = '';
    if (node === rightPanel) attrs['data-cbb-review-panel'] = '';
    if (uploadItems.has(node)) attrs['data-cbb-upload-item'] = '';
    if (virtualRows.has(node)) attrs['data-cbb-virtual-row'] = '';
    if (virtualLists.has(node)) attrs['data-cbb-virtual-list'] = '';
    if (virtualSpacers.has(node)) attrs['data-cbb-virtual-spacer'] = '';
    const result = { id, tag: node.localName, ns: node.namespaceURI, attrs, children: [] };
    if (node.classList.contains('thread-scroll-container')) {
      const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
      result.scrollState = { ratio: maximum ? node.scrollTop / maximum : 1, bottom: maximum - node.scrollTop < 48 };
    }
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
      result.value = node.type === 'password' ? '' : node.value;
      result.checked = node.checked;
    }
    if (node.tagName === 'IFRAME') { result.tag = 'div'; result.attrs = { 'data-cbb-frame': 'true' }; return result; }
    // Cached inactive pages are hidden in the phone mirror as well.
    if (node.getAttribute('data-app-shell-active-page') === 'false') return result;
    for (const child of node.childNodes) {
      const item = serialize(child, seen);
      if (item) result.children.push(item);
    }
    if (node.shadowRoot && node.tagName !== 'WEBVIEW') {
      const root = node.shadowRoot;
      if (!observedShadows.has(root)) {
        observedShadows.add(root);
        observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        root.addEventListener('scroll', markDirty, true);
      }
      result.shadow = { styles: styles(root), children: [] };
      for (const child of root.childNodes) {
        const item = serialize(child, seen);
        if (item) result.shadow.children.push(item);
      }
    }
    return result;
  }
  function styles(root = document) {
    const sheets = [], visited = new Set();
    function add(sheet) {
      if (visited.has(sheet)) return;
      visited.add(sheet);
      try {
        const rules = [];
        for (const rule of sheet.cssRules) {
          if (rule.styleSheet) add(rule.styleSheet);
          else rules.push(rule.cssText);
        }
        sheets.push({ base: sheet.href || document.baseURI, css: rules.join('\n') });
      } catch { sheets.push({ base: sheet.href, inaccessible: true }); }
    }
    for (const sheet of [...(root.styleSheets || []), ...(root.adoptedStyleSheets || [])]) add(sheet);
    return sheets;
  }
  function snapshot(force) {
    if (!dirty && !force) return null;
    dirty = false;
    const visible = node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const candidates = [...document.querySelectorAll('[data-app-shell-left-panel-appearance],nav,aside,[data-testid*="sidebar"],[class*="sidebar"]')];
    sidebar = candidates.find(node => {
      const box = node.getBoundingClientRect();
      return box.left < 80 && box.width >= 140 && box.width <= 450 && box.height > innerHeight * .6;
    }) || null;
    composerMenu = [...document.querySelectorAll('[data-composer-overlay-floating-ui]')].filter(visible).at(-1)?.parentElement || null;
    rightPanel = [...document.querySelectorAll('aside[data-app-shell-focus-area="right-panel"]')].find(visible) || null;
    floatingMenus.clear();
    const floatingContents = [...document.querySelectorAll('[data-radix-popper-content-wrapper] [role="menu"], [data-radix-popper-content-wrapper] [role="listbox"], [data-radix-popper-content-wrapper] [role="dialog"][data-slot="popover-content"]')]
      .filter(node => visible(node) && node.getAttribute('data-state') !== 'closed' && !composerMenu?.contains(node));
    const contentByWrapper = new Map();
    for (const node of floatingContents) {
      const wrapper = node.closest('[data-radix-popper-content-wrapper]');
      floatingMenus.add(wrapper); if (!contentByWrapper.has(wrapper)) contentByWrapper.set(wrapper, node);
    }
    uploadItems.clear();
    for (const button of composerMenu?.querySelectorAll('button') || []) if (button.innerText.trim() === '文件和文件夹') uploadItems.add(button);
    const menuTrigger = [...document.querySelectorAll('[data-codex-composer-root] button[aria-label="添加文件等内容"]')].find(visible);
    const panelClose = [...document.querySelectorAll('button[data-app-shell-workspace-layout-toggle="main"]')].find(visible)
      || [...document.querySelectorAll('button[data-app-shell-tab-close-button]')].filter(visible).at(-1);
    const menus = composerMenu ? [{ id: idFor(composerMenu), triggerId: menuTrigger ? idFor(menuTrigger) : idFor(composerMenu), closeId: menuTrigger ? idFor(menuTrigger) : null, title: '添加' }] : [];
    for (const [wrapper, content] of contentByWrapper) {
      const trigger = content.id ? [...document.querySelectorAll('[aria-controls]')].find(node => node.getAttribute('aria-controls') === content.id) : null;
      const parent = trigger?.closest('[role="menu"]')?.closest('[data-radix-popper-content-wrapper]');
      const parentLayer = parent && menus.find(menu => menu.id === idFor(parent));
      const sidebarMenu = !!(content.getAttribute('data-overlay-owner') === 'slate-sidebar' || (trigger && sidebar?.contains(trigger)) || parentLayer?.sidebar);
      menus.push({ id: idFor(wrapper), triggerId: idFor(content), title: content.getAttribute('aria-label') || '菜单', sidebar: sidebarMenu,
        ...(content.getAttribute('role') === 'dialog' && trigger ? { closeId: idFor(trigger) } : {}),
        ...(parent ? { closeKey: getComputedStyle(content).direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft' } : {}) });
    }
    const layers = {
      menus, menu: menus.at(-1) || null,
      panel: rightPanel ? { id: idFor(rightPanel), closeId: panelClose ? idFor(panelClose) : null, title: '变更' } : null,
    };
    for (const root of observedShadows) if (!root.host.isConnected) { root.removeEventListener('scroll', markDirty, true); observedShadows.delete(root); }
    virtualRows.clear(); virtualLists.clear(); virtualSpacers.clear();
    for (const turn of document.querySelectorAll('[data-thread-find-target="conversation"] [data-turn-key]')) {
      const row = turn.parentElement, list = row?.parentElement, spacer = list?.parentElement;
      if (row?.style.height && row.style.height !== 'auto' && list && spacer) {
        virtualRows.add(row); virtualLists.add(list); virtualSpacers.add(spacer);
      }
    }
    const seen = new Set(), tree = serialize(document.body, seen);
    for (const id of nodes.keys()) if (!seen.has(id)) nodes.delete(id);
    const count = document.styleSheets.length + document.adoptedStyleSheets.length;
    const sheetData = force || stylesDirty || count !== sheetCount ? styles() : null;
    sheetCount = count; stylesDirty = false;
    return { tree, styles: sheetData, base: document.baseURI, title: document.title, layers,
      htmlAttrs: Object.fromEntries([...document.documentElement.attributes].map(a => [a.name, a.value])) };
  }
  function action(message) {
    const node = nodes.get(message.id);
    if (!node?.isConnected) throw new Error('元素已变化，请重试');
    switch (message.type) {
      case 'click':
        if (node.matches?.('[aria-haspopup="menu"], [aria-haspopup="listbox"]')) {
          const row = node.closest('[data-app-action-sidebar-project-row],.sidebar-item');
          if (row && sidebar?.contains(row)) row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
          const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
          if (!box.width || !box.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw new Error('菜单按钮不在当前窗口内，请刷新后重试');
          dirty = true;
          const rowBox = row && sidebar?.contains(row) ? row.getBoundingClientRect() : null;
          return { clickPoint: { x, y }, ...(rowBox ? { hoverPoint: { x: rowBox.x + Math.min(30, rowBox.width / 2), y: rowBox.y + rowBox.height / 2 } } : {}) };
        }
        node.click ? node.click() : node.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
        break;
      case 'focus': node.focus(); break;
      case 'selectText': {
        if (!node.isContentEditable && !['INPUT', 'TEXTAREA'].includes(node.tagName)) throw new Error('该元素不能输入');
        node.focus();
        if (typeof node.select === 'function') node.select();
        else { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
        break;
      }
      case 'change':
        if (node.tagName !== 'SELECT') throw new Error('该元素不是选择框');
        node.value = message.value; node.dispatchEvent(new Event('change', { bubbles: true })); break;
      case 'scroll': {
        const anchor = message.anchor;
        let target = anchor && nodes.get(anchor.id);
        if (anchor && (!target?.isConnected || !node.contains(target))) target = [...node.querySelectorAll('[data-turn-key]')].find(n => n.getAttribute('data-turn-key') === anchor.turnKey);
        if (target?.getBoundingClientRect && node.contains(target)) node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - node.clientHeight * anchor.offset;
        else node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight) * message.ratio;
        break;
      }
      default: throw new Error('不支持的操作');
    }
    markDirty();
    return true;
  }
  window.__codexBrowserBridge = { version: 10, snapshot, action, markDirty, dispose() {
    observer.disconnect();
    for (const name of ['input', 'change', 'scroll', 'load']) document.removeEventListener(name, markDirty, true);
    for (const root of observedShadows) root.removeEventListener('scroll', markDirty, true);
  } };
})()
