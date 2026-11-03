"""Run bridge tests against an isolated headless Chromium, then remove its profile."""
import glob
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def browser_path():
    if os.environ.get('CBB_BROWSER'):
        return os.environ['CBB_BROWSER']
    candidates = [shutil.which(name) for name in ('google-chrome', 'chromium', 'chromium-browser', 'msedge')]
    for variable in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'):
        base = os.environ.get(variable)
        if base:
            candidates.extend(str(Path(base) / suffix) for suffix in (
                'Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise SystemExit('Chrome/Edge/Chromium not found. Set CBB_BROWSER to its executable path.')


def main():
    browser = browser_path()
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js 22 or later must be on PATH.')
    with tempfile.TemporaryDirectory(prefix='codex-bridge-tests-') as temporary:
        profile = Path(temporary) / 'profile'
        arguments = [browser, '--headless=new', '--remote-debugging-address=127.0.0.1',
                     '--remote-debugging-port=0', f'--user-data-dir={profile}',
                     '--no-first-run', '--no-default-browser-check', 'about:blank']
        if os.name != 'nt' and os.environ.get('CI'):
            arguments.insert(1, '--no-sandbox')
        options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        process = subprocess.Popen(arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options)
        endpoint = None
        try:
            port_file = profile / 'DevToolsActivePort'
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('The isolated browser exited before its debugging endpoint was ready.')
                if port_file.exists() and port_file.read_text().strip():
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError('The isolated browser did not start within 15 seconds.')
            port = int(port_file.read_text().splitlines()[0])
            environment = os.environ.copy()
            endpoint = f'http://127.0.0.1:{port}'
            environment['CBB_TEST_CDP'] = endpoint
            directory = ROOT / 'browser-bridge'
            tests = sorted(glob.glob('test/*.test.mjs', root_dir=directory))
            return subprocess.run([node, '--test', '--test-concurrency=1', *tests],
                                  cwd=directory, env=environment).returncode
        finally:
            if endpoint and process.poll() is None:
                shutdown = "import { connect } from './cdp.mjs'; const client = await connect(process.argv[1]); await client.call('Browser.close').catch(() => {}); client.close();"
                try:
                    subprocess.run([node, '--input-type=module', '-e', shutdown, endpoint],
                                   cwd=ROOT / 'browser-bridge', stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options)
                else:
                    process.kill()
                process.wait()


if __name__ == '__main__':
    raise SystemExit(main())
