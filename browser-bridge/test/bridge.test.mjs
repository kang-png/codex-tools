import test from 'node:test';
import assert from 'node:assert/strict';
import { MirrorBridge } from '../bridge.mjs';
import { connect } from '../cdp.mjs';

test('resource rewriting never offers an arbitrary URL proxy', () => {
  const bridge = new MirrorBridge('http://127.0.0.1:1');
  const asset = bridge.assetUrl('images/test.png?private=sensitive', 'app://-/index.html');
  assert.match(asset, /^\/asset\/[a-f0-9]{64}$/);
  assert.equal(asset.includes('sensitive'), false);
  assert.equal(bridge.assetUrl('javascript:alert(1)', 'app://-/'), '');
  const tree = { tag: 'a', attrs: { href: 'https://example.com/?secret=1', onclick: 'x', target: '_blank' }, children: [] };
  bridge.transform(tree, 'app://-/'); assert.equal(tree.attrs.href, '#'); assert.equal(tree.attrs.target, undefined);
});
test('native Codex window takes priority over a browser tab with Codex in its title', async () => {
  const bridge = new MirrorBridge('http://127.0.0.1:1');
  const client = { call: async method => method === 'Target.attachToTarget' ? { sessionId: 'fixture-session' } : {} };
  bridge.client = async () => { bridge.cdp = client; return client; };
  bridge.targets = async () => [{ targetId: 'browser', title: 'Codex 手机入口', url: 'http://127.0.0.1:4788/' }, { targetId: 'native', title: 'ChatGPT', url: 'app://-/index.html' }];
  bridge.evaluate = async () => true;
  await bridge.attach();
  assert.equal(bridge.targetId, 'native');
});
test('real Chromium DOM mirroring and native input events', { skip: !process.env.CBB_TEST_CDP }, async () => {
  const client = await connect(process.env.CBB_TEST_CDP);
  let targetId, bridge;
  try {
    ({ targetId } = await client.call('Target.createTarget', { url: 'about:blank' }));
    bridge = new MirrorBridge(process.env.CBB_TEST_CDP, targetId);
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
    await client.call('Page.enable', {}, sessionId);
    const { frameTree } = await client.call('Page.getResourceTree', {}, sessionId);
    await client.call('Page.setDocumentContent', { frameId: frameTree.frame.id, html: '<!doctype html><html><head><style>body{color:rgb(12,34,56)}aside{width:240px;height:100vh}#editor{white-space:pre-wrap}</style></head><body><aside>会话列表</aside><main><div id="editor" contenteditable="true">initial</div><button id="send">发送</button><p id="result"></p></main><script>window.inputCount=0;editor.addEventListener("input",()=>window.inputCount++);send.onclick=()=>{result.textContent=editor.innerText};</script></body></html>' }, sessionId);
    const snapshot = await bridge.snapshot();
    const flattened = []; const walk = node => { flattened.push(node); for (const child of node.children || []) walk(child); }; walk(snapshot.tree);
    assert.equal(flattened.some(node => node.tag === 'script'), false);
    assert.ok(snapshot.css.includes('rgb(12, 34, 56)'));
    const editor = flattened.find(node => node.attrs?.id === 'editor'), send = flattened.find(node => node.attrs?.id === 'send');
    await bridge.action({ type: 'text', id: editor.id, text: '手机中文输入\n第二行' });
    assert.equal(await bridge.evaluate('document.getElementById("editor").innerText'), '手机中文输入\n第二行', await bridge.evaluate('JSON.stringify({html:editor.innerHTML,whitespace:getComputedStyle(editor).whiteSpace})'));
    assert.ok(await bridge.evaluate('window.inputCount') > 0);
    await bridge.action({ type: 'click', id: send.id });
    assert.equal(await bridge.evaluate('document.getElementById("result").textContent'), '手机中文输入\n第二行');
    const changed = await bridge.snapshot(); assert.ok(changed.revision > snapshot.revision);
    assert.equal(changed.cssRevision, snapshot.cssRevision);
    await bridge.action({ type: 'text', id: editor.id, text: '' });
    assert.equal(await bridge.evaluate('document.getElementById("editor").innerText'), '');
    await assert.rejects(bridge.action({ type: 'evaluate', id: editor.id, text: 'alert(1)' }));
    await assert.rejects(bridge.action({ type: 'click', id: '999999999' }));
  } finally { bridge?.cdp?.close(); if (targetId) await client.call('Target.closeTarget', { targetId }); client.close(); }
});
