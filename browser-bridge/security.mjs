import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}
export function verifyPassword(password, record) {
  const candidate = scryptSync(password, record.salt, 32);
  const expected = Buffer.from(record.hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
export class Sessions {
  constructor(ttl = 12 * 60 * 60 * 1000) { this.ttl = ttl; this.values = new Map(); }
  create() {
    this.prune();
    const token = randomBytes(32).toString('base64url');
    this.values.set(token, { expires: Date.now() + this.ttl, csrf: randomBytes(24).toString('base64url') });
    return token;
  }
  get(token) {
    const session = this.values.get(token);
    if (session && session.expires > Date.now()) return session;
    this.values.delete(token); return null;
  }
  prune() { for (const [token, item] of this.values) if (item.expires <= Date.now()) this.values.delete(token); }
  delete(token) { this.values.delete(token); }
}
export class LoginLimiter {
  constructor(max = 5, windowMs = 15 * 60 * 1000) { this.max = max; this.windowMs = windowMs; this.values = new Map(); }
  allowed(ip) { const entry = this.values.get(ip); return !entry || entry.until <= Date.now() || entry.count < this.max; }
  fail(ip) {
    for (const [key, entry] of this.values) if (entry.until <= Date.now()) this.values.delete(key);
    const entry = this.values.get(ip) || { count: 0, until: Date.now() + this.windowMs };
    entry.count++; this.values.set(ip, entry);
  }
  clear(ip) { this.values.delete(ip); }
}
export function cookieToken(header = '') {
  return header.split(';').map(x => x.trim()).find(x => x.startsWith('cbb_session='))?.slice(12) || '';
}
export function validOrigin(origin, configured) {
  try { return new URL(origin).origin === new URL(configured).origin; } catch { return false; }
}
