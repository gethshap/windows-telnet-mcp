import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test from 'node:test';

const projectRoot = join(import.meta.dirname, '..');
const workerPath = join(projectRoot, 'src', 'windows-console-worker.ps1');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const cmdPath = join(systemRoot, 'System32', 'cmd.exe');
const commonPwsh = join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const windowsPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const pathPwsh = (process.env.PATH || '')
  .split(delimiter)
  .map((directory) => join(directory.replace(/^"|"$/g, ''), 'pwsh.exe'))
  .find((candidate) => existsSync(candidate));
const engines = [
  ...(existsSync(commonPwsh) || pathPwsh
    ? [{ name: 'PowerShell 7', path: existsSync(commonPwsh) ? commonPwsh : pathPwsh }]
    : []),
  ...(existsSync(windowsPowerShell) ? [{ name: 'Windows PowerShell 5.1', path: windowsPowerShell }] : []),
];

function makeWorker(powerShellPath) {
  const child = spawn(powerShellPath, [
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

function isProcessRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(processId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(processId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessRunning(processId);
}

for (const engine of engines) {
  test(`worker controls a real visible Windows console with ${engine.name}`, {
    skip: process.platform !== 'win32' || !existsSync(cmdPath),
    timeout: 30_000,
  }, async () => {
    const worker = makeWorker(engine.path);
    try {
      const launched = await worker.request('launch', {
        clientPath: cmdPath,
        clientArgs: ['/d', '/q', '/k', 'echo VISIBLE CONSOLE READY'],
        title: `Windows Telnet MCP ${engine.name} integration test`,
      });
      assert.equal(launched.visible, true);
      assert.ok(launched.clientPid > 0);
      assert.ok(launched.consoleHostPid > 0);
      await waitForText(worker, 'VISIBLE CONSOLE READY');

      await worker.request('sendText', { text: 'echo CONSOLE_INPUT_WORKED_中文', appendEnter: true });
      const screen = await waitForText(worker, 'CONSOLE_INPUT_WORKED_中文');
      assert.match(screen.text, /CONSOLE_INPUT_WORKED_中文/);

      const closed = await worker.request('close', { force: true });
      assert.equal(closed.closed, true);
    } finally {
      worker.child.stdin.end();
      setTimeout(() => worker.child.kill(), 500).unref();
    }
  });

  test(`worker EOF reaps its console process tree with ${engine.name}`, {
    skip: process.platform !== 'win32' || !existsSync(cmdPath),
    timeout: 30_000,
  }, async () => {
    const worker = makeWorker(engine.path);
    let launched;
    try {
      launched = await worker.request('launch', {
        clientPath: cmdPath,
        clientArgs: ['/d', '/q', '/k', 'echo EOF CLEANUP READY'],
        title: `Windows Telnet MCP ${engine.name} EOF cleanup test`,
      });
      await waitForText(worker, 'EOF CLEANUP READY');

      const workerExited = new Promise((resolve) => worker.child.once('exit', resolve));
      worker.child.stdin.end();
      await workerExited;

      assert.equal(await waitForProcessExit(launched.clientPid), true, 'console client was left running');
      assert.equal(await waitForProcessExit(launched.consoleHostPid), true, 'conhost was left running');
    } finally {
      if (worker.child.exitCode === null) {
        try { await worker.request('close', { force: true }); } catch { /* best-effort cleanup */ }
        worker.child.stdin.end();
        setTimeout(() => worker.child.kill(), 500).unref();
      }
      for (const processId of [launched?.clientPid, launched?.consoleHostPid]) {
        if (processId && isProcessRunning(processId)) {
          try { process.kill(processId); } catch { /* already exited */ }
        }
      }
    }
  });
}
