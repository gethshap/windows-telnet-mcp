import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { engines, telnetPath, isProcessRunning, waitForProcessExit } from '../test-support/windows.js';

const projectRoot = join(import.meta.dirname, '..');

function makeServer(env = {}) {
  const child = spawn(process.execPath, [join(projectRoot, 'src', 'index.js')], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stdin.on('error', () => { /* pending calls are rejected on close */ });
  const closed = new Promise((resolve) => child.once('close', resolve));
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
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`server exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  return {
    child,
    closed,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`server timed out: ${method}: ${stderr}`));
        }, 25_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2_000).unref();
      await closed;
      clearTimeout(timer);
    },
  };
}

test('MCP server completes the legacy handshake and exposes Telnet tools', { timeout: 15_000 }, async () => {
  const server = makeServer();
  try {
    const initialized = await server.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'windows-telnet-mcp-test', version: '1.0.0' },
    });
    assert.equal(initialized.serverInfo.name, 'windows-telnet');
    server.notify('notifications/initialized');

    const listed = await server.request('tools/list');
    const names = listed.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'telnet_check',
      'telnet_start',
      'telnet_list',
      'telnet_status',
      'telnet_read',
      'telnet_send',
      'telnet_key',
      'telnet_wait_for_text',
      'telnet_focus',
      'telnet_close',
    ]);

    const checked = await server.request('tools/call', { name: 'telnet_check', arguments: {} });
    assert.equal(checked.isError, undefined);
    assert.equal(typeof checked.structuredContent.telnetInstalled, 'boolean');
  } finally {
    await server.stop();
  }
});

async function initialize(server) {
  await server.request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'telnet-real-client-test', version: '1.0.0' },
  });
  server.notify('notifications/initialized');
}

async function call(server, name, args = {}) {
  const result = await server.request('tools/call', { name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}

// A tiny loopback-only Telnet peer: accept ECHO/SGA, reject other options,
// consume subnegotiation, and acknowledge complete input lines. No credentials
// or external network connections are involved.
async function echoPeer() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let state = 'data', verb = 0, line = '';
    socket.write(Buffer.from([255, 251, 1, 255, 251, 3]));
    socket.write('TELNET_LOOPBACK_READY\r\n');
    socket.on('data', (bytes) => {
      for (const byte of bytes) {
        if (state === 'option') {
          if (verb === 253 && byte !== 1 && byte !== 3) socket.write(Buffer.from([255, 252, byte]));
          if (verb === 251) socket.write(Buffer.from([255, 254, byte]));
          state = 'data';
        } else if (state === 'sub') {
          if (byte === 255) state = 'sub-iac';
        } else if (state === 'sub-iac') {
          state = byte === 240 ? 'data' : 'sub';
        } else if (state === 'iac') {
          if ([251, 252, 253, 254].includes(byte)) { verb = byte; state = 'option'; }
          else state = byte === 250 ? 'sub' : 'data';
        } else if (byte === 255) {
          state = 'iac';
        } else if (byte === 13) {
          socket.write(`\r\nSERVER_ACK:${line}\r\n`);
          line = '';
        } else if (byte !== 0 && byte !== 10) {
          line += String.fromCharCode(byte);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

for (const engine of engines) {
  for (const scenario of ['loopback and graceful close', 'client quit', 'EOF during send', 'MCP killed']) {
    test(`real telnet.exe: ${scenario} with ${engine.name}`, {
      skip: process.platform !== 'win32' || !existsSync(telnetPath),
      timeout: 40_000,
    }, async () => {
      const server = makeServer({ TELNET_MCP_PWSH: engine.path });
      let peer, launched;
      try {
        await initialize(server);
        if (scenario === 'loopback and graceful close') peer = await echoPeer();
        launched = await call(server, 'telnet_start', {
          ...(peer ? { host: '127.0.0.1', port: peer.port } : {}),
          title: `Real Telnet regression: ${scenario} (${engine.name})`,
        });
        assert.equal(launched.visible, true);
        const sessionId = launched.sessionId;
        if (peer) {
          const banner = await call(server, 'telnet_wait_for_text', {
            sessionId, text: 'TELNET_LOOPBACK_READY', timeoutMs: 8_000,
          });
          assert.equal(banner.matched, true, banner.text);
          await call(server, 'telnet_send', { sessionId, text: 'REAL_TELNET_INPUT', appendEnter: true });
          const reply = await call(server, 'telnet_wait_for_text', {
            sessionId, text: 'SERVER_ACK:REAL_TELNET_INPUT', timeoutMs: 8_000,
          });
          assert.equal(reply.matched, true, reply.text);
          const screen = await call(server, 'telnet_read', { sessionId, mode: 'visible', rows: 100 });
          const width = screen.window.right - screen.window.left + 1;
          for (const line of screen.text.split('\n')) {
            assert.ok(line.length <= width);
            assert.doesNotMatch(line, /[\u0000-\u0008\u000B-\u001F]/);
          }
          const closed = await call(server, 'telnet_close', { sessionId, force: false });
          assert.equal(closed.closed, true);
        } else if (scenario === 'client quit') {
          await call(server, 'telnet_send', { sessionId, text: 'quit', appendEnter: true });
          assert.equal(await waitForProcessExit(launched.clientPid), true);
          const deadline = Date.now() + 5_000;
          while ((await call(server, 'telnet_list')).sessions.length && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.deepEqual((await call(server, 'telnet_list')).sessions, []);
        } else if (scenario === 'EOF during send') {
          const sending = server.request('tools/call', {
            name: 'telnet_send', arguments: { sessionId, text: 'x'.repeat(32_768) },
          }).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 50));
          // No test-side kill fallback here: exercise the MCP EOF handler itself.
          server.child.stdin.end();
          assert.equal(await waitForProcessExit(server.child.pid), true, 'MCP failed to exit on EOF');
          await sending;
        } else {
          const sending = server.request('tools/call', {
            name: 'telnet_send', arguments: { sessionId, text: 'x'.repeat(32_768) },
          }).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 50));
          server.child.kill();
          await server.closed;
          await sending;
        }
        assert.equal(await waitForProcessExit(launched.clientPid), true, 'telnet.exe was left running');
        assert.equal(await waitForProcessExit(launched.consoleHostPid), true, 'conhost.exe was left running');
      } finally {
        await server.stop();
        if (peer) await peer.close();
        for (const pid of [launched?.clientPid, launched?.consoleHostPid]) {
          if (pid && isProcessRunning(pid)) {
            try { process.kill(pid); } catch { /* already exited */ }
          }
        }
      }
    });
  }
}
