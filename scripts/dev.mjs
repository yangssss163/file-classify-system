/**
 * npm run dev —— 界面开发的快速循环（热加载）。
 *
 * 用法：
 *   npm run dev                 前台运行：先完整构建一次 → 开窗口 → 监听 src/**
 *   npm run dev -- --no-electron  只做「监听 + 重编译」，不起 Electron（端口/自动化场合用）
 *
 * 行为（人一眼能看懂的那几行日志都带 [dev] 前缀）：
 *   改 src/renderer/** 或静态资源 → 重编译 + **窗口自动刷新**（不重启主进程）
 *     例：[dev] renderer 变了 → 已重编译，窗口已刷新
 *   改 src/main.ts / src/preload.ts / src/shared.ts / src/core/** → 重编译 + **主进程重启**
 *     例：[dev] main 变了 → 已重编译，主进程已重启
 *   连续多次改动会被合并（默认 200ms 静默窗口，可用 DSH_DEV_DEBOUNCE_MS 调），
 *   不会因为编辑器「先删后建」的事件风暴疯狂重编译。
 *
 * 窗口刷新怎么落到窗口里：构建后启动 Electron 时带 `--dev-reload-port 0` 与 `--dev-reload-token-file=...`，
 * 主进程会在 127.0.0.1 上开一个**只在带这两个开关时存在**的开发用本地小接口
 * （见 src/main.ts 里的 startDevReloadBridge），本脚本 POST /dev-reload 让它调 webContents.reloadIgnoringCache()；
 * 那个接口会把「刷新之后的 renderer 进程号」回给本脚本，所以「窗口已刷新」这句话是有回执的。
 * 不带这两个开关时（npm start / 打包以后）主进程一行都不会跑，产品行为一个字都不变。
 * 窗口起不来（沙箱环境里注定起不来：install_dir_access.cc:52 / 0x80000003）时，
 * 明确打印「窗口起不来（沙箱环境），热加载仍可用」并继续监听重编译。
 * 想核实窗口那一半：另开一个终端跑 `node scripts/dev-reload-probe.mjs`，它会真发一次刷新请求并给出结论。
 *
 * 想停：Ctrl+C（终端里），或给它发 SIGTERM（自动化里用这招）。
 * 不引入任何新依赖：只用 node 内置模块（fs / http / child_process）；不新增 package.json 依赖。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const stageDir = process.env.DSH_DEV_STAGE || path.join(root, 'out');
const outDir = path.join(root, 'out');
const stateFile = path.join(stageDir, '.dev-state.json');
const userDataDir = path.join(outDir, '.dev-userdata');

const args = process.argv.slice(2);
// --no-electron（或环境变量 DSH_DEV_NO_ELECTRON=1）：只做「监听 + 重编译」。
// 给自动化用（比如验收第 17 条）：真窗口在沙箱里注定起不来，而「监听 + 重编译」这一半照样要能真跑。
const noElectron = args.includes('--no-electron') || process.env.DSH_DEV_NO_ELECTRON === '1';
const debounceMs = Number(process.env.DSH_DEV_DEBOUNCE_MS || 200) || 200;

const log = (msg) => process.stdout.write(`[dev] ${msg}\n`);

/* ------------------------------------------------------------------ *
 * 改动分类：哪些文件算「界面」，哪些算「主进程」，剩下的不触发重编译
 * ------------------------------------------------------------------ */
function startsWithSeg(p, seg) {
  const n = path.normalize(p);
  return n === seg || n.startsWith(seg + path.sep);
}

function classify(rel) {
  const p = path.normalize(rel);
  if (startsWithSeg(p, path.join('renderer'))) return 'renderer'; // 界面 + 界面静态资源（html/css）
  if (
    startsWithSeg(p, 'core') ||
    p === 'main.ts' ||
    p === 'preload.ts' ||
    p === 'shared.ts'
  ) {
    return 'main';
  }
  return 'none';
}

/* ------------------------------------------------------------------ *
 * 重编译（= npm run build：主进程 CJS + 界面 ES module + 静态资源拷贝）
 * ------------------------------------------------------------------ */
/**
 * 跑一条外部命令，输出**直接写进日志文件**（子进程的 stdout/stderr 用文件句柄，不走管道）。
 * 这样它不会被「不许开管道」的沙箱拦住；终端里也不会被几千行构建输出刷屏。
 */
function runCommand(label, command, cmdArgs, logPath, useShell = false) {
  return new Promise((resolve) => {
    const fd = fs.openSync(logPath, 'a');
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      resolve({ code });
    };
    let child;
    try {
      child = spawn(command, cmdArgs, {
        cwd: root,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        shell: useShell,
      });
    } catch (err) {
      finish(-1);
      fs.appendFileSync(logPath, `\n[dev] ${label} 起不来：${err.message}\n`);
      return;
    }
    child.on('error', (err) => {
      fs.appendFileSync(logPath, `\n[dev] ${label} 起不来：${err.message}\n`);
      finish(-1);
    });
    child.on('exit', (code) => finish(code ?? -1));
  });
}

/**
 * 构建命令：优先用 node 直接跑 npm-cli.js（不经过 npm.cmd 那个批处理壳子，
 * 免得批处理把子进程的报错当成自己的失败）；找不到再退回 shell 里的 npm。
 */
function buildCommand() {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(npmCli)) {
    return { command: process.execPath, args: [npmCli, 'run', 'build'], shell: false };
  }
  return { command: 'npm', args: ['run', 'build'], shell: true };
}

/** 构建日志写文件（不往终端里喷几千行），终端只留结论。 */
const buildLog = path.join(outDir, 'dev-build.log');

let buildCount = 0;
let building = false;
/** 构建期间又来了改动：记下它属于哪一类（界面 / 主进程），构建完再来一轮。 */
let queued = false;
let queuedKinds = { renderer: false, main: false };
/** 监听器句柄（收尾时关掉）。 */
let watcher = null;

async function rebuild(reason, kinds) {
  if (building) {
    queued = true;
    queuedKinds = {
      renderer: queuedKinds.renderer || kinds.renderer,
      main: queuedKinds.main || kinds.main,
    };
    log(`构建进行中，${reason} 的改动先排队（build-pending）`);
    return;
  }
  building = true;
  buildCount += 1;
  const id = buildCount;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    try {
      // 上一次主进程留下的端口/令牌：构建会清 out/，这里也顺手清掉，避免读到过期的
      fs.rmSync(stateFile, { force: true });
    } catch {
      /* 清不掉不影响 */
    }
    fs.appendFileSync(buildLog, `\n===== build#${id} ${new Date().toISOString()} (${reason}) =====\n`);
    const bc = buildCommand();
    const res = await runCommand('build', bc.command, bc.args, buildLog, bc.shell);
    if (res.code !== 0) {
      log(`构建失败 build#${id} exit=${res.code}（完整日志：out/dev-build.log）`);
      log(`构建失败详情：\n${tailOf(buildLog, 12)}`);
      return;
    }
    log(`构建完成 build#${id} renderer=${kinds.renderer ? 'yes' : 'no'} main=${kinds.main ? 'yes' : 'no'}`);
    if (kinds.main) {
      const restarted = await restartElectron();
      log(
        restarted
          ? 'main 变了 → 已重编译，主进程已重启'
          : 'main 变了 → 已重编译（本次没起主进程）',
      );
    } else if (kinds.renderer) {
      const r = await reloadWindow();
      if (r.reloaded) {
        log(`renderer 变了 → 已重编译，窗口已刷新（reload 序号 ${r.rendererId}）`);
      } else {
        log(`renderer 变了 → 已重编译，窗口未刷新：${r.reason}`);
      }
    }
  } finally {
    building = false;
    if (queued) {
      queued = false;
      const nextKinds = queuedKinds;
      queuedKinds = { renderer: false, main: false };
      log('还有排队的改动，接着再来一轮（build-again）');
      // 排队这一轮也要记住「是谁引起的」：不能一律当界面对待，否则主进程改动会被吞掉
      void rebuild(nextKinds.main ? 'main' : 'renderer', nextKinds);
    }
  }
}

/** 取日志尾部若干行（只给窗口，不整份回吐）。 */
function tailOf(file, lines) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Electron：起 / 重启 / 让窗口刷新
 * ------------------------------------------------------------------ */
let electronChild = null;
let electronPid = null;
let electronEverAlive = false;

function spawnElectron() {
  if (noElectron) return;
  const electronExe = require('electron'); // electron.exe 的绝对路径
  electronChild = spawn(
    electronExe,
    [
      root,
      '--dev-reload-port=0',
      `--dev-reload-token-file=${stateFile}`,
      `--user-data-dir=${userDataDir}`,
    ],
    { cwd: root, stdio: 'inherit', windowsHide: false },
  );
  electronPid = electronChild.pid;
  electronEverAlive = false;
  log(`electron 已拉起 pid=${electronPid}（dev-spawn）`);

  // 3 秒后还活着就算「窗口起来了」；起不来（沙箱）就说人话，然后继续监听
  const probe = setTimeout(() => {
    if (electronChild && !electronChild.killed && electronChild.exitCode === null) {
      electronEverAlive = true;
      log('窗口已开始运行（electron 进程还活着）');
    } else {
      log('窗口起不来（沙箱环境），热加载仍可用：改 src/** 照样重编译，只是没法自动刷新真窗口');
    }
  }, 3000);
  probe.unref?.();

  electronChild.on('exit', (code, signal) => {
    log(`electron 退出 code=${code} signal=${signal ?? 'none'}`);
    electronChild = null;
    electronPid = null;
  });
  electronChild.on('error', (err) => {
    log(`electron 起不来（${err.message}），热加载仍可用（重编译照常）`);
    electronChild = null;
    electronPid = null;
  });
}

function killElectron() {
  return new Promise((resolve) => {
    const child = electronChild;
    if (!child) return resolve();
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 4000);
    t.unref?.();
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

async function restartElectron() {
  if (noElectron) return false;
  await killElectron();
  spawnElectron();
  return true;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

/** 让窗口自己刷新：POST 给主进程里那个开发用小接口。 */
function reloadWindow() {
  return new Promise((resolve) => {
    if (noElectron) return resolve({ reloaded: false, reason: '本次是 --no-electron 模式（没起窗口）' });
    if (!electronChild) {
      return resolve({
        reloaded: false,
        reason: electronEverAlive ? '窗口已经关掉了' : '窗口没起来（沙箱环境），热加载仍可用',
      });
    }
    const state = readState();
    if (!state || !state.port) {
      return resolve({ reloaded: false, reason: '主进程还没把开发用小接口的端口写出来' });
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: state.port,
        path: '/dev-reload',
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-length': 0 },
        timeout: 3000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          if (res.statusCode === 200 && parsed && parsed.ok) {
            resolve({ reloaded: true, rendererId: parsed.rendererId, windows: parsed.windows });
          } else {
            resolve({
              reloaded: false,
              reason: `主进程回绝了刷新请求（HTTP ${res.statusCode} ${body.trim().slice(0, 120)}）`,
            });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => resolve({ reloaded: false, reason: `刷新请求发送失败（${err.message}）` }));
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * 监听 src/**（合并窗口见 debounceMs）
 * ------------------------------------------------------------------ */
const pending = new Set();
let timer = null;

function scheduleFromEvents(events) {
  for (const ev of events) {
    const rel = path.relative(srcDir, path.join(srcDir, ev.file));
    const kind = classify(rel);
    if (kind === 'none') continue;
    pending.add(kind);
  }
  if (pending.size === 0) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, debounceMs);
  timer.unref?.();
}

function flush() {
  timer = null;
  if (pending.size === 0) return;
  const kinds = { renderer: pending.has('renderer'), main: pending.has('main') };
  pending.clear();
  const reason = kinds.main ? 'main' : 'renderer';
  void rebuild(reason, kinds);
}

function startWatching() {
  try {
    watcher = fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (classify(rel) === 'none') return;
      scheduleFromEvents([{ event: eventType, file: rel }]);
    });
    watcher.on('error', (err) => {
      log(`监听 src/** 出错了：${err.message} —— 热加载没在生效，请重开 npm run dev`);
    });
    log(`开始监听 src/**（${debounceMs}ms 合并窗口）`);
  } catch (err) {
    watcher = null;
    log(`监听 src/** 失败：${err.message} —— 热加载没在生效；请检查目录权限后重开 npm run dev`);
  }
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */
let stopping = false;
async function shutdown(why) {
  if (stopping) return;
  stopping = true;
  log(`退出（${why}）：收工`);
  try {
    watcher?.close();
  } catch {
    /* ignore */
  }
  await killElectron();
  log('已退出');
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 主流程：先完整构建一次，再开窗口，再监听
 * ------------------------------------------------------------------ */
log(`dev 启动：先做一次完整构建（构建日志写 out/dev-build.log）`);
await rebuild('首次', { renderer: true, main: true });
if (buildCount > 0 && !fs.existsSync(path.join(outDir, 'main.js'))) {
  log('首次构建没产出 out/main.js，以下步骤会失败；先看 out/dev-build.log');
}
spawnElectron();

startWatching();
log('热加载就绪（dev-ready）：改 src/renderer/** → 窗口自动刷新；改 src/main.ts 等 → 主进程重启');
// 停止：Ctrl+C（终端里），或收到 SIGTERM（自动化里用这个）；两条路都会把 Electron 一并收干净。
// 不靠 stdin 的 EOF 来收工：stdin 被接成「空的」时 EOF 会立刻到来（自动化里会误伤）。
process.on('SIGINT', () => void shutdown('Ctrl+C'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('exit', () => {
  try {
    electronChild?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
});
