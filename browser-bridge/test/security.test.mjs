import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, unlink, rmdir } from 'node:fs/promises';
import { hashPassword, verifyPassword, Sessions, cookieToken, validOrigin, LoginLimiter } from '../security.mjs';
import { createServer } from '../server.mjs';

test('password hashing and origin comparison', () => {
  const record = hashPassword('test-password');
  assert.equal(verifyPassword('test-password', record), true);
  assert.equal(verifyPassword('incorrect', record), false);
  assert.equal(cookieToken('other=x; cbb_session=abc; extra=y'), 'abc');
  assert.equal(validOrigin('https://codex.example.com:18443', 'https://codex.example.com:18443'), true);
  assert.equal(validOrigin('https://codex.example.com.evil.example:18443', 'https://codex.example.com:18443'), false);
  assert.equal(validOrigin('null', 'https://codex.example.com:18443'), false);
});

test('uploads require login and CSRF, preserve bytes, and cannot escape their own directory', async () => {
  const qaRoot = path.resolve('private/qa'); await mkdir(qaRoot, { recursive: true });
  const uploadDirectory = await mkdtemp(path.join(qaRoot, 'http-upload-test-'));
  let uploaded;
  const app = await createServer({ localPort: 14892, uploadDirectory, password: hashPassword('upload-fixture') }, { upload: async files => { uploaded = files[0]; } });
  const base = 'http://127.0.0.1:14892';
  const upload = headers => fetch(base+'/api/upload', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/octet-stream', 'X-CBB-Filename': encodeURIComponent('../附件.txt'), ...headers }, body: 'original phone bytes' });
  try {
    assert.equal((await upload({})).status, 401);
    const login = await fetch(base+'/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'upload-fixture' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await (await fetch(base+'/api/session', { headers: { Cookie: cookie } })).json();
    assert.equal((await upload({ Cookie: cookie })).status, 403);
    assert.equal((await upload({ Cookie: cookie, 'X-CBB-CSRF': session.csrf, Origin: 'https://evil.example' })).status, 403);
    const response = await upload({ Cookie: cookie, 'X-CBB-CSRF': session.csrf });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.name, '.._附件.txt');
    assert.ok(uploaded.startsWith(uploadDirectory+path.sep));
    assert.equal(await readFile(uploaded, 'utf8'), 'original phone bytes');
    assert.equal(JSON.stringify(result).includes(uploadDirectory), false);
  } finally {
    await app.close();
    if (!uploadDirectory.startsWith(qaRoot+path.sep)) throw new Error('Upload fixture cleanup escaped QA directory');
    for (const folder of await readdir(uploadDirectory)) { const directory=path.join(uploadDirectory,folder); for (const name of await readdir(directory)) await unlink(path.join(directory,name)); await rmdir(directory); }
    await rmdir(uploadDirectory);
  }
});
test('expired sessions and failed login limits', async () => {
  const sessions = new Sessions(1), token = sessions.create();
  assert.ok(sessions.get(token));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sessions.get(token), null);
  const limiter = new LoginLimiter(2);
  limiter.fail('test'); assert.equal(limiter.allowed('test'), true);
  limiter.fail('test'); assert.equal(limiter.allowed('test'), false);
  limiter.clear('test'); assert.equal(limiter.allowed('test'), true);
});

test('change streams require login, notify without page content, and close on logout', async () => {
  let notify, subscribed = false;
  const fakeBridge = { attach: async () => {}, onChange: listener => { notify = listener; subscribed = true; return () => { subscribed = false; }; } };
  const app = await createServer({ localPort: 14894, password: hashPassword('events-fixture') }, fakeBridge);
  const base = 'http://127.0.0.1:14894', controller = new AbortController();
  try {
    assert.equal((await fetch(base+'/api/events')).status, 401);
    const login = await fetch(base+'/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'events-fixture' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await (await fetch(base+'/api/session', { headers: { Cookie: cookie } })).json();
    const response = await fetch(base+'/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: changed\n\n');
    notify(); assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: changed\n\n');
    const logout = await fetch(base+'/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-CBB-CSRF': session.csrf, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 200); assert.equal((await reader.read()).done, true); assert.equal(subscribed, false);
  } finally { controller.abort(); await app.close(); }
});
test('HTTP authentication, CSRF, asset access, logout, and login rate limit', async () => {
  const config = { localPort: 14888, cdp: 'http://127.0.0.1:1', publicOrigin: 'https://codex.example.com:18443', password: hashPassword('fixture-password') };
  const fakeBridge = { targetId: 'fixture', targets: async () => [], snapshot: async () => ({ revision: 1, tree: { tag: 'body' }, css: 'body{}', cssRevision: 'one' }), action: async () => true, asset: async () => ({ content: Buffer.from('fixture'), mime: 'image/png' }) };
  fakeBridge.select = async targetId => { fakeBridge.targetId = targetId; };
  let savedTarget;
  const app = await createServer(config, fakeBridge, async targetId => { savedTarget = targetId; });
  const base = 'http://127.0.0.1:14888';
  const request = (route, data, extra = {}) => fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: base, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  try {
    assert.equal((await request('/api/snapshot')).status, 401);
    assert.equal((await request('/asset/' + '0'.repeat(64))).status, 401);
    assert.equal((await request('/mirror')).status, 401);
    assert.equal((await request('/api/login', { password: 'fixture-password' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/login', { password: 'wrong' })).status, 401);
    const login = await request('/api/login', { password: 'fixture-password' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const auth = { Cookie: cookie.split(';')[0] };
    const session = await (await request('/api/session', undefined, auth)).json(); assert.ok(session.csrf);
    assert.equal((await request('/api/action', { type: 'click', id: '1' }, auth)).status, 403);
    assert.equal((await request('/api/action', { type: 'click', id: '1' }, { ...auth, 'X-CBB-CSRF': session.csrf, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/action', { type: 'click', id: '1' }, { ...auth, 'X-CBB-CSRF': session.csrf })).status, 200);
    assert.equal((await request('/api/target', { targetId: 'another-window' }, { ...auth, 'X-CBB-CSRF': session.csrf })).status, 200);
    assert.equal(savedTarget, 'another-window');
    const snapshot = await request('/api/snapshot?cssRevision=one', undefined, auth);
    assert.equal((await snapshot.json()).css, undefined); assert.equal(snapshot.headers.get('cache-control'), 'no-store');
    const asset = await request('/asset/' + '0'.repeat(64), undefined, auth);
    assert.equal(asset.status, 200); assert.equal(asset.headers.get('cache-control'), 'no-store');
    const mirror = await request('/mirror', undefined, auth); assert.match(mirror.headers.get('content-security-policy'), /script-src 'none'/);
    assert.equal((await request('/api/logout', {}, { ...auth, 'X-CBB-CSRF': session.csrf })).status, 200);
    assert.equal((await request('/api/targets', undefined, auth)).status, 401);
    for (let count = 0; count < 5; count++) assert.equal((await request('/api/login', { password: 'wrong' })).status, 401);
    assert.equal((await request('/api/login', { password: 'fixture-password' })).status, 429);
    const status = await new Promise((resolve, reject) => { const req = http.get(base + '/api/session', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); });
    assert.equal(status, 403);
  } finally { await app.close(); }
});
