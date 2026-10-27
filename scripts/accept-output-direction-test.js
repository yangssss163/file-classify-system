/**
 * 验收第 11 条：输出方向（纯逻辑 + 界面接线）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 纯逻辑（真造临时目录与文件，真跑 copyFiles —— 与「开始整理」同一条路）：
 *   1. 输出目录 = 源文件夹本身            → 拒绝开工、有原因、源文件夹里没多出任何文件或目录；
 *   2. 输出目录在源文件夹之下（源\整理）  → 拒绝开工、有原因、没写任何东西；
 *   3. 输出目录是源文件夹的上一级（用户提的隐患）→ 拒绝开工、有原因、没写任何东西；
 *   4. 正常情况（同级不同名的两个目录）   → 允许开工，并且真跑一次能正常工作；
 *   5. 只有散文件、没有源文件夹：输出 = 文件所在目录 → 拒绝；输出 = 另一个目录 → 允许。
 *
 * 界面侧（与第 5/7/9 条同一套做法：**把编译产物当脚本在窗口式桩里真执行**，
 * 真 ES module 作用域 vm.SourceTextModule，绝不退化成字符串匹配）：
 *   6. 危险方向出现在预览里时，界面写出那句人话警告，并且「开始整理」不可点 / 点了直接拒绝，
 *      磁盘上**一个字节都没写**；
 *   7. 把输出目录换成互不相干的另一个目录 → 警告消失、按钮可点，真跑一次能正常落地；
 *   8. 探针有效性自检：拿**抽掉方向校验**的产物（纯内存字符串，其它一律照旧）必须判失败，真产物必须通过。
 *
 * 全部通过：stdout 打印「输出方向OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:输出方向」并 exit 1。
 *
 * 跑法：node --experimental-vm-modules scripts\accept-output-direction-test.js
 *       （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
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

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

/* ------------------------------------------------------------------ *
 * 小工具
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

function makeSource(base, spec) {
  fs.mkdirSync(base, { recursive: true });
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return base;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ *
 * 最小 DOM 桩（与第 5/7/9 条同一套形状）
 * ------------------------------------------------------------------ */

function makeElement(id) {
  const el = {
    id: id || '',
    tagName: 'DIV',
    className: '',
    textContent: '',
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

function walk(node, visit) {
  for (const child of node.children || []) {
    visit(child);
    walk(child, visit);
  }
}

function textOf(root) {
  let out = String(root.textContent || '');
  for (const child of root.children || []) out += `\n${textOf(child)}`;
  return out;
}

/**
 * 把一个界面产物真跑一遍：真 ES module 作用域 + 窗口式桩。
 * 返回 `restore()`，由调用方在所有 await 之后调用（界面的回调是异步的）。
 */
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
    await mod.link((specifier) => {
      // 允许界面引用自己的纯数据模块（关系链球模型）；其它任何 import 一律不许
      if (specifier === './planGraph.js') {
        const dir = process.env.DSH_ACCEPT_OUT || path.join(__dirname, '..', 'out');
        const target = path.join(dir, 'renderer', specifier);
        return new vm.SourceTextModule(fs.readFileSync(target, 'utf8'), { identifier: target });
      }
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
 * 假 window.organizer：**用真的 core 干活**（copyFiles / expandFolders / checkOutputDirection），
 * 所以界面这一轮的断言不是对着假数据自说自话。
 * ------------------------------------------------------------------ */

function makeOrganizer(opts) {
  const o = opts || {};
  const state = {
    pickOutputCalls: 0,
    organizeCalls: [],
    expandCalls: [],
    previewCalls: [],
    directionCalls: [],
    setRootsCalls: [],
    pendingRoots: [],
  };
  const knownFiles = new Set((o.files || []).map((f) => String(f).toLowerCase()));
  const knownRoots = (o.roots || []).map((r) => String(r));

  const api = {
    pathForFile: (file) => (file && file.__path) || null,
    pickFiles: async () => [],
    pickFolders: async () => [],
    pickOutputDir: async () => {
      state.pickOutputCalls++;
      const dir = typeof o.pickOutputResult === 'function' ? o.pickOutputResult() : o.pickOutputResult;
      return dir || null;
    },
    exists: async (paths) => {
      const map = {};
      for (const p of paths || []) {
        const lower = String(p).toLowerCase();
        const isFile = knownFiles.has(lower);
        const isDir = knownRoots.some((r) => lower === r.toLowerCase() || lower.startsWith(r.toLowerCase() + '\\'));
        map[p] = isFile ? true : isDir ? false : false;
      }
      return map;
    },
    expand: async (list) => {
      state.expandCalls.push(list);
      return core.expandFolders(list);
    },
    setSourceRoots: async (list) => {
      state.setRootsCalls.push(list === null || list === undefined ? null : Array.from(list));
      state.pendingRoots = list === null || list === undefined ? [] : Array.from(list);
      return true;
    },
    preview: async (fileList, outputDir, rules) => {
      const rootList = state.pendingRoots.slice();
      state.previewCalls.push({ files: fileList, outputDir, rules, roots: rootList });
      // 与主进程同一条路：buildPreviewTree 里带着输出方向校验
      return core.buildPreviewTree({ files: fileList, roots: rootList, outputDir, rules: rules || null });
    },
    organize: async (fileList, outputDir, rules, rootList) => {
      state.organizeCalls.push({ files: fileList, outputDir, rules, roots: rootList });
      // 与主进程同一条路：copyFiles 会先校验输出方向
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
    lastRun: async () => ({
      available: false,
      reason: '没有可撤销的整理',
      outputDir: '',
      fileCount: 0,
      dirCount: 0,
      successCount: 0,
      failureCount: 0,
      failureNote: '',
      finishedAt: '',
      undoneAt: null,
      message: '没有可撤销的整理',
    }),
    undoLastRun: async () => ({ result: { message: '', files: [], dirs: [] }, summary: { available: false } }),
    checkOutputDirection: async (input) => {
      const list = input || {};
      state.directionCalls.push({ roots: list.roots, files: list.files, outputDir: list.outputDir });
      // 与主进程同一条路：同一个校验函数
      return core.checkOutputDirection({
        roots: list.roots || [],
        files: list.files || [],
        outputDir: list.outputDir || '',
      });
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
 * 内存里现造的「抽掉方向校验」的界面产物：其它一律照旧，只是不写警告、也不拦按钮。
 * 用来反证第 6/7 条的探针是活的。
 * ------------------------------------------------------------------ */
function withoutDirectionGate(source) {
  let out = source;
  out = out.split('gateCheck = tree.outputDirection;').join('void 0;');
  out = out.split('const blocked = gateCheck.ok !== true;').join('const blocked = false;');
  // 新界面在「生成方案」「确认分拣」两处都各有一道出口；抽校验就必须两道一起抽掉
  out = out.split('if (gate && gate.ok !== true) {').join('if (false) {');
  out = out.split('if (before && before.ok !== true) {').join('if (false) {');
  return out;
}

/** 在窗口式桩里跑一个界面产物：返回观察结果（给第 6/7/8 条用）。 */
async function observeUi(productSource, label, ctx, scenario) {
  const s = scenario || {};
  const { api, state } = makeOrganizer({
    files: ctx.files,
    roots: ctx.roots,
    recordPath: ctx.recordPath,
    pickOutputResult: s.outputDir !== undefined ? s.outputDir : ctx.outputDir,
  });
  const run = await runInWindowStub(productSource, label, api, s.confirm !== false);
  const out = { run, state, error: run.error, problems: [] };
  try {
    if (run.error) {
      out.problems.push(`execution failed: ${run.error}`);
      return out;
    }

    if (s.drop !== false) {
      dropFolder(run, ctx.root);
      for (let i = 0; i < 8; i++) await flush();
    }
    if (s.pickOutputDir !== false) {
      const pickOut = run.elements.get('pick-out');
      if (!pickOut) out.problems.push('element never looked up: #pick-out');
      else pickOut.dispatch('click', { preventDefault() {} });
      for (let i = 0; i < 8; i++) await flush();
    }
    if (s.preview !== false) {
      const previewBtn = run.elements.get('preview');
      if (!previewBtn) out.problems.push('element never looked up: #preview');
      else previewBtn.dispatch('click', { preventDefault() {} });
      // 生成方案这条链上有好几个 await（方向校验 → 源文件夹 → 预览），多等几拍
      for (let i = 0; i < 12; i++) await flush();
    }

    out.outputText = String((run.elements.get('out-dir') || {}).textContent || '');
    // 新界面里「不能开工」那条红条在分拣台上（#plan-warning），同一条提示也会落到 #plan-notice；
    // 断言只看「用户看得见的那几句」，两处合起来读。
    out.warningText = [run.elements.get('plan-warning'), run.elements.get('plan-notice')]
      .map((node) => String((node || {}).textContent || ''))
      .filter((t) => t.length > 0)
      .join(' ');
    out.noticeText = String((run.elements.get('notice') || {}).textContent || '');
    out.summaryText = String((run.elements.get('summary') || {}).textContent || '');
    out.startDisabled = (run.elements.get('plan-confirm') || {}).disabled === true;
    out.previewText = run.elements.get('plan-canvas') ? textOf(run.elements.get('plan-canvas')) : '';

    if (s.clickStart === true) {
      const startBtn = run.elements.get('plan-confirm');
      if (!startBtn) out.problems.push('element never looked up: #plan-confirm');
      else startBtn.dispatch('click', { preventDefault() {} });
      // 整理是异步的（真在复制文件）：多等一会儿，等它把话说完
      for (let i = 0; i < 60; i++) await flush();
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (let i = 0; i < 10; i++) await flush();
      out.noticeText = String((run.elements.get('notice') || {}).textContent || '');
      out.summaryText = String((run.elements.get('summary') || {}).textContent || '');
      out.organizeCount = state.organizeCalls.length;
      out.progressText = String((run.elements.get('progress') || {}).textContent || '');
    }
    return out;
  } finally {
    run.restore();
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('=== accept-output-direction-test: 输出方向不对就不许开工（一个字节都不写） ===');
  console.log(`project root: ${projectRoot}`);
  console.log(`core: ${path.join(OUT, 'core', 'index.js')}`);

  for (const p of [RENDERER_JS, RENDERER_TS, HTML, PRELOAD_JS]) {
    if (!fs.existsSync(p)) {
      console.log(`FAIL: missing ${p} (run npm run build first)`);
      console.log('验收失败:输出方向');
      process.exitCode = 1;
      return;
    }
  }
  for (const fn of ['checkOutputDirection', 'copyFiles', 'buildPreviewTree']) {
    if (core[fn] === undefined) {
      console.log(`FAIL: out/core/index.js 没有导出 ${fn}`);
      console.log('验收失败:输出方向');
      process.exitCode = 1;
      return;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-output-direction-'));
  console.log(`temp work dir: ${tmpRoot}`);
  const rendererJs = readText(RENDERER_JS);
  const rendererTs = readText(RENDERER_TS);
  const html = readText(HTML);
  const preloadJs = readText(PRELOAD_JS);

  try {
    /* ================= 一：输出 = 源文件夹本身 ================= */
    await check('输出目录 = 源文件夹本身 → 拒绝开工、有原因、源文件夹里没多出任何文件或目录', async () => {
      const dir = path.join(tmpRoot, '输出就是源');
      const src = makeSource(path.join(dir, '源'), { 'a.jpg': 'A', 'b.pdf': 'B', '子/a2.jpg': 'A2' });
      const files = [path.join(src, 'a.jpg'), path.join(src, 'b.pdf')];
      const before = countTree(src);

      const verdict = core.checkOutputDirection({ roots: [src], outputDir: src });
      eq(verdict.ok, false, '输出就是源文件夹本身时必须拒绝');
      ok(verdict.message.length > 0, '拒绝时必须给一句人话');
      ok(/就是源文件夹本身|卷进去/.test(verdict.message), `原因要说清为什么危险：「${verdict.message}」`);

      const summary = await core.copyFiles({ roots: [src], files, outputDir: src, rules: null });
      eq(summary.blocked, true, 'copyFiles 也必须拦下（不许一个字节都不写）');
      eq(summary.successCount, 0, '被拦下时不许有任何成功');
      eq(summary.writtenFiles.length, 0, '被拦下时不许有写出的文件');
      eq(countTree(src).files, before.files, '源文件夹里多了文件（不该发生）');
      eq(countTree(src).dirs, before.dirs, '源文件夹里多了目录（不该发生）');
      const after = countTree(src);
      eq(JSON.stringify(after), JSON.stringify(before), '源文件夹的内容变了');
      console.log(`      ${verdict.message}`);
    });

    /* ================= 二：输出在源文件夹之下 ================= */
    await check('输出目录在源文件夹之下（源\\整理）→ 拒绝开工、有原因、没写任何东西', async () => {
      const dir = path.join(tmpRoot, '输出在源之下');
      const src = makeSource(path.join(dir, '源'), { 'a.jpg': 'A', 'b.pdf': 'B' });
      const out = path.join(src, '整理');
      const files = [path.join(src, 'a.jpg'), path.join(src, 'b.pdf')];
      const before = countTree(src);

      const verdict = core.checkOutputDirection({ roots: [src], outputDir: out });
      eq(verdict.ok, false, '输出在源文件夹之下时必须拒绝');
      ok(/在源文件夹里面|卷进去/.test(verdict.message), `原因要说清为什么危险：「${verdict.message}」`);

      const summary = await core.copyFiles({ roots: [src], files, outputDir: out, rules: null });
      eq(summary.blocked, true, 'copyFiles 也必须拦下');
      eq(summary.writtenFiles.length, 0, '被拦下时不许有写出的文件');
      ok(!fs.existsSync(out), `被拦下时连输出目录都不该建出来：${out}`);
      eq(countTree(src).files, before.files, '源文件夹里多了文件（不该发生）');
      eq(countTree(src).dirs, before.dirs, '源文件夹里多了目录（不该发生）');
      console.log(`      ${verdict.message}`);
    });

    /* ================= 三：输出是源文件夹的上一级（用户提的隐患） ================= */
    await check('输出目录是源文件夹的上一级（用户提的隐患）→ 拒绝开工、有原因、没写任何东西', async () => {
      const dir = path.join(tmpRoot, '输出是上一级');
      fs.mkdirSync(dir, { recursive: true });
      const src = makeSource(path.join(dir, '原文件夹'), { 'a.jpg': 'A', 'b.pdf': 'B' });
      const files = [path.join(src, 'a.jpg'), path.join(src, 'b.pdf')];
      const beforeParent = countTree(dir);

      const verdict = core.checkOutputDirection({ roots: [src], outputDir: dir });
      eq(verdict.ok, false, '输出是源文件夹的上一级时必须拒绝');
      ok(/上一级/.test(verdict.message), `原因要说清「是上一级」：「${verdict.message}」`);
      ok(/卷进去/.test(verdict.message), `原因要说清「会把原文件所在文件夹卷进去」：「${verdict.message}」`);

      const summary = await core.copyFiles({ roots: [src], files, outputDir: dir, rules: null });
      eq(summary.blocked, true, 'copyFiles 也必须拦下');
      eq(summary.writtenFiles.length, 0, '被拦下时不许有写出的文件');
      eq(countTree(dir).files, beforeParent.files, '上一级目录里多了文件（不该发生）');
      eq(countTree(dir).dirs, beforeParent.dirs, '上一级目录里多了目录（不该发生）');
      ok(countTree(src).files === 2, '源文件夹里的文件数变了');
      console.log(`      ${verdict.message}`);
    });

    /* ================= 四：正常情况（同级不同名） ================= */
    await check('正常情况（同级不同名的两个目录）→ 允许开工，并且真跑一次能正常工作', async () => {
      const dir = path.join(tmpRoot, '正常方向');
      const src = makeSource(path.join(dir, '源'), { 'a.jpg': 'A', 'b.pdf': 'B', '子/c.mp3': 'C' });
      const out = path.join(dir, '整理结果');
      const files = [path.join(src, 'a.jpg'), path.join(src, 'b.pdf'), path.join(src, '子/c.mp3')];

      const verdict = core.checkOutputDirection({ roots: [src], outputDir: out });
      eq(verdict.ok, true, `同级不同名时必须允许开工（原因码 ${verdict.reason}）`);
      eq(verdict.message, '', '允许时不该有拒绝说明');

      const summary = await core.copyFiles({ roots: [src], files, outputDir: out, rules: null });
      eq(summary.blocked, false, '正常方向不该被拦下');
      eq(summary.successCount, 3, '三个文件都应当复制成功');
      const tree = countTree(out);
      ok(tree.files === 3, `输出里应当有 3 个文件，实际 ${tree.files}`);
      ok(tree.dirs >= 2, `输出里应当有分类夹/子文件夹，实际 ${tree.dirs} 个目录`);
      ok(fs.existsSync(path.join(src, 'a.jpg')), '源文件应当还在（只复制不移动）');
      console.log(`      输出：${tree.files} 个文件 / ${tree.dirs} 个目录`);
    });

    /* ================= 五：只有散文件，没有源文件夹 ================= */
    await check('只有散文件、没有源文件夹：输出 = 文件所在目录 → 拒绝；输出是另一个目录 → 允许', async () => {
      const dir = path.join(tmpRoot, '散文件');
      const src = makeSource(path.join(dir, '散文件所在'), { 'a.jpg': 'A', 'b.pdf': 'B' });
      const files = [path.join(src, 'a.jpg'), path.join(src, 'b.pdf')];
      const outOther = path.join(dir, '另一个目录');

      const verdictBad = core.checkOutputDirection({ roots: [], files, outputDir: src });
      eq(verdictBad.ok, false, '输出 = 散文件所在目录时必须拒绝');
      ok(/原文件/.test(verdictBad.message), `原因要说清为什么危险：「${verdictBad.message}」`);

      const summaryBad = await core.copyFiles({ files, outputDir: src, rules: null });
      eq(summaryBad.blocked, true, 'copyFiles 也必须拦下');
      eq(countTree(src).files, 2, '拒绝时散文件所在目录里不该多出文件');
      eq(countTree(src).dirs, 0, '拒绝时散文件所在目录里不该多出目录');

      const verdictGood = core.checkOutputDirection({ roots: [], files, outputDir: outOther });
      eq(verdictGood.ok, true, '输出是另一个目录时必须允许');
      const summaryGood = await core.copyFiles({ files, outputDir: outOther, rules: null });
      eq(summaryGood.blocked, false, '允许方向不该被拦下');
      eq(summaryGood.successCount, 2, '两个散文件都应当复制成功');
      eq(countTree(outOther).files, 2, '输出里应当有 2 个文件');
      console.log(`      拒绝理由：${verdictBad.message}`);
    });

    /* ================= 六 / 七：界面侧（真 ES module 执行） ================= */
    const uiDir = path.join(tmpRoot, '界面');
    const uiSrc = makeSource(path.join(uiDir, '源'), {
      '图1.jpg': 'P1',
      '文1.pdf': 'P2',
      '子/深.txt': 'P3',
    });
    const uiFiles = [path.join(uiSrc, '图1.jpg'), path.join(uiSrc, '文1.pdf'), path.join(uiSrc, '子', '深.txt')];
    const uiCtxDangerous = {
      root: uiSrc,
      roots: [uiSrc],
      files: uiFiles,
      outputDir: uiSrc, // 危险：输出就是源文件夹本身
      recordPath: path.join(uiDir, '界面记录-危险.json'),
    };
    const uiCtxNested = {
      root: uiSrc,
      roots: [uiSrc],
      files: uiFiles,
      outputDir: path.join(uiSrc, '整理'), // 危险：输出在源文件夹之下
      recordPath: path.join(uiDir, '界面记录-嵌套.json'),
    };
    const uiCtxParent = {
      root: uiSrc,
      roots: [uiSrc],
      files: uiFiles,
      outputDir: uiDir, // 危险：输出是源文件夹的上一级
      recordPath: path.join(uiDir, '界面记录-上级.json'),
    };
    const uiOutSafe = path.join(uiDir, '界面输出（互不相干）');
    const uiCtxSafe = {
      root: uiSrc,
      roots: [uiSrc],
      files: uiFiles,
      outputDir: uiOutSafe,
      recordPath: path.join(uiDir, '界面记录-正常.json'),
    };

    await check('界面侧：危险输出方向出现在预览里 → 写出那句人话警告，「开始整理」不可点或点了直接拒绝，磁盘一个字节都没写', async () => {
      ok(/id\s*=\s*["']undo["']/.test(html) || /撤销/.test(html), '界面里应当有撤销那一段');
      ok(/checkOutputDirection|outputDirection/.test(rendererJs), '编译产物里没有引用输出方向校验（界面没接线）');
      ok(/checkOutputDirection/.test(rendererTs), 'renderer.ts 里没有引用输出方向校验');
      ok(/output:check|outputDirection|checkOutputDirection/.test(preloadJs), 'preload 产物里没有输出方向校验这条通道');

      for (const [label, ctx, wantReason] of [
        ['输出=源', uiCtxDangerous, /就是源文件夹本身/],
        ['输出在源下', uiCtxNested, /在源文件夹里面/],
        ['输出是源的上一级', uiCtxParent, /上一级/],
      ]) {
        const beforeOut = fs.existsSync(ctx.outputDir) ? countTree(ctx.outputDir) : { files: 0, dirs: 0 };
        const beforeSrc = countTree(uiSrc);
        const seen = await observeUi(rendererJs, `ui-danger-${label}.js`, ctx, { clickStart: true });
        ok(seen.problems.length === 0, `${label}：${seen.problems.join(' | ')}`);
        ok(seen.warningText.length > 0, `${label}：预览里没有写出那句警告`);
        ok(/不能开工/.test(seen.warningText), `${label}：警告里应当明说「不能开工」：「${seen.warningText}」`);
        ok(wantReason.test(seen.warningText), `${label}：警告没说清为什么危险：「${seen.warningText}」`);
        ok(/卷进去|原文件|一个字节/.test(seen.warningText), `${label}：警告应当说清会把原文件夹卷进去 / 一个字节都不写：「${seen.warningText}」`);
        // 按钮不可点，或点了直接拒绝
        const rejected = seen.startDisabled === true || /不能开工/.test(seen.noticeText) || /没有开始整理/.test(seen.summaryText);
        ok(rejected, `${label}：既是不可点、也没拒绝开工（按钮 disabled=${seen.startDisabled}，提示：「${seen.noticeText}」）`);
        // 磁盘：一个字节都没写
        eq(countTree(uiSrc).files, beforeSrc.files, `${label}：源文件夹里多了文件（不该发生）`);
        eq(countTree(uiSrc).dirs, beforeSrc.dirs, `${label}：源文件夹里多了目录（不该发生）`);
        if (fs.existsSync(ctx.outputDir) && ctx.outputDir !== uiSrc) {
          eq(countTree(ctx.outputDir).files, beforeOut.files, `${label}：输出目录里多了文件（不该发生）`);
          eq(countTree(ctx.outputDir).dirs, beforeOut.dirs, `${label}：输出目录里多了目录（不该发生）`);
        }
        console.log(`      ${label}：警告「${seen.warningText.slice(0, 90)}…」，start.disabled=${seen.startDisabled}`);
      }
    });

    await check('界面侧：换成互不相干的输出目录 → 警告消失、「开始整理」可点，真跑一次能正常落地', async () => {
      const seen = await observeUi(rendererJs, 'ui-safe.js', uiCtxSafe, { clickStart: true });
      ok(seen.problems.length === 0, seen.problems.join(' | '));
      eq(seen.startDisabled, false, '互不相干的输出目录下，「开始整理」应当可点');
      ok(!/不能开工/.test(seen.warningText || ''), `正常方向下不该有「不能开工」的警告：「${seen.warningText}」`);
      ok(/预览|没有复制/.test(seen.warningText || ''), `正常预览时应当还是那句预览提示：「${seen.warningText}」`);
      const tree = countTree(uiOutSafe);
      ok(tree.files === 3, `真跑一次之后输出里应当有 3 个文件，实际 ${tree.files}`);
      ok(fs.existsSync(path.join(uiSrc, '图1.jpg')), '源文件应当还在（只复制不移动）');
      console.log(`      输出：${tree.files} 个文件 / ${tree.dirs} 个目录`);
    });

    /* ================= 八：探针有效性自检 ================= */
    await check('探针有效性自检：抽掉方向校验的产物必须判失败，真产物必须通过', async () => {
      const crippled = withoutDirectionGate(rendererJs);
      ok(crippled !== rendererJs, '没能造出「抽掉方向校验」的产物样本');
      ok(!/const blocked = gateCheck\.ok !== true;/.test(crippled), '样本里还留着方向判定那条（没抽干净）');

      const hits = [];
      for (const [label, ctx, wantReason] of [
        ['抽掉校验-输出=源', uiCtxDangerous, /就是源文件夹本身/],
        ['抽掉校验-输出在源下', uiCtxNested, /在源文件夹里面/],
        ['抽掉校验-输出是上一级', uiCtxParent, /上一级/],
      ]) {
        const seen = await observeUi(crippled, `crippled-${label}.js`, ctx, { clickStart: true });
        if (seen.problems.length > 0) {
          hits.push(`${label}: 执行失败 ${seen.problems.join(' | ')}`);
          continue;
        }
        const warned = /不能开工/.test(seen.warningText) && wantReason.test(seen.warningText);
        if (!warned) hits.push(`${label}: 没有写出那句人话警告（「${seen.warningText}」）`);
      }
      ok(hits.length > 0, '「抽掉方向校验」的产物被说 OK —— 探针是死的');
      console.log(`      抽掉校验后被抓到（前 2 条）：${hits.slice(0, 2).join(' | ')}`);
      // 真产物必须通过（单独跑一遍，不复用上面的结果）
      const live = await observeUi(rendererJs, 'live-again.js', uiCtxDangerous, {});
      ok(live.problems.length === 0, live.problems.join(' | '));
      ok(/不能开工/.test(live.warningText), `真产物在危险方向下没有警告（探针误报）：「${live.warningText}」`);
      ok(core.checkOutputDirection({ roots: [uiSrc], outputDir: uiSrc }).ok === false, '真校验函数在危险方向下应当拒绝');
      console.log('      探针：抽掉方向校验判失败、真产物判通过');
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
    console.log('输出方向OK');
    process.exitCode = 0;
  } else {
    console.log('验收失败:输出方向');
    process.exitCode = 1;
  }
}

main();
