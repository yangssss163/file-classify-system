/**
 * 前台启动 Electron（跨平台，不用 PowerShell），把 app 的输出直接打到当前终端。
 * 这样 `npm run start` / 验收脚本拿到的是同一个启动方式。
 * 用法：node scripts/start-electron.mjs [--no-window]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronExe = require('electron'); // 返回 electron.exe 的绝对路径

const passthrough = process.argv.slice(2);
const child = spawn(electronExe, [projectRoot, ...passthrough], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});

const forward = (sig) => () => {
  try {
    child.kill(sig);
  } catch {
    /* ignore */
  }
};
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
