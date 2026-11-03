import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../cdp.mjs';
import { MirrorBridge } from '../bridge.mjs';
import { createServer } from '../server.mjs';
import { hashPassword } from '../security.mjs';

test('sidebar popovers and nested menus fit mobile and return one level without closing navigation', { skip: !process.env.CBB_TEST_CDP, timeout: 30000 }, async () => {
  const c = await connect(process.env.CBB_TEST_CDP), targets = [];
  let app, bridge;
  try {
    const source = await c.call('Target.createTarget', { url: 'about:blank' }); targets.push(source.targetId);
    const sourceSession = (await c.call('Target.attachToTarget', { targetId: source.targetId, flatten: true })).sessionId;
    await c.call('Page.enable', {}, sourceSession);
    const { frameTree } = await c.call('Page.getResourceTree', {}, sourceSession);
    await c.call('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html><html><head><style>
      body{margin:0;display:flex;font:15px system-ui}aside{width:260px;height:100vh;background:#eee}main{padding:20px}button{min-height:32px}
      #row{display:flex;width:240px;height:40px;overflow:hidden;align-items:center}#label{flex:1}.actions{width:0;overflow:hidden}#row:hover .actions{width:24px}.actions button{width:24px}
      .popup{display:none;position:fixed;top:0;left:0;transform:translate(550px,70px);min-width:max-content}.popup>[role]{width:220px;background:white;border:1px solid #aaa;padding:8px}.popup button,[role=menuitem]{display:block;min-height:40px;width:100%}
    </style></head><body><aside data-app-shell-left-panel-appearance="default"><button id="explore" aria-haspopup="dialog" aria-controls="exploreContent"><span id="explore-icon">更多</span></button>
      <div id="row" class="sidebar-item" data-app-action-sidebar-project-row><span id="label">项目</span><div class="actions"><button id="project" aria-label="项目操作" aria-haspopup="menu" aria-controls="rootMenu">…</button></div></div>
      <button id="chat" data-sidebar-destination="thread:fixture">聊天</button>
    </aside><main id="selected">当前聊天</main>
    <div id="explorePopup" class="popup" data-radix-popper-content-wrapper><div id="exploreContent" role="dialog" data-slot="popover-content" data-state="open" tabindex="-1"><button id="popupNav" data-sidebar-destination="builtin:projects">项目</button><button>图像</button><button>设置</button></div></div>
    <div id="rootPopup" class="popup" data-radix-popper-content-wrapper><div id="rootMenu" role="menu" data-state="open" data-overlay-owner="slate-sidebar" tabindex="-1"><button role="menuitem">编辑</button><div id="sub" role="menuitem" aria-haspopup="menu" aria-controls="childMenu" tabindex="0">分区</div></div></div>
    <div id="childPopup" class="popup" data-radix-popper-content-wrapper style="transform:translate(650px,170px)"><div id="childMenu" role="menu" data-state="open" tabindex="-1"><button role="menuitem">分区 A</button><button role="menuitem">分区 B</button></div></div>
    <script>
      explore.onclick=()=>{const open=explorePopup.style.display!=='block';explorePopup.style.display=open?'block':'none';if(open)exploreContent.focus()};
      project.onpointerdown=e=>{const r=project.getBoundingClientRect();window.projectHit=e.isTrusted&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===project;rootPopup.style.display='block';rootMenu.focus()};
      sub.onpointerdown=()=>{childPopup.style.display='block';childMenu.focus()};
      document.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){childPopup.style.display='none';sub.focus()}if(e.key==='Escape'){childPopup.style.display='none';rootPopup.style.display='none';explorePopup.style.display='none'}});
      chat.onclick=()=>selected.textContent='已选择聊天';
      popupNav.onclick=()=>{selected.textContent='项目页';explorePopup.style.display='none'};
    </script></body></html>` }, sourceSession);
    bridge = new MirrorBridge(process.env.CBB_TEST_CDP, source.targetId);
    app = await createServer({ localPort: 14896, password: hashPassword('sidebar-fixture') }, bridge);
    const viewer = await c.call('Target.createTarget', { url: 'about:blank' }); targets.push(viewer.targetId);
    const { sessionId } = await c.call('Target.attachToTarget', { targetId: viewer.targetId, flatten: true });
    await c.call('Page.enable', {}, sessionId);
    await c.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true }, sessionId);
    const evaluate = async expression => {
      const r = await c.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const until = async expression => { for (let i=0;i<120;i++) { if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,40)); }throw new Error('Sidebar condition timed out: '+expression+'; status='+await evaluate('document.getElementById("status").textContent')); };
    const d = 'document.getElementById("mirror").contentDocument';
    const drawer = `${d}.documentElement.hasAttribute('data-cbb-drawer')`;
    await c.call('Page.navigate', { url: 'http://127.0.0.1:14896/' }, sessionId);
    await until('document.readyState==="complete"');
    await evaluate('document.getElementById("password").value="sidebar-fixture";document.getElementById("login-form").requestSubmit();true');
    await until(`!!${d}?.getElementById('project')`);
    await evaluate('document.getElementById("sidebar").click();true');
    await until(drawer);
    await evaluate(`${d}.getElementById('explore-icon').click();true`);
    await until(`${d}.getElementById('explorePopup').hasAttribute('data-cbb-menu-active')`);
    assert.equal(await evaluate(drawer), true, 'opening a sidebar popover must preserve the drawer');
    for (const width of [390,430]) {
      await c.call('Emulation.setDeviceMetricsOverride', { width, height:780,deviceScaleFactor:1,mobile:true }, sessionId);
      const bounds = await evaluate(`(()=>{const n=${d}.getElementById('explorePopup'),r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:n.ownerDocument.defaultView.innerHeight,z:+getComputedStyle(n).zIndex,sidebarZ:+getComputedStyle(${d}.querySelector('[data-cbb-sidebar]')).zIndex}})()`);
      assert.ok(bounds.x>=0&&bounds.right<=width&&bounds.y>=0&&bounds.bottom<=bounds.height&&bounds.z>bounds.sidebarZ);
    }
    await evaluate(`${d}.getElementById('cbb-menu-backdrop').click();true`);
    await until(`!${d}.getElementById('explorePopup').hasAttribute('data-cbb-menu-active') && activeLayer?.kind==='drawer'`);
    assert.equal(await evaluate(drawer), true);
    await evaluate(`${d}.getElementById('explore-icon').click();true`);
    await until(`${d}.getElementById('explorePopup').hasAttribute('data-cbb-menu-active')`);
    await evaluate(`${d}.getElementById('popupNav').click();true`);
    await until(`${d}.getElementById('selected').textContent==='项目页' && !activeLayer`);
    assert.equal(await evaluate(drawer), false, 'navigation from a sidebar popover should close the drawer');
    await evaluate('document.getElementById("sidebar").click();true');
    await evaluate(`${d}.getElementById('project').click();true`);
    await until(`${d}.getElementById('rootPopup').hasAttribute('data-cbb-menu-active')`);
    assert.equal(await bridge.evaluate('window.projectHit'), true, 'hover-hidden source buttons must be revealed before the native click');
    await evaluate(`${d}.getElementById('sub').click();true`);
    await until(`${d}.getElementById('childPopup').hasAttribute('data-cbb-menu-active')`);
    assert.equal(await evaluate(`getComputedStyle(${d}.getElementById('rootPopup')).visibility`), 'hidden');
    await evaluate('history.back();true');
    await until(`${d}.getElementById('rootPopup').hasAttribute('data-cbb-menu-active') && !${d}.getElementById('childPopup').hasAttribute('data-cbb-menu-active')`);
    assert.equal(await evaluate(drawer), true);
    await evaluate('document.getElementById("sidebar").click();true');
    await until(`activeLayer?.kind==='drawer'`);
    await evaluate('history.back();true');
    await until(`!(${drawer}) && !activeLayer`);
    await evaluate('document.getElementById("sidebar").click();true');
    await evaluate(`${d}.getElementById('chat').click();true`);
    await until(`${d}.getElementById('selected').textContent==='已选择聊天'`);
    assert.equal(await evaluate(drawer), false, 'choosing a destination should close the drawer');
  } finally {
    if (app) await app.close();
    for (const targetId of targets.reverse()) await c.call('Target.closeTarget', { targetId });
    c.close();
  }
});
