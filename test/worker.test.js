import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { WorkerClient, SessionManager } from '../src/index.js';
import { engines, systemRoot, isProcessRunning, waitForProcessExit } from '../test-support/windows.js';

const projectRoot = join(import.meta.dirname, '..');
const workerPath = join(projectRoot, 'src', 'windows-console-worker.ps1');
const cmdPath = join(systemRoot, 'System32', 'cmd.exe');

function makeWorker(powerShellPath) {
  const worker = new WorkerClient({ executable: powerShellPath, scriptPath: workerPath });
  worker.child = worker.process;
  return worker;
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

for (const engine of engines) {
  test(`shutdown during real worker startup with ${engine.name}`, {
    skip: process.platform !== 'win32' || !existsSync(cmdPath),
    timeout: 15_000,
  }, async () => {
    let worker;
    const manager = new SessionManager({ createWorker() {
      worker = makeWorker(engine.path);
      const request = worker.request.bind(worker);
      worker.request = (op, payload, timeout) => request(op, op === 'launch'
        ? { ...payload, clientPath: cmdPath, clientArgs: ['/d', '/q', '/k'] }
        : payload, timeout);
      return worker;
    } });
    const starting = manager.start({}).then(() => 'started', () => 'cancelled');
    try {
      await manager.closeAll();
      assert.equal(await starting, 'cancelled');
      assert.equal(worker.exited, true);
      assert.equal(isProcessRunning(worker.child.pid), false);
      assert.deepEqual(manager.list(), []);
      assert.equal(manager.workers.size, 0);
    } finally {
      await worker.stop();
    }
  });

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
      await worker.stop();
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
        await worker.stop();
      }
      for (const processId of [launched?.clientPid, launched?.consoleHostPid]) {
        if (processId && isProcessRunning(processId)) {
          try { process.kill(processId); } catch { /* already exited */ }
        }
      }
    }
  });

  for (const scenario of ['client exit', 'worker killed', 'maximum send interrupted', 'read bounds']) {
    test(`${scenario} regression with ${engine.name}`, {
      skip: process.platform !== 'win32' || !existsSync(cmdPath),
      timeout: 30_000,
    }, async () => {
      const worker = makeWorker(engine.path);
      let launched;
      try {
        launched = await worker.request('launch', {
          clientPath: cmdPath,
          clientArgs: ['/d', '/q', '/k', 'echo REGRESSION_READY'],
          title: `Telnet MCP regression: ${scenario} (${engine.name})`,
        });
        await waitForText(worker, 'REGRESSION_READY');
        if (scenario === 'client exit') {
          await worker.request('sendText', { text: 'exit', appendEnter: true });
          assert.equal(await waitForProcessExit(worker.child.pid), true, 'idle worker survived client exit');
        } else if (scenario === 'worker killed') {
          worker.child.kill();
          await worker.closed;
        } else if (scenario === 'maximum send interrupted') {
          const sending = worker.request('sendText', { text: 'x'.repeat(32_768), appendEnter: false }, 30_000)
            .then((result) => ({ result }), (error) => ({ error }));
          await new Promise((resolve) => setTimeout(resolve, 50));
          await worker.stop();
          await sending;
        } else {
          for (let count = 0; count < 15; count++) {
            const screen = await worker.request('read', { mode: 'visible', rows: 100 });
            const width = screen.window.right - screen.window.left + 1;
            for (const line of screen.text.split('\n')) {
              assert.ok(line.length <= width, `read ${line.length} characters from ${width} columns`);
              assert.doesNotMatch(line, /[\u0000-\u0008\u000B-\u001F]/, 'unexpected control character');
            }
          }
          await worker.stop();
        }
        assert.equal(await waitForProcessExit(launched.clientPid), true, 'client was left running');
        assert.equal(await waitForProcessExit(launched.consoleHostPid), true, 'conhost was left running');
      } finally {
        await worker.stop();
        for (const pid of [launched?.clientPid, launched?.consoleHostPid]) {
          if (pid && isProcessRunning(pid)) {
            try { process.kill(pid); } catch { /* already exited */ }
          }
        }
      }
    });
  }
}
