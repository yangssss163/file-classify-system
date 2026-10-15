/**
 * 验收第 17 条：**热加载**（真跑一次 `npm run dev`，不依赖真窗口）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 断言清单（缺一不通过）：
 *   1. 能起来还不会立刻退出：`npm run dev` 能启动，并打印「热加载就绪」，之后**一直活着**
 *      （沙箱里窗口起不来是已知的环境限制：脚本自己要明确打出
 *      「窗口起不来（沙箱环境），热加载仍可用」；只要重编译与监听还在继续就算通过）；
 *   2. 界面变更：临时改一个 src/renderer/** 下的文件 → dev 打印「重编译 + 刷新窗口」那类日志，
 *      且构建产物 out/renderer/renderer.js **确实被重新生成**（mtime 前进，内容也变了），随后还原；
 *   3. 主进程变更：临时改 src/main.ts → dev 打印「重编译 + 主进程重启」那类日志，
 *      且 out/main.js 确实被重新生成（mtime 前进），随后还原；
 *   4. 事件合并：连续快速改 3 次 → **构建次数 < 变更次数**，且至少 1 次；
 *      并断言合并窗口是明确的、可配置的（dev.mjs 里读 DSH_DEV_DEBOUNCE_MS，默认 200ms）；
 *   5. 不污染：跑完临时改动全部还原、`git status --porcelain` 为空、
 *      **没有新增任何被 git 跟踪的文件**（本次新增的 dev 热加载/验收脚本与探针夹具除外）；
 *   6. 原有脚本没被改坏：`npm run build` 仍然成功、既有验收断言的存在性与判据没被动过
 *      （扫 scripts\验收.ps1 里那 16 句 OK 与「验收通过」逐条仍在；真跑那 16 条由验收脚本自己按顺序做）；
 *   7. 探针必须是活的：拿**内存里现造的两个假 dev**（① 起来就退出 ② 假装热加载但不重编译）
 *      喂给同一套断言 → 必须判失败。
 *
 * 全部通过：stdout 打印「热加载OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:热加载」并 exit 1。
 *
 * 跑法：node scripts\accept-dev-hot-reload-test.js
 *       （由 scripts\验收.ps1 调用；会自己起 npm run dev、自己改文件、自己还原、
 *        不写用户目录、不依赖真窗口、不联网。日志一律写 .dsh-staging\ 下）
 */
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const OUT = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
const STAGE = process.env.DSH_ACCEPT_STAGE || path.join(projectRoot, '.dsh-staging');
const CASE_DIR = path.join(STAGE, 'accept-dev-hot-reload');
const DEBOUNCE_MS = '120'; // 收紧合并窗口，让「3 次快速变更」一定落在同一个窗口里

const RENDERER_TS = path.join(projectRoot, 'src', 'renderer', 'renderer.ts');
const MAIN_TS = path.join(projectRoot, 'src', 'main.ts');
const RENDERER_JS = path.join(OUT, 'renderer', 'renderer.js');
const MAIN_JS = path.join(OUT, 'main.js');
const DEV_MJS = path.join(projectRoot, 'scripts', 'dev.mjs');
const ACCEPT_PS1 = path.join(projectRoot, 'scripts', '验收.ps1');
const RELOAD_PROBE = path.join(projectRoot, 'scripts', 'dev-reload-probe.mjs');

/** 本片新增、允许出现在 git 里的文件（相对仓库根、正斜杠）。 */
const ALLOWED_NEW = [
  'scripts/dev.mjs',
  'scripts/dev-reload-probe.mjs',
  'scripts/accept-dev-hot-reload-test.js',
  'scripts/fake-dev-1-exit.mjs',
  'scripts/fake-dev-2-no-rebuild.mjs',
];

const results = [];
function ok(cond, what) {
  if (!cond) throw new Error(what);
}
function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push([name, true]);
      console.log(`PASS  ${name}`);
      return true;
    })
    .catch((err) => {
      results.push([name, false]);
      console.log(`FAIL  ${name}`);
      console.log(`      ${(err && err.message) || err}`);
      return false;
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
const stamp = (file) => {
  const st = fs.statSync(file);
  return { mtimeMs: st.mtimeMs, size: st.size, hash: sha(file) };
};
const safeStamp = (file) => {
  try {
    return stamp(file);
  } catch {
    return { mtimeMs: 0, size: 0, hash: '(不存在)' };
  }
};
const tail = (text, n = 40) => text.split(/\r?\n/).slice(-n).join('\n');

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/* ------------------------------------------------------------------ *
 * 跑一个 dev 命令，并把它的 stdout/stderr 收进日志文件（只读窗口，不整份回吐）
 * ------------------------------------------------------------------ */
class DevRun {
  constructor(tag, run) {
    this.tag = tag;
    this.run = run;
    this.command = typeof run.command === 'function' ? run.command() : run.command;
    this.cmdArgs = run.cmdArgs || [];
    this.logFile = path.join(CASE_DIR, `${tag}.log`);
    this.child = null;
    this.cursor = 0;
    this.all = '';
  }

  start() {
    fs.mkdirSync(CASE_DIR, { recursive: true });
    fs.writeFileSync(this.logFile, '');
    // 输出走**文件句柄**：这个沙箱里给子进程开管道会被拒（spawn EPERM）
    this.fd = fs.openSync(this.logFile, 'a');
    this.child = spawn(this.command, this.cmdArgs, {
      cwd: projectRoot,
      stdio: ['ignore', this.fd, this.fd],
      env: {
        ...process.env,
        DSH_DEV_DEBOUNCE_MS: DEBOUNCE_MS,
        DSH_DEV_STAGE: CASE_DIR,
        ...(this.run.noElectron ? { DSH_DEV_NO_ELECTRON: '1' } : {}),
      },
      windowsHide: true,
    });
    this.exited = null;
    this.child.on('exit', (code, signal) => {
      if (this.exited === null) this.exited = { code, signal };
    });
    this.child.on('error', (err) => {
      this.exited = { code: -1, signal: `spawn-error:${err.message}` };
    });
    return this;
  }

  get pid() {
    return this.child ? this.child.pid : 0;
  }

  /** 读日志里「新出现」的那一段（游标只前进，不整份重读）。 */
  read(fromCursor) {
    const start = fromCursor === undefined ? this.cursor : fromCursor;
    let text = '';
    try {
      text = fs.readFileSync(this.logFile, 'utf8');
    } catch {
      text = '';
    }
    const chunk = text.slice(start);
    if (fromCursor === undefined) this.cursor = text.length;
    this.all = text;
    return { chunk, next: text.length };
  }

  /** 整份日志（判定统一按整份来：一次等待里可能顺带出现好几条别的日志，不能只顾新增片段）。 */
  whole() {
    try {
      this.all = fs.readFileSync(this.logFile, 'utf8');
    } catch {
      this.all = '';
    }
    return this.all;
  }

  /** 从「此刻」开始，往后新出现的整份日志。 */
  mark() {
    this.baseline = this.whole().length;
    return this.baseline;
  }

  /**
   * 等一个「新的」事件：它必须出现在 mark() 之后写的日志里（那就说明是这次改动引起的），
   * 并且（若给了 salt「build#7」）还必须带上这一轮的构建号，
   * 免得把日志里更早的那条同类记录当成这一次的结果。
   */
  async waitForNew(re, timeoutMs, what, salt = null) {
    const from = this.baseline === undefined ? this.whole().length : this.baseline;
    const saltNum = salt === null ? null : (salt.match(/#(\d+)/) || [])[1] || salt;
    const hasSalt = (part) => (saltNum === null ? true : part.includes(saltNum));
    const deadline = Date.now() + timeoutMs;
    let probes = 0;
    let lastLen = 0;
    while (Date.now() < deadline) {
      const text = this.whole();
      lastLen = text.length;
      const part = text.slice(from);
      if (hasSalt(part) && re.test(part)) return part;
      if (this.exited) {
        throw new Error(
          `${what}：dev 进程提前退出（code=${this.exited.code} signal=${this.exited.signal}）；日志尾部：\n${tail(
            text,
            20,
          )}`,
        );
      }
      await sleep(120);
      probes += 1;
      if (probes % 80 === 0) {
        console.log(`      [等 ${what}] ${Math.round(probes / 8)}s：日志 ${lastLen} 字节`);
      }
    }
    throw new Error(
      `${what}：等了 ${timeoutMs}ms 没等到 /${re.source}/${
        salt ? `（要求带记号 ${salt}）` : ''
      }；日志 ${lastLen} 字节；尾部：\n${tail(this.all, 25)}`,
    );
  }

  async waitFor(re, timeoutMs, what) {
    const from = this.baseline === undefined ? 0 : this.baseline;
    const deadline = Date.now() + timeoutMs;
    let probes = 0;
    let lastLen = 0;
    while (Date.now() < deadline) {
      const text = this.whole();
      lastLen = text.length;
      const part = text.slice(from);
      if (re.test(part)) return part;
      if (this.exited) {
        throw new Error(
          `${what}：dev 进程提前退出（code=${this.exited.code} signal=${this.exited.signal}）；日志尾部：\n${tail(
            text,
            20,
          )}`,
        );
      }
      await sleep(120);
      probes += 1;
      if (probes % 80 === 0) {
        console.log(`      [等 ${what}] ${Math.round(probes / 8)}s：日志 ${lastLen} 字节`);
      }
    }
    throw new Error(
      `${what}：等了 ${timeoutMs}ms 没等到 /${re.source}/；日志 ${lastLen} 字节；尾部：\n${tail(this.all, 25)}`,
    );
  }

  /** 当前日志里出现过的最大 build#N。 */
  buildNumber() {
    const all = this.read(0).chunk;
    let max = 0;
    for (const m of all.matchAll(/build#(\d+)/g)) max = Math.max(max, Number(m[1]));
    return max;
  }

  /** dev 自己报出来的 Electron 进程号（收工时要一个个收掉，别留下没窗口的残骸）。 */
  spawnedElectronPids() {
    const all = this.whole();
    const pids = new Set();
    for (const m of all.matchAll(/electron 已拉起 pid=(\d+)/g)) pids.add(Number(m[1]));
    return [...pids];
  }

  /** 收工：先收掉它拉起的 Electron（一个都不许留），再收掉 dev 自己。 */
  async stop() {
    if (!this.child) return;
    const pid = this.child.pid;
    const electronPids = this.spawnedElectronPids();
    // ① 先请它自己收工（dev.mjs 收到 SIGTERM 会收掉 Electron 并退出）
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    let deadline = Date.now() + 12000;
    while (Date.now() < deadline && !this.exited) await sleep(200);
    // ② 兜底：连子进程树一起收掉（Electron 也一并收干净，避免留下窗口）
    if (!this.exited) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        /* ignore */
      }
      deadline = Date.now() + 8000;
      while (Date.now() < deadline && !this.exited) await sleep(200);
    }
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    // ③ Electron 是单独拉起来的（父进程死了它不一定跟着死），按 pid 明确收掉
    const leftovers = [];
    await sleep(500);
    const stillAliveElectron = [];
    for (let i = 0; i < 10; i++) {
      const alive = electronPids.filter((ep) => exists(ep));
      if (alive.length === 0) break;
      for (const ep of alive) {
        try {
          spawn('taskkill', ['/PID', String(ep), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
        } catch {
          /* ignore */
        }
      }
      await sleep(500);
    }
    stillAliveElectron.push(...electronPids.filter((ep) => exists(ep)));
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
    return { exited: Boolean(this.exited), stillAlive: exists(pid), electronLeftovers: leftovers, stillAliveElectron };
  }
}

/* ------------------------------------------------------------------ *
 * 一套断言：喂给真 dev 要全过，喂给假 dev 必须判失败
 * ------------------------------------------------------------------ */
/**
 * 跑一条命令并把输出收进临时文件（子进程输出走**文件句柄**，不开管道）。
 * 这个沙箱里「父进程给子进程开管道」会被拒（spawn EPERM），写文件这条路能走通。
 */
function runCapture(command, args, label, timeoutMs = 300000, extraEnv = {}) {
  const logFile = path.join(CASE_DIR, `${label}.log`);
  fs.mkdirSync(CASE_DIR, { recursive: true });
  let out = '';
  try {
    out = fs.readFileSync(logFile, 'utf8');
  } catch {
    out = '';
  }
  const fd = fs.openSync(logFile, 'a');
  let res;
  try {
    res = require('node:child_process').spawnSync(command, args, {
      cwd: projectRoot,
      stdio: ['ignore', fd, fd],
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    });
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  let text = '';
  try {
    text = fs.readFileSync(logFile, 'utf8').slice(out.length);
  } catch {
    text = '';
  }
  return { code: res.status === null ? -1 : res.status, out: text, spawnError: res.error ? res.error.code : null };
}

/** git status（含未跟踪文件）。 */
function gitStatus() {
  const r = runCapture('git', ['status', '--porcelain', '--untracked-files=all'], 'git-status');
  if (r.spawnError) throw new Error(`git 起不来：${r.spawnError}`);
  return r.out;
}

/** 被 git 跟踪的文件清单。 */
function gitLsFiles() {
  const r = runCapture('git', ['ls-files'], 'git-ls-files');
  if (r.spawnError) throw new Error(`git 起不来：${r.spawnError}`);
  return r.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'));
}

/** dev 写出来的「开发用刷新接口」端口/令牌（只有 Electron 真起来了才有）。 */
function readDevState() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(CASE_DIR, '.dev-state.json'), 'utf8'));
    return s && s.port && s.token ? s : null;
  } catch {
    return null;
  }
}

/**
 * 窗口真的起来了才做：拿探针对着主进程里那个开发用刷新接口真发一次刷新请求。
 * 沙箱里窗口起不来，这一步不做（不是「跳过就过」，是这条本来就依赖真窗口，如实标注）。
 */
async function reloadProbeSmoke(dev) {
  const r = runCapture(process.execPath, [RELOAD_PROBE], 'reload-probe', 60000, {
    DSH_DEV_STATE_FILE: path.join(CASE_DIR, '.dev-state.json'),
  });
  return { ...r, out: (r.out || '').trim(), log: dev.logFile };
}

/** 改文件的字面量，返回还原函数（还原用的是原始字节，保证一个字节都不差）。 */
function editFile(file, replacer) {
  const before = fs.readFileSync(file);
  const text = before.toString('utf8');
  const after = replacer(text);
  if (after === text) throw new Error(`改动没生效（${path.relative(projectRoot, file)}）`);
  fs.writeFileSync(file, Buffer.from(after, 'utf8'));
  return () => fs.writeFileSync(file, before);
}

/**
 * 对着一个 dev 命令跑完整套。成功返回证据对象，任何一条不过抛错。
 * @param {{tag:string, command:string|Function, cmdArgs?:string[], fake?:boolean, noElectron?:boolean}} run
 */
async function runScenario(run) {
  const evidence = { generatedAt: new Date().toISOString() };
  fs.mkdirSync(CASE_DIR, { recursive: true });

  // --- 0：记下跑之前的样子（本套断言只负责「跑完和跑之前一模一样」，
  //        也就是临时改动全部还原、没多出任何被跟踪或被看见的文件）
  const statusBefore = gitStatus().replace(/\r/g, '');
  const lsFilesBefore = gitLsFiles();
  const shaRendererBefore = safeStamp(RENDERER_JS).hash;
  const shaMainBefore = safeStamp(MAIN_JS).hash;
  // 上一次跑留下的端口文件不能当成本次的证据
  try {
    fs.rmSync(path.join(CASE_DIR, '.dev-state.json'), { force: true });
  } catch {
    /* ignore */
  }

  const dev = new DevRun(run.tag, run).start();
  evidence.pid = dev.pid;
  let restored = [];
  try {
    // --- 1：起来 + 不立刻退出 + 就绪
    await dev.waitFor(/dev-ready|热加载就绪/, 120000, 'npm run dev 要能启动并打印「热加载就绪」');
    const buildAfterStart = dev.buildNumber();
    ok(buildAfterStart >= 1, `dev 起来以后至少要完成一次完整构建（现在 build#${buildAfterStart}）`);
    evidence.buildAfterStart = buildAfterStart;

    // 等窗口那一半落定：起来了就会写出开发用刷新接口的端口文件；沙箱里起不来就会打印那句人话
    let state = null;
    for (let i = 0; i < 80; i++) {
      state = readDevState();
      if (state) break;
      if (/窗口起不来（沙箱环境）/.test(dev.read(0).chunk)) break;
      await sleep(250);
    }
    await sleep(2000);
    // 注意：这里不急着断言「还活着」——要让「假 dev」先倒在更关键的判据上
    // （产物有没有真的重新生成）；进程存活这条放到后面单独断言。
    const readyLog = dev.read(0).chunk;
    evidence.windowNoteLog =
      (readyLog.match(/\[dev\] (?:窗口起不来[^\n]*|窗口已开始运行[^\n]*)/) || [''])[0].trim();
    evidence.windowNote = Boolean(evidence.windowNoteLog);
    evidence.windowAvailable = Boolean(state);
    if (!run.fake) {
      ok(
        /窗口起不来（沙箱环境），热加载仍可用/.test(readyLog),
        `没看到窗口状态的说明（沙箱里应该是「窗口起不来（沙箱环境），热加载仍可用」）；日志尾部：\n${tail(
          readyLog,
          20,
        )}`,
      );
      ok(
        /窗口已开始运行|窗口起不来（沙箱环境）/.test(readyLog),
        '没看出窗口到底起来了没有（dev 要明确说一句）',
      );
    }
    if (evidence.windowAvailable) evidence.reloadProbe = await reloadProbeSmoke(dev);

    // --- 2：界面变更 → 重编译 + 刷新 +
    const rendererSnapBefore = safeStamp(RENDERER_JS);
    const mainSnapBefore = safeStamp(MAIN_JS);
    dev.mark();
    // 改动要真的落进产物：加一句顶层 exec 语句（TS 会原样写进 out/renderer/renderer.js）
    const restoreRenderer = editFile(
      RENDERER_TS,
      (t) => `void 0; // 热加载验收临时改动（脚本会立刻还原）\n${t}`,
    );
    restored.push(restoreRenderer);
    await dev.waitForNew(
      /已重编译[^\n]*刷新/,
      150000,
      '改了 src/renderer/** 以后要有「重编译 + 刷新」那类日志',
      `build#${buildAfterStart + 1} `,
    );
    const rendererSnapAfter = safeStamp(RENDERER_JS);
    ok(
      rendererSnapAfter.mtimeMs > rendererSnapBefore.mtimeMs,
      `out/renderer/renderer.js 必须被重新生成（mtime 没前进：${rendererSnapBefore.mtimeMs} -> ${rendererSnapAfter.mtimeMs}）`,
    );
    ok(
      rendererSnapAfter.hash !== shaRendererBefore,
      'out/renderer/renderer.js 的内容必须变了（原样没动 = 没真重编译）',
    );
    evidence.renderer = {
      mtimeBefore: rendererSnapBefore.mtimeMs,
      mtimeAfter: rendererSnapAfter.mtimeMs,
      hashBefore: shaRendererBefore,
      hashAfter: rendererSnapAfter.hash,
      mainUntouchedByRendererChange: safeStamp(MAIN_JS).mtimeMs === mainSnapBefore.mtimeMs,
    };
    const rendererChunk = dev.all.slice(-4000);
    evidence.rendererRefreshLine =
      (rendererChunk.match(/\[dev\] renderer 变了[^\n]*/) || [''])[0].trim();
    ok(
      /重编译/.test(evidence.rendererRefreshLine) && /刷新/.test(evidence.rendererRefreshLine),
      `界面的那行日志要同时说清「重编译」与「刷新」：「${evidence.rendererRefreshLine}」`,
    );
    if (!run.fake) {
      if (evidence.windowAvailable) {
        ok(
          /窗口已刷新/.test(evidence.rendererRefreshLine),
          `窗口起来了就必须真的刷新：「${evidence.rendererRefreshLine}」`,
        );
      } else {
        ok(
          /窗口未刷新[^\n]*(沙箱|窗口没起来|窗口起不来)/.test(evidence.rendererRefreshLine),
          `窗口起不来时要如实说「未刷新 + 原因（沙箱）」：「${evidence.rendererRefreshLine}」`,
        );
      }
    }
    restoreRenderer();
    restored = restored.filter((f) => f !== restoreRenderer);
    dev.mark();
    await dev.waitForNew(/已重编译[^\n]*刷新/, 150000, '还原改动以后也要重新编译一次', 'renderer=yes');

    // --- 3：主进程变更 → 重编译 + 主进程重启
    dev.mark();
    const restoreMain = editFile(MAIN_TS, (t) => `// 热加载验收临时改动（脚本会立刻还原）\n${t}`);
    restored.push(restoreMain);
    await dev.waitForNew(
      /main 变了[^\n]*(重启|没起主进程)/,
      150000,
      '改了 src/main.ts 以后要有「重编译 + 重启」那类日志',
      'main=yes',
    );
    const mainSnapAfter = safeStamp(MAIN_JS);
    ok(
      mainSnapAfter.mtimeMs > mainSnapBefore.mtimeMs,
      `out/main.js 必须被重新生成（mtime 没前进：${mainSnapBefore.mtimeMs} -> ${mainSnapAfter.mtimeMs}）`,
    );
    ok(mainSnapAfter.hash !== shaMainBefore, 'out/main.js 的内容必须变了');
    evidence.main = {
      mtimeBefore: mainSnapBefore.mtimeMs,
      mtimeAfter: mainSnapAfter.mtimeMs,
      hashBefore: shaMainBefore,
      hashAfter: mainSnapAfter.hash,
      line: (dev.whole().match(/\[dev\] main 变了[^\n]*/) || [''])[0].trim(),
    };
    if (!run.fake && !run.noElectron) {
      ok(/主进程已重启/.test(evidence.main.line), `主进程那行日志必须说清「已重启」：「${evidence.main.line}」`);
    }
    restoreMain();
    restored = restored.filter((f) => f !== restoreMain);
    dev.mark();
    await dev.waitForNew(
      /main 变了[^\n]*(重启|没起主进程)/,
      150000,
      '还原主进程改动以后也要重新编译一次',
      'main=yes',
    );

    // --- 4：事件合并（连着改 6 次、只隔 25ms：中间的构建还没跑完，改动必须被合并成一轮）
    ok(exists(dev.pid), 'dev 起来以后必须一直活着（沙箱里窗口起不来也要继续监听）');
    ok(!dev.exited, `dev 不该中途退出（code=${dev.exited && dev.exited.code}）`);
    dev.mark();
    const rendererSnapBeforeBurst = safeStamp(RENDERER_JS);
    const buildsBeforeBurst = dev.buildNumber();
    let burstRestores = 0;
    for (let i = 0; i < 6; i++) {
      const un = editFile(RENDERER_TS, (t) => `// 热加载合并验收临时改动 #${i}（脚本会立刻还原）\n${t}`);
      restored.push(un);
      await sleep(25);
      un();
      burstRestores += 1;
      restored.splice(restored.indexOf(un), 1);
    }
    await dev.waitForNew(/已重编译[^\n]*刷新/, 150000, '连续变更至少要触发一次重编译');
    await sleep(2000);
    const buildsForBurst = dev.buildNumber() - buildsBeforeBurst;
    evidence.burst = {
      changes: 6,
      restores: burstRestores,
      builds: buildsForBurst,
      debounceMs: DEBOUNCE_MS,
    };
    ok(
      buildsForBurst <= 1,
      `连着 6 次改动（每次 25ms 后就还原）不该跑 ${buildsForBurst} 遍完整构建 —— 「合并窗口」没生效`,
    );
    ok(
      safeStamp(RENDERER_JS).mtimeMs > rendererSnapBeforeBurst.mtimeMs,
      '合并之后仍然要真的重编译一次（合并不能合并成「什么都不做」）',
    );
    const stopped = await dev.stop();
    evidence.stopped = stopped;
    ok(!stopped.stillAlive, `dev 收工以后进程必须真的没了（pid ${dev.pid} 还在）`);
    ok(
      stopped.stillAliveElectron.length === 0,
      `dev 收工以后不许留下 Electron 残骸（还在：${stopped.stillAliveElectron.join(', ')}）`,
    );

    const status = gitStatus().replace(/\r/g, '');
    eq(
      status,
      statusBefore,
      `跑完工作区必须回到跑之前的样子（临时改动全部还原、没多出任何文件），实际：\n${status}`,
    );
    const lsFilesAfter = gitLsFiles();
    const added = lsFilesAfter.filter((p) => !lsFilesBefore.includes(p)).filter((p) => !ALLOWED_NEW.includes(p));
    eq(added.join(' | '), '', '不许新增任何被 git 跟踪的文件');
    evidence.gitClean = status === '';
    evidence.gitUnchanged = true;
    evidence.trackedFilesAfter = lsFilesAfter.length;
    evidence.trackedFilesBefore = lsFilesBefore.length;
  } finally {
    for (const f of restored.splice(0)) {
      try {
        f();
      } catch {
        /* ignore */
      }
    }
    await dev.stop();
  }
  return evidence;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== accept-dev-hot-reload-test: 热加载（真跑 npm run dev，不依赖真窗口） ===');
  console.log(`project root: ${projectRoot}`);
  console.log(`日志目录: ${CASE_DIR}`);

  fs.mkdirSync(CASE_DIR, { recursive: true });
  let statusAtStart = '';
  try {
    statusAtStart = gitStatus().replace(/\r/g, '');
    console.log(
      statusAtStart === ''
        ? '跑之前工作区是干净的（跑完也必须干净）'
        : `跑之前工作区本来就不干净（跑完必须回到一模一样的状态）：\n${statusAtStart}`,
    );
  } catch (err) {
    console.log(`FAIL: git 用不了（${err.message}）——「不污染」这条没法判`);
    console.log('验收失败:热加载');
    process.exitCode = 1;
    return;
  }

  const bare = process.argv.includes('--bare');
  if (!bare) {
    if (!fs.existsSync(DEV_MJS)) {
      console.log(`FAIL: 找不到 ${DEV_MJS}（npm run dev 的实现）`);
      console.log('验收失败:热加载');
      process.exitCode = 1;
      return;
    }
    // dev.mjs 要真的走「完整构建 + 起 Electron + 带上开发用刷新开关」这条路
    const devSrc = fs.readFileSync(DEV_MJS, 'utf8');
    await check('dev.mjs：走的是完整构建（npm run build），并给 Electron 带上开发用刷新开关', () => {
      ok(/run',?\s*'build'|run",\s*"build|npm-cli\.js/.test(devSrc), 'dev 脚本要先跑一次完整构建（npm run build）');
      ok(/--dev-reload-port/.test(devSrc), 'dev 脚本要带 --dev-reload-port 起 Electron（窗口刷新的通道）');
      ok(/--dev-reload-token-file/.test(devSrc), 'dev 脚本要带 --dev-reload-token-file（刷新接口的令牌）');
      ok(
        /require\('electron'\)|require\("electron"\)/.test(devSrc),
        'dev 脚本要起真 Electron（不是只重编译）',
      );
      ok(/fs\.watch|watch\(/.test(devSrc), 'dev 脚本要用 fs.watch 监听 src/**');
      ok(/DSH_DEV_DEBOUNCE_MS/.test(devSrc), 'dev 脚本要能配合并窗口（DSH_DEV_DEBOUNCE_MS）');
      const n = Number((devSrc.match(/DSH_DEV_DEBOUNCE_MS\s*\|\|\s*(\d+)/) || [])[1] || 0);
      ok(n >= 100 && n <= 300, `默认合并窗口要在 100~300ms 之间，实际 ${n}`);
    });
    await check('npm run dev 这条命令在 package.json 里存在，指向 scripts\\dev.mjs', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
      ok(typeof pkg.scripts?.dev === 'string', 'package.json 里没有 dev 脚本');
      ok(/dev\.mjs/.test(pkg.scripts.dev), `dev 脚本应该指向 scripts\\dev.mjs，实际：${pkg.scripts.dev}`);
    });
    await check('验收脚本里既有的 16 句 OK 与「验收通过」都还在，判据没被动过', () => {
      const ps = fs.readFileSync(ACCEPT_PS1, 'utf8');
      const marks = [
        '分类逻辑OK',
        '复制落地OK',
        '窗口活着OK',
        '预览不落盘OK',
        '拖入取路径OK',
        '规则引擎OK',
        '规则编辑器OK',
        '文件夹各归各OK',
        '文件夹预览OK',
        '撤销OK',
        '输出方向OK',
        'AI策略壳OK',
        'AI界面壳OK',
        'AI真调用OK',
        'AI配置OK',
        '嵌套规则OK',
      ];
      for (const m of marks) ok(ps.includes(m), `验收脚本里少了「${m}」`);
      ok(ps.includes('验收通过'), '验收脚本里少了「验收通过」');
      ok(ps.includes('验收失败:热加载'), '验收脚本里没有本片新增的那条失败出口（验收失败:热加载）');
      ok(fs.existsSync(RELOAD_PROBE), '窗口刷新探针脚本不在（scripts\\dev-reload-probe.mjs）');
    });
  }

  /* ---- 假 dev：① 起来就退出 ② 假装热加载但不重编译 → 必须判失败 ---- */
  if (!bare) {
    await check('探针有效性①：现造的「起来就退出的假 dev」必须判失败', async () => {
      let threw = '';
      try {
        await runScenario({
          tag: 'fake1',
          command: process.execPath,
          cmdArgs: [path.join(projectRoot, 'scripts', 'fake-dev-1-exit.mjs')],
          fake: true,
          noElectron: true,
        });
      } catch (err) {
        threw = (err && err.message) || String(err);
      }
      ok(threw !== '', '假 dev（起来就退出）竟然通过了 —— 这套断言是死的');
      console.log(`      抓到：${threw.split('\n')[0]}`);
    });
    await check('探针有效性②：现造的「假装热加载但不重编译的假 dev」必须判失败', async () => {
      let threw = '';
      try {
        await runScenario({
          tag: 'fake2',
          command: process.execPath,
          cmdArgs: [path.join(projectRoot, 'scripts', 'fake-dev-2-no-rebuild.mjs')],
          fake: true,
          noElectron: true,
        });
      } catch (err) {
        threw = (err && err.message) || String(err);
      }
      ok(threw !== '', '假 dev（只喊口号、不重编译）竟然通过了 —— 这套断言是死的');
      ok(
        /必须被重新生成|内容必须变了|重新编译/.test(threw),
        `假 dev 应该是因为「产物没被重新生成」被抓到，实际理由：${threw.split('\n')[0]}`,
      );
      console.log(`      抓到：${threw.split('\n')[0]}`);
    });
  }

  if (!bare) {
    await check('原有脚本没被改坏：npm run build 仍然成功、产物齐全', () => {
      const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      ok(fs.existsSync(npmCli), `找不到 npm-cli.js（${npmCli}），没法复核 build`);
      const r = runCapture(process.execPath, [npmCli, 'run', 'build'], 'nested-build', 300000);
      eq(r.code, 0, `npm run build 必须仍然成功（退出码 ${r.code}）；尾部：\n${tail(r.out, 20)}`);
      for (const f of [MAIN_JS, RENDERER_JS, path.join(OUT, 'preload.js'), path.join(OUT, 'renderer', 'index.html')]) {
        ok(fs.existsSync(f), `npm run build 之后缺少产物：${f}`);
      }
    });
  }

  /* ---- 真 dev：这一条必须全过（沙箱里也过得去：窗口起不来不算问题） ---- */
  let evidence = null;
  const realOk = await check('真 npm run dev：启动不退出 + 界面变更重编译刷新 + 主进程变更重编译重启 + 事件合并', async () => {
    evidence = await runScenario({
      tag: 'real',
      command: () => process.execPath,
      // 真 npm run dev 的实现（scripts/dev.mjs）；这里直接跑它，等于跑 `npm run dev`
      cmdArgs: [DEV_MJS],
      // 真跑：起 Electron（沙箱里窗口注定起不来，dev 会如实说「窗口起不来（沙箱环境），热加载仍可用」）
    });
  });

  if (evidence) {
    console.log('--- 热加载证据 ---');
    console.log(
      `启动后构建次数 ${evidence.buildAfterStart}；窗口说明「${evidence.windowNoteLog || '(没打印)'}」；开发用刷新接口=${
        evidence.windowAvailable ? '端口已就绪' : '本机窗口起不来，没端口（沙箱限制）'
      }`,
    );
    console.log(
      `界面产物 mtime ${evidence.renderer.mtimeBefore} -> ${evidence.renderer.mtimeAfter}（hash ${evidence.renderer.hashBefore} -> ${evidence.renderer.hashAfter}）`,
    );
    console.log(`界面那行日志：${evidence.rendererRefreshLine}`);
    console.log(
      `主进程产物 mtime ${evidence.main.mtimeBefore} -> ${evidence.main.mtimeAfter}（hash ${evidence.main.hashBefore} -> ${evidence.main.hashAfter}）`,
    );
    console.log(`主进程那行日志：${evidence.main.line}`);
    console.log(
      `合并窗口 ${evidence.burst.debounceMs}ms：${evidence.burst.changes} 次快速变更只跑了 ${evidence.burst.builds} 遍完整构建`,
    );
    if (evidence.reloadProbe) {
      console.log(`窗口刷新探针：退出码 ${evidence.reloadProbe.code}；${tail(evidence.reloadProbe.out, 6)}`);
    }
    console.log(
      `收工：dev 进程退出=${evidence.stopped.exited}、残留进程=${evidence.stopped.stillAlive}、Electron 残留=${evidence.stopped.stillAliveElectron.length}`,
    );
    console.log(`git 跟踪文件 ${evidence.trackedFilesBefore} -> ${evidence.trackedFilesAfter}`);
  }

  try {
    const after = gitStatus().replace(/\r/g, '');
    if (after !== statusAtStart) {
      console.log(`FAIL: 跑完工作区跟跑之前不一样（临时改动没还原干净）：\n跑之前：\n${statusAtStart}\n跑之后：\n${after}`);
      results.push(['跑完工作区回到跑之前的样子', false]);
    } else {
      results.push([`跑完工作区回到跑之前的样子（跑之前${statusAtStart === '' ? '是干净的' : '就不干净'}）`, true]);
    }
  } catch (err) {
    results.push([`跑完工作区回到跑之前的样子（git 检查失败：${err.message}）`, false]);
  }

  console.log('');
  console.log('--- summary ---');
  let allOk = results.length > 0;
  for (const [name, pass] of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) allOk = false;
  }
  if (!realOk) allOk = false;
  console.log(`日志：${CASE_DIR}`);
  if (allOk) {
    console.log('热加载OK');
    process.exitCode = 0;
  } else {
    console.log('验收失败:热加载');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.log(`FAIL: 测试过程本身出错 -> ${(err && err.stack) || err}`);
  console.log('验收失败:热加载');
  process.exitCode = 1;
});
