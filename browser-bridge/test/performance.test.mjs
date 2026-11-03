import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from '../cdp.mjs';
import { MirrorBridge } from '../bridge.mjs';
import { createServer } from '../server.mjs';
import { hashPassword } from '../security.mjs';

test('slow-network clicks return small deltas and idle desktop changes arrive by push', { skip: !process.env.CBB_TEST_CDP, timeout: 30000 }, async () => {
  const client = await connect(process.env.CBB_TEST_CDP), targets = [];
  let bridge, app;
  try {
    const source = await client.call('Target.createTarget', { url: 'about:blank' }); targets.push(source.targetId);
    const sourceSession = (await client.call('Target.attachToTarget', { targetId: source.targetId, flatten: true })).sessionId;
    await client.call('Page.enable', {}, sourceSession);
    const { frameTree } = await client.call('Page.getResourceTree', {}, sourceSession);
    await client.call('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html><html><head><style>body{margin:0;font:16px system-ui}button{min-height:44px}</style><style>:root{--qa-large-style:"${'unchanged base sheet '.repeat(30000)}"}</style></head><body>
      <button id="increment"><span id="icon">计数</span></button><p id="result">0</p>
      <section id="static" data-payload="${randomBytes(90000).toString('base64')}">${'<p>unchanged transcript</p>'.repeat(600)}</section>
      <div id="cached" data-app-shell-active-page="false"><p>inactive cached page</p></div>
      <script>let n=0;increment.onclick=()=>{result.textContent=String(++n);let s=document.getElementById('dynamic');if(!s){s=document.createElement('style');s.id='dynamic';document.head.append(s)}s.textContent='#result{color:rgb('+n+',0,0)}'}</script></body></html>` }, sourceSession);
    bridge = new MirrorBridge(process.env.CBB_TEST_CDP, source.targetId);
    app = await createServer({ localPort: 14893, password: hashPassword('performance-fixture') }, bridge);
    const viewer = await client.call('Target.createTarget', { url: 'about:blank' }); targets.push(viewer.targetId);
    const session = (await client.call('Target.attachToTarget', { targetId: viewer.targetId, flatten: true })).sessionId;
    await client.call('Page.enable', {}, session);
    await client.call('Network.enable', {}, session);
    await client.call('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 125000, uploadThroughput: 125000, connectionType: 'cellular4g' }, session);
    await client.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true }, session);
    const evaluate = async expression => {
      const response = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw new Error('Performance condition timed out: ' + expression);
    };
    const d = 'document.getElementById("mirror").contentDocument';
    await client.call('Page.navigate', { url: 'http://127.0.0.1:14893/' }, session);
    await until('document.readyState === "complete"');
    await evaluate('document.getElementById("password").value="performance-fixture";document.getElementById("login-form").requestSubmit();true');
    await until(`!!${d}?.getElementById('result') && eventsReady`);
    assert.equal(await bridge.evaluate('document.visibilityState'), 'visible', 'the source must keep rendering while its physical tab is in the background');
    assert.equal(await evaluate(`${d}.getElementById('cached').childNodes.length`), 0);
    await evaluate(`window.qaStatic=${d}.getElementById('static');window.qaStyle=[...${d}.head.querySelectorAll('style')].find(n=>n.textContent.includes('qa-large-style'));window.qaPayloads=[];window.qaReceives=[];const qaReceive=receive;receive=v=>{const before=revision;qaReceive(v);qaReceives.push({before,after:revision,base:v?.baseRevision,next:v?.revision,css:!!v?.styles})};const qaFetch=fetch;window.fetch=async(...args)=>{const r=await qaFetch(...args);if(String(args[0]).startsWith('/api/action'))r.clone().json().then(v=>qaPayloads.push(JSON.stringify(v).length)).catch(()=>{});return r};true`);
    const times = [];
    for (let count = 1; count <= 3; count++) {
      const duration = await evaluate(`new Promise((resolve,reject)=>{const d=${d},n=d.getElementById('result'),start=performance.now();const observer=new MutationObserver(()=>{if(n.textContent===${JSON.stringify(String(count))}){clearTimeout(timer);observer.disconnect();resolve(performance.now()-start)}});const timer=setTimeout(()=>{observer.disconnect();reject(Error('Click response timed out'))},4000);observer.observe(n,{childList:true,subtree:true,characterData:true});d.getElementById('icon').click()})`);
      times.push(Math.round(duration));
    }
    assert.ok(Math.max(...times) < 900, 'click response must not wait for a full transcript transfer plus a poll interval');
    assert.equal(await evaluate(`qaStatic === ${d}.getElementById('static') && qaStatic.isConnected`), true);
    assert.equal(await evaluate(`qaStyle === [...${d}.head.querySelectorAll('style')].find(n=>n.textContent.includes('qa-large-style')) && qaStyle.isConnected`), true, 'the large base stylesheet must not be replaced for a dynamic rule');
    assert.equal(await evaluate(`getComputedStyle(${d}.getElementById('result')).color`), 'rgb(3, 0, 0)');
    const payloads = await evaluate('qaPayloads');
    assert.equal(payloads.length, 3); assert.ok(Math.max(...payloads) < 5000, 'button changes must not resend the 120 KB static attribute');
    await evaluate('new Promise(resolve=>setTimeout(resolve,250))');
    const started = performance.now();
    await bridge.evaluate('document.getElementById("result").textContent="desktop update";true');
    await until(`${d}.getElementById('result').textContent === 'desktop update'`);
    const pushMs = Math.round(performance.now() - started);
    if (pushMs >= 900) console.log(JSON.stringify({ pushMs, receives: await evaluate('qaReceives') }));
    assert.ok(pushMs < 900, 'desktop changes must interrupt the idle ten-second safety interval: '+pushMs+' ms');
    await bridge.evaluate('document.getElementById("cached").setAttribute("data-app-shell-active-page","true");true');
    await until(`${d}.getElementById('cached').textContent === 'inactive cached page'`);
    console.log(JSON.stringify({ clickMs: times, actionBytes: payloads, desktopPushMs: pushMs, simulatedLatencyMs: 100, downloadBytesPerSecond: 125000 }));
  } finally {
    if (app) await app.close();
    for (const targetId of targets.reverse()) await client.call('Target.closeTarget', { targetId });
    bridge?.close(); client.close();
  }
});
