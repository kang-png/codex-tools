import { EventEmitter } from 'node:events';

export class CDP extends EventEmitter {
  constructor(url) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('调试接口连接失败')), { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else this.emit(message.method, message.params, message.sessionId);
    });
    this.socket.addEventListener('close', () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Codex 调试连接已断开'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });
  }
  async call(method, params = {}, sessionId) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调试请求超时：${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { this.socket.close(); }
}

export async function connect(endpoint) {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('CDP 只能连接本机回环地址');
  const response = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('调试接口未就绪');
  const version = await response.json();
  const socketUrl = new URL(version.webSocketDebuggerUrl);
  socketUrl.hostname = url.hostname;
  const client = new CDP(socketUrl.href);
  await client.ready;
  return client;
}
