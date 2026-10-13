/**
 * 验收第 13 条：**AI 界面壳**（界面接线，不依赖真窗口）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 做法与第 5/7/9/11 条同一套：**把编译产物当脚本在窗口式桩里真执行**
 * （真 ES module 作用域 vm.SourceTextModule，绝不退化成字符串匹配），
 * 并且真造临时目录与文件，落盘效果逐条核对。
 *
 * 断言清单（缺一不通过）：
 *   1. 界面上有常显的「AI 分类：未配置」状态（不用点按钮就能看出现在只有规则分类可用）；
 *   2. 桩里让「上一次整理可撤销」：点「换一种分法：AI 分类」→
 *      **先撤销、后 AI**（调用序列里「撤销」在「AI 分类」之前）；
 *      撤销后 AI 返回「未配置」→ 界面显示那句人话（同时含「已撤销」与「AI 分类还没配置」两层信息）；
 *      **输出目录里那份被真的撤掉了**（真造临时目录与文件）、**源文件一个没动**（内容也一致）；
 *   3. 再点一次（已撤销状态）→ 只给提示、**不删任何东西**、AI 接口**不再被调用**（真查磁盘：输出里那份回不来、也没多东西）；
 *   4. 让撤销接口**返回失败**（有文件删不掉）→ 断言**没有**继续调用 AI 接口，并且界面如实显示撤销报告；
 *   5. 探针有效性自检：拿内存里现造的「点按钮先调 AI、后撤销」的产物喂给第 2 条那套断言，**必须判失败**；
 *      真产物用同一套断言必须通过。
 *
 * 全部通过：stdout 打印「AI界面壳OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:AI界面壳」并 exit 1。
 *
 * 跑法：node --experimental-vm-modules scripts\accept-ai-ui-test.js
 *       （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 *       记录一律走临时路径，绝不碰用户 userData 下的真实记录与规则文件。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const OUT = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
const RENDERER_JS = path.join(OUT, 'renderer', 'renderer.js');
const RENDERER_TS = path.join(projectRoot, 'src', 'renderer', 'renderer.ts');
const HTML = path.join(OUT, 'renderer', 'index.html');
const PRELOAD_JS = path.join(OUT, 'preload.js');
const MAIN_JS = path.join(OUT, 'main.js');
const core = require(path.join(OUT, 'core', 'index.js'));

const uncaught = [];
process.on('uncaughtException', (err) => {
  uncaught.push(`uncaughtException: ${(err && err.message) || err}`);
});
process.on('unhandledRejection', (reason) => {
  uncaught.push(`unhandledRejection: ${(reason && reason.message) || reason}`);
});

const results = [];
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

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

const readText = (p) => fs.readFileSync(p, 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) await flush();
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (let i = 0; i < 10; i++) await flush();
}

/* ------------------------------------------------------------------ *
 * 小工具（与第 11 条同一套）
 * ------------------------------------------------------------------ */

function countTree(root) {
  const acc = { files: 0, dirs: 0 };
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        acc.dirs++;
        visit(path.join(dir, e.name));
      } else {
        acc.files++;
      }
    }
  };
  visit(root);
  return acc;
}

function listFiles(root) {
  const out = [];
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full);
      else out.push(path.relative(root, full));
    }
  };
  visit(root);
  return out.sort();
}

function makeSource(base, spec) {
  fs.mkdirSync(base, { recursive: true });
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return base;
}

/* ------------------------------------------------------------------ *
 * 最小 DOM 桩（与第 5/7/9/11 条同一套形状）
 * ------------------------------------------------------------------ */

function makeElement(id) {
  const el = {
    id: id || '',
    tagName: 'DIV',
    className: '',
    scrollTop: 0,
    scrollHeight: 0,
    disabled: false,
    value: '',
    type: '',
    checked: false,
    style: {},
    children: [],
    listeners: new Map(),
    attrs: new Map(),
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
      toggle(c, force) {
        const want = force === undefined ? !this._set.has(c) : !!force;
        if (want) this._set.add(c);
        else this._set.delete(c);
        return want;
      },
    },
    setAttribute(name, value) {
      this.attrs.set(name, String(value));
    },
    getAttribute(name) {
      return this.attrs.has(name) ? this.attrs.get(name) : null;
    },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this.listeners.get(type) || [];
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
    dispatch(type, event) {
      const list = (this.listeners.get(type) || []).slice();
      for (const h of list) h(event === undefined ? { preventDefault() {} } : event);
      return list.length;
    },
  };

  let _text = '';
  Object.defineProperty(el, 'textContent', {
    get() {
      return _text;
    },
    set(v) {
      _text = v === undefined || v === null ? '' : String(v);
      if (_text === '') el.children.length = 0;
    },
    enumerable: true,
  });

  return el;
}

function textOf(root) {
  let out = String(root.textContent || '');
  for (const child of root.children || []) out += `\n${textOf(child)}`;
  return out;
}

/** 把一个界面产物真跑一遍：真 ES module 作用域 + 窗口式桩。 */
async function runInWindowStub(source, label, organizer, confirmAnswer) {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('node was started without --experimental-vm-modules, so a real ES-module scope cannot be built');
  }
  const elements = new Map();
  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement(tag) {
      const e = makeElement('');
      e.tagName = String(tag).toUpperCase();
      return e;
    },
  };
  const windowEl = makeElement('window');
  const confirmCalls = [];
  const windowStub = {
    organizer,
    confirm(msg) {
      confirmCalls.push(String(msg));
      return confirmAnswer === true;
    },
    addEventListener(type, handler) {
      windowEl.addEventListener(type, handler);
    },
    removeEventListener(type, handler) {
      windowEl.removeEventListener(type, handler);
    },
  };

  const globalBefore = { window: global.window, document: global.document };
  global.window = windowStub;
  global.document = documentStub;
  const before = uncaught.length;
  let error = null;
  let restoreCalled = false;
  const restore = () => {
    if (restoreCalled) return;
    restoreCalled = true;
    global.window = globalBefore.window;
    global.document = globalBefore.document;
  };

  try {
    const mod = new vm.SourceTextModule(source, { identifier: label });
    await mod.link(() => {
      throw new Error(`${label} must not import anything at load time`);
    });
    await mod.evaluate();
    await flush();
    if (uncaught.length > before) error = `uncaught: ${uncaught.slice(before).join(' | ')}`;
  } catch (err) {
    error = `${err.constructor.name}: ${err.message}`;
  }
  return { error, elements, windowStub, windowEl, confirmCalls, restore };
}

/* ------------------------------------------------------------------ *
 * 假 window.organizer：撤销用**真的 core/runRecord** 干活（所以磁盘上的效果是真的），
 * AI 那两件事按场景给答案（这一片 AI 不许联网，所以桩里也只能「回话」）。
 * 调用序列记在 `state.sequence` 里 —— 「先撤销、后 AI」就是靠它判的。
 * ------------------------------------------------------------------ */

function makeOrganizer(opts) {
  const o = opts || {};
  const state = {
    sequence: [],
    undoCalls: 0,
    aiCalls: [],
    aiStatusCalls: 0,
    lastRunCalls: 0,
    organizeCalls: 0,
    pickOutputCalls: 0,
    pendingRoots: [],
    aiResult: o.aiResult || {
      ok: false,
      reason: 'not-configured',
      message: 'AI 分类还没配置，先按规则分类；到设置里填接口与密钥后可用（下一版做）',
    },
    aiStatus: o.aiStatus || { configured: false, label: 'AI 分类：未配置', message: 'AI 分类还没配置，先按规则分类。' },
    undoOutcome: o.undoOutcome || null,
    lastRunOverride: o.lastRun || null,
  };
  const knownFiles = new Set((o.files || []).map((f) => String(f)));
  const knownRoots = (o.roots || []).map((r) => String(r));
  const lower = (s) => String(s).toLowerCase();

  const realLastRun = () =>
    o.recordPath && fs.existsSync(o.recordPath)
      ? core.summarizeLastRun(core.loadRunRecord(o.recordPath))
      : core.summarizeLastRun(null);

  const api = {
    pathForFile: (file) => (file && file.__path) || null,
    pickFiles: async () => [],
    pickFolders: async () => [],
    pickOutputDir: async () => {
      state.pickOutputCalls++;
      return o.outputDir || null;
    },
    exists: async (paths) => {
      const map = {};
      for (const p of paths || []) {
        const isFile = [...knownFiles].some((f) => lower(f) === lower(p));
        const isDir = knownRoots.some((r) => lower(p) === lower(r) || lower(p).startsWith(`${lower(r)}\\`));
        map[p] = isFile ? true : isDir ? false : false;
      }
      return map;
    },
    expand: async (list) => core.expandFolders(list),
    setSourceRoots: async (list) => {
      state.pendingRoots = list === null || list === undefined ? [] : Array.from(list);
      return true;
    },
    preview: async (fileList, outputDir, rules) =>
      core.buildPreviewTree({ files: fileList, roots: state.pendingRoots.slice(), outputDir, rules: rules || null }),
    organize: async (fileList, outputDir, rules, rootList) => {
      state.organizeCalls++;
      return core.copyFiles({
        files: fileList,
        roots: rootList,
        outputDir,
        rules: rules || null,
        recordPath: o.recordPath || null,
      });
    },
    openPath: async () => '',
    loadRules: async () => ({ ok: true, rules: [], source: 'default', message: 'stub', filePath: 'stub' }),
    saveRules: async () => ({ ok: true, message: 'stub', filePath: 'stub' }),
    rulesPath: async () => 'stub',
    checkOutputDirection: async (input) =>
      core.checkOutputDirection({
        roots: (input && input.roots) || [],
        files: (input && input.files) || [],
        outputDir: (input && input.outputDir) || '',
      }),
    /** 上一次整理的摘要：默认按真记录算，场景可以覆盖 */
    lastRun: async () => {
      state.lastRunCalls++;
      if (state.lastRunOverride) return state.lastRunOverride;
      return realLastRun();
    },
    /** 撤销：默认真调 core.undoLastRun（所以磁盘效果是真的）；场景可以给一个「失败」的报告 */
    undoLastRun: async () => {
      state.undoCalls++;
      state.sequence.push('undo');
      if (state.undoOutcome) return state.undoOutcome;
      const recordPath = o.recordPath || null;
      if (!recordPath) {
        return { result: core.undoLastRun(''), summary: realLastRun() };
      }
      const result = core.undoLastRun(recordPath);
      return { result, summary: realLastRun() };
    },
    /** 界面上那行常显状态 */
    aiStatus: async () => {
      state.aiStatusCalls++;
      return state.aiStatus;
    },
    /** 「换一种分法」的 AI 分类那一调（这一片只回话，不联网络） */
    aiClassify: async (filePaths, outputDir) => {
      state.aiCalls.push({ filePaths: Array.from(filePaths || []), outputDir: outputDir ?? null });
      state.sequence.push('ai');
      return state.aiResult;
    },
    onProgress: () => {},
  };
  return { api, state };
}

/** 模拟拖入一个文件夹（界面用 api.pathForFile 取路径）。 */
function dropFolder(run, folderPath) {
  const el = run.elements.get('drop');
  const file = { name: path.basename(folderPath) };
  Object.defineProperty(file, '__path', { value: folderPath, enumerable: true });
  el.dispatch('drop', { preventDefault() {}, dataTransfer: { files: [file] } });
}

/* ------------------------------------------------------------------ *
 * 场景跑法：造源文件夹 → 拖入 → 选输出 → 点「开始整理」（真复制、真落记录）
 * → 点「换一种分法：AI 分类」（这一步是这一条要验的）。
 * ------------------------------------------------------------------ */

async function startScenario(ctx, productSource, label, scenario) {
  const s = scenario || {};
  const { api, state } = makeOrganizer({
    files: ctx.files,
    roots: ctx.roots,
    outputDir: ctx.outputDir,
    recordPath: ctx.recordPath,
    aiResult: s.aiResult,
    aiStatus: s.aiStatus,
    undoOutcome: s.undoOutcome,
    lastRun: s.lastRun,
  });
  const run = await runInWindowStub(productSource, label, api, s.confirm !== false);
  const out = { run, state, error: run.error, problems: [], aiNotice: [], aiStatus: [] };
  // 注意：桩**不能**在这里 restore —— 点按钮之后界面还要继续跑（点完才看得到结果）。
  // 由调用方在「所有 await 都结束」之后再调 seen.close()。
  out.close = () => run.restore();
  if (run.error) {
    out.problems.push(`execution failed: ${run.error}`);
    return out;
  }
  try {
    out.aiStatus.push(String((run.elements.get('ai-status') || {}).textContent || ''));
    if (s.clickStart !== false) {
      dropFolder(run, ctx.root);
      await settle(20);
      const pickOut = run.elements.get('pick-out');
      if (!pickOut) out.problems.push('element never looked up: #pick-out');
      else pickOut.dispatch('click', { preventDefault() {} });
      await settle(20);
      const startBtn = run.elements.get('start');
      if (!startBtn) out.problems.push('element never looked up: #start');
      else startBtn.dispatch('click', { preventDefault() {} });
      await settle(60);
    }
    return out;
  } catch (err) {
    out.problems.push(`scenario setup failed: ${(err && err.message) || err}`);
    return out;
  }
}

/** 点一次「换一种分法：AI 分类」，并把点完的界面文字收下来。 */
async function clickAiReclassify(seen) {
  const btn = seen.run.elements.get('ai-reclassify');
  if (!btn) {
    seen.problems.push('element never looked up: #ai-reclassify');
    return seen;
  }
  btn.dispatch('click', { preventDefault() {} });
  await settle(60);
  seen.aiNotice.push(String((seen.run.elements.get('ai-notice') || {}).textContent || ''));
  seen.aiStatus.push(String((seen.run.elements.get('ai-status') || {}).textContent || ''));
  seen.undoReportText = seen.run.elements.get('undo-report') ? textOf(seen.run.elements.get('undo-report')) : '';
  seen.undoHintText = String((seen.run.elements.get('undo-hint') || {}).textContent || '');
  seen.aiDisabled = btn.disabled === true;
  return seen;
}

/** 「造场 → 点按钮 → 收结果」的完整一趟（桩由调用方在断言之后 close）。 */
async function runAiClickScenario(ctx, renderer, label, scenario) {
  const seen = await startScenario(ctx, renderer, label, scenario);
  const copied = listFiles(ctx.outputDir);
  seen.__before = {
    copiedFile:
      copied.length > 0 ? path.join(ctx.outputDir, ...copied[0].split(path.sep)) : path.join(ctx.outputDir, '输出里没有这份'),
    srcFile: ctx.srcFile,
    srcContent: readText(ctx.srcFile),
    srcTree: countTree(ctx.src),
  };
  await clickAiReclassify(seen);
  return seen;
}

/* ------------------------------------------------------------------ *
 * 造「先调 AI、后撤销」的产物：把 AI 那一块**整块搬到撤销之前**（只用内存字符串替换，其它照旧）。
 * 用来反证这一条的探针是活的。
 * ------------------------------------------------------------------ */
function aiBeforeUndo(source) {
  // 把两个接口调用的**先后**换过来（只换这一句，别的一律照旧）：
  // 换完之后，点按钮时「AI 分类」先被调到、并且它成功后直接结束，撤销那一块成了够不到的代码。
  const undoCall = 'outcome = (await api.undoLastRun());';
  const aiCall = 'ai = (await api.aiClassify(collectFiles(), outputDir));';
  if (!source.includes(undoCall) || !source.includes(aiCall)) return source;
  const TOKEN_A = '__PROBE_UNDO_CALL__';
  const TOKEN_B = '__PROBE_AI_CALL__';
  let out = source.replace(undoCall, TOKEN_A).replace(aiCall, TOKEN_B);
  out = out.replace(
    TOKEN_A,
    // 撤销那一句被搬到 AI 的位置上：并明写「先调 AI 就直接结束」这道闸
    `${aiCall}\n        if (ai?.ok !== true) { return; }`,
  );
  out = out.replace(TOKEN_B, undoCall);
  return out;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** 第 2 条那套断言：「先撤销、后 AI 」+ 人话 + 磁盘效果。真产物与「顺序反了」的产物都喂给它。 */
function assertUndoBeforeAi(seen, ctx, label) {
  const before = seen.__before;
  ok(seen.problems.length === 0, `${label}：${seen.problems.join(' | ')}`);
  ok(seen.state.undoCalls === 1, `${label}：撤销接口应当正好被调到 1 次，实际 ${seen.state.undoCalls} 次`);
  ok(seen.state.aiCalls.length === 1, `${label}：AI 接口应当正好被调到 1 次，实际 ${seen.state.aiCalls.length} 次`);
  const seq = seen.state.sequence.join('→');
  const iUndo = seen.state.sequence.indexOf('undo');
  const iAi = seen.state.sequence.indexOf('ai');
  ok(iUndo >= 0 && iAi >= 0, `${label}：调用序列里缺一环（${seq}）`);
  ok(iUndo < iAi, `${label}：顺序错了 —— 必须先「撤销」后「AI 分类」，实际序列是 ${seq}`);
  eq(seen.state.sequence[0], 'undo', `${label}：第一个动作必须是撤销（实际序列 ${seq}）`);

  const notice = seen.aiNotice[seen.aiNotice.length - 1] || '';
  ok(/本次已撤销/.test(notice), `${label}：界面要说清「本次已撤销」：「${notice}」`);
  ok(/删掉\s*\d+\s*个文件/.test(notice), `${label}：界面要说清删掉了几个：「${notice}」`);
  ok(/AI 分类还没配置/.test(notice), `${label}：界面要说清「AI 分类还没配置」：「${notice}」`);

  ok(!fs.existsSync(before.copiedFile), `${label}：输出目录里那份没被撤掉（${before.copiedFile} 还在）`);
  eq(listFiles(ctx.outputDir).length, 0, `${label}：输出目录里应当一份都不剩`);
  ok(fs.existsSync(before.srcFile), `${label}：源文件不见了（撤销的红线：原文件不许动）`);
  eq(readText(before.srcFile), before.srcContent, `${label}：源文件内容被改了`);
  eq(countTree(ctx.src).files, before.srcTree.files, `${label}：源目录的文件数变了`);
  eq(JSON.stringify(countTree(ctx.src)), JSON.stringify(before.srcTree), `${label}：源目录被动过`);
  return true;
}

async function main() {
  console.log('=== accept-ai-ui-test: 「换一种分法：AI 分类」的界面接线（先撤销、后 AI） ===');
  console.log(`project root: ${projectRoot}`);
  console.log(`core: ${path.join(OUT, 'core', 'index.js')}`);

  for (const p of [RENDERER_JS, RENDERER_TS, HTML, PRELOAD_JS, MAIN_JS]) {
    if (!fs.existsSync(p)) {
      console.log(`FAIL: missing ${p} (run npm run build first)`);
      console.log('验收失败:AI界面壳');
      process.exitCode = 1;
      return;
    }
  }
  for (const fn of ['copyFiles', 'undoLastRun', 'summarizeLastRun', 'loadRunRecord']) {
    if (typeof core[fn] !== 'function') {
      console.log(`FAIL: out/core/index.js 没有导出 ${fn}`);
      console.log('验收失败:AI界面壳');
      process.exitCode = 1;
      return;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-ai-ui-'));
  console.log(`temp work dir: ${tmpRoot}`);
  const rendererJs = readText(RENDERER_JS);
  const rendererTs = readText(RENDERER_TS);
  const html = readText(HTML);

  try {
    /* ================= 一：常显状态 + HTML 接线 ================= */
    await check('界面上有常显的「AI 分类：未配置」：按钮旁那行状态一打开就有，且界面里没有第二处 AI 实现', async () => {
      ok(/id\s*=\s*["']ai-reclassify["']/.test(html), 'index.html 里没有「换一种分法：AI 分类」那个按钮');
      ok(/换一种分法：AI 分类/.test(html), 'index.html 里按钮的文字不对（必须是「换一种分法：AI 分类」）');
      ok(/id\s*=\s*["']ai-status["']/.test(html), 'index.html 里没有常显状态那行（#ai-status）');
      ok(/AI 分类：未配置/.test(html), 'index.html 里没有「AI 分类：未配置」这句常显状态');
      ok(/\.aiClassify\s*\(/.test(rendererTs), 'renderer.ts 里没有调 aiClassify（按钮没接线）');
      ok(/\.aiStatus\s*\(/.test(rendererTs), 'renderer.ts 里没有调 aiStatus（那行状态不会更新）');
      ok(/\.aiClassify\s*\(/.test(rendererJs), '编译产物里没有调 aiClassify');
      ok(/ai:classify/.test(readText(PRELOAD_JS)), 'preload 产物里没有 ai:classify 这条通道');
      ok(/ai:classify/.test(readText(MAIN_JS)), '主进程产物里没有 ai:classify 这条门');

      // 真跑一遍界面脚本，看那行状态是「跑出来的」而不是只写在 HTML 里
      const ctx = makeCtx(path.join(tmpRoot, '常显状态'), '常显状态');
      const seen = await startScenario(ctx, rendererJs, 'ui-ai-status.js', {});
      ok(seen.problems.length === 0, seen.problems.join(' | '));
      ok(seen.state.aiStatusCalls >= 1, `界面启动时应当查一次 AI 状态（实际查了 ${seen.state.aiStatusCalls} 次）`);
      const status = seen.aiStatus[0] || '';
      eq(status, 'AI 分类：未配置', '那行常显状态必须显示「AI 分类：未配置」');
      console.log(`      常显状态：「${status}」（启动时查了 ${seen.state.aiStatusCalls} 次）`);
    });

    /* ================= 二：先撤销、后 AI（真产物） ================= */
    let ctxA = null;
    let seenA = null;
    await check('点「换一种分法：AI 分类」：先撤销、后 AI；界面说清「已撤销 N 个 + AI 分类还没配置」；输出里那份真被撤掉、源文件一个没动', async () => {
      ctxA = makeCtx(path.join(tmpRoot, '先撤销后AI'), '先撤销后AI');
      seenA = await startScenario(ctxA, rendererJs, 'ui-ai-live.js', {});
      try {
        ok(seenA.problems.length === 0, seenA.problems.join(' | '));
        ok(seenA.state.organizeCalls === 1, '整理那一步没跑成（这一条没法验）');
        // 前置：整理之后输出里确实有那份、记录也可撤销（点按钮之前先钉死这个前提）
        const copiedBefore = listFiles(ctxA.outputDir);
        ok(copiedBefore.length > 0, '整理之后输出目录里应当有文件（这一条没法验）');
        const summary = core.summarizeLastRun(core.loadRunRecord(ctxA.recordPath));
        eq(summary.available, true, '前置不成立：这份记录应当是可撤销的（要先真整理过一次）');
        console.log(`      前置：输出里 ${copiedBefore.length} 份（${copiedBefore[0]}），记录说可撤销 ${summary.fileCount} 个`);

        seenA.__before = {
          copiedFile: path.join(ctxA.outputDir, ...copiedBefore[0].split(path.sep)),
          srcFile: ctxA.srcFile,
          srcContent: readText(ctxA.srcFile),
          srcTree: countTree(ctxA.src),
        };
        await clickAiReclassify(seenA);
        assertUndoBeforeAi(seenA, ctxA, '真产物');
        ok(seenA.state.aiCalls[0].filePaths.length > 0, 'AI 那一调应当把文件清单一起带上（将来的接口要用）');
        console.log(`      序列：${seenA.state.sequence.join('→')}；界面：「${seenA.aiNotice[seenA.aiNotice.length - 1]}」`);
      } finally {
        seenA.close();
      }
    });

    /* ================= 三：再点一次（已撤销状态） ================= */
    await check('再点一次（已经撤销过）：只给提示、不删任何东西、AI 接口不再被调用', async () => {
      ok(seenA !== null, '上一条没跑成，这一条没法验');
      const outputBefore = listFiles(ctxA.outputDir);
      const srcTreeBefore = countTree(ctxA.src);
      const aiCallsBefore = seenA.state.aiCalls.length;

      // 桩里的记录此时已经被标成「已撤销」：界面必须自己看出来「没有可撤销的整理」
      const summary = core.summarizeLastRun(core.loadRunRecord(ctxA.recordPath));
      eq(summary.available, false, '前置不成立：这份记录此时应当已经不可撤销');
      ok(/已经撤销过/.test(summary.reason), `摘要应当说明「已经撤销过」，实际「${summary.reason}」`);

      const seen = await startScenario(
        { ...ctxA, recordPath: ctxA.recordPath },
        rendererJs,
        'ui-ai-again.js',
        { clickStart: false },
      );
      try {
        ok(seen.problems.length === 0, seen.problems.join(' | '));
        await clickAiReclassify(seen);
        const notice = seen.aiNotice[seen.aiNotice.length - 1] || '';
        ok(/没有可撤销的整理/.test(notice), `界面应当只给一句提示：「${notice}」`);
        ok(/没有删任何东西/.test(notice), `提示里要说清「没删东西」：「${notice}」`);
        eq(seen.state.aiCalls.length, 0, '没有可撤销的整理时，绝不许调 AI 分类接口');
        eq(seen.state.undoCalls, 0, '没有可撤销的整理时，不该去调撤销');
        eq(JSON.stringify(listFiles(ctxA.outputDir)), JSON.stringify(outputBefore), '输出目录被动了（不该发生）');
        eq(JSON.stringify(countTree(ctxA.src)), JSON.stringify(srcTreeBefore), '源目录被动了（不该发生）');
        console.log(`      第二次点：界面提示「${notice}」；AI 调用次数仍然是 ${seen.state.aiCalls.length}（上一轮是 ${aiCallsBefore} 次）`);
      } finally {
        seen.close();
      }
    });

    /* ================= 四：撤销失败 → 不许继续调 AI ================= */
    await check('撤销接口返回失败（有文件删不掉）：如实显示撤销报告，且**不**继续调用 AI 接口', async () => {
      const ctxB = makeCtx(path.join(tmpRoot, '撤销失败'), '撤销失败');
      const failureTarget = path.join(ctxB.outputDir, '01_图片', '撤不掉的.jpg');
      const seen = await startScenario(ctxB, rendererJs, 'ui-ai-undo-fail.js', {
        undoOutcome: {
          result: {
            ok: false,
            clean: false,
            changed: true,
            message: '撤销没有撤干净：1 个文件删不掉',
            outputDir: ctxB.outputDir,
            plannedFiles: 1,
            plannedDirs: 1,
            deletedFiles: 0,
            skippedFiles: 1,
            removedDirs: 0,
            skippedDirs: 0,
            files: [
              {
                target: failureTarget,
                source: ctxB.srcFile,
                action: 'skipped',
                reason: '删不掉：文件被别的程序占用（跳过它，继续处理后面的）',
              },
            ],
            dirs: [],
          },
          summary: core.summarizeLastRun(null),
        },
      });
      try {
        ok(seen.problems.length === 0, seen.problems.join(' | '));
        ok(seen.state.organizeCalls === 1, '整理那一步没跑成（这一条没法验）');
        const outputBefore = listFiles(ctxB.outputDir);
        await clickAiReclassify(seen);
        eq(seen.state.undoCalls, 1, '撤销接口应当被调到 1 次');
        eq(seen.state.aiCalls.length, 0, '撤销失败之后绝不许继续调 AI 分类接口');
        eq(seen.state.sequence.join('→'), 'undo', `撤销失败时序列里只该有「撤销」：实际 ${seen.state.sequence.join('→')}`);
        const notice = seen.aiNotice[seen.aiNotice.length - 1] || '';
        ok(/撤销没有成功/.test(notice), `界面要说清「撤销没有成功、这次不换分法」：「${notice}」`);
        ok(!/本次已撤销/.test(notice), `撤销失败时不许说「已撤销」：「${notice}」`);
        const report = seen.undoReportText || '';
        ok(/(撤不掉|删不掉|占用)/.test(report), `撤销报告要如实显示为什么没撤掉：「${report}」`);
        ok(report.includes(failureTarget), `撤销报告里要列出那个删不掉的文件：期望含 ${failureTarget}`);
        eq(JSON.stringify(listFiles(ctxB.outputDir)), JSON.stringify(outputBefore), '撤销失败时不该动输出目录里剩下的东西');
        console.log(`      撤销失败：序列「${seen.state.sequence.join('→')}」、AI 调用 0 次；界面「${notice}」`);
        console.log(`      报告首行：${(report.split('\n')[0] || '').slice(0, 80)}`);
      } finally {
        seen.close();
      }
    });

    /* ================= 五：探针有效性自检 ================= */
    await check('探针有效性自检：拿「先调 AI、后撤销」的产物喂给第 2 条那套断言必须判失败，真产物必须通过', async () => {
      const crippled = aiBeforeUndo(rendererJs);
      ok(crippled !== rendererJs, '没能造出「顺序反了」的产物样本');
      // 样本确实被改坏了：第一次调用接口的那一句变成了 AI 分类（原来第一句是撤销）
      const iFirstApi = crippled.indexOf('outcome = (await api.undoLastRun());');
      const iFirstAi = crippled.indexOf('ai = (await api.aiClassify(');
      ok(iFirstApi >= 0 && iFirstAi >= 0, '样本里缺少必要的接口调用（样本不对）');
      ok(iFirstAi < iFirstApi, `样本里 AI 那一调没有排到撤销之前（样本不对：AI 在 ${iFirstAi}、撤销在 ${iFirstApi}）`);
      const hits = [];
      const ctxBad = makeCtx(path.join(tmpRoot, '顺序反了'), '顺序反了');
      const bad = await runAiClickScenario(ctxBad, crippled, 'ui-ai-reversed.js', {});
      const badSeq = bad.state.sequence.join('→');
      const badAiCalls = bad.state.aiCalls.length;
      const badUndoCalls = bad.state.undoCalls;
      try {
        try {
          assertUndoBeforeAi(bad, ctxBad, '顺序反了的产物');
          hits.push(`顺序反了的产物居然被判通过了（序列 ${badSeq}）`);
        } catch (err) {
          hits.push(`顺序反了被抓到：${(err && err.message) || err}`);
        }
      } finally {
        bad.close();
      }
      ok(hits.length === 1 && /顺序反了被抓到/.test(hits[0]), `「顺序反了」的产物必须判失败：${hits.join(' | ')}`);
      console.log(`      ${hits[0].slice(0, 170)}`);
      console.log(`      反证样本的调用序列：${badSeq}（撤销 ${badUndoCalls} 次 / AI ${badAiCalls} 次）；执行问题：${bad.problems.join(' | ') || '无'}`);

      // 真产物用同一套断言，单独再跑一遍（不复用上面的结论）
      const ctx = makeCtx(path.join(tmpRoot, '真产物复验'), '真产物复验');
      const live = await runAiClickScenario(ctx, rendererJs, 'ui-ai-live-again.js', {});
      try {
        assertUndoBeforeAi(live, ctx, '真产物（复验）');
        console.log(`      真产物复验通过（序列 ${live.state.sequence.join('→')}）`);
      } finally {
        live.close();
      }
    });
  } catch (err) {
    console.log(`FAIL: 测试过程本身出错 -> ${(err && err.stack) || err}`);
    results.push(['unexpected-error', false]);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定 */
    }
  }

  console.log('');
  console.log('--- summary ---');
  let allOk = results.length > 0;
  for (const [name, pass] of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) allOk = false;
  }
  if (uncaught.length > 0) {
    for (const u of uncaught) console.log(`FAIL: uncaught during the whole run -> ${u}`);
    allOk = false;
  }
  if (allOk) {
    console.log('AI界面壳OK');
    process.exitCode = 0;
  } else {
    console.log('验收失败:AI界面壳');
    process.exitCode = 1;
  }
}

/** 造一个场景：源文件夹（一个文件夹 + 里面两个文件）+ 空的输出目录 + 临时记录路径。 */
function makeCtx(baseDir, name) {
  const dir = path.join(baseDir, name);
  const src = makeSource(path.join(dir, '源'), { '风景.jpg': 'J1', '合同.pdf': 'P1' });
  const outputDir = path.join(dir, '输出');
  fs.mkdirSync(outputDir, { recursive: true });
  const files = [path.join(src, '风景.jpg'), path.join(src, '合同.pdf')];
  return {
    root: src,
    roots: [src],
    files,
    src,
    srcFile: path.join(src, '风景.jpg'),
    outputDir,
    recordPath: path.join(dir, '记录-临时.json'),
  };
}

main();
