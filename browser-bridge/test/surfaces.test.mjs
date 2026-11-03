import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { connect } from '../cdp.mjs';
import { MirrorBridge } from '../bridge.mjs';
import { createServer } from '../server.mjs';
import { hashPassword } from '../security.mjs';

test('phone plus menu, file picker, Shadow DOM review, and return controls', { skip: !process.env.CBB_TEST_CDP }, async () => {
  const qaRoot = path.resolve('private/qa'); await mkdir(qaRoot, { recursive: true });
  const temp = await mkdtemp(path.join(qaRoot, 'surfaces-test-'));
  const input = path.join(temp, 'phone-fixture.txt'), uploads = path.join(temp, 'uploads');
  await writeFile(input, 'phone upload fixture');
  const client = await connect(process.env.CBB_TEST_CDP); const targets = [];
  let app, bridge;
  try {
    const { targetId } = await client.call('Target.createTarget', { url: 'about:blank' }); targets.push(targetId);
    const sourceSession = (await client.call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await client.call('Page.enable', {}, sourceSession);
    const { frameTree } = await client.call('Page.getResourceTree', {}, sourceSession);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;font:15px system-ui}main{padding:24px}button{min-height:32px}#composer{border:1px solid #aaa;padding:16px;margin-top:250px}
      #menu{display:none;position:fixed;left:700px;top:500px;translate:0 -100%;width:700px;--composer-overlay-available-height:600px}
      #menu>div{background:white;border:1px solid #aaa;overflow:auto}#menu button{display:block;width:100%}
      #panel{display:none;position:fixed;right:0;top:0;width:620px;height:100vh;background:white}
    </style></head><body><main>
      <button id="review">查看变更</button><div id="composer" data-codex-composer-root><div contenteditable="true" data-codex-composer="true">draft</div><button id="plus" aria-label="添加文件等内容" data-state="closed">+</button></div>
    </main><div id="menu"><div data-composer-overlay-floating-ui><button id="choose" data-list-navigation-item>文件和文件夹</button>${'<button data-list-navigation-item>插件条目</button>'.repeat(20)}</div></div>
    <aside id="panel" data-app-shell-focus-area="right-panel"><div style="position:absolute;inset:0"><div style="clip-path:none;position:absolute;inset:0"><div style="position:absolute;inset:0;min-width:620px;width:620px">
      <button id="close" data-app-shell-workspace-layout-toggle="main">隐藏标签页</button><h2>变更</h2><button id="options" aria-haspopup="menu"><span id="options-icon">变更选项</span></button><div style="height:500px;overflow:auto"><diffs-container id="diff"></diffs-container></div>
    </div></div></div></aside><div id="floating" data-radix-popper-content-wrapper style="display:none;position:fixed;left:0;top:0;transform:translate(900px,400px);min-width:max-content"><div role="menu" tabindex="-1" style="width:650px;background:white"><button role="menuitem">统一视图</button></div></div><script>
      window.desktopPickerCalls=0;window.shadowClicks=0;
      plus.onclick=()=>{const open=plus.dataset.state!=='open';menu.style.display=open?'flex':'none';plus.dataset.state=open?'open':'closed'};
      document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.style.display='none';plus.dataset.state='closed';floating.style.display='none'}});
      choose.onclick=()=>window.desktopPickerCalls++;
      review.onclick=()=>panel.style.display='block';document.getElementById('close').onclick=()=>panel.style.display='none';
      options.onpointerdown=e=>{window.menuPointerTrusted=e.isTrusted;floating.style.display='block';floating.firstElementChild.focus()};
      composer.ondragover=e=>e.preventDefault();composer.ondrop=e=>{e.preventDefault();for(const file of e.dataTransfer.files){const n=document.createElement('span');n.setAttribute('aria-label',file.name);n.textContent=file.name;composer.append(n)}};
      const root=diff.attachShadow({mode:'open'});const sheet=new CSSStyleSheet();sheet.replaceSync(':host{display:block;max-width:100%}pre{background:rgb(12,34,56);color:white;max-width:100%;overflow:auto}');root.adoptedStyleSheets=[sheet];
      root.innerHTML='<style>button{color:rgb(10,20,30)}</style><pre data-diff><code data-code>+ fixture change\\n- previous line</code></pre><button id="shadowAction">折叠</button>';
      root.getElementById('shadowAction').onclick=()=>{window.shadowClicks++;root.getElementById('shadowAction').textContent='已折叠'};
    </script></body></html>`;
    await client.call('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sourceSession);
    bridge = new MirrorBridge(process.env.CBB_TEST_CDP, targetId);
    app = await createServer({ localPort: 14891, password: hashPassword('surfaces-fixture'), uploadDirectory: uploads }, bridge);
    const viewer = await client.call('Target.createTarget', { url: 'about:blank' }); targets.push(viewer.targetId);
    const session = (await client.call('Target.attachToTarget', { targetId: viewer.targetId, flatten: true })).sessionId;
    await client.call('Page.enable', {}, session);
    await client.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true }, session);
    const evaluate = async (expression, userGesture = false) => {
      const value = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }, session);
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
      return value.result.value;
    };
    const until = async expression => {
      for (let index = 0; index < 100; index++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('Condition timed out: '+expression+'; status='+await evaluate('document.getElementById("status")?.textContent'));
    };
    const d = 'document.getElementById("mirror").contentDocument';
    await client.call('Page.navigate', { url: 'http://127.0.0.1:14891/' }, session);
    await until('document.readyState==="complete" && !!document.getElementById("login-form")');
    await evaluate('document.getElementById("password").value="surfaces-fixture";document.getElementById("login-form").requestSubmit();true');
    await until(`!!${d}?.getElementById("plus")`);
    await evaluate(`${d}.getElementById("plus").click();true`);
    await until(`${d}.getElementById("menu").hasAttribute("data-cbb-composer-menu")`);
    const menu = await evaluate(`(()=>{const e=${d}.getElementById('menu'),r=e.getBoundingClientRect();return{x:r.x,right:r.right,y:r.y,bottom:r.bottom,viewport:e.ownerDocument.defaultView.innerHeight}})()`);
    assert.ok(menu.x >= 0 && menu.right <= 390 && menu.y >= 0 && menu.bottom <= menu.viewport);
    assert.equal(await bridge.evaluate('getComputedStyle(document.getElementById("menu")).left'), '700px');
    await evaluate('history.back();true');
    await until('document.getElementById("layer-title").hidden');
    assert.equal(await bridge.evaluate('document.getElementById("menu").style.display'), 'none');

    await evaluate(`${d}.getElementById("plus").click();true`);
    await until(`${d}.getElementById("choose").hasAttribute("data-cbb-upload-item")`);
    await client.call('Page.setInterceptFileChooserDialog', { enabled: true }, session);
    let chooser;
    const chosen = new Promise(resolve => { chooser = (event, source) => { if (source === session) resolve(event); }; client.on('Page.fileChooserOpened', chooser); });
    await evaluate(`${d}.getElementById("choose").click();true`, true);
    const event = await Promise.race([chosen, new Promise((_, reject) => setTimeout(() => reject(new Error('Phone file chooser did not open')), 5000))]);
    client.off('Page.fileChooserOpened', chooser);
    await client.call('DOM.setFileInputFiles', { files: [input], backendNodeId: event.backendNodeId }, session);
    await until(`!!${d}.querySelector('[aria-label="phone-fixture.txt"]')`);
    assert.equal(await bridge.evaluate('window.desktopPickerCalls'), 0, 'phone upload must not open the desktop file dialog');

    await evaluate(`${d}.getElementById("review").click();true`);
    await until(`${d}.getElementById("panel").hasAttribute("data-cbb-review-panel")`);
    await until(`!!${d}.getElementById("diff").shadowRoot?.querySelector("code")`);
    const panel = await evaluate(`(()=>{const e=${d}.getElementById('panel'),r=e.getBoundingClientRect();return{x:r.x,width:r.width,y:r.y,height:r.height,viewport:e.ownerDocument.defaultView.innerHeight}})()`);
    assert.ok(Math.abs(panel.x) < 1 && Math.abs(panel.width - 390) < 1 && panel.y === 0 && Math.abs(panel.height-panel.viewport) < 1);
    assert.match(await evaluate(`${d}.getElementById("diff").shadowRoot.querySelector("code").textContent`), /fixture change/);
    assert.equal(await evaluate(`getComputedStyle(${d}.getElementById("diff").shadowRoot.querySelector("pre")).backgroundColor`), 'rgb(12, 34, 56)');
    await evaluate(`${d}.getElementById("diff").shadowRoot.getElementById("shadowAction").click();true`);
    for (let index = 0; index < 50 && await bridge.evaluate('window.shadowClicks') !== 1; index++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await bridge.evaluate('window.shadowClicks'), 1, 'shadow controls must reach the original node once');
    await evaluate(`${d}.getElementById("options-icon").click();true`);
    await until(`${d}.getElementById("floating").hasAttribute("data-cbb-floating-menu")`);
    assert.equal(await bridge.evaluate('window.menuPointerTrusted'), true, 'popup triggers must receive the native pointer sequence');
    const floating = await evaluate(`(()=>{const e=${d}.getElementById('floating'),r=e.getBoundingClientRect();return{x:r.x,right:r.right,y:r.y,bottom:r.bottom,viewport:e.ownerDocument.defaultView.innerHeight}})()`);
    assert.ok(floating.x >= 0 && floating.right <= 390 && floating.y >= 0 && floating.bottom <= floating.viewport, 'review menus must fit the phone viewport');
    await evaluate('history.back();true');
    await until(`!${d}.getElementById("floating").hasAttribute("data-cbb-floating-menu") && document.getElementById("layer-title").textContent==="变更"`);
    assert.equal(await bridge.evaluate('document.getElementById("panel").style.display'), 'block', 'closing a review menu must preserve the panel');
    await evaluate('document.getElementById("sidebar").click();true');
    await until('document.getElementById("layer-title").hidden');
    assert.equal(await bridge.evaluate('document.getElementById("panel").style.display'), 'none');
  } finally {
    bridge?.cdp?.close();
    for (const targetId of targets.reverse()) await client.call('Target.closeTarget', { targetId });
    client.close(); if (app) await app.close();
    if (!path.resolve(temp).startsWith(qaRoot + path.sep)) throw new Error('Fixture cleanup path escaped QA directory');
    for (const folder of await readdir(uploads).catch(() => [])) {
      const directory = path.join(uploads, folder);
      for (const name of await readdir(directory)) await unlink(path.join(directory, name));
      await rmdir(directory);
    }
    await rmdir(uploads).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(input); await rmdir(temp);
  }
});
