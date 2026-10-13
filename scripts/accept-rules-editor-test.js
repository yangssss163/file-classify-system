/**
 * 验收第 7 条：规则编辑器（界面接线，不依赖真窗口）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 做法（与第 5 条同一套）：把**编译产物当脚本在窗口式桩里真执行**
 *   —— 真 ES module 作用域（vm.SourceTextModule），作用域里没有 exports / module / require。
 *   不许退回字符串匹配当主要证据；字符串检查只用来钉住「那条真实的求值路径还在不在」。
 *
 * 断言：
 *   一、界面里存在：规则列表容器、新增规则按钮、恢复默认按钮、保存规则按钮、加载规则按钮
 *       （源码、编译产物、index.html 三处一起看）；
 *   二、编译产物里「预览」与「整理」都真的把规则表传下去（第三条参数），保存/加载也接到了 api 上；
 *   三、桩里点「新增规则」→ 列表多一行；填一条关键词规则 → 触发预览时**传给预览的规则表里确实含有这条新规则**；
 *   四、桩里点「保存规则」→ 调用到假的保存接口且参数里含刚配的规则；点「加载规则」→ 调用到假的加载接口；
 *       并验证启动时自动读规则、界面显示「当前共 N 条规则」；
 *   五、**探针必须是活的**：拿内存里现造的「旧版界面产物（没有规则列表容器 / 不把规则传给预览）」
 *       喂给检查必须判失败；再用真产物证明它通过。抓不住前者 = 探针是死的 = 本条直接失败；
 *   六、跑界面脚本的过程里，磁盘不许多出任何文件（规则是通过 preload/主进程写的，界面自己不碰文件系统）。
 *
 * 全部通过：stdout 打印「规则编辑器OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:规则编辑器」并 exit 1。
 *
 * 跑法：node --experimental-vm-modules scripts\accept-rules-editor-test.js
 *       （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'out');
const RENDERER_JS = path.join(outDir, 'renderer', 'renderer.js');
const RENDERER_TS = path.join(projectRoot, 'src', 'renderer', 'renderer.ts');
const HTML = path.join(outDir, 'renderer', 'index.html');
const PRELOAD_JS = path.join(outDir, 'preload.js');

/* ---- 全程监听未捕获异常：界面脚本的任何未捕获异常都算失败 ---- */
const uncaught = [];
process.on('uncaughtException', (err) => {
  uncaught.push(`uncaughtException: ${(err && err.message) || err}`);
});
process.on('unhandledRejection', (reason) => {
  uncaught.push(`unhandledRejection: ${(reason && reason.message) || reason}`);
});

function log(line) {
  console.log(line);
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push([name, true]);
      log(`PASS  ${name}`);
      return true;
    })
    .catch((err) => {
      results.push([name, false]);
      log(`FAIL  ${name}`);
      log(`      ${(err && err.message) || err}`);
      return false;
    });
}

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

/* ------------------------------------------------------------------ *
 * 最小 DOM 桩（与第 5 条同一套形状）
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

  // textContent 赋值语义：赋空串等于清空子节点
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

/** 深搜所有子节点，按类名找（桩的 children 就是真 DOM 的子节点列表）。 */
function findByClass(root, className) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.className === className) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function byId(elements, id) {
  return elements.has(id) ? elements.get(id) : null;
}

/* ------------------------------------------------------------------ *
 * 假 window.organizer：真的记录「预览/整理拿到的规则表」「保存/加载被调用过没有」
 * ------------------------------------------------------------------ */

function makeRule(id, name, condition, enabled) {
  return { id, name, enabled: enabled !== false, condition: condition || {} };
}

/** 默认「按后缀分五类」的规则表（与 core 的默认规则同形状）。 */
function defaultsFive() {
  return [
    makeRule('default-1', '01_图片', { extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'] }),
    makeRule('default-2', '02_文档', { extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'] }),
    makeRule('default-3', '03_音视频', { extensions: ['mp3', 'wav', 'mp4', 'mov', 'avi', 'mkv'] }),
    makeRule('default-4', '04_压缩包', { extensions: ['zip', 'rar', '7z', 'tar', 'gz'] }),
    makeRule('default-5', '05_其他', { extensions: [] }),
  ];
}

function makeLocalOrganizer(withRules) {
  const local = {
    pathForFile: () => null,
    pickFiles: async () => [],
    pickOutputDir: async () => null,
    exists: async () => ({}),
    preview: async () => ({ ok: true, tree: { total: 0, folders: [], counts: {}, files: [], readableCount: 0, unreadableCount: 0, outputDir: null, rulesApplied: true } }),
    organize: async () => ({ total: 0, successCount: 0, failureCount: 0, results: [], outputDir: '' }),
    openPath: async () => '',
    loadRules: async () => ({ ok: true, rules: defaultsFive(), source: 'default', message: 'stub 默认规则', filePath: 'stub' }),
    saveRules: async () => ({ ok: true, message: 'stub 已保存', filePath: 'stub' }),
    rulesPath: async () => 'stub',
    onProgress: () => {},
  };
  if (withRules) withRules(local);
  return local;
}

/** 真实跑一条规则编辑器流程用的假 api：记录每次调用与参数。 */
function makeRecordingOrganizer(overrides) {
  const calls = { preview: [], organize: [], save: [], load: 0, loadOptions: [] };
  const organizer = makeLocalOrganizer((local) => {
    local.loadRules = async () => {
      calls.load++;
      const options = overrides && overrides.loadResults ? overrides.loadResults.slice() : [];
      const next = options.length > 0 ? options.shift() : { ok: true, rules: defaultsFive(), source: 'file', message: '已读取上次保存的 5 条规则', filePath: 'stub-rules.json' };
      calls.loadOptions = options;
      calls.lastLoad = next;
      return next;
    };
    // 注意：只改同一个对象上的方法（界面脚本加载时就把 window.organizer 抓成了局部常量）
    local.preview = async (files, outputDir, rules) => {
      calls.preview.push({ files, outputDir, rules });
      return {
        ok: true,
        tree: {
          total: Array.isArray(files) ? files.length : 0,
          folders: [{ folder: '发票', count: 1, files: [{ path: 'x', name: 'x', ext: '', folder: '发票', readable: true, error: null }] }],
          counts: { 发票: 1 },
          files: [],
          readableCount: 1,
          unreadableCount: 0,
          outputDir: 'stub-out',
          rulesApplied: true,
        },
      };
    };
    local.organize = async (files, outputDir, rules) => {
      calls.organize.push({ files, outputDir, rules });
      return { total: 0, successCount: 0, failureCount: 0, results: [], outputDir: 'stub-out' };
    };
    local.saveRules = async (rules) => {
      calls.save.push(rules);
      return { ok: true, message: '已保存 ' + (Array.isArray(rules) ? rules.length : 0) + ' 条规则到 stub-rules.json', filePath: 'stub-rules.json' };
    };
    local.exists = async (paths) => {
      const map = {};
      for (const p of paths || []) map[p] = true;
      return map;
    };
    local.pickOutputDir = async () => 'stub-out';
  });
  return { organizer, calls };
}

/** 把一个界面产物真跑一遍：真 ES module 作用域 + 窗口式桩。 */
async function runInWindowStub(source, label, organizer, options) {
  const opts = options || {};
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('node was started without --experimental-vm-modules, so a real ES-module scope cannot be built');
  }
  const elements = new Map();
  const documentStub = opts.documentStub || {
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
  const windowStub = {
    organizer,
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
  try {
    const mod = new vm.SourceTextModule(source, { identifier: label });
    await mod.link(() => {
      throw new Error(`${label} must not import anything at load time`);
    });
    await mod.evaluate();
  } catch (err) {
    error = `${err.constructor.name}: ${err.message}`;
  }
  await flush();
  if (!error && uncaught.length > before) {
    error = `uncaught: ${uncaught.slice(before).join(' | ')}`;
  }
  return { error, elements, documentStub, windowStub, windowEl };
}

/* ------------------------------------------------------------------ *
 * 旧版界面产物（纯内存字符串，不落盘）：没有规则列表容器、也不把规则传给预览
 * ------------------------------------------------------------------ */

const LEGACY_RULE_PRODUCT = [
  '// 旧版界面产物：规则编辑器还不存在',
  'const api = window.organizer;',
  'const el = {',
  "  preview: document.getElementById('preview'),",
  "  fileCount: document.getElementById('file-count'),",
  '};',
  'let selectedFiles = [];',
  'let outputDir = null;',
  'function add(a, b) { return a + b; }',
  'el.preview.addEventListener("click", () => {',
  '  api.preview(selectedFiles, outputDir);',
  '});',
  'document.getElementById("rule-add").addEventListener("click", () => { document.getElementById("rule-list").textContent = ""; });',
].join('\n');

/**
 * 内存里现造的「新规则追加到末尾」的界面产物：
 * 规则编辑器该有的元素都在、预览也把规则传下去了（所以别的判据都过得去），
 * 只有插入位置不对 —— `currentRules.push(...)` 把新规则放到了所有已有规则后面。
 * 用来反证「新增规则排在第一行」这条断言是活的。
 */
const APPEND_PRODUCT = [
  '// 有缺陷的界面产物：新增规则被追加到末尾（不会优先命中）',
  'const api = window.organizer;',
  'const el = {',
  "  add: document.getElementById('rule-add'),",
  "  list: document.getElementById('rule-list'),",
  "  def: document.getElementById('rule-default'),",
  "  save: document.getElementById('rule-save'),",
  "  load: document.getElementById('rule-load'),",
  "  preview: document.getElementById('preview'),",
  "  pickOut: document.getElementById('pick-out'),",
  "  drop: document.getElementById('drop'),",
  '};',
  'let currentRules = [];',
  'let selectedFiles = [];',
  'let outputDir = null;',
  'api.loadRules().then((result) => { currentRules = (result && result.rules) || []; draw(); });',
  'function draw() {',
  "  el.list.textContent = '';",
  '  currentRules.forEach((rule) => {',
  "    const row = document.createElement('div');",
  "    row.className = 'rule-row';",
  "    const name = document.createElement('input');",
  "    name.className = 'rule-name';",
  '    name.value = rule.name;',
  '    row.appendChild(name);',
  '    el.list.appendChild(row);',
  '  });',
  '}',
  'el.add.addEventListener("click", () => {',
  '  // 缺陷：追加到末尾（新规则不优先）',
  "  currentRules.push({ id: 'x' + currentRules.length, name: '新分类', enabled: true, condition: {} });",
  '  draw();',
  '});',
  'el.def.addEventListener("click", () => { api.loadRules().then((r) => { currentRules = r.rules; draw(); }); });',
  'el.save.addEventListener("click", () => { api.saveRules(currentRules); });',
  'el.load.addEventListener("click", () => { api.loadRules().then((r) => { currentRules = r.rules; draw(); }); });',
  'el.preview.addEventListener("click", () => { api.preview(selectedFiles, outputDir, currentRules); });',
  'el.pickOut.addEventListener("click", () => { api.pickOutputDir().then((d) => { outputDir = d; }); });',
  'el.drop.addEventListener("drop", (ev) => { selectedFiles = selectedFiles.concat(Array.from(ev.dataTransfer.files)); });',
].join('\n');

/* ------------------------------------------------------------------ *
 * 探针本体（只用来钉住「那条真实的求值路径还在不在」；主要证据是第三条的真执行）
 * ------------------------------------------------------------------ */

const RULE_ELEMENT_IDS = ['rule-list', 'rule-add', 'rule-default', 'rule-save', 'rule-load'];

/** 给一个界面产物：它有没有把「规则表」当第三个参数传给预览？返回证据数组（空 = 找不到）。 */
function findRuleArgsInPreview(productSource) {
  const hits = [];
  const callRe = /\bapi\.preview\s*\(/g;
  let m;
  while ((m = callRe.exec(productSource)) !== null) {
    const args = splitArgs(productSource, callRe.lastIndex);
    if (args === null) continue;
    if (args >= 3) hits.push(`preview(${args} args)`);
  }
  return hits;
}

/** 从 '(' 之后开始按括号配对切分参数，返回参数个数；括号不配平返回 null。 */
function splitArgs(source, from) {
  let depth = 1;
  let args = 0;
  let seenAny = false;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return seenAny ? args + 1 : 0;
    } else if (c === ',' && depth === 1) {
      args++;
    } else if (depth === 1 && !/\s/.test(c)) {
      seenAny = true;
    }
  }
  return null;
}

/** 这个「产物文本 + DOM 桩」跑起来之后，规则编辑器是不是真接线了？返回证据数组（空 = 没问题）。 */
async function inspectRuleEditor(productSource, label) {
  const hits = [];

  // A. 真执行一遍，看它到底碰了哪些元素
  const run = await runInWindowStub(productSource, label, makeLocalOrganizer());
  if (run.error) {
    hits.push(`execution failed: ${run.error}`);
    return hits;
  }

  // B. 规则相关的元素必须真的被查过
  for (const id of RULE_ELEMENT_IDS) {
    if (!run.elements.has(id)) hits.push(`element never looked up: #${id}`);
  }

  // C. 列表容器里必须能装行（初始化时挂上东西），或者它是个真空壳
  const listEl = byId(run.elements, 'rule-list');
  if (!listEl) hits.push('no #rule-list element at all');
  else if (!Array.isArray(listEl.children)) hits.push('#rule-list has no children array');

  // D. 真实那条求值路径：预览必须拿到规则表（第三个参数）
  const previewHits = findRuleArgsInPreview(productSource);
  if (previewHits.length === 0) hits.push('no .preview(...) call with a rules argument');

  return hits;
}

/**
 * 「新增规则必须排在第一行」这条断言本体：在窗口式桩里真点「新增规则」，看行的顺序。
 * 返回证据数组（空 = 没问题）。
 */
async function inspectAddRuleGoesFirst(productSource, label, expectedDefaultCount) {
  const hits = [];
  const recording = makeRecordingOrganizer();
  const run = await runInWindowStub(productSource, label, recording.organizer);
  if (run.error) {
    hits.push(`execution failed: ${run.error}`);
    return hits;
  }
  const listEl = byId(run.elements, 'rule-list');
  if (!listEl) {
    hits.push('no #rule-list element');
    return hits;
  }
  const rowNames = () =>
    findByClass(listEl, 'rule-row').map((row) => {
      const field = findByClass(row, 'rule-name')[0];
      return field ? String(field.value) : '';
    });

  const before = rowNames();
  if (before.length !== expectedDefaultCount) {
    hits.push(`starting list should be the defaults (${expectedDefaultCount} rows), got ${before.length}`);
    return hits;
  }
  const lastBefore = before[before.length - 1];

  const addBtn = byId(run.elements, 'rule-add');
  if (!addBtn) {
    hits.push('no #rule-add button');
    return hits;
  }

  // 第 1 次新增：新规则必须在第一行，原来那几条整体往后挪一位、相对顺序不变
  addBtn.dispatch('click', { preventDefault() {} });
  await flush();
  const afterFirst = rowNames();
  if (afterFirst.length !== expectedDefaultCount + 1) {
    hits.push(`after the 1st add the list should have ${expectedDefaultCount + 1} rows, got ${afterFirst.length}`);
    return hits;
  }
  if (afterFirst[afterFirst.length - 1] !== lastBefore) {
    hits.push(`the last row changed after adding: it became "${afterFirst[afterFirst.length - 1]}" (it was "${lastBefore}") -> the new rule was not put in front`);
  }
  if (afterFirst[0] === before[0]) {
    hits.push(`the 1st row did not change after adding ("${before[0]}") -> the new rule was not put in front`);
  }
  if (afterFirst.slice(1).join('|') !== before.join('|')) {
    hits.push(`the existing rules did not shift down keeping their order: [${before.join(' | ')}] -> [${afterFirst.slice(1).join(' | ')}]`);
  }
  const firstNew = afterFirst[0];

  // 第 2 次新增：新加的那条仍然在第一行，上一次那条挪到第二行
  addBtn.dispatch('click', { preventDefault() {} });
  await flush();
  const afterSecond = rowNames();
  if (afterSecond.length !== expectedDefaultCount + 2) {
    hits.push(`after the 2nd add the list should have ${expectedDefaultCount + 2} rows, got ${afterSecond.length}`);
    return hits;
  }
  // 真的多画了一行（不是原地替换），所以只要行数对、第一行是刚加的那条、第二行是上一次那条即可
  if (afterSecond[0] === before[0]) {
    hits.push(`after the 2nd add the 1st row is "${afterSecond[0]}" -> the new rule did not take the first row`);
  }
  if (afterSecond[1] !== firstNew) {
    hits.push(`after the 2nd add the 2nd row should still be the rule added 1st ("${firstNew}"), got "${afterSecond[1]}"`);
  }
  if (afterSecond.slice(2).join('|') !== before.join('|')) {
    hits.push(`the existing rules did not shift down again keeping their order: [${afterSecond.slice(2).join(' | ')}]`);
  }

  // 列表顺序就是求值顺序：送给保存接口的规则表必须与行顺序一致，新规则仍在第一行
  const saveBtn = byId(run.elements, 'rule-save');
  if (saveBtn) {
    saveBtn.dispatch('click', { preventDefault() {} });
    await flush();
    const saved = recording.calls.save[recording.calls.save.length - 1];
    if (!Array.isArray(saved)) {
      hits.push('saveRules was not called with a rules array');
    } else {
      const savedNames = saved.map((r) => r.name);
      if (savedNames.join('|') !== afterSecond.join('|')) {
        hits.push(`what gets saved does not follow the row order: [${savedNames.join(' | ')}] vs [${afterSecond.join(' | ')}]`);
      }
      if (savedNames[0] !== firstNew) {
        hits.push('the new rule is not first in the rules table handed to save');
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

(async () => {
  log('=== accept-rules-editor-test: the rule editor must be wired to preview/organize and to save/load ===');
  log(`project root: ${projectRoot}`);

  if (typeof vm.SourceTextModule !== 'function') {
    log('');
    log('FAIL: node must be started with --experimental-vm-modules for this check (see scripts/验收.ps1)');
    log('验收失败:规则编辑器');
    process.exitCode = 1;
    return;
  }

  for (const p of [RENDERER_JS, RENDERER_TS, HTML, PRELOAD_JS]) {
    if (!fs.existsSync(p)) {
      log(`FAIL: missing ${p} (run npm run build first)`);
      log('验收失败:规则编辑器');
      process.exitCode = 1;
      return;
    }
  }

  const rendererJs = readText(RENDERER_JS);
  const rendererTs = readText(RENDERER_TS);
  const html = readText(HTML);
  const preloadJs = readText(PRELOAD_JS);
  let tmpRoot = null;

  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-rules-editor-'));
    log(`temp work dir: ${tmpRoot}`);

    /* ---------- 一、界面里存在这些部件 ---------- */
    await check('存在：规则列表容器、新增规则、恢复默认、保存规则、加载规则', () => {
      for (const id of RULE_ELEMENT_IDS) {
        ok(new RegExp(`id\\s*=\\s*["']${id}["']`).test(html), `index.html 里没有 #${id}`);
        ok(new RegExp(id.replace('-', '\\-')).test(rendererTs), `renderer.ts 里没有引用 #${id}`);
        ok(new RegExp(id.replace('-', '\\-')).test(rendererJs), `编译产物 out/renderer/renderer.js 里没有引用 #${id}`);
      }
      // api-types / preload 侧：保存与加载必须真的接到 ipc 上
      ok(/rules:save/.test(preloadJs), 'preload 产物里没有 rules:save');
      ok(/rules:load/.test(preloadJs), 'preload 产物里没有 rules:load');
      ok(/rules:save/.test(readText(path.join(outDir, 'main.js'))), '主进程产物里没有 rules:save');
      ok(/rules:load/.test(readText(path.join(outDir, 'main.js'))), '主进程产物里没有 rules:load');
    });

    /* ---------- 二、预览与整理都把规则表传下去 ---------- */
    await check('编译产物：预览与整理都带上规则表（第三个参数）', () => {
      ok(findRuleArgsInPreview(rendererJs).length > 0, 'out/renderer/renderer.js 里没有把规则传给预览');
      ok(findRuleArgsInPreview(rendererTs).length > 0, 'src/renderer/renderer.ts 里没有把规则传给预览');
      const organizeCalls = rendererJs.match(/\.organize\s*\([^)]*\)/g) || [];
      ok(
        organizeCalls.some((c) => c.split(',').length >= 3),
        `out/renderer/renderer.js 里没有把规则传给整理（找到的调用：${organizeCalls.join(' | ') || '无'}）`,
      );
      ok(/\.saveRules\s*\(/.test(rendererJs), 'out/renderer/renderer.js 里没有调用保存规则');
      ok(/\.loadRules\s*\(/.test(rendererJs), 'out/renderer/renderer.js 里没有调用加载规则');
    });

    /* ---------- 三、桩里真点一遍：新增规则 → 填关键词 → 预览拿到这条规则 ---------- */
    const recording = makeRecordingOrganizer();
    const live = await runInWindowStub(rendererJs, 'current-renderer.js', recording.organizer);
    const liveErr = live.error;
    const rows = () => findByClass(byId(live.elements, 'rule-list'), 'rule-row');

    await check('真执行：界面脚本在窗口式桩里跑到底、没有未捕获异常', () => {
      ok(!liveErr, `执行 out/renderer/renderer.js 失败 -> ${liveErr}`);
      ok(byId(live.elements, 'rule-list'), '没有 #rule-list 元素');
    });

    await check('启动时自动读规则，并一眼看出「当前共 N 条规则」', () => {
      eq(recording.calls.load, 1, '启动时应当自动调用一次加载规则');
      eq(rows().length, 5, '默认规则应当画出 5 行');
      const countText = String((byId(live.elements, 'rule-count') || {}).textContent || '');
      ok(/当前共\s*5\s*条规则/.test(countText), `规则条数文字不对：「${countText}」`);
    });

    await check('点「新增规则」→ 列表多一行；填关键词规则 → 传给预览的规则表里含这条新规则', async () => {
      const addBtn = byId(live.elements, 'rule-add');
      const before = rows().length;
      addBtn.dispatch('click', { preventDefault() {} });
      await flush();
      eq(rows().length, before + 1, '点新增规则之后的规则行数');

      // 给这一行填：规则名 = 发票，关键词 = 发票。新增的规则在第一行，所以这一行就是 rows()[0]
      const rowList = rows();
      const newRow = rowList[0];
      const nameField = findByClass(newRow, 'rule-name')[0];
      const keyField = findByClass(newRow, 'rule-keywords')[0];
      ok(nameField, '新增的行里没有规则名输入框');
      ok(keyField, '新增的行里没有关键词输入框');
      nameField.value = '发票';
      keyField.value = '发票';
      nameField.dispatch('input', { target: nameField });
      keyField.dispatch('input', { target: keyField });
      await flush();

      // 选文件 + 输出目录，然后点预览
      live.windowStub.organizer.pathForFile = () => path.join(tmpRoot, 'r1.txt');
      byId(live.elements, 'drop').dispatch('drop', {
        preventDefault() {},
        dataTransfer: { files: [{ name: 'r1.txt' }] },
      });
      await flush();
      const pickOutBtn = byId(live.elements, 'pick-out');
      pickOutBtn.dispatch('click', { preventDefault() {} });
      await flush();

      byId(live.elements, 'preview').dispatch('click', { preventDefault() {} });
      await flush();
      eq(recording.calls.preview.length, 1, '点预览应当调用一次预览接口');
      const sent = recording.calls.preview[0].rules;
      ok(Array.isArray(sent), '预览的第三个参数必须是规则表数组');
      eq(sent.length, 6, '传给预览的规则条数（5 条默认 + 1 条新规则）');
      const hit = sent.find((r) => Array.isArray(r.condition && r.condition.keywords) && r.condition.keywords.indexOf('发票') >= 0);
      ok(hit, `传给预览的规则表里没有刚配的关键词规则：${JSON.stringify(sent.map((r) => r.name))}`);
      eq(hit.name, '发票', '新规则的规则名');
      ok(sent.indexOf(hit) === 0, '新规则应当排在第一行（列表顺序 = 求值顺序，最优先命中）');
      // 界面上还要能看出「预览用的是当前规则」
      const warn = String((byId(live.elements, 'preview-warning') || {}).textContent || '');
      const summary = String((byId(live.elements, 'preview-summary') || {}).textContent || '');
      ok(/预览/.test(warn), `预览提示不对：「${warn}」`);
      ok(/当前规则\s*（共\s*6\s*条/.test(summary), `预览说明里应当写清用的是当前规则共 6 条：「${summary}」`);
    });

    await check('点「保存规则」→ 调到假的保存接口且参数里含刚配的规则；点「加载规则」→ 调到假的加载接口', async () => {
      byId(live.elements, 'rule-save').dispatch('click', { preventDefault() {} });
      await flush();
      eq(recording.calls.save.length, 1, '点保存规则应当调用一次保存接口');
      const saved = recording.calls.save[0];
      ok(Array.isArray(saved), '保存接口的参数必须是规则表数组');
      eq(saved.length, 6, '保存下去的规则条数');
      const savedHit = saved.find((r) => r.name === '发票');
      ok(savedHit, `保存的参数里没有刚配的规则：${JSON.stringify(saved.map((r) => r.name))}`);
      eq(JSON.stringify(savedHit.condition.keywords), JSON.stringify(['发票']), '保存下去的关键词条件');
      ok(savedHit.enabled !== false, '保存下去的规则应当是启用的');
      const statusText = String((byId(live.elements, 'rule-status') || {}).textContent || '');
      ok(/已保存\s*6\s*条规则/.test(statusText), `保存成功提示不对：「${statusText}」`);

      // 加载：假的加载接口必须被调到，并且把规则换回读回来的那一套
      const before = recording.calls.load;
      byId(live.elements, 'rule-load').dispatch('click', { preventDefault() {} });
      await flush();
      eq(recording.calls.load, before + 1, '点加载规则应当调用一次加载接口');
      eq(rows().length, 5, '加载之后规则行数应当回到读回来的 5 条');
      const countText = String((byId(live.elements, 'rule-count') || {}).textContent || '');
      ok(/当前共\s*5\s*条规则/.test(countText), `加载后的条数文字不对：「${countText}」`);
    });

    await check('点「恢复默认规则」→ 取回默认规则表并画出 5 行', async () => {
      const before = recording.calls.load;
      byId(live.elements, 'rule-default').dispatch('click', { preventDefault() {} });
      await flush();
      eq(recording.calls.load, before + 1, '恢复默认应当从主进程取一份规则表');
      eq(rows().length, 5, '恢复默认之后的规则行数');
    });

    /* ---------- 四、新增规则必须排在第一行（列表顺序 = 求值顺序） ---------- */
    await check('新增规则排在第一行：默认 5 条时连点两次「新增规则」，新规则都在第一行、原来五条整体后移一位', async () => {
      const hits = await inspectAddRuleGoesFirst(rendererJs, 'current-renderer.js', 5);
      ok(hits.length === 0, `新增规则没排在第一行：${hits.join(' | ')}`);
      // 反证：探针必须是活的 —— 拿「新规则追加到末尾」的产物喂进去必须判失败
      const deadHits = await inspectAddRuleGoesFirst(APPEND_PRODUCT, 'append-product.js', 5);
      ok(deadHits.length > 0, '追加到末尾的产物被说 OK —— 这条断言是死的');
      log(`      反证（追加到末尾的产物被抓到）：${deadHits.slice(0, 3).join(' | ')}`);
      // 真产物里现存规则的顺序也不许被动过（新增只插入一行，不重排）
      const names = rows().map((row) => {
        const field = findByClass(row, 'rule-name')[0];
        return field ? String(field.value) : '';
      });
      eq(names.join('|'), '01_图片|02_文档|03_音视频|04_压缩包|05_其他', '恢复默认后的行顺序');
    });

    /* ---------- 五、探针必须是活的 ---------- */
    await check('探针有效性自检：拿旧版界面产物（没有规则列表容器 / 不把规则传给预览）必须判失败', async () => {
      const dead = await inspectRuleEditor(LEGACY_RULE_PRODUCT, 'legacy-rule-product.js');
      ok(dead.length > 0, '探针对旧版界面产物说 OK —— 探针是死的');
      log(`      旧产物被抓到的证据（前 3 条）：${dead.slice(0, 3).join(' | ')}`);

      // 只补上「把规则传给预览」，仍然没有规则列表容器 → 必须还是判失败
      const half = LEGACY_RULE_PRODUCT.replace('api.preview(selectedFiles, outputDir);', 'api.preview(selectedFiles, outputDir, currentRules);');
      const halfHits = await inspectRuleEditor(half, 'legacy-rule-product-half.js');
      ok(halfHits.length > 0, '没有规则列表容器的产物被说 OK —— 探针是死的');

      // 「不把规则传给预览」的产物：全部元素都在、也画得出规则行，就是预览少传了规则 → 必须判失败
      const noRulesToPreview = APPEND_PRODUCT.split('api.preview(selectedFiles, outputDir, currentRules)').join('api.preview(selectedFiles, outputDir)');
      ok(noRulesToPreview !== APPEND_PRODUCT, '没能造出「不把规则传给预览」的产物样本');
      const noRulesHits = await inspectRuleEditor(noRulesToPreview, 'rule-editor-without-rules-arg.js');
      ok(noRulesHits.length > 0, '不把规则传给预览的产物被说 OK —— 探针是死的');
      log(`      不把规则传给预览的产物被抓到：${noRulesHits.slice(0, 3).join(' | ')}`);

      // 反过来：真产物里只把「传给预览的规则」这一项抽掉 → 必须被判失败（说明规则参数这一条探针是活的）
      const liveTarget = 'api.preview(selectedFiles.slice(), outputDir, rulesForUse())';
      ok(rendererJs.indexOf(liveTarget) >= 0, '真产物里找不到「把规则传给预览」那一行（探针要钉的就是它）');
      const crippled = rendererJs.split(liveTarget).join('api.preview(selectedFiles.slice(), outputDir)');
      const crippledHits = await inspectRuleEditor(crippled, 'current-renderer-without-rules.js');
      ok(crippledHits.length > 0, '不把规则传给预览的产物被说 OK —— 探针是死的');
      log(`      只抽掉「规则传给预览」后的证据：${crippledHits.slice(0, 3).join(' | ')}`);

      // 真产物必须通过
      const liveHits = await inspectRuleEditor(rendererJs, 'current-renderer.js');
      ok(liveHits.length === 0, `真产物被判不合格（探针误报）：${liveHits.join(' | ')}`);
      log('      探针：旧产物判失败、抽掉规则传参判失败、真产物判通过');
    });

    /* ---------- 六、界面脚本自己不碰磁盘 ---------- */
    await check('跑界面脚本的过程里磁盘不多出任何文件（规则是由主进程/preload 写的）', () => {
      ok(!/require\s*\(\s*['"](?:node:)?fs['"]/.test(rendererJs.replace(/\/\/[^\n]*/g, '')), '界面产物里出现了 require(fs)');
      ok(!/writeFile/.test(rendererJs), '界面产物里出现了写文件调用');
      ok(!/writeFile/.test(preloadJs), 'preload 产物里直接写了文件（应该交给主进程）');
      // 项目文件夹与输出目录里不许出现规则文件
      const strays = ['out', 'dist'].map((d) => path.join(projectRoot, d)).filter((p) => fs.existsSync(path.join(p, 'organizer-rules.json')));
      eq(strays.length, 0, `项目文件夹里出现了规则文件：${strays.join(', ')}`);
    });
  } catch (err) {
    log(`FAIL: 测试过程本身出错 -> ${(err && err.stack) || err}`);
    results.push(['unexpected-error', false]);
  } finally {
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判定 */
      }
    }
  }

  log('');
  log('--- summary ---');
  let allOk = results.length > 0;
  for (const [name, pass] of results) {
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) allOk = false;
  }
  if (uncaught.length > 0) {
    for (const u of uncaught) log(`FAIL: uncaught during the whole run -> ${u}`);
    allOk = false;
  }
  if (allOk) {
    log('规则编辑器OK');
    process.exitCode = 0;
  } else {
    log('验收失败:规则编辑器');
    process.exitCode = 1;
  }
})();

