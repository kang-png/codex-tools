import http from 'node:http';
import https from 'node:https';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MirrorBridge } from './bridge.mjs';
import { SnapshotHistory } from './snapshots.mjs';
import { Sessions, LoginLimiter, hashPassword, verifyPassword, cookieToken, validOrigin } from './security.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const state = process.env.CBB_STATE || path.join(root, 'private');
const configPath = path.join(state, 'config.json');
const compress = promisify(gzip);
if (process.argv[2] === 'setup') {
  await mkdir(state, { recursive: true });
  const password = randomBytes(18).toString('base64url');
  const config = { cdp: 'http://127.0.0.1:9223', localPort: 4788, publicOrigin: '', tlsPort: 18443,
    certificate: '', privateKey: '', targetId: '', password: hashPassword(password) };
  await writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(state, 'login-password.txt'), password + '\n', { flag: 'wx', mode: 0o600 });
  console.log('配置已生成。初始密码保存在 private/login-password.txt，日志不显示密码。');
  process.exit(0);
}

export async function createServer(config, bridge = new MirrorBridge(config.cdp, config.targetId), saveTarget = async () => {}) {
  const sessions = new Sessions();
  const limiter = new LoginLimiter();
  const snapshots = new SnapshotHistory();
  const eventStreams = new Set();
  const origins = [`http://127.0.0.1:${config.localPort}`, `http://localhost:${config.localPort}`, ...(config.publicOrigin ? [config.publicOrigin] : [])];
  const hosts = origins.map(origin => new URL(origin).host);
  const allowedOrigin = origin => origins.some(expected => validOrigin(origin, expected));
  const send = async (request, response, status, data, type = 'application/json; charset=utf-8', extra = {}) => {
    if (response.destroyed) return;
    let body = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...extra };
    if (body.length > 1500 && /gzip/.test(request.headers['accept-encoding'] || '')) { body = await compress(body, { level: 3 }); headers['Content-Encoding'] = 'gzip'; }
    if (response.destroyed) return;
    response.writeHead(status, headers); response.end(body);
  };
  async function bytes(request, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > limit) { const error = new Error('请求过大'); error.status = 413; throw error; } chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function body(request) { return JSON.parse((await bytes(request, 512000)).toString('utf8') || '{}'); }
  async function handle(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    if (request.socket.encrypted) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (!hosts.includes(request.headers.host)) return send(request, response, 403, { error: 'Host 不匹配' });
    const url = new URL(request.url, origins[0]);
    const token = cookieToken(request.headers.cookie);
    const session = sessions.get(token);
    const secure = !!request.socket.encrypted;
    const cookie = value => `cbb_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value ? 43200 : 0}${secure ? '; Secure' : ''}`;
    try {
      if (request.method === 'POST' && !allowedOrigin(request.headers.origin)) return send(request, response, 403, { error: '来源验证失败' });
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const ip = request.socket.remoteAddress;
        if (!limiter.allowed(ip)) return send(request, response, 429, { error: '尝试次数过多，请稍后再试' });
        const data = await body(request);
        if (typeof data.password !== 'string' || data.password.length > 256 || !verifyPassword(data.password, config.password)) {
          limiter.fail(ip); return send(request, response, 401, { error: '密码错误' });
        }
        limiter.clear(ip);
        const newToken = sessions.create();
        return send(request, response, 200, { ok: true }, undefined, { 'Set-Cookie': cookie(newToken) });
      }
      if (url.pathname === '/api/session') return send(request, response, 200, { authenticated: !!session, csrf: session?.csrf });
      if (url.pathname === '/' || url.pathname === '/client.js' || url.pathname === '/shell.css' || url.pathname === '/mobile.css') {
        const names = { '/': ['index.html', 'text/html'], '/client.js': ['client.js', 'text/javascript'], '/shell.css': ['shell.css', 'text/css'], '/mobile.css': ['mobile.css', 'text/css'] };
        const [name, type] = names[url.pathname];
        return send(request, response, 200, await readFile(path.join(root, 'public', name)), `${type}; charset=utf-8`);
      }
      if (!session) return send(request, response, 401, { error: '请先登录' });
      if (request.method === 'POST' && request.headers['x-cbb-csrf'] !== session.csrf) return send(request, response, 403, { error: '会话验证失败' });
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        sessions.delete(token);
        for (const stream of eventStreams) if (stream.token === token) stream.close();
        return send(request, response, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('') });
      }
      if (url.pathname === '/api/events' && request.method === 'GET') {
        await bridge.attach();
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        response.flushHeaders(); response.write('data: changed\n\n');
        const unsubscribe = bridge.onChange(() => { if (!response.destroyed) response.write('data: changed\n\n'); });
        const stream = { token, close: () => { clearInterval(heartbeat); unsubscribe(); eventStreams.delete(stream); response.end(); } };
        const heartbeat = setInterval(() => { if (!sessions.get(token)) stream.close(); else response.write(': keepalive\n\n'); }, 15000);
        heartbeat.unref(); eventStreams.add(stream);
        response.on('close', stream.close);
        return;
      }
      if (url.pathname === '/mirror' && request.method === 'GET') {
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; script-src 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'none'");
        return send(request, response, 200, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>', 'text/html; charset=utf-8');
      }
      if (url.pathname === '/api/targets' && request.method === 'GET') return send(request, response, 200, { targets: await bridge.targets(), selected: bridge.targetId });
      if (url.pathname === '/api/target' && request.method === 'POST') {
        await bridge.select((await body(request)).targetId); await saveTarget(bridge.targetId);
        snapshots.reset();
        return send(request, response, 200, { ok: true });
      }
      if (url.pathname === '/api/snapshot' && request.method === 'GET') {
        const snapshot = await bridge.snapshot(url.searchParams.has('force'));
        if (url.searchParams.get('delta') === '1') return send(request, response, 200, snapshots.response(snapshot, Object.fromEntries(url.searchParams)));
        return send(request, response, 200, snapshot?.revision === Number(url.searchParams.get('revision')) ? { revision: snapshot.revision }
          : { ...snapshot, styleChunks: undefined, ...(snapshot?.cssRevision === url.searchParams.get('cssRevision') ? { css: undefined } : {}) });
      }
      if (url.pathname === '/api/action' && request.method === 'POST') {
        const { view, ...message } = await body(request);
        await bridge.inFlight;
        await bridge.action(message);
        if (view?.delta === true) {
          // Let the source's click handler and queued render commit, without a poll-period delay.
          await new Promise(resolve => setTimeout(resolve, 16));
          await bridge.inFlight;
          const snapshot = snapshots.response(await bridge.snapshot(), view);
          return send(request, response, 200, { ok: true, snapshot });
        }
        return send(request, response, 200, { ok: true });
      }
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        if (request.headers['content-type'] !== 'application/octet-stream') return send(request, response, 415, { error: '附件格式无效' });
        let name = decodeURIComponent(request.headers['x-cbb-filename'] || 'upload');
        name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || 'upload';
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
        const content = await bytes(request, 64 * 1024 * 1024);
        if (!content.length) return send(request, response, 400, { error: '附件为空' });
        const folder = path.join(config.uploadDirectory || path.join(state, 'uploads'), randomUUID());
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const file = path.join(folder, name);
        await writeFile(file, content, { flag: 'wx', mode: 0o600 });
        await bridge.upload([file]);
        return send(request, response, 200, { ok: true, name });
      }
      if (url.pathname.startsWith('/asset/') && request.method === 'GET') {
        const id = url.pathname.slice(7);
        if (!/^[a-f0-9]{64}$/.test(id)) return send(request, response, 404, { error: '资源不存在' });
        const result = await bridge.asset(id);
        return send(request, response, 200, result.content, result.mime, { 'Content-Disposition': 'inline' });
      }
      return send(request, response, 404, { error: '页面不存在' });
    } catch (error) {
      const unavailable = /fetch failed|ECONNREFUSED|调试|未就绪/.test(error.message);
      return send(request, response, error.status || (unavailable ? 503 : 400), { error: unavailable ? 'Codex 调试接口未就绪。请从带调试参数的快捷方式启动 Codex。' : error.message });
    }
  }
  const local = http.createServer(handle);
  const servers = [local];
  let renewalTimer;
  await new Promise(resolve => local.listen(config.localPort, '127.0.0.1', resolve));
  if (config.certificate && config.privateKey) {
    const external = https.createServer({ cert: await readFile(config.certificate), key: await readFile(config.privateKey), minVersion: 'TLSv1.2' }, handle);
    await new Promise(resolve => external.listen(config.tlsPort, '0.0.0.0', resolve));
    servers.push(external);
    if (config.dnsConfigPath && config.pythonExecutable && config.domain && config.dnsZone) {
      let renewing = false;
      renewalTimer = setInterval(async () => {
        if (renewing) return;
        const certificate = new X509Certificate(await readFile(config.certificate));
        if (Date.parse(certificate.validTo) - Date.now() > 30 * 86400000) return;
        renewing = true;
        try {
          await promisify(execFile)(config.pythonExecutable, [path.join(root, 'tls.py'), '--dns-config', config.dnsConfigPath,
            '--domain', config.domain, '--zone', config.dnsZone, '--proxy', config.tlsProxy || ''], { windowsHide: true, timeout: 15 * 60000 });
          external.setSecureContext({ cert: await readFile(config.certificate), key: await readFile(config.privateKey) });
          console.log('HTTPS certificate renewed and reloaded.');
        } catch { console.error('HTTPS certificate renewal failed; see the certificate setup command in README.md.'); }
        finally { renewing = false; }
      }, 12 * 60 * 60 * 1000);
      renewalTimer.unref();
    }
  }
  return { servers, bridge, sessions, close: () => { clearInterval(renewalTimer); bridge.close?.(); for (const stream of eventStreams) stream.close(); return Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const app = await createServer(config, undefined, async targetId => {
    const latest = JSON.parse(await readFile(configPath, 'utf8'));
    latest.targetId = targetId;
    await writeFile(configPath, JSON.stringify(latest, null, 2), 'utf8');
  });
  console.log(`本机入口：http://127.0.0.1:${config.localPort}`);
  console.log(config.certificate ? `HTTPS 入口：${config.publicOrigin}` : '尚未配置 HTTPS，仅监听本机。');
  process.on('SIGINT', async () => { app.bridge.cdp?.close(); await app.close(); process.exit(0); });
}
