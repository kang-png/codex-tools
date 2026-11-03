import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { connect } from '../cdp.mjs';
import { MirrorBridge } from '../bridge.mjs';
import { createServer } from '../server.mjs';
import { hashPassword } from '../security.mjs';

test('phone browser logs in, mirrors the original DOM, types, clicks, and opens the sidebar', { skip: !process.env.CBB_TEST_CDP }, async () => {
  const client = await connect(process.env.CBB_TEST_CDP);
  const targets = []; let bridge, app;
  try {
    const source = await client.call('Target.createTarget', { url: 'about:blank' }); targets.push(source.targetId);
    const sourceSession = (await client.call('Target.attachToTarget', { targetId: source.targetId, flatten: true })).sessionId;
    await client.call('Page.enable', {}, sourceSession);
    const frameTree = await client.call('Page.getResourceTree', {}, sourceSession);
    const fixtureHtml = `<!doctype html><html style="--qa-original-font:17px"><head><meta charset="utf-8"><style>
      body{margin:0;display:flex;height:100vh;font:15px/1.6 system-ui;background:#f9f9f7;color:#222}
      aside{width:240px;height:100vh;background:#ededeb;padding:24px;box-sizing:border-box}
      main{flex:1;min-width:0;padding:24px;box-sizing:border-box}h1{font-size:24px}
      #editor{white-space:pre-wrap;min-height:100px;padding:14px;border:1px solid #bbb;border-radius:12px;background:white}
      button{margin-top:14px;padding:10px 22px;border:0;border-radius:9px;color:white;background:#222}
      #result{white-space:pre-wrap;padding:16px;background:#e5f2e9;border-radius:12px}
    </style></head><body><aside><h2>会话</h2><p>浏览器层验证</p></aside><main>
      <h1>浏览器层连接测试</h1><p>验证原页面的桌面测量值不会挤压手机上换行后的消息。</p>
      <div data-thread-find-target="conversation"><div style="height:220px"><div style="display:flex;flex-direction:column;margin-top:800px">
        <div id="desktop-measured-row" style="height:100px"><div data-turn-key="first">
          <p>${'手机上文字会换行，消息必须按实际内容撑开高度，后面的文件卡片不能覆盖前面的文字。'.repeat(5)}</p>
        </div></div>
        <div style="height:100px;margin-top:12px"><div data-turn-key="second"><div style="padding:12px;border:1px solid #aaa;border-radius:12px">
          <strong>已编辑 3 个文件</strong><p>output/example/source-file.js +20 -3</p><p>tools/verify-layout.js +18 -2</p>
        </div></div>
      </div></div></div>
      <div id="editor" contenteditable="true">在手机端输入内容</div><button id="send">发送到原始页面</button><p id="result">等待操作</p>
    </main><script>send.onclick=()=>{result.textContent=editor.innerText};</script></body></html>`;
    await client.call('Page.setDocumentContent', { frameId: frameTree.frameTree.frame.id, html: fixtureHtml }, sourceSession);
    bridge = new MirrorBridge(process.env.CBB_TEST_CDP, source.targetId);
    app = await createServer({ localPort: 14889, password: hashPassword('browser-fixture-password') }, bridge);
    const viewer = await client.call('Target.createTarget', { url: 'about:blank' }); targets.push(viewer.targetId);
    const viewerSession = (await client.call('Target.attachToTarget', { targetId: viewer.targetId, flatten: true })).sessionId;
    await client.call('Page.enable', {}, viewerSession);
    await client.call('Runtime.enable', {}, viewerSession);
    const exceptions = [];
    client.on('Runtime.exceptionThrown', (params, sessionId) => { if (sessionId === viewerSession) exceptions.push(params.exceptionDetails.text); });
    await client.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, viewerSession);
    const evaluate = async expression => {
      const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, viewerSession);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async expression => {
      for (let attempt = 0; attempt < 60; attempt++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('Browser condition timed out: '+expression+'; status='+await evaluate('document.getElementById("status")?.textContent'));
    };
    await client.call('Page.navigate', { url: 'http://127.0.0.1:14889' }, viewerSession);
    await until('document.readyState==="complete" && !!document.getElementById("login-form")');
    await evaluate('document.getElementById("password").value="browser-fixture-password";document.getElementById("login-form").requestSubmit();true');
    await until('!!document.getElementById("mirror")?.contentDocument?.getElementById("editor")');
    await until('!!document.getElementById("mirror").contentDocument.querySelector("link")?.sheet');
    assert.equal(await evaluate('document.getElementById("mirror").contentDocument.querySelectorAll("script").length'), 0);
    assert.equal(await evaluate('getComputedStyle(document.getElementById("mirror").contentDocument.body).backgroundColor'), 'rgb(249, 249, 247)');
    const virtualRows = await evaluate('(()=>{const d=document.getElementById("mirror").contentDocument;return [...d.querySelectorAll("[data-cbb-virtual-row]")].map(n=>({height:n.clientHeight,contentHeight:n.scrollHeight,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom}))})()');
    assert.equal(virtualRows.length, 2);
    assert.ok(virtualRows[0].height > 100, 'phone text must grow beyond the cached desktop row height');
    assert.ok(virtualRows[0].bottom <= virtualRows[1].top, 'message rows must not overlap');
    assert.ok(virtualRows.every(row => row.contentHeight <= row.height + 2));
    assert.equal(await bridge.evaluate('document.getElementById("desktop-measured-row").style.height'), '100px', 'mobile adaptation must not change the original desktop DOM');
    assert.equal(await evaluate('document.getElementById("mirror").contentDocument.documentElement.style.getPropertyValue("--qa-original-font")'), '17px');
    await evaluate('(()=>{const e=document.getElementById("mirror").contentDocument.getElementById("editor");e.focus();const r=e.ownerDocument.createRange();r.selectNodeContents(e);const s=e.ownerDocument.getSelection();s.removeAllRanges();s.addRange(r);return true})()');
    await client.call('Input.insertText', { text: '手机输入验证\n操作回传成功' }, viewerSession);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await bridge.evaluate('document.getElementById("editor").innerText') === '手机输入验证\n操作回传成功') break;
      if (attempt === 59) throw new Error('Phone text did not reach the original page');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await evaluate('document.getElementById("mirror").contentDocument.getElementById("send").click();true');
    await until('document.getElementById("mirror").contentDocument.getElementById("result").textContent==="手机输入验证\\n操作回传成功"');
    assert.equal(await bridge.evaluate('document.getElementById("result").textContent'), '手机输入验证\n操作回传成功');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("mirror").contentDocument.querySelector("aside")).position'), 'fixed');
    await evaluate('document.getElementById("sidebar").click();true');
    assert.equal(await evaluate('document.getElementById("mirror").contentDocument.documentElement.getAttribute("data-cbb-drawer")'), 'open');
    await evaluate('document.getElementById("sidebar").click();true');
    assert.deepEqual(exceptions, []);
    if (process.env.CBB_SCREENSHOT) {
      const screenshot = await client.call('Page.captureScreenshot', { format: 'png' }, viewerSession);
      await writeFile(process.env.CBB_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    }
  } finally {
    bridge?.cdp?.close();
    for (const targetId of targets.reverse()) await client.call('Target.closeTarget', { targetId });
    client.close(); if (app) await app.close();
  }
});
