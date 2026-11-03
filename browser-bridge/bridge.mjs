import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { connect } from './cdp.mjs';

const agent = await readFile(new URL('./page-agent.js', import.meta.url), 'utf8');
export class MirrorBridge {
  constructor(endpoint, targetId = '') {
    this.endpoint = endpoint; this.targetId = targetId; this.assets = new Map();
    this.revision = 0; this.latest = null;
    this.changeListeners = new Set();
  }
  onChange(listener) { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  changed() { for (const listener of this.changeListeners) listener(); }
  close() { this.closed = true; this.changeListeners.clear(); this.cdp?.close(); }
  async client() {
    if (this.closed) throw new Error('连接已关闭');
    if (this.cdp) return this.cdp;
    if (!this.connecting) this.connecting = connect(this.endpoint).then(client => {
      if (this.closed) { client.close(); throw new Error('连接已关闭'); }
      this.cdp = client;
      client.on('disconnected', () => { if (this.cdp === client) { this.cdp = null; this.session = null; this.latest = null; this.changed(); } });
      client.on('Target.detachedFromTarget', ({ sessionId }) => { if (sessionId === this.session) { this.session = null; this.latest = null; } });
      client.on('Runtime.bindingCalled', (event, sessionId) => { if (sessionId === this.session && event.name === '__cbbSnapshotChanged') this.changed(); });
      return client;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async targets() {
    const client = await this.client();
    const { targetInfos } = await client.call('Target.getTargets');
    return targetInfos.filter(target => target.type === 'page' && !target.url.startsWith('devtools:'))
      .map(({ targetId, title, url }) => ({ targetId, title, url: url.split(/[?#]/)[0] }));
  }
  async attach() {
    if (this.session) return;
    if (!this.attaching) this.attaching = this.attachPage().finally(() => { this.attaching = null; });
    return this.attaching;
  }
  async attachPage() {
    const client = await this.client();
    if (this.session) return;
    const pages = await this.targets();
    const page = pages.find(page => page.targetId === this.targetId)
      || pages.find(page => page.url.startsWith('app://-/index.html'))
      || pages.find(page => /codex|chatgpt/i.test(page.title + page.url)) || (pages.length === 1 ? pages[0] : null);
    if (!page) throw new Error('没有找到 Codex 页面，请在顶部选择窗口');
    this.targetId = page.targetId;
    const { sessionId } = await client.call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.session = sessionId;
    await client.call('Runtime.enable', {}, sessionId);
    await client.call('Runtime.addBinding', { name: '__cbbSnapshotChanged' }, sessionId);
    await client.call('Page.enable', {}, sessionId);
    // Keep rAF/lazy diff rendering alive while the desktop window is hidden.
    // This does not activate or move the native window; detaching restores it.
    await client.call('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    await client.call('Page.addScriptToEvaluateOnNewDocument', { source: agent }, sessionId);
    await this.evaluate(agent);
    this.assets.clear(); this.latest = null;
  }
  async select(targetId) {
    await this.attaching;
    const pages = await this.targets();
    if (!pages.some(page => page.targetId === targetId)) throw new Error('窗口不存在');
    if (this.session) await this.cdp.call('Target.detachFromTarget', { sessionId: this.session });
    this.session = null; this.targetId = targetId;
    await this.attach();
  }
  async evaluate(expression) {
    const result = await this.cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, this.session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] || '页面操作失败');
    return result.result.value;
  }
  assetUrl(value, base) {
    if (!value || value.startsWith('data:') || value.startsWith('#')) return value;
    let url;
    try { url = new URL(value, base).href; } catch { return ''; }
    if (!/^(https?:|file:|app:|codex:|blob:|chrome-extension:)/i.test(url)) return '';
    const id = createHash('sha256').update(url).digest('hex');
    this.assets.set(id, url);
    return `/asset/${id}`;
  }
  css(css, base) {
    return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, url) => `url("${this.assetUrl(url, base).replaceAll('"', '%22')}")`);
  }
  transform(node, base) {
    if (!node?.attrs) return;
    const attrs = node.attrs;
    if (attrs.style) attrs.style = this.css(attrs.style, base);
    for (const key of ['src', 'poster', 'background', 'xlink:href']) if (attrs[key]) attrs[key] = this.assetUrl(attrs[key], base);
    if (attrs.href && node.tag !== 'a') attrs.href = this.assetUrl(attrs.href, base);
    if (node.tag === 'a') attrs.href = '#';
    for (const key of ['srcset', 'action', 'formaction', 'ping', 'download', 'target']) delete attrs[key];
    if (node.tag === 'input' && attrs.type === 'file') attrs.disabled = '';
    for (const child of node.children) this.transform(child, base);
    if (node.shadow) {
      node.shadow.css = node.shadow.styles.map(sheet => this.css(sheet.css || '', sheet.base || base)).join('\n');
      delete node.shadow.styles;
      for (const child of node.shadow.children) this.transform(child, base);
    }
  }
  async snapshot(force = false) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.readSnapshot(force).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async readSnapshot(force) {
    await this.attach();
    await this.evaluate(agent);
    const data = await this.evaluate(`window.__codexBrowserBridge.snapshot(${!this.latest || force})`);
    if (data) {
      this.transform(data.tree, data.base);
      const css = [];
      for (const sheet of data.styles || []) {
        if (sheet.css) css.push(this.css(sheet.css, sheet.base));
        else if (sheet.base) css.push(`@import url("${this.assetUrl(sheet.base, sheet.base)}");`);
      }
      const cssText = data.styles ? css.join('\n') : this.latest?.css || '';
      const cssRevision = createHash('sha256').update(cssText).digest('hex').slice(0, 16);
      const occurrences = new Map();
      const styleChunks = data.styles ? css.map(text => {
        const hash = createHash('sha256').update(text).digest('hex').slice(0, 24), occurrence = occurrences.get(hash) || 0;
        occurrences.set(hash, occurrence + 1); return { id: `${hash}-${occurrence}`, css: text };
      }) : this.latest?.styleChunks || [];
      this.latest = { tree: data.tree, css: cssText, cssRevision, styleChunks, title: data.title, htmlAttrs: data.htmlAttrs, layers: data.layers, revision: ++this.revision };
    }
    return this.latest;
  }
  async action(message) {
    if (!['click', 'text', 'change', 'scroll', 'key'].includes(message.type)) throw new Error('不支持的操作');
    if (typeof message.id !== 'string' || !/^\d+$/.test(message.id)) throw new Error('元素编号无效');
    await this.attach();
    if (message.type === 'text') {
      if (typeof message.text !== 'string' || message.text.length > 100000) throw new Error('输入内容过长');
      await this.evaluate(`window.__codexBrowserBridge.action(${JSON.stringify({ type: 'selectText', id: message.id })})`);
      await this.cdp.call('Input.insertText', { text: message.text }, this.session);
    } else if (message.type === 'key') {
      const keys = { Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 } };
      if (!keys[message.key]) throw new Error('按键不支持');
      await this.evaluate(`window.__codexBrowserBridge.action(${JSON.stringify({ type: 'focus', id: message.id })})`);
      const params = { ...keys[message.key], modifiers: message.shift ? 8 : 0 };
      await this.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...params }, this.session);
      await this.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, this.session);
    } else {
      if (message.type === 'scroll' && (!Number.isFinite(message.ratio) || message.ratio < 0 || message.ratio > 1)) throw new Error('滚动位置无效');
      if (message.type === 'scroll' && message.anchor && (typeof message.anchor.id !== 'string' || !/^\d+$/.test(message.anchor.id) || !Number.isFinite(message.anchor.offset) || message.anchor.offset < 0 || message.anchor.offset > 1 || (message.anchor.turnKey !== undefined && (typeof message.anchor.turnKey !== 'string' || message.anchor.turnKey.length > 512)))) throw new Error('滚动锚点无效');
      let result = await this.evaluate(`window.__codexBrowserBridge.action(${JSON.stringify(message)})`);
      if (result?.clickPoint) {
        if (result.hoverPoint) {
          await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...result.hoverPoint, button: 'none', buttons: 0 }, this.session);
          await new Promise(resolve => setTimeout(resolve, 80));
          result = await this.evaluate(`window.__codexBrowserBridge.action(${JSON.stringify(message)})`);
        }
        const point = result.clickPoint;
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 }, this.session);
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }, this.session);
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }, this.session);
      }
    }
  }
  async upload(files) {
    if (!Array.isArray(files) || !files.length || files.length > 5) throw new Error('附件数量无效');
    await this.attach();
    const point = await this.evaluate(`(()=>{const e=[...document.querySelectorAll('[data-codex-composer-root]')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);if(!e)throw Error('当前窗口没有可用的输入框');const r=e.getBoundingClientRect();return {x:r.x+Math.min(30,r.width/2),y:r.y+Math.min(25,r.height/2)}})()`);
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await this.cdp.call('Input.dispatchDragEvent', { type, ...point, data }, this.session);
    const names = files.map(file => path.basename(file));
    let confirmed = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      confirmed = await this.evaluate(`(()=>{const root=[...document.querySelectorAll('[data-codex-composer-root]')].find(e=>e.getBoundingClientRect().width>0);if(!root)return false;const labels=[...root.querySelectorAll('[aria-label]')].map(n=>n.getAttribute('aria-label'));return ${JSON.stringify(names)}.every(name=>labels.some(label=>label.includes(name))||root.innerText.includes(name))})()`);
      if (confirmed) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!confirmed) throw new Error('附件已保存，但尚未在 Codex 输入框中确认，请检查当前窗口');
    await this.evaluate('window.__codexBrowserBridge?.markDirty()');
  }
  async asset(id) {
    const url = this.assets.get(id);
    if (!url) throw new Error('资源不存在');
    await this.attach();
    const tree = await this.cdp.call('Page.getResourceTree', {}, this.session);
    const frameId = tree.frameTree.frame.id;
    let content, mime = 'application/octet-stream';
    const resource = tree.frameTree.resources?.find(resource => resource.url === url);
    if (resource) {
      const result = await this.cdp.call('Page.getResourceContent', { frameId, url }, this.session);
      content = Buffer.from(result.content, result.base64Encoded ? 'base64' : 'utf8'); mime = resource.mimeType;
    } else {
      const result = await this.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(url)});if(!r.ok)throw Error('资源读取失败');const b=await r.blob();if(b.size>20*1024*1024)throw Error('资源过大');return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({data:reader.result,type:b.type});reader.onerror=reject;reader.readAsDataURL(b)})})()`);
      content = Buffer.from(result.data.split(',')[1], 'base64'); mime = result.type;
    }
    if (content.length > 20 * 1024 * 1024) throw new Error('资源过大');
    if (!/^(image\/|font\/|text\/css|application\/(?:font|x-font|vnd\.ms-fontobject|octet-stream))/.test(mime)) throw new Error('不支持该资源类型');
    if (mime.includes('text/css')) content = Buffer.from(this.css(content.toString('utf8'), url));
    return { content, mime };
  }
}
