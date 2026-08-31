import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

const projectRoot = join(import.meta.dirname, '..');

function makeServer() {
  const child = spawn(process.execPath, [join(projectRoot, 'src', 'index.js')], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
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
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code) => {
    for (const entry of pending.values()) entry.reject(new Error(`server exited ${code}: ${stderr}`));
    pending.clear();
  });
  return {
    child,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
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
    server.child.stdin.end();
    setTimeout(() => server.child.kill(), 500).unref();
  }
});
