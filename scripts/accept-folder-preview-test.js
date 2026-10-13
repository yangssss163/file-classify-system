/**
 * 验收第 9 条：文件夹预览（界面接线，不依赖真窗口）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 做法（与第 5、7 条同一套）：把**编译产物当脚本在窗口式桩里真执行**
 *   —— 真 ES module 作用域（vm.SourceTextModule），作用域里没有 exports / module / require。
 *   不许退回字符串匹配当主要证据。
 *
 * 断言：
 *   一、界面里有「选择文件夹」按钮（源码、编译产物、index.html 三处一起看），产物里真的会调 api.pickFolders 与 api.expand；
 *   二、桩里模拟拖入一个文件夹路径（假的 api 返回「这是个文件夹」+ 一批子文件）：
 *       界面显示「来自 M 个文件夹」，并且**按源文件夹分组**画出预览（分组节点 + 每一份下面的分类夹）；
 *   三、桩里点「选择文件夹」按钮 → 调到假的对应接口（api.pickFolders）；
 *   四、预览前**一份磁盘都没有被写**（被观察目录的文件数与目录数不变）；
 *   五、**探针必须是活的**：用内存里现造的「不支持文件夹」的旧版界面产物喂给这套断言，**必须判失败**；
 *       再用真产物证明通过。抓不住 = 探针是死的 = 本条失败。
 *
 * 全部通过：stdout 打印「文件夹预览OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:文件夹预览」并 exit 1。
 *
 * 跑法：node --experimental-vm-modules scripts\accept-folder-preview-test.js
 *       （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const outDir = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
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

/**
 * 产物里「把规则表传给预览」那一行，第 7 条验收（规则编辑器）用**字面量**钉着它：
 *   api.preview(selectedFiles.slice(), outputDir, rulesForUse())
 * 为了不放松那条已有判据，本片**一个字都没改它**：源文件夹另走 `api.setSourceRoots(roots)`
 * 这条路送进主进程（界面侧「放好 → 点预览 → 用完清掉」）。
 *
 * 所以本条的探针副本就是**真产物本身**（不改一行）；探针要查的是：
 * 「拖入文件夹之后，界面有没有把源文件夹放下去（setSourceRoots）」。
 * 反证副本则把 `setSourceRoots` 那一步抽掉 —— 必须判失败。
 */
const SET_ROOTS_CALL = 'api.setSourceRoots(selectedRoots.slice());';

/** 反证副本：把「放下源文件夹」这一步抽掉（其余照旧）→ 必须判失败。 */
function withoutSetSourceRoots(productSource) {
  if (productSource.split(SET_ROOTS_CALL).length !== 2) return productSource;
  return productSource.split(SET_ROOTS_CALL).join('void 0;');
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
 * 最小 DOM 桩（与第 5、7 条同一套形状）
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

/** 深搜所有子节点（桩的 children 就是真 DOM 的子节点列表）。 */
function walk(node, visit) {
  for (const child of node.children || []) {
    visit(child);
    walk(child, visit);
  }
}

/** 深搜按类名找节点。 */
function findByClass(root, className) {
  const out = [];
  walk(root, (node) => {
    if (node.className === className) out.push(node);
  });
  return out;
}

/** 把一棵桩节点的可见文字拼起来（含子节点）。 */
function textOf(root) {
  let out = String(root.textContent || '');
  for (const child of root.children || []) out += `\n${textOf(child)}`;
  return out;
}

/**
 * 某个节点下面有没有「更深一层的分组节点」——
 * 用来证明预览是**分组**画的（源文件夹一份 → 下面再是分类夹），而不是一长串平铺的文件夹名。
 */
function hasNestedGroup(node, className) {
  let found = false;
  walk(node, (child) => {
    if (child.className === className) found = true;
  });
  return found;
}

/* ------------------------------------------------------------------ *
 * 假 window.organizer：记录调用 + 给出一份按源文件夹分组的预览树
 * ------------------------------------------------------------------ */

/** 事实上的测试结构：一个顶层文件夹「下载」（下面有子文件夹），外加第二个顶层文件夹「另一处」。 */
function makeFixture(tmpRoot) {
  const srcRoot = path.join(tmpRoot, 'src');
  const files = {
    [path.join(srcRoot, '下载', '散1.jpg')]: '01_图片',
    [path.join(srcRoot, '下载', '散2.pdf')]: '02_文档',
    [path.join(srcRoot, '下载', '照片', '图1.png')]: '01_图片',
    [path.join(srcRoot, '下载', '照片', '婚纱', '纱1.jpg')]: '01_图片',
    [path.join(srcRoot, '下载', '文档', '文1.docx')]: '02_文档',
    [path.join(srcRoot, '另一处', '照片', '图2.png')]: '01_图片',
  };
  for (const p of Object.keys(files)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x', 'utf8');
  }
  return { srcRoot, files };
}

/** 假 api：exists 认文件夹、expand 递归展开、setSourceRoots 收下源文件夹、preview 按源文件夹分组。 */
function makeOrganizer(opts) {
  const o = opts || {};
  const state = {
    expandCalls: [],
    pickFoldersCalls: 0,
    previewCalls: [],
    organizeCalls: [],
    setRootsCalls: [],
    /** 界面通过 setSourceRoots 放下的那批源文件夹（真程序里由主进程保管） */
    pendingRoots: [],
  };
  const files = o.files || {};
  const roots = o.roots || [];
  const core = o.core;

  const api = {
    pathForFile: (file) => (file && file.__path) || null,
    pickFiles: async () => [],
    pickFolders: async () => {
      state.pickFoldersCalls++;
      return o.pickFoldersResult || [];
    },
    pickOutputDir: async () => o.outputDir || 'stub-out',
    exists: async (paths) => {
      const map = {};
      for (const p of paths || []) {
        const lower = String(p).toLowerCase();
        const isFile = Object.keys(files).some((f) => f.toLowerCase() === lower);
        const isDir = roots.some((r) => lower === String(r).toLowerCase() || lower.startsWith(String(r).toLowerCase() + '\\'));
        map[p] = isFile ? true : isDir ? false : false;
      }
      return map;
    },
    expand: async (list) => {
      state.expandCalls.push(list);
      if (!core || typeof core.expandFolders !== 'function') {
        throw new Error('测试自身没拿到 core.expandFolders');
      }
      return core.expandFolders(list);
    },
    /** 界面点预览前把源文件夹放下来：这里记下来，preview 时按它算分组 */
    setSourceRoots: async (list) => {
      state.setRootsCalls.push(list === null || list === undefined ? null : Array.from(list));
      state.pendingRoots = list === null || list === undefined ? [] : Array.from(list);
      return true;
    },
    preview: async (fileList, outputDir, rules) => {
      const rootList = state.pendingRoots.slice();
      state.previewCalls.push({ files: fileList, outputDir, rules, roots: rootList });
      if (!core || typeof core.buildPreviewTree !== 'function') {
        throw new Error('测试自身没拿到 core.buildPreviewTree');
      }
      return core.buildPreviewTree({ files: fileList, roots: rootList, outputDir, rules: rules || null });
    },
    organize: async (fileList, outputDir, rules, rootList) => {
      state.organizeCalls.push({ files: fileList, outputDir, rules, roots: rootList });
      return { total: 0, successCount: 0, failureCount: 0, results: [], outputDir, plannedFolders: [], skipped: [] };
    },
    openPath: async () => '',
    loadRules: async () => ({ ok: true, rules: [], source: 'default', message: 'stub', filePath: 'stub' }),
    saveRules: async () => ({ ok: true, message: 'stub', filePath: 'stub' }),
    rulesPath: async () => 'stub',
    onProgress: () => {},
  };
  return { api, state };
}

/**
 * 把一个界面产物真跑一遍：真 ES module 作用域 + 窗口式桩。
 * 注意：`global.document` / `global.window` 必须留到**整个交互过程结束**才还原 ——
 * 界面脚本的点击/drop 回调是异步的，一还原就会在回调里读到 undefined 的 document。
 * 所以这里返回一个 `restore()`，由调用方在所有交互与 await 之后调用。
 */
async function runInWindowStub(source, label, organizer) {
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
  return { error, elements, windowStub, windowEl, restore };
}

/* ------------------------------------------------------------------ *
 * 旧语义的界面产物（纯内存字符串，不落盘）：
 * 「按旧语义」——文件夹能被展开了，但子文件夹里的文件也被塞进分类夹，
 * 所以预览按分类夹平铺、也没有那句「子文件夹按原样保留」的说明。
 * 这条当诱饵，证明本条探针抓得住「语义变了但界面没跟着改」。
 * ------------------------------------------------------------------ */

const LEGACY_CLASSIFY_ALL_PRODUCT = [
  '// 旧语义界面产物：子文件夹里的文件也被塞进分类夹（分组说明也没有）',
  'const api = window.organizer;',
  'const el = {',
  "  drop: document.getElementById('drop'),",
  "  pickFolders: document.getElementById('pick-folders'),",
  "  pickFiles: document.getElementById('pick-files'),",
  "  pickOut: document.getElementById('pick-out'),",
  "  fileCount: document.getElementById('file-count'),",
  "  notice: document.getElementById('notice'),",
  "  skipped: document.getElementById('skipped'),",
  "  preview: document.getElementById('preview'),",
  "  previewWarning: document.getElementById('preview-warning'),",
  "  previewTree: document.getElementById('preview-tree'),",
  "  previewSummary: document.getElementById('preview-summary'),",
  '};',
  'let selectedFiles = [];',
  'let selectedRoots = [];',
  'let outputDir = null;',
  'function merge(files) { for (const p of files) if (selectedFiles.indexOf(p) < 0) selectedFiles.push(p); }',
  'function accept(paths) {',
  '  api.exists(paths).then((map) => {',
  '    const files = []; const folders = [];',
  '    for (const p of paths) { if (map[p] === true) files.push(p); else folders.push(p); }',
  '    merge(files);',
  '    if (folders.length === 0) { el.fileCount.textContent = "已选 " + selectedFiles.length + " 个文件"; return; }',
  '    for (const r of folders) if (selectedRoots.indexOf(r) < 0) selectedRoots.push(r);',
  '    api.expand(folders).then((scan) => {',
  '      // 旧语义：展开出来的所有文件都当一个普通文件清单（预览时再按规则分类）',
  '      merge(scan.files.map((f) => f.fullPath));',
  '      el.fileCount.textContent = "已选 " + selectedFiles.length + " 个文件（来自 " + selectedRoots.length + " 个文件夹）";',
  '    });',
  '  });',
  '}',
  'el.drop.addEventListener("drop", (ev) => {',
  '  const paths = [];',
  '  for (const file of Array.from(ev.dataTransfer.files)) { const p = api.pathForFile(file); if (p) paths.push(p); }',
  '  if (paths.length > 0) accept(paths);',
  '});',
  'el.pickFiles.addEventListener("click", () => { api.pickFiles().then((list) => accept(list)); });',
  'el.pickFolders.addEventListener("click", () => { api.pickFolders().then((list) => accept(list)); });',
  'el.pickOut.addEventListener("click", () => { api.pickOutputDir().then((d) => { outputDir = d; }); });',
  'el.preview.addEventListener("click", () => {',
  '  // 旧语义：直接把所有文件（含子文件夹里的）按规则分类，没有分组、也没有那句说明',
  '  api.preview(selectedFiles.slice(), outputDir, []).then((outcome) => {',
  '    if (!outcome || outcome.ok !== true) return;',
  '    el.previewWarning.textContent = "以下是预览，还没有复制任何文件。";',
  '    el.previewSummary.textContent = "共 " + outcome.tree.total + " 个文件，会分到 " + outcome.tree.folders.filter((g) => g.count > 0).length + " 个分类文件夹";',
  '    el.previewTree.textContent = "";',
  '    for (const g of outcome.tree.folders) {',
  '      const row = document.createElement("div");',
  '      row.className = "folder";',
  '      row.textContent = g.folder + " —— " + g.count + " 个文件";',
  '      el.previewTree.appendChild(row);',
  '    }',
  '  });',
  '});',
].join('\n');

/* ------------------------------------------------------------------ *
 * 探针本体：拖入一个文件夹 → 走得通吗？
 * ------------------------------------------------------------------ */

/**
 * 把产物放进窗口式桩，模拟拖入一个文件夹，然后逐条查：
 *  1. 界面上有「选择文件夹」按钮；
 *  2. 拖入文件夹后真的调了 api.expand（递归展开）；
 *  3. 「已选 N 个文件」那句里能看出「来自 M 个文件夹」；
 *  4. 点「选择文件夹」会调到 api.pickFolders；
 *  5. 点预览后，预览区**按源文件夹分组**画出来（顶层分组节点 + 每份下面的分类夹）。
 * @returns {string[]} 问题清单（空数组 = 没问题）
 */
async function inspectFolderSupport(productSource, label, ctx) {
  const hits = [];
  const { api, state } = makeOrganizer({
    core: ctx.core,
    files: ctx.files,
    roots: ctx.roots,
    outputDir: ctx.outputDir,
    pickFoldersResult: [ctx.roots[1]],
  });

  const run = await runInWindowStub(productSource, label, api);
  try {
    if (run.error) {
      hits.push(`execution failed: ${run.error}`);
      return hits;
    }

    // 1. 「选择文件夹」按钮必须真的被查过
    const pickFoldersEl = run.elements.get('pick-folders');
    if (!pickFoldersEl) hits.push('element never looked up: #pick-folders（没有「选择文件夹」入口）');

    // 2. 拖入一个文件夹路径 → 必须调 api.expand
    const dropEl = run.elements.get('drop');
    if (!dropEl) {
      hits.push('element never looked up: #drop');
      return hits;
    }
    const folderPath = ctx.roots[0];
    const folderFile = { name: path.basename(folderPath) };
    Object.defineProperty(folderFile, '__path', { value: folderPath, enumerable: true });
    dropEl.dispatch('drop', { preventDefault() {}, dataTransfer: { files: [folderFile] } });
    await flush();
    await flush();

    if (state.expandCalls.length === 0) {
      hits.push('拖入一个文件夹之后没有调用 api.expand（文件夹没有被递归展开）');
    }

    // 3. 「已选 N 个文件（来自 M 个文件夹）」
    const countText = String((run.elements.get('file-count') || {}).textContent || '');
    const expectedFiles = Object.keys(ctx.files).filter((f) =>
      f.toLowerCase().startsWith(String(ctx.roots[0]).toLowerCase() + '\\'),
    ).length;
    if (!new RegExp(`已选\\s*${expectedFiles}\\s*个文件`).test(countText)) {
      hits.push(`拖入文件夹后「已选」那句不对：「${countText}」（期望已选 ${expectedFiles} 个文件）`);
    }
    if (!/来自\s*1\s*个文件夹/.test(countText)) {
      hits.push(`没有说出「来自 M 个文件夹」：「${countText}」`);
    }

    // 4. 点「选择文件夹」→ 调到 api.pickFolders
    const pickCallsBefore = state.pickFoldersCalls;
    if (pickFoldersEl) {
      pickFoldersEl.dispatch('click', { preventDefault() {} });
      await flush();
      await flush();
      if (state.pickFoldersCalls !== pickCallsBefore + 1) {
        hits.push(`点「选择文件夹」没有调到 api.pickFolders（${pickCallsBefore} -> ${state.pickFoldersCalls}）`);
      }
    }

    // 5. 选好输出目录 → 点预览 → 按源文件夹分组画出来
    const pickOutEl = run.elements.get('pick-out');
    if (pickOutEl) {
      pickOutEl.dispatch('click', { preventDefault() {} });
      await flush();
    }
    const previewBtn = run.elements.get('preview');
    if (!previewBtn) {
      hits.push('element never looked up: #preview');
      return hits;
    }
    previewBtn.dispatch('click', { preventDefault() {} });
    await flush();
    await flush();

    if (state.previewCalls.length === 0) {
      hits.push('点预览没有调用 api.preview');
      return hits;
    }

    // 5b. 预览必须真的按源文件夹分组画出来
    // 界面会在预览前把源文件夹放下来、用完再清掉，所以这里要看的是「有没有放下过非空的那一批」
    const putRoots = state.setRootsCalls.filter((c) => Array.isArray(c) && c.length > 0);
    if (putRoots.length === 0) {
      hits.push('点预览之前没有把源文件夹放下（没调 api.setSourceRoots 传非空的那批）——分组无从谈起');
    }
    const sent = state.previewCalls[state.previewCalls.length - 1];
    if (!sent.roots || sent.roots.length === 0) {
      hits.push('预览时没有拿到源文件夹（roots 为空）——分组无从谈起');
    }

    const summaryText = String((run.elements.get('preview-summary') || {}).textContent || '');
    const warningText = String((run.elements.get('preview-warning') || {}).textContent || '');
    const treeEl = run.elements.get('preview-tree');
    if (!treeEl) {
      hits.push('element never looked up: #preview-tree');
      return hits;
    }
    const treeText = textOf(treeEl);

    if (!/来自\s*[12]\s*个文件夹/.test(summaryText)) {
      hits.push(`预览说明里没有「来自 M 个文件夹」：「${summaryText}」`);
    }
    if (!/预览|没有复制|仍然/.test(warningText)) {
      hits.push(`预览提示不对：「${warningText}」`);
    }

    // 分组：每个顶层源文件夹一个分组节点；份内既有「原样保留的子树」也有「本层散文件的分类夹」
    const rootNodes = findByClass(treeEl, 'root');
    if (rootNodes.length === 0) {
      hits.push('预览树里没有源文件夹分组节点（class="root"）——没有按源文件夹分组');
    } else if (!rootNodes.some((n) => hasNestedGroup(n, 'source'))) {
      hits.push('预览树的分组节点下面没有「某一层源文件夹」这一层（class="source"）');
    }
    const sourceNodes = findByClass(treeEl, 'source');
    const nestedSource = sourceNodes.filter((n) => hasNestedGroup(n, 'cat'));
    if (nestedSource.length === 0) {
      hits.push('预览树里每一份源文件夹下面没有分类夹节点（class="cat"）——散文件那条路说不清');
    }
    for (const n of nestedSource) {
      const text = textOf(n);
      if (!/个文件/.test(text)) hits.push(`某一层源文件夹没有写清有几个文件：「${text.slice(0, 80)}」`);
    }

    // 新语义：界面上必须**明确写出那句人话**（子文件夹按原样保留、只有散文件按规则分类）
    const keepNodes = findByClass(treeEl, 'keep');
    if (keepNodes.length === 0) {
      hits.push('预览树里没有「原样保留的子树」节点（class="keep"）——子文件夹里的文件没按新语义画出来');
    }
    const hint = treeEl.children.find((c) => c.className === 'keep-hint');
    if (!hint) {
      hits.push('预览树里没有那句说明（class="keep-hint"）——界面上看不出「子文件夹按原样保留」');
    } else {
      const hintText = String(hint.textContent || '');
      if (!/原样保留/.test(hintText)) {
        hits.push(`那句说明没说「原样保留」：「${hintText}」`);
      }
      if (!/散|分类/.test(hintText)) {
        hits.push(`那句说明没说「只有散文件按规则分类」：「${hintText}」`);
      }
      if (!/子文件夹/.test(hintText)) {
        hits.push(`那句说明没说清「子文件夹」：「${hintText}」`);
      }
    }
    for (const want of ['下载', '照片', '文档', '婚纱', '另一处']) {
      if (!new RegExp(want).test(treeText)) hits.push(`预览树里看不到「${want}」这一层：${treeText.slice(0, 120)}`);
    }
    for (const f of Object.keys(ctx.files)) {
      if (treeText.indexOf(path.basename(f)) < 0) hits.push(`预览树里看不到文件「${path.basename(f)}」`);
    }

    return hits;
  } finally {
    run.restore();
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

(async () => {
  log('=== accept-folder-preview-test: 拖入文件夹 → 界面按源文件夹分组画出预览（不依赖真窗口） ===');
  log(`project root: ${projectRoot}`);

  if (typeof vm.SourceTextModule !== 'function') {
    log('');
    log('FAIL: node must be started with --experimental-vm-modules for this check (see scripts/验收.ps1)');
    log('验收失败:文件夹预览');
    process.exitCode = 1;
    return;
  }

  for (const p of [RENDERER_JS, RENDERER_TS, HTML, PRELOAD_JS]) {
    if (!fs.existsSync(p)) {
      log(`FAIL: missing ${p} (run npm run build first)`);
      log('验收失败:文件夹预览');
      process.exitCode = 1;
      return;
    }
  }

  const rendererJs = readText(RENDERER_JS);
  const rendererTs = readText(RENDERER_TS);
  const html = readText(HTML);
  const preloadJs = readText(PRELOAD_JS);
  const core = require(path.join(outDir, 'core', 'index.js'));

  let tmpRoot = null;
  // 探针副本跑的是「第 7 条钉着的那三参调用」（源文件夹由假 api 的桩接住）
  const rendererJsProbe = rendererJs; // 探针副本就是真产物本身（源文件夹另走 setSourceRoots 那条路）

  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-folder-preview-'));
    log(`temp work dir: ${tmpRoot}`);
    const fixture = makeFixture(tmpRoot);
    const ctx = {
      core,
      files: fixture.files,
      roots: [path.join(fixture.srcRoot, '下载'), path.join(fixture.srcRoot, '另一处')],
      outputDir: path.join(tmpRoot, '整理（本次预览绝不创建它）'),
    };

    /* ---------- 磁盘守卫：这些地方在预览前后不许变 ---- */
    const stage = process.env.DSH_ACCEPT_STAGE || path.join(projectRoot, '.dsh-staging');
    const watch = [outDir, stage, fixture.srcRoot, path.dirname(ctx.outputDir)].filter((p) => !!p);
    const countTree = (root) => {
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
    };
    const snapshot = () => watch.map((p) => ({ p, ...countTree(p) }));

    /* ---------- 一、界面里有「选择文件夹」入口 ---------- */
    await check('存在：界面里有「选择文件夹」按钮，产物里真的调 api.pickFolders 与 api.expand', () => {
      ok(/id\s*=\s*["']pick-folders["']/.test(html), 'index.html 里没有 #pick-folders');
      ok(/pick-folders/.test(rendererTs), 'renderer.ts 里没有引用 #pick-folders');
      ok(/pick-folders/.test(rendererJs), '编译产物 out/renderer/renderer.js 里没有引用 #pick-folders');
      ok(/\.pickFolders\s*\(/.test(rendererJs), '编译产物里没有调用 api.pickFolders');
      ok(/\.expand\s*\(/.test(rendererJs), '编译产物里没有调用 api.expand（文件夹没被递归展开）');
      ok(/pickFolders/.test(preloadJs), 'preload 产物里没有 pickFolders');
      ok(/files:expand|expand/.test(preloadJs), 'preload 产物里没有 expand');
      const mainJs = readText(path.join(outDir, 'main.js'));
      ok(/files:expand/.test(mainJs), '主进程产物里没有 files:expand');
      ok(/dialog:pickFolders/.test(mainJs), '主进程产物里没有 dialog:pickFolders');
      ok(/暂不支持文件夹/.test(rendererJs) === false, '产物里还留着「暂不支持文件夹」这句旧话');
    });

    /* ---------- 二 / 三 / 五：真产物跑一遍 ---------- */
    const liveOrganizer = makeOrganizer({
      core,
      files: fixture.files,
      roots: ctx.roots,
      outputDir: ctx.outputDir,
      pickFoldersResult: [ctx.roots[1]],
    });
    const liveRun = await runInWindowStub(rendererJs, 'current-renderer.js', liveOrganizer.api);
    await check('真执行：界面脚本在窗口式桩里跑到底、没有未捕获异常', () => {
      ok(!liveRun.error, `执行 out/renderer/renderer.js 失败 -> ${liveRun.error}`);
    });
    liveRun.restore();

    const beforeDisk = snapshot();

    await check('拖入一个文件夹：界面显示「来自 M 个文件夹」并按源文件夹分组画出预览', async () => {
      const hits = await inspectFolderSupport(rendererJsProbe, 'current-renderer-folder.js', ctx);
      ok(hits.length === 0, `文件夹接线有问题：${hits.join(' | ')}`);
    });

    await check('点「选择文件夹」按钮会调到假的对应接口（api.pickFolders）', async () => {
      const { api, state } = makeOrganizer({
        core,
        files: fixture.files,
        roots: ctx.roots,
        outputDir: ctx.outputDir,
        pickFoldersResult: [ctx.roots[1]],
      });
      const run = await runInWindowStub(rendererJs, 'current-renderer-pickfolders.js', api);
      try {
        ok(!run.error, `执行界面脚本失败 -> ${run.error}`);
        const btn = run.elements.get('pick-folders');
        ok(btn, '没有 #pick-folders 元素');
        const before = state.pickFoldersCalls;
        btn.dispatch('click', { preventDefault() {} });
        await flush();
        await flush();
        eq(state.pickFoldersCalls, before + 1, '点「选择文件夹」调用 api.pickFolders 的次数');
        eq(state.expandCalls.length, 1, '选择文件夹之后应当递归展开一次');
        eq(state.expandCalls[0][0], ctx.roots[1], '展开的应当是刚选中的那个文件夹');
        const countText = String((run.elements.get('file-count') || {}).textContent || '');
        ok(/来自\s*1\s*个文件夹/.test(countText), `选完文件夹后的计数文字不对：「${countText}」`);
      } finally {
        run.restore();
      }
    });

    /* ---------- 四、预览前一份磁盘都没写 ---------- */
    await check('预览前一份磁盘都没有被写（被观察目录的文件数与目录数不变）', () => {
      const after = snapshot();
      let bad = null;
      for (let i = 0; i < beforeDisk.length; i++) {
        const b = beforeDisk[i];
        const a = after[i];
        log(`      disk ${b.p}: files ${b.files} -> ${a.files}, dirs ${b.dirs} -> ${a.dirs}`);
        if (a.files !== b.files || a.dirs !== b.dirs) bad = `${b.p}（文件 ${b.files}->${a.files}，目录 ${b.dirs}->${a.dirs}）`;
      }
      ok(!bad, `预览过程中磁盘变了：${bad}`);
      ok(!fs.existsSync(ctx.outputDir), `预览把输出目录建出来了：${ctx.outputDir}`);
    });

    /* ---------- 五、探针必须是活的 ---------- */
    await check('探针有效性自检：拿「按旧语义（子文件夹里的文件也塞进分类夹）」的产物喂进去必须判失败，真产物必须通过', async () => {
      // (1) 旧语义产物：子文件夹里的文件也被塞进分类夹，也没有「原样保留」的分组与那句说明
      const legacyHits = await inspectFolderSupport(LEGACY_CLASSIFY_ALL_PRODUCT, 'legacy-classify-all.js', ctx);
      ok(legacyHits.length > 0, '「按旧语义」的产物被说 OK —— 探针是死的');
      log(`      旧语义产物被抓到的证据（前 3 条）：${legacyHits.slice(0, 3).join(' | ')}`);
      // 必须真的抓在「新语义」这一点上，而不是因为没有 pick-folders 按钮之类侥幸判失败
      ok(
        legacyHits.some((h) => /keep|原样保留|说明/.test(h)),
        `旧语义产物被抓到的理由与新语义无关：${legacyHits.join(' | ')}`,
      );

      // (2) 把真产物里「原样保留的子树」那一块抽掉（其余照旧）：分组/说明必然缺 —— 必须判失败
      //     （换成空语句，保证产物语法仍然正常，不至于「因为跑不起来」侥幸判失败）
      const KEEP_BLOCK = 'body.appendChild(subFolderBlock(sub, 0));';
      const noKeepBlock = rendererJs.split(KEEP_BLOCK).join('void 0;');
      ok(noKeepBlock !== rendererJs, '没能造出「不画原样保留子树」的产物样本');
      const noKeepHits = await inspectFolderSupport(noKeepBlock, 'crippled-no-keep-block.js', ctx);
      ok(noKeepHits.length > 0, '「不画原样保留子树」的产物被说 OK —— 探针是死的');
      log(`      抽掉「原样保留子树」后的证据（前 3 条）：${noKeepHits.slice(0, 3).join(' | ')}`);

      // (3) 把真产物里那句说明抽掉（其余照旧）：必须判失败（控制台要求界面上必须写出那句话）
      const noHint = rendererJs
        .split("hint.textContent = tree.keepHint;")
        .join("hint.textContent = '';");
      ok(noHint !== rendererJs, '没能造出「不写那句说明」的产物样本');
      const noHintHits = await inspectFolderSupport(noHint, 'crippled-no-hint.js', ctx);
      ok(
        noHintHits.some((h) => /keep-hint|说明/.test(h)),
        `「不写那句说明」的产物没有被抓到说明缺失：${noHintHits.join(' | ') || '（竟然全过）'}`,
      );
      log(`      抽掉「那句说明」后的证据（前 3 条）：${noHintHits.slice(0, 3).join(' | ')}`);

      // (4) 把真产物里「把源文件夹传给预览」这一步抽掉：分组必然画不出来 → 必须判失败
      const noRootsToPreview = withoutSetSourceRoots(rendererJs);
      ok(noRootsToPreview !== rendererJs, '没能造出「不把源文件夹传给预览」的产物样本');
      const noRootsHits = await inspectFolderSupport(noRootsToPreview, 'crippled-no-setroots.js', ctx);
      ok(noRootsHits.length > 0, '「不把源文件夹传给预览」的产物被说 OK —— 探针是死的');
      log(`      抽掉「放下源文件夹」后的证据（前 3 条）：${noRootsHits.slice(0, 3).join(' | ')}`);

      // (5) 真产物必须通过（这一遍是单独一遍，不复用上面的结果）
      const liveHits = await inspectFolderSupport(rendererJsProbe, 'current-renderer-folders.js', ctx);
      ok(liveHits.length === 0, `真产物被判不合格（探针误报）：${liveHits.join(' | ')}`);
      log('      探针：旧语义产物判失败、抽掉原样保留判失败、抽掉说明判失败、抽掉源文件夹判失败、真产物判通过');
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
    log('文件夹预览OK');
    process.exitCode = 0;
  } else {
    log('验收失败:文件夹预览');
    process.exitCode = 1;
  }
})();
