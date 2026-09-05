import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const systemRoot = process.env.SystemRoot || 'C:\\Windows';
export const telnetPath = join(systemRoot, 'System32', 'telnet.exe');
const commonPwsh = join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const windowsPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const pathPwsh = (process.env.PATH || '')
  .split(delimiter)
  .map((directory) => join(directory.replace(/^"|"$/g, ''), 'pwsh.exe'))
  .find((candidate) => existsSync(candidate));

export const engines = [
  ...(existsSync(commonPwsh) || pathPwsh
    ? [{ name: 'PowerShell 7', path: existsSync(commonPwsh) ? commonPwsh : pathPwsh }]
    : []),
  ...(existsSync(windowsPowerShell) ? [{ name: 'Windows PowerShell 5.1', path: windowsPowerShell }] : []),
];

export function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessRunning(pid);
}
