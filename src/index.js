import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const workerPath = join(sourceDirectory, 'windows-console-worker.ps1');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const telnetPath = join(systemRoot, 'System32', 'telnet.exe');
const conhostPath = join(systemRoot, 'System32', 'conhost.exe');

function findPowerShell() {
  if (process.env.TELNET_MCP_PWSH) return process.env.TELNET_MCP_PWSH;
  const common = join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  if (existsSync(common)) return common;
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, '');
    if (cleanDirectory && existsSync(join(cleanDirectory, 'pwsh.exe'))) return join(cleanDirectory, 'pwsh.exe');
  }
  const windowsPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(windowsPowerShell)) return windowsPowerShell;
  return 'powershell.exe';
}

const powerShellPath = findPowerShell();

class WorkerClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.exited = false;
    this.process = spawn(powerShellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      workerPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk) => this.#onData(chunk));
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-16_384);
    });
    this.process.on('error', (error) => this.#failAll(error));
    this.process.on('exit', (code, signal) => {
      this.exited = true;
      const detail = this.stderr.trim();
      this.#failAll(new Error(
        `Windows console worker exited (code=${code}, signal=${signal}).${detail ? ` ${detail}` : ''}`,
      ));
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.#failAll(new Error(`Worker emitted invalid JSON: ${line.slice(0, 300)}`, { cause: error }));
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'The Windows console worker reported an error.'));
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(op, payload = {}, timeoutMs = 15_000) {
    if (this.exited) return Promise.reject(new Error('Windows console worker is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows console worker timed out during ${op}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  stop() {
    if (this.exited) return;
    this.process.stdin.end();
    setTimeout(() => {
      if (!this.exited) this.process.kill();
    }, 500).unref();
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async start(options) {
    const worker = new WorkerClient();
    const id = randomUUID();
    try {
      const result = await worker.request('launch', {
        clientArgs: buildTelnetArguments(options),
        title: options.title,
      }, 20_000);
      this.sessions.set(id, {
        id,
        worker,
        startedAt: new Date().toISOString(),
        target: options.host ? `${options.host}${options.port ? `:${options.port}` : ''}` : null,
        escapeCharacter: options.escapeCharacter || null,
        ...result,
      });
      return this.publicSession(this.sessions.get(id));
    } catch (error) {
      worker.stop();
      throw error;
    }
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown Telnet session '${id}'. Call telnet_list to see active sessions.`);
    return session;
  }

  publicSession(session) {
    return {
      sessionId: session.id,
      startedAt: session.startedAt,
      target: session.target,
      clientPid: session.clientPid,
      consoleHostPid: session.consoleHostPid,
      windowHandle: session.windowHandle,
      title: session.title,
      visible: session.visible,
    };
  }

  list() {
    return [...this.sessions.values()].map((session) => this.publicSession(session));
  }

  async close(id, force) {
    const session = this.get(id);
    const result = await session.worker.request('close', {
      force,
      escapeCharacter: session.escapeCharacter,
    }, 8_000);
    if (result.closed) {
      session.worker.stop();
      this.sessions.delete(id);
    }
    return result;
  }

  async closeAll() {
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map(async (session) => {
      try {
        await session.worker.request('close', {
          force: true,
          escapeCharacter: session.escapeCharacter,
        }, 8_000);
      } finally {
        session.worker.stop();
        this.sessions.delete(session.id);
      }
    }));
  }
}

function buildTelnetArguments(options) {
  const args = [];
  if (options.autoLogin) args.push('/a');
  if (options.escapeCharacter) args.push('/e', options.escapeCharacter);
  if (options.logFile) args.push('/f', options.logFile);
  if (options.username) args.push('/l', options.username);
  if (options.terminalType) args.push('/t', options.terminalType);
  if (options.host) {
    args.push(options.host);
    if (options.port) args.push(String(options.port));
  }
  return args;
}

function toolResult(data, summary) {
  return {
    content: [{ type: 'text', text: summary || JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function withErrors(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toolError(error);
    }
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const manager = new SessionManager();

function buildServer() {
  const server = new McpServer(
    { name: 'windows-telnet', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool('telnet_check', {
    title: 'Check Windows Telnet prerequisites',
    description: 'Checks whether this machine can open and control a visible Windows Telnet client.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, withErrors(async () => {
    const data = {
      supportedPlatform: process.platform === 'win32',
      telnetInstalled: existsSync(telnetPath),
      telnetPath,
      conhostAvailable: existsSync(conhostPath),
      conhostPath,
      powerShellPath,
      activeSessions: manager.list().length,
    };
    return toolResult(data);
  }));

  server.registerTool('telnet_start', {
    title: 'Start visible Windows Telnet',
    description: 'Opens a real, user-visible conhost.exe window running the built-in Windows telnet.exe. If host is supplied, this initiates an outbound Telnet connection.',
    inputSchema: z.object({
      host: z.string().min(1).max(253).optional().describe('Host name or IP address. Omit to open the Microsoft Telnet prompt without connecting.'),
      port: z.number().int().min(1).max(65_535).optional(),
      terminalType: z.enum(['vt100', 'vt52', 'ansi', 'vtnt']).optional(),
      username: z.string().min(1).max(256).optional(),
      autoLogin: z.boolean().default(false),
      escapeCharacter: z.string().length(1).optional(),
      logFile: z.string().min(1).max(32_767).optional().describe('Optional client-side Telnet log path.'),
      title: z.string().min(1).max(120).default('MCP Windows Telnet'),
    }).refine((value) => !value.port || value.host, {
      message: 'port requires host',
      path: ['port'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, withErrors(async (options) => {
    if (process.platform !== 'win32') throw new Error('This MCP server only supports Windows.');
    const session = await manager.start(options);
    return toolResult(session, `Visible Windows Telnet session started.\n${JSON.stringify(session, null, 2)}`);
  }));

  server.registerTool('telnet_list', {
    title: 'List Telnet sessions',
    description: 'Lists visible Windows Telnet sessions started by this MCP server process.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, withErrors(async () => {
    const data = { sessions: manager.list() };
    return toolResult(data);
  }));

  server.registerTool('telnet_status', {
    title: 'Get Telnet session status',
    description: 'Checks whether a visible Windows Telnet process is still running.',
    inputSchema: z.object({ sessionId: z.string().uuid() }),
    annotations: { readOnlyHint: true },
  }, withErrors(async ({ sessionId }) => {
    const session = manager.get(sessionId);
    const status = await session.worker.request('status');
    return toolResult({ sessionId, ...status });
  }));

  server.registerTool('telnet_read', {
    title: 'Read visible Telnet screen',
    description: 'Reads text from the real Windows console screen buffer. Use mode=visible for exactly what the user can see, or mode=tail for recent buffer rows.',
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      mode: z.enum(['visible', 'tail']).default('visible'),
      rows: z.number().int().min(1).max(500).default(40),
    }),
    annotations: { readOnlyHint: true },
  }, withErrors(async ({ sessionId, mode, rows }) => {
    const session = manager.get(sessionId);
    const screen = await session.worker.request('read', { mode, rows });
    return toolResult({ sessionId, ...screen }, screen.text || '(The Telnet screen is blank.)');
  }));

  server.registerTool('telnet_send', {
    title: 'Type into Windows Telnet',
    description: 'Injects text as real Windows console keyboard events into the visible Telnet session. Set appendEnter=true to submit the line. The text may be transmitted to the remote Telnet server.',
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      text: z.string().max(32_768),
      appendEnter: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, withErrors(async ({ sessionId, text, appendEnter }) => {
    const session = manager.get(sessionId);
    const result = await session.worker.request('sendText', { text, appendEnter }, 30_000);
    return toolResult({ sessionId, ...result }, `Sent ${result.sent} character(s)${result.enterSent ? ' and Enter' : ''} to the visible Telnet session.`);
  }));

  server.registerTool('telnet_key', {
    title: 'Press a key in Windows Telnet',
    description: 'Sends one named key to the visible Telnet console. CTRL+] enters the Microsoft Telnet command prompt.',
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      key: z.enum([
        'ENTER', 'TAB', 'BACKSPACE', 'ESCAPE', 'UP', 'DOWN', 'LEFT', 'RIGHT',
        'DELETE', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN', 'CTRL+]', 'CTRL+C', 'CTRL+BREAK',
      ]),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, withErrors(async ({ sessionId, key }) => {
    const session = manager.get(sessionId);
    const result = await session.worker.request('sendKey', { key });
    return toolResult({ sessionId, ...result }, `Sent ${key} to the visible Telnet session.`);
  }));

  server.registerTool('telnet_wait_for_text', {
    title: 'Wait for Telnet screen text',
    description: 'Polls the real console screen until literal text appears or the timeout expires.',
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      text: z.string().min(1).max(4_096),
      timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
      pollMs: z.number().int().min(50).max(5_000).default(200),
      caseSensitive: z.boolean().default(true),
      rows: z.number().int().min(1).max(500).default(100),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, withErrors(async ({ sessionId, text, timeoutMs, pollMs, caseSensitive, rows }) => {
    const session = manager.get(sessionId);
    const deadline = Date.now() + timeoutMs;
    const needle = caseSensitive ? text : text.toLocaleLowerCase();
    let screen;
    do {
      screen = await session.worker.request('read', { mode: 'tail', rows });
      const haystack = caseSensitive ? screen.text : screen.text.toLocaleLowerCase();
      if (haystack.includes(needle)) {
        return toolResult({ sessionId, matched: true, elapsedMs: timeoutMs - Math.max(0, deadline - Date.now()), ...screen }, screen.text);
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return toolResult({ sessionId, matched: false, timeoutMs, ...screen }, `Timed out after ${timeoutMs} ms waiting for ${JSON.stringify(text)}.\n\n${screen?.text || ''}`);
  }));

  server.registerTool('telnet_focus', {
    title: 'Focus visible Telnet window',
    description: 'Restores and brings the real conhost.exe Telnet window to the foreground.',
    inputSchema: z.object({ sessionId: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, withErrors(async ({ sessionId }) => {
    const session = manager.get(sessionId);
    const result = await session.worker.request('focus');
    return toolResult({ sessionId, ...result });
  }));

  server.registerTool('telnet_close', {
    title: 'Close Windows Telnet session',
    description: 'Closes the visible Telnet session. Graceful mode sends CTRL+], then quit. Force mode closes or terminates the process if necessary.',
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      force: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, withErrors(async ({ sessionId, force }) => {
    const result = await manager.close(sessionId, force);
    return toolResult({ sessionId, ...result });
  }));

  return server;
}

const stdio = serveStdio(buildServer, {
  legacy: 'serve',
  onerror(error) {
    console.error(`[windows-telnet-mcp] ${error.stack || error.message}`);
  },
});

let shutdownPromise;

function shutdown() {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      await manager.closeAll();
      await stdio.close();
    })();
  }
  return shutdownPromise;
}

process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
process.stdin.once('end', () => void shutdown());
