import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyPassword } from '../security.mjs';

test('first setup is local-only, keeps passwords out of logs, and refuses to overwrite existing state', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'codex-bridge-setup-'));
  const run = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), 'setup'], {
    env: { ...process.env, CBB_STATE: state }, windowsHide: true,
  });
  try {
    const result = await run();
    const configText = await readFile(path.join(state, 'config.json'), 'utf8');
    const password = (await readFile(path.join(state, 'login-password.txt'), 'utf8')).trim();
    const config = JSON.parse(configText);
    assert.equal(config.publicOrigin, '');
    assert.equal(config.certificate, '');
    assert.equal(config.privateKey, '');
    assert.equal(config.cdp, 'http://127.0.0.1:9223');
    assert.equal(verifyPassword(password, config.password), true);
    assert.equal(configText.includes(password), false);
    assert.equal((result.stdout + result.stderr).includes(password), false);
    await assert.rejects(run());
    assert.equal(await readFile(path.join(state, 'config.json'), 'utf8'), configText);
    assert.equal((await readFile(path.join(state, 'login-password.txt'), 'utf8')).trim(), password);
  } finally { await rm(state, { recursive: true, force: true }); }
});
