import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../cdp.mjs';
import { MirrorBridge } from '../bridge.mjs';
import { createServer } from '../server.mjs';
import { hashPassword } from '../security.mjs';

async function fixture(html) {
  const client = await connect(process.env.CBB_TEST_CDP), targets = [];
  const source = await client.call('Target.createTarget', { url: 'about:blank' }); targets.push(source.targetId);
  const sourceSession = (await client.call('Target.attachToTarget', { targetId: source.targetId, flatten: true })).sessionId;
  await client.call('Page.enable', {}, sourceSession);
  const { frameTree } = await client.call('Page.getResourceTree', {}, sourceSession);
  await client.call('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sourceSession);
  const bridge = new MirrorBridge(process.env.CBB_TEST_CDP, source.targetId);
  const app = await createServer({ localPort: 14895, password: hashPassword('scroll-question-fixture') }, bridge);
  const viewer = await client.call('Target.createTarget', { url: 'about:blank' }); targets.push(viewer.targetId);
  const { sessionId } = await client.call('Target.attachToTarget', { targetId: viewer.targetId, flatten: true });
  await client.call('Page.enable', {}, sessionId);
  await client.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true }, sessionId);
  const evaluate = async expression => {
    const r = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error('Scroll/question condition timed out: ' + expression);
  };
  await client.call('Page.navigate', { url: 'http://127.0.0.1:14895/' }, sessionId);
  await until('document.readyState === "complete"');
  await evaluate('document.getElementById("password").value="scroll-question-fixture";document.getElementById("login-form").requestSubmit();true');
  await until('!!document.getElementById("mirror").contentDocument?.getElementById("ready")');
  return { client, sessionId, bridge, evaluate, until, close: async () => { await app.close(); for (const targetId of targets.reverse()) await client.call('Target.closeTarget', { targetId }); client.close(); } };
}

test('reading history stays anchored through insertion, remount, resize and delayed layout', { skip: !process.env.CBB_TEST_CDP, timeout: 30000 }, async () => {
  const messages = Array.from({ length: 60 }, (_, i) => `<article data-turn-key="m${i}" id="m${i}"><p>message ${i}: ${'long history text wraps differently on a phone. '.repeat(5)}</p></article>`).join('');
  const f = await fixture(`<!doctype html><html><head><style>body{margin:0;font:16px/1.5 system-ui}.thread-scroll-container{height:calc(100vh - 20px);overflow:auto}article{padding:12px}p{margin:0}#late{height:20px}</style></head><body><div data-app-shell-active-page="true"><div id="ready" class="thread-scroll-container"><div id="messages"><div id="late"></div>${messages}</div></div></div><script>ready.scrollTop=ready.scrollHeight*.3</script></body></html>`);
  const d = 'document.getElementById("mirror").contentDocument';
  const scroll = `${d}.getElementById('ready')`;
  const gap = `${scroll}.scrollHeight - ${scroll}.clientHeight - ${scroll}.scrollTop`;
  const offset = `(()=>{const d=${d};return d.querySelector('#m20 p').getBoundingClientRect().top-d.getElementById('ready').getBoundingClientRect().top})()`;
  try {
    await f.until(`${gap} < 3`);
    await f.evaluate(`(()=>{const e=${scroll};e.scrollTop=${d}.getElementById('m20').offsetTop+23;e.dispatchEvent(new Event('scroll'));return true})()`);
    await new Promise(resolve => setTimeout(resolve, 350));
    await f.until('pendingActions === 0');
    const initial = await f.evaluate(offset);
    await f.bridge.evaluate(`(()=>{const n=document.createElement('article');n.id='prepended';n.style.height='240px';n.textContent='older history';document.getElementById('messages').prepend(n);return true})()`);
    await f.until(`!!${d}.getElementById('prepended')`);
    assert.ok(Math.abs(await f.evaluate(offset) - initial) < 3, 'inserting older rows above must preserve the visible paragraph');
    await f.bridge.evaluate(`document.getElementById('m59').querySelector('p').textContent+=' ${'new streamed text '.repeat(30)}';true`);
    await f.until(`${d}.getElementById('m59').textContent.includes('new streamed text')`);
    assert.ok(Math.abs(await f.evaluate(offset) - initial) < 3, 'new responses must not pull history readers to the bottom');
    await f.bridge.evaluate(`(()=>{const old=document.getElementById('ready'),n=old.cloneNode(true);old.replaceWith(n);n.scrollTop=0;return true})()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    await f.until(`Math.abs(${offset} - ${initial}) < 3`);
    await f.evaluate(`${d}.getElementById('late').style.height='320px';true`);
    await f.until(`Math.abs(${offset} - ${initial}) < 3`);
    await f.client.call('Emulation.setDeviceMetricsOverride', { width: 430, height: 690, deviceScaleFactor: 1, mobile: true }, f.sessionId);
    await f.until(`Math.abs(${offset} - ${initial}) < 3`);
    assert.ok(await f.evaluate(gap) > 1000);
    await f.evaluate(`(()=>{const e=${scroll};e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));return true})()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    await f.bridge.evaluate(`(()=>{const p=document.createElement('p');p.id='newest';p.textContent='${'latest answer '.repeat(40)}';document.getElementById('messages').append(p);return true})()`);
    await f.until(`!!${d}.getElementById('newest') && ${gap} < 3`);
  } finally { await f.close(); }
});

test('page questions arrive by push and phone choices plus typed reply reach the source', { skip: !process.env.CBB_TEST_CDP, timeout: 20000 }, async () => {
  const f = await fixture(`<!doctype html><html><head><style>body{font:16px system-ui}button,input,textarea{min-height:44px}</style></head><body><div id="ready" data-request-input-activity-root="true"><button id="open" hidden>回答问题</button><form id="question" hidden><p>Choose a destination</p><label><input id="a" type="radio" name="choice" value="A"> A</label><label><input id="b" type="radio" name="choice" value="B"> B</label><textarea id="reply"></textarea><button id="submit" type="submit">提交回答</button></form><p id="answer"></p></div><script>document.getElementById('open').onclick=()=>{question.hidden=false};question.onsubmit=e=>{e.preventDefault();window.submitted={choice:document.querySelector('input:checked')?.value,text:reply.value};answer.textContent=JSON.stringify(window.submitted);question.hidden=true}</script></body></html>`);
  const d = 'document.getElementById("mirror").contentDocument';
  try {
    await f.bridge.evaluate('document.getElementById("open").hidden=false;true');
    await f.until(`!${d}.getElementById('open').hidden`);
    await f.evaluate(`${d}.getElementById('open').click();true`);
    await f.until(`!${d}.getElementById('question').hidden`);
    await f.evaluate(`${d}.getElementById('b').click();true`);
    await f.until(`${d}.getElementById('b').checked`);
    await f.evaluate(`${d}.getElementById('reply').focus();true`);
    await f.client.call('Input.insertText', { text: '手机补充说明' }, f.sessionId);
    await f.evaluate(`${d}.getElementById('submit').click();true`);
    await f.until(`${d}.getElementById('answer').textContent.includes('手机补充说明')`);
    assert.deepEqual(await f.bridge.evaluate('window.submitted'), { choice: 'B', text: '手机补充说明' });
  } finally { await f.close(); }
});
