/**
 * 验收第 13 条：**AI 界面壳**（界面接线，不依赖真窗口）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 这一条跟着界面改过一版：AI 现在是**一等公民**（分拣台上一个按钮就能用），
 * 不再是「先按规则分、不满意再撤销、再换 AI」那套。所以判据换成：
 *   1. 界面上有常显的「AI 分类：未配置」状态（不用点按钮就能看出现在只有规则分类可用）；
 *      启动时真的查过一次状态；界面里只有一处 AI 调用（没有第二套实现）；
 *   2. 点「AI 分拣」（AI 未配置）：**不撤销、不复制、不删任何东西**，直接调 AI；
 *      界面说清「AI 分类还没配置」并给出退路（可以点「规则分拣」）；
 *      AI 那一调必须把源文件夹一起带上（AI 要在「原文件夹已有的目录结构」上分类）；
 *      一个字节都没写：输出目录、源目录前后一致；而且**没有亮出预览卡**；
 *   3. AI 分好之后只出方案（关系链球），**还没落盘**：输出目录一个字节都没写、源文件一个没动；
 *      点「取消本次分拣」也不写，界面说清「已取消」；
 *   4. 点「确认分拣」才落盘：按 AI 给的分类落地（<输出>\<源文件夹>\分类\文件），源文件一个没少；
 *   5. 探针有效性自检：两个内存里现造的坏样本（「AI 没配置却当成功画出了方案」
 *      「一分拣就偷偷把文件复制了」）喂给第 2/3 条那套断言**必须判失败**，真产物必须通过。
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
    placeholder: '',
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
      if (String(name) === 'class') this.className = String(value);
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
  Object.defineProperty(el, 'firstElementChild', {
    get() {
      return el.children.length > 0 ? el.children[0] : null;
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
 * 假 window.organizer：预览/整理用**真的 core** 干活（磁盘上的效果是真的），
 * AI 那两件事按场景给答案（这一片界面只回话，不联网络）。
 * 调用序列记在 `state.sequence` 里 —— 「分拣时不撤销、不写盘」就是靠它判的。
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
    organizeAssignments: null,
    pickOutputCalls: 0,
    pendingRoots: [],
    aiResult: o.aiResult || {
      ok: false,
      reason: 'not-configured',
      message: 'AI 分类还没配置，先按规则分类；到设置里填接口与密钥后可用',
    },
    aiStatus: o.aiStatus || { configured: false, label: 'AI 分类：未配置', message: 'AI 分类还没配置，先按规则分类。' },
  };
  const knownFiles = new Set((o.files || []).map((f) => String(f)));
  const knownRoots = (o.roots || []).map((r) => String(r));
  const lower = (s) => String(s).toLowerCase();

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
    organize: async (fileList, outputDir, rules, rootList, assignments) => {
      state.organizeCalls++;
      state.organizeAssignments = assignments ? Array.from(assignments) : null;
      return core.copyFiles({
        files: fileList,
        roots: rootList,
        outputDir,
        rules: rules || null,
        assignments: assignments || null,
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
    lastRun: async () => {
      state.lastRunCalls++;
      return o.recordPath && fs.existsSync(o.recordPath)
        ? core.summarizeLastRun(core.loadRunRecord(o.recordPath))
        : core.summarizeLastRun(null);
    },
    undoLastRun: async () => {
      state.undoCalls++;
      state.sequence.push('undo');
      const recordPath = o.recordPath || null;
      const result = core.undoLastRun(recordPath || '');
      return { result, summary: core.summarizeLastRun(recordPath ? core.loadRunRecord(recordPath) : null) };
    },
    /** 界面上那行常显状态 */
    aiStatus: async () => {
      state.aiStatusCalls++;
      return state.aiStatus;
    },
    /** 「AI 分拣」那一调（这一片只回话，不联网络） */
    aiClassify: async (filePaths, outputDir, roots) => {
      state.aiCalls.push({
        filePaths: Array.from(filePaths || []),
        outputDir: outputDir ?? null,
        // 第三个参数是源文件夹：核心据它读出「原文件夹已有的分类目录」，界面必须把它带上
        roots: roots ? Array.from(roots) : null,
      });
      state.sequence.push('ai');
      return state.aiResult;
    },
    onProgress: () => {},
    onAiProgress: () => {},
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
 * 场景跑法：造源文件夹 → 拖入 → 选输出 → 点分拣台上那个按钮。
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
  });
  const run = await runInWindowStub(productSource, label, api, s.confirm !== false);
  const out = { run, state, error: run.error, problems: [] };
  // 注意：桩**不能**在这里 restore —— 点按钮之后界面还要继续跑（点完才看得到结果）。
  // 由调用方在「所有 await 都结束」之后再调 seen.close()。
  out.close = () => run.restore();
  if (run.error) {
    out.problems.push(`execution failed: ${run.error}`);
    return out;
  }
  try {
    out.aiStatusText = String((run.elements.get('ai-status') || {}).textContent || '');
    if (s.dropOnly === true) {
      dropFolder(run, ctx.root);
      for (let i = 0; i < 20; i++) await flush();
      const pickOut = run.elements.get('pick-out');
      if (!pickOut) out.problems.push('element never looked up: #pick-out');
      else pickOut.dispatch('click', { preventDefault() {} });
      for (let i = 0; i < 20; i++) await flush();
    }
    return out;
  } catch (err) {
    out.problems.push(`scenario setup failed: ${(err && err.message) || err}`);
    return out;
  }
}

/** 收下一次点击之后界面上那几句话。 */
function readUi(seen) {
  const e = seen.run.elements;
  const txt = (id) => String((e.get(id) || {}).textContent || '');
  return {
    status: txt('ai-status'),
    planNotice: txt('plan-notice'),
    planSummary: txt('plan-summary'),
    notice: txt('notice'),
    summary: txt('summary'),
    canvas: e.get('plan-canvas') ? textOf(e.get('plan-canvas')) : '',
    planShown: (e.get('plan-card') || {}).hidden === false,
    confirmDisabled: (e.get('plan-confirm') || {}).disabled === true,
  };
}

/** 点一次分拣台上那个按钮（默认「AI 分拣」，也可以点「规则分拣」）。 */
async function clickSort(seen, which = 'sort-ai') {
  const btn = seen.run.elements.get(which);
  if (!btn) {
    seen.problems.push(`element never looked up: #${which}`);
    return seen;
  }
  btn.dispatch('click', { preventDefault() {} });
  await settle(60);
  seen.ui = readUi(seen);
  return seen;
}

/* ------------------------------------------------------------------ *
 * 判据（真产物与坏样本共用同一套）
 * ------------------------------------------------------------------ */

/** 第 2 条：AI 未配置时点「AI 分拣」——直接调 AI、不撤销、不写盘、不出方案、说清退路。 */
function assertAiNotConfigured(seen, ctx, label) {
  ok(seen.problems.length === 0, `${label}：${seen.problems.join(' | ')}`);
  eq(seen.state.aiCalls.length, 1, `${label}：「AI 分拣」必须真的把 AI 调起来（实际 ${seen.state.aiCalls.length} 次）`);
  eq(seen.state.undoCalls, 0, `${label}：这条路不许去调撤销（现在是直接就能用 AI）`);
  eq(seen.state.organizeCalls, 0, `${label}：出方案这一步绝不许复制文件`);
  eq(seen.state.sequence.join('→'), 'ai', `${label}：序列里只该有 AI 那一调：实际 ${seen.state.sequence.join('→')}`);

  const ui = seen.ui || readUi(seen);
  ok(/AI 分类还没配置/.test(ui.planNotice), `${label}：界面要说清「AI 分类还没配置」：「${ui.planNotice}」`);
  ok(
    /规则分拣|规则分类|回落|兜底/.test(ui.planNotice),
    `${label}：界面要给退路（可以先用规则分拣）：「${ui.planNotice}」`,
  );
  ok(ui.planShown !== true, `${label}：AI 没配好时不该亮出预览卡（那样等于假装成功了）`);
  ok(
    !/AI 分好了/.test(ui.planNotice),
    `${label}：AI 没配好时不许说「AI 分好了」：「${ui.planNotice}」`,
  );

  // 源文件夹必须一起带下去（AI 要在「原文件夹已有的目录结构」上分类，不是凭空另起一套）
  eq(
    JSON.stringify(seen.state.aiCalls[0].roots || []),
    JSON.stringify([ctx.root]),
    `${label}：AI 那一调必须把源文件夹带上（实际 ${JSON.stringify(seen.state.aiCalls[0].roots)}）`,
  );
  // 一个字节都没写
  eq(listFiles(ctx.outputDir).length, 0, `${label}：输出目录里不该多出任何东西`);
  eq(
    JSON.stringify(countTree(ctx.src)),
    JSON.stringify(seen.srcTreeBefore),
    `${label}：源目录被动过（这一步连读都不该改）`,
  );
  return true;
}

/** 第 3 条：AI 分好之后只出方案、不落盘；点「取消本次分拣」也不写。 */
function assertPlanOnlyNoDisk(seen, ctx, label) {
  ok(seen.problems.length === 0, `${label}：${seen.problems.join(' | ')}`);
  eq(seen.state.aiCalls.length, 1, `${label}：AI 接口应当正好被调到 1 次，实际 ${seen.state.aiCalls.length} 次`);
  eq(seen.state.undoCalls, 0, `${label}：不撤销`);
  eq(seen.state.organizeCalls, 0, `${label}：没点确认之前绝不许落盘`);

  const ui = seen.ui || readUi(seen);
  ok(ui.planShown === true, `${label}：AI 分好之后应当亮出预览卡（关系链球）`);
  ok(/AI 分好了/.test(ui.planNotice), `${label}：界面要把 AI 那句话原样说出来：「${ui.planNotice}」`);
  ok(/确认之前不会动任何文件|不会动任何文件/.test(ui.planNotice), `${label}：要说清「确认之前不会动任何文件」：「${ui.planNotice}」`);
  ok(/AI/.test(ui.planSummary), `${label}：预览卡标题要写明这是 AI 分法：「${ui.planSummary}」`);
  for (const cat of ['风景照', '合同']) {
    ok(ui.canvas.includes(cat), `${label}：预览里没有 AI 给的分类「${cat}」：${ui.canvas.slice(0, 160)}`);
  }

  // 磁盘：一个字节都没写
  eq(listFiles(ctx.outputDir).length, 0, `${label}：还没点确认，输出目录里不该有文件`);
  eq(countTree(ctx.src).files, seen.srcTreeBefore.files, `${label}：源目录的文件数变了`);
  eq(JSON.stringify(countTree(ctx.src)), JSON.stringify(seen.srcTreeBefore), `${label}：源目录被动过`);

  // 点「取消本次分拣」：一个字节都不写，界面说清「已取消」
  const cancel = seen.run.elements.get('plan-cancel');
  ok(!!cancel, `${label}：找不到「取消本次分拣」按钮`);
  cancel.dispatch('click', { preventDefault() {} });
  return (async () => {
    await settle(30);
    const after = readUi(seen);
    ok(/已取消本次分拣/.test(after.planNotice), `${label}：取消之后要说清「已取消本次分拣」：「${after.planNotice}」`);
    eq(listFiles(ctx.outputDir).length, 0, `${label}：取消之后输出目录里不该有文件`);
    eq(seen.state.organizeCalls, 0, `${label}：取消之后也不许落盘`);
    eq(JSON.stringify(countTree(ctx.src)), JSON.stringify(seen.srcTreeBefore), `${label}：取消之后源目录被动过`);
    return true;
  })();
}

/* ------------------------------------------------------------------ *
 * 内存里现造的坏样本（其它一律照旧，只坏一处），用来反证探针是活的
 * ------------------------------------------------------------------ */

/** 坏样本一：AI 没配好也当成功，照样把方案画出来。 */
function ignoreAiFailure(source) {
  const anchor = 'if (!ai || ai.ok !== true) {';
  if (!source.includes(anchor)) return source;
  return source.replace(anchor, 'if (!ai) {');
}

/** 坏样本二：刚出方案就偷偷把文件复制了（等于「预览」这一步就落盘）。 */
function copiesAtPlanTime(source) {
  const anchor = 'planGraph = buildPlanGraph(base);';
  if (!source.includes(anchor)) return source;
  return source.replace(
    anchor,
    `${anchor} void api.organize(files, outputDir, rulesForUse(), null, assignmentsOf(planGraph));`,
  );
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('=== accept-ai-ui-test: 分拣台「AI 分拣」一键到底的界面接线 ===');
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
    /* ================= 一：常显状态 + 接线 ================= */
    await check('界面上有常显的「AI 分类：未配置」：分拣台按钮旁一打开就有，且界面里只有一处 AI 调用', async () => {
      ok(/id\s*=\s*["']sort-ai["']/.test(html), 'index.html 里没有「AI 分拣」那个按钮（#sort-ai）');
      ok(/id\s*=\s*["']sort-rules["']/.test(html), 'index.html 里没有「规则分拣」那个按钮（#sort-rules）');
      ok(/id\s*=\s*["']ai-status["']/.test(html), 'index.html 里没有常显状态那行（#ai-status）');
      ok(/AI 分类：未配置/.test(html), 'index.html 里没有「AI 分类：未配置」这句常显状态');
      ok(/\.aiClassify\s*\(/.test(rendererTs), 'renderer.ts 里没有调 aiClassify（按钮没接线）');
      ok(/\.aiStatus\s*\(/.test(rendererTs), 'renderer.ts 里没有调 aiStatus（那行状态不会更新）');
      ok(/\.aiClassify\s*\(/.test(rendererJs), '编译产物里没有调 aiClassify');
      ok(/ai:classify/.test(readText(PRELOAD_JS)), 'preload 产物里没有 ai:classify 这条通道');
      ok(/ai:classify/.test(readText(MAIN_JS)), '主进程产物里没有 ai:classify 这条门');
      // 没有第二处 AI 实现：界面里调 aiClassify 的地方只该有一处（就是「AI 分拣」那条路）
      const callsInTs = (rendererTs.match(/\.aiClassify\s*\(/g) || []).length;
      eq(callsInTs, 1, `renderer.ts 里调 aiClassify 的地方该只有一处（实际 ${callsInTs} 处）`);

      // 真跑一遍界面脚本，看那行状态是「跑出来的」而不是只写在 HTML 里
      const ctx = makeCtx(tmpRoot, '常显状态');
      const seen = await startScenario(ctx, rendererJs, 'ui-ai-status.js', { dropOnly: false });
      seen.close();
      ok(seen.problems.length === 0, seen.problems.join(' | '));
      ok(seen.state.aiStatusCalls >= 1, `界面启动时应当查一次 AI 状态（实际查了 ${seen.state.aiStatusCalls} 次）`);
      eq(seen.aiStatusText, 'AI 分类：未配置', '那行常显状态必须显示「AI 分类：未配置」');
      console.log(`      常显状态：「${seen.aiStatusText}」（启动时查了 ${seen.state.aiStatusCalls} 次）`);
    });

    /* ================= 二：AI 未配置 → 直接说清 + 退路 ================= */
    await check(
      '点「AI 分拣」（AI 未配置）：不撤销、不复制、不删任何东西，直接调 AI，并说清「AI 分类还没配置」+ 退路',
      async () => {
        const ctx = makeCtx(tmpRoot, 'AI未配置');
        const seen = await startScenario(ctx, rendererJs, 'ui-ai-unconfigured.js', { dropOnly: true });
        try {
          seen.srcTreeBefore = countTree(ctx.src);
          await clickSort(seen, 'sort-ai');
          assertAiNotConfigured(seen, ctx, '真产物');
          console.log(`      界面「${seen.ui.planNotice}」；撤销 ${seen.state.undoCalls} 次 / AI ${seen.state.aiCalls.length} 次`);
        } finally {
          seen.close();
        }
      },
    );

    /* ================= 三：AI 分好 → 只出方案，不落盘；取消也不写 ================= */
    await check(
      'AI 分好之后只出关系链球、还没落盘：输出目录一个字节都没写；点「取消本次分拣」也不写、源文件没动',
      async () => {
        const ctx = makeCtx(tmpRoot, 'AI只出方案');
        const seen = await startScenario(ctx, rendererJs, 'ui-ai-plan-only.js', {
          dropOnly: true,
          aiResult: {
            ok: true,
            message: 'AI 分好了：2 个（分 2 类）',
            assignments: [
              { source: ctx.files[0], category: '风景照' },
              { source: ctx.files[1], category: '合同' },
            ],
          },
        });
        try {
          seen.srcTreeBefore = countTree(ctx.src);
          await clickSort(seen, 'sort-ai');
          await assertPlanOnlyNoDisk(seen, ctx, '真产物');
          console.log(`      预览：${seen.ui.planSummary}｜提示「${seen.ui.planNotice}」`);
        } finally {
          seen.close();
        }
      },
    );

    /* ================= 四：确认分拣 → 才落盘，按 AI 的分法 ================= */
    await check('点「确认分拣」才落盘：按 AI 给的分类落地，源文件一个没少', async () => {
      const ctx = makeCtx(tmpRoot, 'AI确认落盘');
      const seen = await startScenario(ctx, rendererJs, 'ui-ai-confirm.js', {
        dropOnly: true,
        aiResult: {
          ok: true,
          message: 'AI 分好了：2 个（分 2 类）',
          assignments: [
            { source: ctx.files[0], category: '风景照' },
            { source: ctx.files[1], category: '合同' },
          ],
        },
      });
      try {
        seen.srcTreeBefore = countTree(ctx.src);
        await clickSort(seen, 'sort-ai');
        const confirm = seen.run.elements.get('plan-confirm');
        ok(!!confirm, '找不到「确认分拣」按钮');
        ok(confirm.disabled !== true, '「确认分拣」不该是禁用的（方向没问题、方案也有）');
        confirm.dispatch('click', { preventDefault() {} });
        for (let i = 0; i < 80; i++) await flush();
        await new Promise((resolve) => setTimeout(resolve, 300));
        for (let i = 0; i < 10; i++) await flush();

        eq(seen.state.organizeCalls, 1, '点「确认分拣」应当正好调一次整理接口');
        const sent = seen.state.organizeAssignments || [];
        eq(sent.length, ctx.files.length, '整理接口必须带上 AI 那份「文件 → 分类」表');

        const landed = path.join(ctx.outputDir, '源', '风景照', '风景.jpg');
        ok(fs.existsSync(landed), `输出里没有按 AI 的分类落地：期望 ${landed}，实际 ${JSON.stringify(listFiles(ctx.outputDir))}`);
        ok(
          fs.existsSync(path.join(ctx.outputDir, '源', '合同', '合同.pdf')),
          `第二个文件也没按 AI 的分类落地：${JSON.stringify(listFiles(ctx.outputDir))}`,
        );
        for (const f of ctx.files) ok(fs.existsSync(f), `源文件不见了（只复制不移动）：${f}`);
        eq(countTree(ctx.src).files, seen.srcTreeBefore.files, '源目录的文件数变了');
        const ui = readUi(seen);
        ok(/分拣完了/.test(ui.planNotice), `落盘之后界面要说清结果：「${ui.planNotice}」`);
        console.log(`      落盘：${JSON.stringify(listFiles(ctx.outputDir))}`);
      } finally {
        seen.close();
      }
    });

    /* ================= 五：探针有效性自检 ================= */
    await check(
      '探针有效性自检：「AI 没配好却当成功」「一分拣就偷偷复制」的两个坏样本必须判失败，真产物必须通过',
      async () => {
        // 坏样本一：AI 失败当成成功 → 第 2 条那套判据必须判失败
        const baitA = ignoreAiFailure(rendererJs);
        ok(baitA !== rendererJs, '没能造出「AI 没配好却当成功」的样本');
        const ctxA = makeCtx(tmpRoot, '坏样本-假装成功');
        const seenA = await startScenario(ctxA, baitA, 'ui-ai-bait-a.js', { dropOnly: true });
        let hitA = '';
        try {
          seenA.srcTreeBefore = countTree(ctxA.src);
          await clickSort(seenA, 'sort-ai');
          try {
            assertAiNotConfigured(seenA, ctxA, '坏样本一');
            hitA = '坏样本一居然被判通过了（探针是死的）';
          } catch (err) {
            hitA = `坏样本一被抓到：${(err && err.message) || err}`;
          }
        } finally {
          seenA.close();
        }
        ok(/被抓到/.test(hitA), hitA);
        console.log(`      ${hitA.slice(0, 160)}`);

        // 坏样本二：出方案时就偷偷复制 → 第 3 条那套判据必须判失败
        const baitB = copiesAtPlanTime(rendererJs);
        ok(baitB !== rendererJs, '没能造出「一分拣就偷偷复制」的样本');
        const ctxB = makeCtx(tmpRoot, '坏样本-偷偷复制');
        const seenB = await startScenario(ctxB, baitB, 'ui-ai-bait-b.js', {
          dropOnly: true,
          aiResult: {
            ok: true,
            message: 'AI 分好了：2 个（分 2 类）',
            assignments: [
              { source: ctxB.files[0], category: '风景照' },
              { source: ctxB.files[1], category: '合同' },
            ],
          },
        });
        let hitB = '';
        try {
          seenB.srcTreeBefore = countTree(ctxB.src);
          await clickSort(seenB, 'sort-ai');
          try {
            await assertPlanOnlyNoDisk(seenB, ctxB, '坏样本二');
            hitB = '坏样本二居然被判通过了（探针是死的）';
          } catch (err) {
            hitB = `坏样本二被抓到：${(err && err.message) || err}`;
          }
        } finally {
          seenB.close();
        }
        ok(/被抓到/.test(hitB), hitB);
        console.log(`      ${hitB.slice(0, 160)}`);

        // 真产物用同一套判据，单独再跑一遍（不复用上面的结论）
        const ctxC = makeCtx(tmpRoot, '真产物复验');
        const live = await startScenario(ctxC, rendererJs, 'ui-ai-live-again.js', {
          dropOnly: true,
          aiResult: {
            ok: true,
            message: 'AI 分好了：2 个（分 2 类）',
            assignments: [
              { source: ctxC.files[0], category: '风景照' },
              { source: ctxC.files[1], category: '合同' },
            ],
          },
        });
        try {
          live.srcTreeBefore = countTree(ctxC.src);
          await clickSort(live, 'sort-ai');
          await assertPlanOnlyNoDisk(live, ctxC, '真产物（复验）');
          console.log('      真产物复验通过');
        } finally {
          live.close();
        }
      },
    );
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
