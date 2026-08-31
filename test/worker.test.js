import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const projectRoot = join(import.meta.dirname, '..');
const workerPath = join(projectRoot, 'src', 'windows-console-worker.ps1');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const cmdPath = join(systemRoot, 'System32', 'cmd.exe');
const commonPwsh = join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const pwsh = process.env.TELNET_MCP_PWSH || (existsSync(commonPwsh) ? commonPwsh : 'pwsh.exe');

function makeWorker() {
  const child = spawn(pwsh, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      message.ok ? entry.resolve(message.result) : entry.reject(new Error(message.error));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code) => {
    for (const entry of pending.values()) entry.reject(new Error(`worker exited ${code}: ${stderr}`));
    pending.clear();
  });
  return {
    child,
    request(op, payload = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      });
    },
  };
}

async function waitForText(worker, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let screen;
  while (Date.now() < deadline) {
    screen = await worker.request('read', { mode: 'tail', rows: 80 });
    if (screen.text.includes(expected)) return screen;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${expected}. Last screen:\n${screen?.text}`);
}

test('worker controls a real visible Windows console', {
  skip: process.platform !== 'win32' || !existsSync(cmdPath),
  timeout: 30_000,
}, async () => {
  const worker = makeWorker();
  try {
    const launched = await worker.request('launch', {
      clientPath: cmdPath,
      clientArgs: ['/d', '/q', '/k', 'echo', 'VISIBLE_CONSOLE_READY'],
      title: 'Windows Telnet MCP integration test',
    });
    assert.equal(launched.visible, true);
    assert.ok(launched.clientPid > 0);
    assert.ok(launched.consoleHostPid > 0);
    await waitForText(worker, 'VISIBLE_CONSOLE_READY');

    await worker.request('sendText', { text: 'echo CONSOLE_INPUT_WORKED', appendEnter: true });
    const screen = await waitForText(worker, 'CONSOLE_INPUT_WORKED');
    assert.match(screen.text, /CONSOLE_INPUT_WORKED/);

    const closed = await worker.request('close', { force: true });
    assert.equal(closed.closed, true);
  } finally {
    worker.child.stdin.end();
    setTimeout(() => worker.child.kill(), 500).unref();
  }
});
