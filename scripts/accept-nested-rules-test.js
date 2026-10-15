/**
 * 验收第 16 条：嵌套规则（规则的分类名可以是多级相对路径）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 要验的东西（P0：规则的输出目标支持多层嵌套文件夹）：
 *   一、不变：不写层级的规则（`01_图片`）行为与现在逐条一致（默认规则表跑既有用例，结果不变）；
 *   二、一层不变：写 `照片` 与写 `照片\` 等价，都落在这一层下面的 `照片\`；
 *   三、两级：`照片\风光` → 文件落在 `<这一层>\照片\风光\`，**中间层 `照片` 真的被创建**（不是把整体当一个目录名）；
 *   四、三级：`归档\2023\发票` → 三层都在；
 *   五、分隔符等价：`照片/风光` 与 `照片\风光` 落到同一个目录（Windows 语义）；
 *   六、同深度同名不覆盖：`照片\重名` 与 `视频\重名` 两个 `重名` 目录各自独立；同一最深处同名文件按「原名 (1).后缀」换名；
 *   七、与既有规则共存：同一次整理里「子文件夹原样保留」「沉进同名子文件夹」「规则输出多级目录」三类互不干扰；
 *   八、只往深处：每个文件的目标路径都在**它原来所在的那一层**之下（以那一层为前缀），没有任何文件被挪到更浅的位置；
 *   九、安全：`..\..\外面` / `C:\temp\x` / `\\server\share` / `photos:bad` / `con` / 结尾空格 / 结尾点
 *       各自被拒绝（带上人话原因），并且**源树之外一个文件一个目录都没多**（哨兵目录前后对比）；
 *   十、真落盘一次：结构与逐条预期一致，且源文件一个不少；
 *   十一、界面侧：规则行显示 core 给的那份「归一化后的实际目标」、预览树里多层结构真的被画成两层/三层；
 *   十二、探针必须是活的：内存里现造的「把 `照片\风光` 当成一个目录名」的产物喂给这套断言，**必须判失败**。
 *
 * 全部通过：stdout 打印「嵌套规则OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:嵌套规则」并 exit 1。
 *
 * 跑法：node --experimental-vm-modules scripts\accept-nested-rules-test.js
 *       （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 *
 * 纪律：期望值一律**从 core 现算**（`normalizeCategoryPath` / `classifyWithMeta` / 计划结果），
 * 不许在这个脚本里再写一份「照片\风光」的第二实现；
 * 所有目录都建在系统临时目录里，绝不碰用户 userData 下的真实记录 / 规则 / AI 配置。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const outDir = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
const RENDERER_JS = path.join(outDir, 'renderer', 'renderer.js');
const core = require(path.join(outDir, 'core', 'index.js'));

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
 * 临时目录 + 小工具（一切都在临时目录里，跑完清掉）
 * ------------------------------------------------------------------ */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-nested-'));
process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清不掉也不影响判定 */
  }
});

let caseSeq = 0;

/** 每个用例一个自己的目录：{ case, src, out }。 */
function makeCase(label) {
  const dir = path.join(tmpRoot, `case-${++caseSeq}-${label}`);
  const src = path.join(dir, 'src');
  const out = path.join(dir, 'out');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  return { dir, src, out };
}

/** 造一个文件（内容带上标记，便于确认复制的是它）。 */
function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text ?? 'x', 'utf8');
  return filePath;
}

/** 一棵目录树上所有文件（相对 root 的路径，小写、反斜杠）。 */
function listFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full);
      else out.push(path.relative(root, full).toLowerCase().replace(/\//g, '\\'));
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out.sort();
}

/** 一棵目录树上所有目录（相对 root 的路径，小写、反斜杠；不含 root 自己）。 */
function listDirs(root) {
  const out = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      out.push(path.relative(root, full).toLowerCase().replace(/\//g, '\\'));
      visit(full);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out.sort();
}

/** 数一棵树里的文件与目录（哨兵目录前后对比用）。 */
function countTree(root) {
  return { files: listFiles(root).length, dirs: listDirs(root).length };
}

/** 一条规则（形状与 core 的 Rule 一致）。 */
function makeRule(id, name, extensions, enabled) {
  return { id, name, enabled: enabled !== false, condition: { extensions: extensions ?? [] } };
}

/**
 * 真的整理一次（走 core 的同一个入口：copyFiles → planFolders）。
 * 期望值一律从这里出来的结果现算，不在脚本里另写一份。
 */
async function runOrganize(input) {
  return core.copyFiles({
    outputDir: input.out,
    files: input.files,
    roots: input.roots ?? null,
    rules: input.rules ?? null,
    recordPath: null,
  });
}

/** 整理完之后：输出里的文件 + 目录（相对输出根） + 原文件还在不在。 */
function snapshot(out, srcFiles) {
  const files = listFiles(out);
  const missingSources = srcFiles.filter((p) => !fs.existsSync(p));
  return { files, dirs: listDirs(out), missingSources };
}

/** 「这一层」在输出里的目录：输出根 + 源文件夹在输出里的名字 + 它的各层子文件夹名。 */
function layerDirOf(out, origin, outputRootName) {
  const parts = [out, outputRootName ?? origin.rootName, ...(origin.chain ?? [])];
  return path.join(...parts);
}

/* ------------------------------------------------------------------ *
 * 一、不变：不写层级的规则行为与现在逐条一致
 * ------------------------------------------------------------------ */

/** 既有的九个文件（与第 1、2 条验收同一批：五类后缀 + 无后缀 + 大小写 + 别的后缀）。 */
const LEGACY_NAMES = ['t1.jpg', 't2.pdf', 't3.mp3', 't4.zip', 't5.xyz', 'noext', 't6.JPG', 't7.docx', 't8.mp4'];

/* ------------------------------------------------------------------ *
 * 二、一层不变 / 三、两级 / 四、三级 / 五、分隔符等价
 * 每个用例：一条规则 + 一个散文件 → 断言落在 core 现在算出来的那条路径上
 * ------------------------------------------------------------------ */

async function checkSegments(label, ruleName, expectedFolder) {
  // 期望的各层名字：**从 core 现算**（不在这脚本里写死第二份）
  const normalized = core.normalizeCategoryPath(ruleName);
  ok(normalized.ok, `${label}：core 认为「${ruleName}」这个分类名不能用（${normalized.reason}）`);
  eq(normalized.path, expectedFolder, `${label}：core 归一化「${ruleName}」之后的路径`);

  const c = makeCase(label);
  const root = path.join(c.src, '来源');
  const srcFile = writeFile(path.join(root, '散1.jpg'));
  const rules = [makeRule('r1', ruleName, ['jpg'])];
  const summary = await runOrganize({ out: c.out, files: [srcFile], roots: [root], rules });
  const snap = snapshot(c.out, [srcFile]);

  const wanted = path.join(c.out, '来源', ...normalized.segments, '散1.jpg');
  eq(snap.missingSources.length, 0, `${label}：原文件不见了`);
  eq(snap.files.length, 1, `${label}：输出里的文件数`);
  eq(snap.files[0], path.relative(c.out, wanted).toLowerCase().replace(/\//g, '\\'), `${label}：文件落到哪儿`);
  ok(fs.existsSync(wanted), `${label}：期望的落点不存在 ${wanted}`);

  // 中间层真的被逐层创建（不是把 `照片\风光` 当成一个目录名）
  for (let i = 1; i <= normalized.segments.length; i++) {
    const layer = path.join(c.out, '来源', ...normalized.segments.slice(0, i));
    ok(fs.existsSync(layer) && fs.statSync(layer).isDirectory(), `${label}：第 ${i} 层目录没被创建：${layer}`);
  }
  // 多级时，「整体当一个目录名」的那种错法必须不存在：逐层看目录项，
  // 每一层的目录项里必须有一个**正好等于那一段名字**的，而不是名字里带分隔符的一坨。
  if (normalized.segments.length > 1) {
    let dir = path.join(c.out, '来源');
    for (const seg of normalized.segments) {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
      ok(
        entries.some((e) => e.name === seg),
        `${label}：目录 ${dir} 里没有一层正好叫「${seg}」的目录（现在有：${entries.map((e) => e.name).join(' | ')}）`,
      );
      dir = path.join(dir, seg);
    }
  }
  return { summary, snap, normalized };
}

/* ------------------------------------------------------------------ *
 * 界面侧：把编译产物在窗口式桩里真跑一遍（真 ES module 作用域）
 * ------------------------------------------------------------------ */

/** 最小 DOM 桩（与第 7、9 条同一套形状）。 */
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

/** 深搜按类名找节点（类名可能是一串，如 `cat cat-nest`，按 token 比）。 */
function findByClass(root, className) {
  const out = [];
  walk(root, (node) => {
    const classes = String(node.className || '')
      .split(/\s+/)
      .filter((c) => c.length > 0);
    if (classes.includes(className)) out.push(node);
  });
  return out;
}

/** 把一棵桩节点的可见文字拼起来（含子节点）。 */
function textOf(root) {
  let out = String(root.textContent || '');
  for (const child of root.children || []) out += `\n${textOf(child)}`;
  return out;
}

/** 一个分组节点（`cat` / `keep` / `source` / `root`）标题里的那一层名字（去掉前面那个三角）。 */
function nodeLabel(node) {
  const first = String(node.className || '').split(/\s+/)[0];
  const headClass = `${first}-head`;
  const head = (node.children || []).find((ch) => String(ch.className || '').split(/\s+/).includes(headClass));
  if (!head) return '';
  // 桩里 textContent 只记「自己格子里写上来的字」，子节点里的字要自己拼（真 DOM 会自动带上）
  return String(textOf(head) || '')
    .split('\n')
    .join('')
    .replace(/^[▾▸·]\s*/, '')
    .trim();
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 等一小会儿（真实异步 IO 用，比 flush 更接近真窗口里的节奏）。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到条件成立为止（最多 timeout 毫秒）；返回是否等到了。 */
async function waitFor(cond, timeout = 5000, step = 20) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let hit = false;
    try {
      hit = !!cond();
    } catch {
      hit = false;
    }
    if (hit) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

/**
 * 假 api：预览/整理/规则目标一律走**真的 core**（同一条路），界面拿到的就是真结论。
 * 只把「文件对话框」「撤销/AI 那些与本条无关的接口」做成桩。
 */
function makeOrganizer(opts) {
  const o = opts || {};
  const state = {
    expandCalls: [],
    previewCalls: [],
    organizeCalls: [],
    setRootsCalls: [],
    targetCalls: [],
    pendingRoots: [],
  };
  const files = o.files || {};
  const roots = o.roots || [];

  const api = {
    pathForFile: (file) => (file && file.__path) || null,
    pickFiles: async () => [],
    pickFolders: async () => [],
    pickOutputDir: async () => o.outputDir || null,
    exists: async (paths) => {
      const map = {};
      for (const p of paths || []) {
        const lower = String(p).toLowerCase();
        const isFile = Object.keys(files).some((f) => f.toLowerCase() === lower);
        const isDir = roots.some(
          (r) => lower === String(r).toLowerCase() || lower.startsWith(String(r).toLowerCase() + '\\'),
        );
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
    preview: async (fileList, outputDirPath, rules) => {
      const rootList = state.pendingRoots.slice();
      state.previewCalls.push({ files: fileList, outputDir: outputDirPath, rules, roots: rootList });
      return core.buildPreviewTree({
        files: fileList,
        roots: rootList,
        outputDir: outputDirPath,
        rules: rules || null,
      });
    },
    organize: async (fileList, outputDirPath, rules, rootList) => {
      state.organizeCalls.push({ files: fileList, outputDir: outputDirPath, rules, roots: rootList });
      const summary = await core.copyFiles({
        outputDir: outputDirPath,
        files: fileList,
        roots: rootList || null,
        rules: rules || null,
        recordPath: null,
      });
      state.organizeSummaries = state.organizeSummaries || [];
      state.organizeSummaries.push({
        total: summary.total,
        successCount: summary.successCount,
        failureCount: summary.failureCount,
        blocked: summary.blocked,
        blockedReason: summary.blockedReason,
        errors: (summary.results || []).map((r) => r.error),
        written: summary.writtenFiles,
      });
      return summary;
    },
    checkOutputDirection: async (input) => {
      const list = input || {};
      return core.checkOutputDirection({
        roots: list.roots || [],
        files: list.files || [],
        outputDir: list.outputDir || '',
      });
    },
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
    openPath: async () => '',
    // 规则行上那句「实际会建到哪儿」由 core 现算（与落盘同一个函数）
    ruleTargets: async (rules) => {
      const list = core.ruleTargetsOf(rules || []);
      state.targetCalls.push({ rules: rules || [], targets: list });
      return list;
    },
    loadRules: async () => ({ ok: true, rules: [], source: 'default', message: 'stub', filePath: 'stub' }),
    saveRules: async () => ({ ok: true, message: 'stub', filePath: 'stub' }),
    rulesPath: async () => 'stub',
    aiStatus: async () => ({ configured: false, label: 'AI 分类：未配置' }),
    aiConfigLoad: async () => null,
    aiConfigSave: async () => ({ ok: true, message: 'stub', config: null }),
    aiConfigTest: async () => ({ ok: false, message: 'stub' }),
    aiSuggestRules: async () => ({ rules: [], checks: [], message: 'stub' }),
    aiClassify: async () => ({ ok: false, message: 'stub' }),
    onAiProgress: () => {},
    onProgress: () => {},
  };
  return { api, state };
}

/**
 * 把一个界面产物真跑一遍：真 ES module 作用域 + 窗口式桩。
 * `global.document` / `global.window` 留到整个交互过程结束才还原（回调是异步的）。
 */
async function runInWindowStub(source, label, organizer) {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('node 没带 --experimental-vm-modules，建不出真的 ES module 作用域');
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
 * 界面侧：一个「把 照片\风光 当成单个目录名」的反证产物
 * （树画得跟真产物一样，只有多层分类名这一处退化成「整体一个名字」）
 * ------------------------------------------------------------------ */
const FLAT_CATEGORY_PRODUCT = [
  '// 反证产物：分类名被当成**单个目录名**（本片要求逐层画出来）',
  'const api = window.organizer;',
  'const el = {',
  "  drop: document.getElementById('drop'),",
  "  pickFolders: document.getElementById('pick-folders'),",
  "  pickOut: document.getElementById('pick-out'),",
  "  preview: document.getElementById('preview'),",
  "  previewWarning: document.getElementById('preview-warning'),",
  "  previewSummary: document.getElementById('preview-summary'),",
  "  previewTree: document.getElementById('preview-tree'),",
  "  fileCount: document.getElementById('file-count'),",
  '};',
  'let selectedFiles = [];',
  'let selectedRoots = [];',
  'let outputDir = null;',
  'function accept(roots) {',
  '  for (const r of roots) if (selectedRoots.indexOf(r) < 0) selectedRoots.push(r);',
  '  api.expand(roots).then((scan) => { for (const f of scan.files) if (selectedFiles.indexOf(f.fullPath) < 0) selectedFiles.push(f.fullPath); el.fileCount.textContent = "已选 " + selectedFiles.length + " 个文件"; });',
  '}',
  'el.drop.addEventListener("drop", (ev) => {',
  '  const paths = [];',
  '  for (const f of Array.from(ev.dataTransfer.files)) { const p = api.pathForFile(f); if (p) paths.push(p); }',
  '  if (paths.length > 0) accept(paths);',
  '});',
  'el.pickFolders.addEventListener("click", () => { api.pickFolders().then((list) => accept(list)); });',
  'el.pickOut.addEventListener("click", () => { api.pickOutputDir().then((d) => { outputDir = d; }); });',
  'el.preview.addEventListener("click", () => {',
  '  api.setSourceRoots(selectedRoots.slice());',
  '  api.preview(selectedFiles.slice(), outputDir, []).then((outcome) => {',
  '    try { api.setSourceRoots([]); } catch (e) {}',
  '    if (!outcome || outcome.ok !== true) return;',
  '    const tree = outcome.tree;',
  '    el.previewTree.textContent = "";',
  '    for (const root of tree.roots) {',
  '      const rootBox = document.createElement("div");',
  '      rootBox.className = "root";',
  '      const rootHead = document.createElement("div");',
  '      rootHead.className = "root-head";',
  '      rootHead.textContent = root.name + "（源：" + root.path + "）";',
  '      rootBox.appendChild(rootHead);',
  '      const rootBody = document.createElement("div");',
  '      rootBody.className = "root-files";',
  '      rootBody.appendChild(sourceNode(root.self));',
  '      for (const child of root.children) rootBody.appendChild(sourceNode(child));',
  '      rootBox.appendChild(rootBody);',
  '      el.previewTree.appendChild(rootBox);',
  '    }',
  '  });',
  '});',
  'function sourceNode(sf) {',
  '  const box = document.createElement("div");',
  '  box.className = "source";',
  '  const head = document.createElement("div");',
  '  head.className = "source-head";',
  '  head.textContent = sf.name;',
  '  box.appendChild(head);',
  '  const body = document.createElement("div");',
  '  body.className = "source-files";',
  '  for (const sub of sf.subfolders) body.appendChild(keepNode(sub));',
  '  // 退化点：把每条规则的分类名整体当成一个目录名画出来（不逐层）',
  '  const groups = sf.categories || [];',
  '  for (const g of groups) {',
  '    const catBox = document.createElement("div");',
  '    catBox.className = "cat";',
  '    const catHead = document.createElement("div");',
  '    catHead.className = "cat-head";',
  '    catHead.textContent = g.folder;',
  '    catBox.appendChild(catHead);',
  '    const files = document.createElement("div");',
  '    files.className = "files";',
  '    for (const f of g.files) files.appendChild(fileNode(f));',
  '    catBox.appendChild(files);',
  '    body.appendChild(catBox);',
  '  }',
  '  box.appendChild(body);',
  '  return box;',
  '}',
  'function keepNode(sub) {',
  '  const box = document.createElement("div");',
  '  box.className = "keep";',
  '  const head = document.createElement("div");',
  '  head.className = "keep-head";',
  '  head.textContent = sub.name;',
  '  box.appendChild(head);',
  '  const body = document.createElement("div");',
  '  body.className = "keep-files";',
  '  for (const f of sub.files) body.appendChild(fileNode(f));',
  '  for (const child of sub.children) body.appendChild(keepNode(child));',
  '  box.appendChild(body);',
  '  return box;',
  '}',
  'function fileNode(f) {',
  '  const line = document.createElement("div");',
  '  line.className = "file";',
  '  line.textContent = f.name;',
  '  return line;',
  '}',
].join('\n');

/**
 * 一条「多层分类名在预览里被画成几层」的探针。
 * 判定口径：最深那一层的目录名（class 为 `cat` 的那一层）里必须**只有** `照片\风光` 的最后一段，
 * 而且它的上一级里必须有一个叫第一段的节点；中间层 `照片` 必须是真的一层。
 * @returns 证据数组（空 = 探针没问题）
 */
function findFlatCategoryEvidence(treeEl, segments) {
  const hits = [];
  if (!treeEl || !Array.isArray(treeEl.children)) return ['预览树没画出来（找不到 preview-tree 的子节点）'];
  const cats = findByClass(treeEl, 'cat');
  const names = cats.map((c) => nodeLabel(c));
  const deepest = segments[segments.length - 1];
  if (!names.includes(deepest)) hits.push(`找不到最深那一层的目录节点「${deepest}」（现在有：${names.join(' | ')}）`);
  for (const name of names) {
    if (name.includes('\\')) hits.push(`有一层目录名里带着分隔符（被当成一个目录名了）：${name}`);
  }
  // 中间层必须真被画成一层（不是只在文字里出现）
  for (const mid of segments.slice(0, -1)) {
    if (!names.includes(mid)) hits.push(`中间层「${mid}」没有单独的一层`);
  }
  return hits;
}

/** 同上，但口径更严：最深的目录节点必须**嵌在**它的上一层的正文里（真的嵌套，而不是两行并列）。 */
function findNotNestedEvidence(treeEl, segments) {
  if (segments.length < 2) return [];
  const cats = findByClass(treeEl, 'cat');
  const find = (name) => cats.find((c) => nodeLabel(c) === name);
  const outer = find(segments[0]);
  const inner = find(segments[segments.length - 1]);
  if (!outer) return [`找不到最外层目录节点「${segments[0]}」（现在有：${cats.map((c) => nodeLabel(c)).join(' | ')}）`];
  if (!inner) return [`找不到最内层目录节点「${segments[segments.length - 1]}」`];
  const inside = [];
  walk(outer, (node) => {
    if (node === inner) inside.push(node);
  });
  return inside.length > 0
    ? []
    : [`「${segments[segments.length - 1]}」没有嵌在「${segments[0]}」里面（看起来是并列的两行）`];
}

/* ------------------------------------------------------------------ *
 * 跑
 * ------------------------------------------------------------------ */

(async () => {
  log('--- 一、不变：不写层级的规则，行为与现在逐条一致 ---');
  await check('不变：默认规则表跑既有九个文件，落点与 core 现算的一致', async () => {
    const c = makeCase('unchanged');
    const root = path.join(c.src, '来源');
    const srcFiles = LEGACY_NAMES.map((n) => writeFile(path.join(root, n)));
    const rules = core.defaultRules();
    const summary = await runOrganize({ out: c.out, files: srcFiles, roots: [root], rules });
    const snap = snapshot(c.out, srcFiles);
    eq(summary.failureCount, 0, '有文件没复制成功');
    eq(snap.missingSources.length, 0, '原文件被动了');
    eq(snap.files.length, LEGACY_NAMES.length, '输出里的文件数');
    for (const f of srcFiles) {
      // 期望落点**现算**：core 的同一个求值函数 + 同一个归一化
      const matched = core.classifyWithMeta(rules, f, path.basename(f));
      const expected = path.join(c.out, '来源', matched.folder, path.basename(f));
      const rel = path.relative(c.out, expected).toLowerCase().replace(/\//g, '\\');
      ok(snap.files.includes(rel), `${path.basename(f)} 期望落在 ${matched.folder}\\ 里，输出里没有：${rel}`);
      // 一层分类名：目录就是一条，不许出现多层
      eq(matched.segments.length, 1, `${path.basename(f)} 的分类名段数（不写层级就该是一层）`);
    }
  });

  log('--- 二、一层不变 / 三、两级 / 四、三级 / 五、分隔符等价 ---');
  await check('一层不变：写 照片 与写 照片\\ 等价', async () => {
    const plain = await checkSegments('one-plain', '照片', '照片');
    const trailing = await checkSegments('one-trailing', '照片\\', '照片');
    eq(trailing.normalized.path, plain.normalized.path, '「照片」与「照片\\」归一化之后应该等价');
    eq(trailing.normalized.segments.join('|'), plain.normalized.segments.join('|'), '两边的层名应该一样');
  });

  await check('两级：照片\\风光 落在 <这一层>\\照片\\风光\\，中间层真的被创建', async () => {
    const r = await checkSegments('two-level', '照片\\风光', '照片\\风光');
    eq(r.normalized.segments.length, 2, '两级写法的段数');
    eq(r.snap.dirs.length, 3, `输出里的目录数（这一层 + 照片 + 风光）：${r.snap.dirs.join(' | ')}`);
  });

  await check('三级：归档\\2023\\发票 三层都在', async () => {
    const r = await checkSegments('three-level', '归档\\2023\\发票', '归档\\2023\\发票');
    eq(r.normalized.segments.length, 3, '三级写法的段数');
    eq(r.snap.dirs.length, 4, `输出里的目录数（这一层 + 三层分类）：${r.snap.dirs.join(' | ')}`);
  });

  await check('分隔符等价：照片/风光 与 照片\\风光 落到同一个目录', async () => {
    const back = await checkSegments('sep-back', '照片\\风光', '照片\\风光');
    const forward = await checkSegments('sep-forward', '照片/风光', '照片\\风光');
    eq(forward.normalized.path, back.normalized.path, '两种分隔符的归一化结果');
    eq(forward.snap.files[0], back.snap.files[0], '两种分隔符下文件的相对落点');
  });

  log('--- 六、同深度同名不覆盖 ---');
  await check('同深度同名不覆盖：照片\\重名 与 视频\\重名 各自独立', async () => {
    const segA = core.normalizeCategoryPath('照片\\重名');
    const segB = core.normalizeCategoryPath('视频\\重名');
    ok(segA.ok && segB.ok, '这两条分类名该是能用的');
    eq(segA.segments[segA.segments.length - 1], segB.segments[segB.segments.length - 1], '两条规则的最深层该同名（这正是要验的点）');
    ok(segA.segments.length === 2 && segB.segments.length === 2, '两条规则该都是两级');

    // ① 两条规则分别单独跑：各自落在自己那条路径上
    const single = async (label, ruleName, expected) => {
      const c = makeCase(label);
      const root = path.join(c.src, '来源');
      const f = writeFile(path.join(root, 'a.txt'), label);
      const summary = await runOrganize({ out: c.out, files: [f], roots: [root], rules: [makeRule('r1', ruleName, ['txt'])] });
      eq(summary.failureCount, 0, `${label}：文件没复制成功`);
      const deep = path.join(c.out, '来源', ...expected.segments);
      ok(fs.existsSync(deep), `${label}：目标目录不存在 ${deep}`);
      eq(listFiles(deep).length, 1, `${label}：最深目录里的文件数`);
      return deep;
    };
    const dirA = await single('same-leaf-a', '照片\\重名', segA);
    const dirB = await single('same-leaf-b', '视频\\重名', segB);
    ok(dirA.toLowerCase() !== dirB.toLowerCase(), '两个「重名」目录不该是同一个');

    // ② 同一个输出根下两条路径同时存在：互不覆盖
    const c2 = makeCase('same-leaf-both');
    const root2 = path.join(c2.src, '来源');
    const g1 = writeFile(path.join(root2, 'a.txt'), 'A');
    const g2 = writeFile(path.join(root2, 'b.txt'), 'B');
    // 两个文件分两批各走一条规则（两条规则同时存在时第一条会先命中，所以分两批）
    const s1 = await runOrganize({ out: c2.out, files: [g1], roots: [root2], rules: [makeRule('r1', '照片\\重名', ['txt'])] });
    const s2 = await runOrganize({ out: c2.out, files: [g2], roots: [root2], rules: [makeRule('r1', '视频\\重名', ['txt'])] });
    eq(s1.failureCount + s2.failureCount, 0, '有文件没复制成功');
    const deepA = path.join(c2.out, '来源', ...segA.segments);
    const deepB = path.join(c2.out, '来源', ...segB.segments);
    ok(fs.existsSync(deepA), `照片\\重名 的目录不存在：${deepA}`);
    ok(fs.existsSync(deepB), `视频\\重名 的目录不存在：${deepB}`);
    eq(listFiles(deepA).length, 1, '照片\\重名 该只有 1 个文件');
    eq(listFiles(deepB).length, 1, '视频\\重名 该只有 1 个文件');
    eq(fs.readFileSync(path.join(deepA, 'a.txt'), 'utf8'), 'A', 'A 那份被改了');
    eq(fs.readFileSync(path.join(deepB, 'b.txt'), 'utf8'), 'B', 'B 那份被改了');
  });

  await check('同一最深处同名文件按「原名 (1).后缀」换名，不覆盖', async () => {
    const c = makeCase('same-name-file');
    const rootA = path.join(c.src, 'A');
    const rootB = path.join(c.src, 'B');
    const f1 = writeFile(path.join(rootA, '照片', '同名.jpg'), 'FIRST');
    const f2 = writeFile(path.join(rootB, '照片', '同名.jpg'), 'SECOND');
    const rules = [makeRule('r1', '照片', ['jpg'])];
    // 两个不同源文件夹各整理一次到同一个输出根（同一段路径、同名的文件）
    await runOrganize({ out: c.out, files: [f1], roots: [rootA], rules });
    const second = await runOrganize({ out: c.out, files: [f2], roots: [rootB], rules });
    eq(second.failureCount, 0, '第二次整理有文件没成功');
    const seg = core.normalizeCategoryPath('照片').segments;
    const inA = listFiles(path.join(c.out, 'A', ...seg));
    const inB = listFiles(path.join(c.out, 'B', ...seg));
    eq(inA.length, 1, 'A 那一份里的文件数');
    eq(inB.length, 1, 'B 那一份里的文件数');
    eq(fs.readFileSync(path.join(c.out, 'A', ...seg, '同名.jpg'), 'utf8'), 'FIRST', 'A 那份的文件被覆盖了');
    eq(fs.readFileSync(path.join(c.out, 'B', ...seg, '同名.jpg'), 'utf8'), 'SECOND', 'B 那份的文件被覆盖了');

    // 同一最深目录里两个同名文件 → 换名（走 core 的既有换名规则）
    const c2 = makeCase('same-name-file-2');
    const root = path.join(c2.src, '来源');
    // 散文件「重名.jpg」与子文件夹「重名」里的「重名.jpg」同名 → 散文件沉进去之后**不能覆盖**它
    const p1 = writeFile(path.join(root, '重名.jpg'), 'LOOSE');
    const p2 = writeFile(path.join(root, '重名', '重名.jpg'), 'INNER');
    const rules2 = [makeRule('r1', '重名', ['jpg'])];
    const plan = core.planFolders({ roots: [root], outputDir: c2.out, rules: rules2 });
    eq(plan.plan.files.length, 2, '计划里的文件数');
    const deepSegs = core.normalizeCategoryPath('重名').segments;
    eq(deepSegs.length, 1, '这条规则该是一层');
    // 两个文件都要落进同一个最深目录（同一个分类名）
    const dirs = new Set(plan.plan.files.map((f) => f.targetDir.toLowerCase()));
    eq(dirs.size, 1, `两个文件该落进同一个最深目录，实际有 ${dirs.size} 个：${Array.from(dirs).join(' | ')}`);
    const deepDir = plan.plan.files[0].targetDir;
    eq(deepDir.toLowerCase(), path.join(c2.out, '来源', ...deepSegs).toLowerCase(), '最深目录与分类路径对不上');
    const summary2 = await runOrganize({ out: c2.out, files: [p1, p2], roots: [root], rules: rules2 });
    eq(summary2.failureCount, 0, '有文件没成功');
    const deepFiles = listFiles(deepDir);
    eq(deepFiles.length, 2, `最深目录里该有 2 个文件，实际：${deepFiles.join(' | ')}`);
    ok(deepFiles.includes('重名.jpg'), '原来的那个文件该保留原名');
    ok(deepFiles.includes('重名 (1).jpg'), '同名相撞的那个该换成「重名 (1).jpg」');
    eq(fs.readFileSync(path.join(deepDir, '重名.jpg'), 'utf8'), 'INNER', '原来的文件被覆盖了');
    eq(fs.readFileSync(path.join(deepDir, '重名 (1).jpg'), 'utf8'), 'LOOSE', '换名后的内容不对');
    ok(fs.existsSync(p1) && fs.existsSync(p2), '原文件被动了');
  });

  log('--- 七、与既有规则共存 + 八、只往深处 ---');
  await check('共存：原样保留 / 沉进同名子文件夹 / 规则输出多级目录，三类互不干扰', async () => {
    const c = makeCase('coexist');
    const root = path.join(c.src, '来源');
    const files = {
      [path.join(root, '散1.jpg')]: '散文件 → 规则（多级）',
      [path.join(root, '发票.pdf')]: '散文件 → 沉进同名子文件夹',
      [path.join(root, '发票', '老发票.pdf')]: '子文件夹里的文件（原样保留）',
      [path.join(root, '相册', '图1.png')]: '子文件夹里的文件（原样保留）',
      [path.join(root, '相册', '婚纱', '纱1.jpg')]: '子文件夹里的文件（原样保留）',
    };
    for (const p of Object.keys(files)) writeFile(p, files[p]);
    const srcFiles = Object.keys(files);
    const rules = [makeRule('r1', '深\\一层\\再一层', ['jpg', 'png'])];
    const summary = await runOrganize({ out: c.out, files: srcFiles, roots: [root], rules });
    eq(summary.failureCount, 0, `有文件没成功：${JSON.stringify(summary.results.map((r) => r.error))}`);
    eq(snapshot(c.out, srcFiles).missingSources.length, 0, '原文件被动了');

    // 期望值全部从计划现算（同一个入口）
    const plan = core.planFolders({ roots: [root], outputDir: c.out, rules }).plan;
    eq(plan.files.length, srcFiles.length, '计划里的文件数');
    const placements = {};
    for (const f of plan.files) placements[f.placement] = (placements[f.placement] || 0) + 1;
    eq(placements.classify, 1, '按规则进多级分类夹的应该只有 1 个（散1.jpg）');
    eq(placements.merge, 1, '沉进同名子文件夹的应该只有 1 个（发票.pdf）');
    eq(placements.keep, 3, '原样保留的应该是 3 个');

    const segs = core.normalizeCategoryPath('深\\一层\\再一层').segments;
    ok(fs.existsSync(path.join(c.out, '来源', segs[0], segs[1], segs[2], '散1.jpg')), '多级分类夹里的文件不在预期位置');
    ok(fs.existsSync(path.join(c.out, '来源', '发票', '发票.pdf')), '沉进同名子文件夹的文件不在预期位置');
    ok(fs.existsSync(path.join(c.out, '来源', '发票', '老发票.pdf')), '发票子文件夹里原有的文件不见了');
    ok(fs.existsSync(path.join(c.out, '来源', '相册', '图1.png')), '相册子文件夹里的文件不见了');
    ok(fs.existsSync(path.join(c.out, '来源', '相册', '婚纱', '纱1.jpg')), '相册\\婚纱 里的文件不见了');

    // 八、只往深处：每个文件的目标目录都以「它原来所在的那一层」为前缀
    for (const f of plan.files) {
      const layer = layerDirOf(c.out, f.origin, f.origin.rootName).toLowerCase();
      const target = f.targetDir.toLowerCase();
      ok(
        target === layer || target.startsWith(layer.endsWith('\\') ? layer : layer + '\\'),
        `文件 ${path.basename(f.fullPath)} 被挪到了更浅的位置：目标 ${f.targetDir} 不在它原来那一层 ${layer} 之下`,
      );
    }
    // 反证：原样保留的文件必须还在**它原来所在的那一层**（层级没被改过）
    for (const f of plan.files) {
      if (f.placement !== 'keep') continue;
      const ownLayer = path.join(f.origin.rootPath, ...(f.origin.chain ?? []));
      eq(
        path.basename(f.targetDir).toLowerCase(),
        path.basename(ownLayer).toLowerCase(),
        `原样保留的文件的层级被改了：${f.fullPath} 的目标目录是 ${f.targetDir}，不是它原来那一层 ${ownLayer}`,
      );
      eq(
        listFiles(path.join(f.targetDir)).includes(path.basename(f.fullPath).toLowerCase()),
        true,
        `原样保留的文件不在它原来那一层里：${f.fullPath}`,
      );
    }
  });

  log('--- 九、安全：危险分类名一律拒绝，且源树之外一个字节都不多 ---');
  await check('安全：危险分类名各自被拒绝（带人话原因），哨兵目录前后不变', async () => {
    // 哨兵目录：与临时目录同级的一个独立目录，前后对比它的文件数与目录数
    const sentinel = path.join(tmpRoot, 'sentinel-outside');
    fs.mkdirSync(path.join(sentinel, 'keep'), { recursive: true });
    writeFile(path.join(sentinel, 'keep', '哨兵.txt'), 'sentinel');
    const before = countTree(sentinel);

    const dangerous = ['..\\..\\外面', 'C:\\temp\\x', '\\\\server\\share', 'photos:bad', 'con', '名字  ', '名字.'];
    const cases = [
      { name: '..\\..\\外面', label: 'parent-escape' },
      { name: 'C:\\temp\\x', label: 'drive-abs' },
      { name: '\\\\server\\share', label: 'unc' },
      { name: 'photos:bad', label: 'colon' },
      { name: 'con', label: 'reserved' },
      { name: '名字  ', label: 'trailing-space' },
      { name: '名字.', label: 'trailing-dot' },
    ];
    eq(cases.map((c) => c.name).join('|'), dangerous.join('|'), '危险用例清单不许被改小');

    for (const item of cases) {
      const c = makeCase(`safety-${item.label}`);
      const root = path.join(c.src, '来源');
      const srcFile = writeFile(path.join(root, '危.txt'), 'x');
      const rules = [makeRule('r1', item.name, ['txt'])];
      const matched = core.classifyWithMeta(rules, srcFile, path.basename(srcFile));
      // ① 必须拒绝（归一化不给路径）并给人话原因
      const normalized = core.normalizeCategoryPath(item.name);
      ok(!normalized.ok, `「${item.name}」该被拒绝，却给出了路径：${normalized.path}`);
      ok(String(normalized.reason || '').length > 0, `「${item.name}」被拒绝了，但没给原因`);
      eq(matched.folder, core.FALLBACK_FOLDER, `「${item.name}」该落到兜底分类`);
      ok(String(matched.invalidReason || '').length > 0, `「${item.name}」随求值一起给的人话原因为空`);

      const summary = await runOrganize({ out: c.out, files: [srcFile], roots: [root], rules });
      eq(summary.failureCount, 0, `「${item.name}」：文件没复制成功`);
      const snap = snapshot(c.out, [srcFile]);
      eq(snap.missingSources.length, 0, `「${item.name}」：原文件被动了`);
      // ② 落在输出树内部，且**不在**源文件夹树外面
      ok(snap.files.length === 1, `「${item.name}」：输出里的文件数`);
      eq(listFiles(c.src).length, 1, `「${item.name}」：源文件夹里的文件数变了`);
      eq(listDirs(c.src).length, 1, `「${item.name}」：源文件夹里多出了目录`);
      // ③ 源文件夹树的外面（c.src 之上）没有多出东西
      eq(countTree(sentinel).files, before.files, `「${item.name}」之后哨兵目录里的文件数变了`);
      eq(countTree(sentinel).dirs, before.dirs, `「${item.name}」之后哨兵目录里的目录数变了`);
    }

    // 再跑一次「危险名 + 正常多级名」混在一起：正常的那条必须照常生效
    const c = makeCase('safety-mixed');
    const root = path.join(c.src, '来源');
    const bad = writeFile(path.join(root, '坏.txt'), 'bad');
    const good = writeFile(path.join(root, '好.jpg'), 'good');
    const rules = [makeRule('r1', '..\\..\\外面', ['txt']), makeRule('r2', '照片\\风光', ['jpg'])];
    const summary = await runOrganize({ out: c.out, files: [bad, good], roots: [root], rules });
    eq(summary.failureCount, 0, '混合用例里有文件没成功');
    const goodSegs = core.normalizeCategoryPath('照片\\风光').segments;
    ok(fs.existsSync(path.join(c.out, '来源', ...goodSegs, '好.jpg')), '正常的多级规则没有生效');
    ok(fs.existsSync(path.join(c.out, '来源', core.FALLBACK_FOLDER, '坏.txt')), '被拒绝的规则该落到兜底分类');
    eq(countTree(sentinel).files, before.files, '混合用例之后哨兵目录里的文件数变了');
    eq(countTree(sentinel).dirs, before.dirs, '混合用例之后哨兵目录里的目录数变了');

    // 结尾空格这种写法，落到磁盘上（经过规则文件读写那一步）也必须还是安全的
    const storeFile = path.join(c.src, '用例-rules.json');
    const saved = core.saveRulesToFile(storeFile, [makeRule('r1', '名字  ', ['txt'])]);
    ok(saved.ok, `把「名字  」写进规则文件失败：${saved.message}`);
    const loaded = core.loadRulesFromFile(storeFile);
    eq(loaded.rules.length, 1, '规则文件读回来的条数');
    // 落盘会顺手把规则名收拾干净（现有的 cleanText 会去掉头尾空白），这是**产品行为**，
    // 所以两种都要验：① 存之前（名字带结尾空格）被拒绝；② 读回来之后（名字已被收拾）能正常用、且不越界。
    const savedNormalized = core.normalizeCategoryPath(loaded.rules[0].name);
    ok(savedNormalized.ok, `从规则文件读回来的「${loaded.rules[0].name}」该是能用的：${savedNormalized.reason}`);
    eq(savedNormalized.segments.length, 1, '读回来的这条该是一层');
    const savedMatch = core.classifyWithMeta(loaded.rules, path.join(root, '危2.txt'), '危2.txt');
    eq(savedMatch.folder, savedNormalized.path, '读回来的这条规则求值结果与归一化结果该一致');
    // 而「名字.」（结尾点）不管怎么落盘都不许过：那是 Windows 建不出来的目录名
    const savedDot = core.normalizeCategoryPath('名字.');
    ok(!savedDot.ok, '「名字.」该被拒绝');
    ok(String(savedDot.reason || '').length > 0, '「名字.」被拒绝了但没给原因');
  });

  log('--- 十、真落盘一次（多级规则） ---');
  await check('真落盘：结构与逐条预期一致，源文件一个不少', async () => {
    const c = makeCase('real-run');
    const root = path.join(c.src, '下载');
    const files = {
      [path.join(root, '一.jpg')]: '1',
      [path.join(root, '二.png')]: '2',
      [path.join(root, '三.pdf')]: '3',
      [path.join(root, '相册', '四.jpg')]: '4',
      [path.join(root, '相册', '风光', '五.jpg')]: '5',
    };
    for (const p of Object.keys(files)) writeFile(p, files[p]);
    const srcFiles = Object.keys(files);
    const rules = [makeRule('r1', '照片\\风光', ['jpg', 'png'])];
    const summary = await runOrganize({ out: c.out, files: srcFiles, roots: [root], rules });
    eq(summary.failureCount, 0, '有文件没成功');
    eq(summary.successCount, srcFiles.length, '成功数');
    const snap = snapshot(c.out, srcFiles);
    eq(snap.missingSources.length, 0, `源文件少了：${snap.missingSources.join(' | ')}`);
    eq(snap.files.length, srcFiles.length, `输出里的文件数该等于源文件数：${snap.files.join(' | ')}`);
    // 逐条对照计划（同一个入口算出来的落点）
    const plan = core.planFolders({ roots: [root], outputDir: c.out, rules }).plan;
    eq(plan.files.length, srcFiles.length, '计划里的文件数');
    for (const f of plan.files) {
      const target = path.join(f.targetDir, f.name);
      ok(fs.existsSync(target), `计划说要去 ${target}，磁盘上没有`);
      ok(fs.readFileSync(target, 'utf8').length >= 0, '读不到目标文件');
      const layer = layerDirOf(c.out, f.origin, f.origin.rootName).toLowerCase();
      const dir = f.targetDir.toLowerCase();
      ok(dir === layer || dir.startsWith(layer + '\\'), `文件被挪到更浅的位置：${f.targetDir}`);
    }
    // 「照片\风光」这一条：分类夹是两层（照片 下面是 风光），不是名字里带分隔符的一个目录
    const segs = core.normalizeCategoryPath('照片\\风光').segments;
    const layer1 = path.join(c.out, '下载', segs[0]);
    ok(
      fs.existsSync(layer1) && fs.statSync(layer1).isDirectory(),
      `第一层分类夹没建出来：${layer1}`,
    );
    const layer1Entries = fs.readdirSync(layer1, { withFileTypes: true }).filter((e) => e.isDirectory());
    ok(
      layer1Entries.some((e) => e.name === segs[1]),
      `第一层分类夹里没有一层正好叫「${segs[1]}」的目录（现在有：${layer1Entries.map((e) => e.name).join(' | ')}）`,
    );
    const deepDir = path.join(layer1, segs[1]);
    eq(listFiles(deepDir).length, 2, `两层分类夹里的文件数（一.jpg、二.png）：${listFiles(deepDir).join(' | ')}`);
    ok(fs.existsSync(path.join(c.out, '下载', '相册', '风光', '五.jpg')), '原有的 相册\\风光 里的文件没被原样保留');
  });

  log('--- 十一、界面侧：规则行显目标 + 预览树多层结构 ---');
  await check('界面：规则行显示 core 给的归一化目标，预览树画出两层，且真整理出两层', async () => {
    const rendererSource = fs.readFileSync(RENDERER_JS, 'utf8');
    const ruleName = '照片\\风光';
    const normalized = core.normalizeCategoryPath(ruleName);
    ok(normalized.ok, 'core 认为「照片\\风光」不能用');
    eq(normalized.segments.length, 2, '这条规则该是两层');

    const c = makeCase('ui-nested');
    const root = path.join(c.src, '来源');
    const srcFile = writeFile(path.join(root, '散1.jpg'), 'x');

    const org = makeOrganizer({ files: { [srcFile]: true }, roots: [root], outputDir: c.out });
    const stub = await runInWindowStub(rendererSource, 'renderer(nested)', org.api);
    try {
      ok(!stub.error, `界面产物在窗口桩里没跑完：${stub.error}`);
      const fileCount = stub.elements.get('file-count');
      const ruleList = stub.elements.get('rule-list');
      const previewTree = stub.elements.get('preview-tree');
      ok(!!ruleList && !!previewTree, '桩里没有规则表 / 预览树这两个容器');

      // ① 加入源文件夹（走界面自己的按钮，不直接改内部状态）
      stub.windowStub.organizer.pickFolders = async () => [root];
      stub.elements.get('pick-folders').dispatch('click');
      await flush();
      await flush();
      ok(String(fileCount.textContent).includes('已选 1 个文件'), `选文件夹之后界面没显示已选 1 个文件：${fileCount.textContent}`);

      // ② 新建一条规则，分类名写「照片\风光」（用户的写法：带层级）
      stub.elements.get('rule-add').dispatch('click');
      await flush();
      await flush();
      const rows = ruleList.children || [];
      ok(rows.length >= 1, '规则表里没有规则行');
      const nameInput = rows[0].children.find((ch) => ch.className === 'rule-name');
      ok(!!nameInput, '规则行里没有分类名输入框（class=rule-name）');
      nameInput.value = ruleName;
      nameInput.dispatch('change');
      // 让 core 的结论回包跑几轮，确保界面拿到的是「改名之后」的那份
      for (let i = 0; i < 5; i++) await flush();

      // ③ 规则行上必须能看出「实际会建到哪儿」，而且与 core 给出的结论一致
      const targetSpan = rows[0].children.find((ch) => ch.className === 'rule-target');
      ok(!!targetSpan, '规则行上没有「实际目标」那一格（class=rule-target）');
      const targetText = String(targetSpan.textContent || '');
      ok(targetText.includes(ruleName), `规则行上的目标没写出「${ruleName}」：${targetText}`);
      // 「core 给的归一化结论」= 拿界面上这份规则表（桩记下来的那份）喂给 core 现算
      const askedRules = org.state.targetCalls.length > 0 ? org.state.targetCalls[org.state.targetCalls.length - 1].rules : [];
      eq(askedRules.length, rows.length, '界面传给 core 的规则条数该与规则行数一致');
      const authoritative = core.ruleTargetsOf(askedRules);
      eq(authoritative.length, rows.length, 'core 给出的规则目标条数');
      const targetEntry = authoritative.find((t) => t.segments && t.segments.join('\\') === normalized.path);
      ok(!!targetEntry, `core 给的规则目标里找不到「${normalized.path}」：${JSON.stringify(authoritative)}`);
      eq(targetEntry.segments.length, 2, 'core 给的这条规则该是两层');
      eq(targetEntry.targetPath, normalized.path, 'core 给的路径与归一化结果该一致');
      ok(
        targetText.includes(`${targetEntry.targetPath}\\`) || targetText.includes(targetEntry.targetPath),
        `规则行上的目标（${targetText}）与 core 给的（${targetEntry.targetPath}）对不上`,
      );
      // 规则行上那格还必须是**两层**的意思（不是把整串当成一个名字）
      eq(targetEntry.segments[0], normalized.segments[0], 'core 给的第一层');
      eq(targetEntry.segments[1], normalized.segments[1], 'core 给的第二层');

      // ④ 预览：多层分类名必须被画成两层，而且最内层嵌在最外层里
      //    （先走界面自己的「选择输出文件夹」按钮，别直接改内部状态）
      stub.elements.get('pick-out').dispatch('click');
      await flush();
      await flush();
      const previewBtn = stub.elements.get('preview');
      const noticeEl = stub.elements.get('notice');
      previewBtn.dispatch('click');
      await flush();
      await flush();
      await flush();
      ok(
        (org.state.previewCalls || []).length > 0,
        `点「预览」没有走到 api.preview（预览树是空的，文字=${JSON.stringify(textOf(previewTree))}；` +
          `按钮监听器=${(previewBtn.listeners.get('click') || []).length}；界面提示=${JSON.stringify(String(noticeEl.textContent))}）`,
      );
      ok(
        (previewTree.children || []).length > 0,
        `预览树一个节点都没有（提示=${JSON.stringify(String(noticeEl.textContent))}；` +
          `第一次预览的 roots=${JSON.stringify(org.state.previewCalls[0].roots)}；` +
          `根节点=${(previewTree.children || []).map((c) => c.className).join(' | ')}）`,
      );
      const previewOutcome = org.state.previewCalls[org.state.previewCalls.length - 1];
      ok(
        Array.isArray(previewOutcome.roots) && previewOutcome.roots.length === 1,
        `界面点预览时没有把源文件夹交给后台（roots=${JSON.stringify(previewOutcome.roots)}）`,
      );
      const cats = findByClass(previewTree, 'cat');
      const catNames = cats.map((node) => nodeLabel(node));
      ok(catNames.includes(normalized.segments[0]), `预览里没有「${normalized.segments[0]}」这一层：${catNames.join(' | ')}`);
      ok(catNames.includes(normalized.segments[1]), `预览里没有「${normalized.segments[1]}」这一层：${catNames.join(' | ')}`);
      for (const name of catNames) ok(!name.includes('\\'), `预览里有一层目录名带着分隔符：${name}`);
      eq(findNotNestedEvidence(previewTree, normalized.segments).length, 0, findNotNestedEvidence(previewTree, normalized.segments).join('；'));
      const previewText = textOf(previewTree);
      ok(previewText.includes('散1.jpg'), `预览树里没看到那个文件：${previewText}`);
      // 预览树里的目录链必须与 core 计划里那条链一致（不是脚本自己猜的）
      const plan = core.planFolders({ roots: [root], outputDir: c.out, rules: [{ ...makeRule('r1', ruleName, ['jpg']) }] }).plan;
      const plannedSegs = plan.files[0].targetDir.slice(path.join(c.out, '来源').length + 1).split(/[\\/]+/);
      eq(plannedSegs.join('|'), normalized.segments.join('|'), '计划里那条目录链与规则归一化结果不一致');
      eq(previewText.includes(normalized.segments[1]), true, '预览里没写出最内层那一段');

      // ⑤ 真的整理一次：输出里确实出现两层（走界面自己的按钮）
      const before = countTree(c.out);
      const startBtn = stub.elements.get('start');
      ok(startBtn.disabled !== true, '「开始整理」按钮被禁用了（方向校验该是允许的）');
      startBtn.dispatch('click');
      // 真整理是异步落盘，等它落地（最多 5 秒；等不到下面就会带着证据判失败）
      await waitFor(
        () => (org.state.organizeSummaries || []).length > 0 && countTree(c.out).files >= 1,
        5000,
      );
      const after = countTree(c.out);
      ok(
        (org.state.organizeCalls || []).length >= 1,
        `点「开始整理」没有走到 api.organize（界面提示=${JSON.stringify(String(noticeEl.textContent))}；` +
          `结果区=${JSON.stringify(String(stub.elements.get('summary').textContent))}）`,
      );
      ok(after.files >= 1, `点「开始整理」之后输出里没有文件（before=${JSON.stringify(before)} after=${JSON.stringify(after)}；` +
        `界面提示=${JSON.stringify(String(noticeEl.textContent))}；结果区=${JSON.stringify(String(stub.elements.get('summary').textContent))}；` +
        `整理调用=${JSON.stringify((org.state.organizeCalls[0] || {}).files)}；` +
        `整理结果=${JSON.stringify((org.state.organizeSummaries || [])[0] || null)})`);
      ok(
        fs.existsSync(path.join(c.out, '来源', normalized.segments[0], normalized.segments[1], '散1.jpg')),
        '界面点「开始整理」之后，两层分类夹里没有那个文件',
      );
      ok(fs.existsSync(srcFile), '原文件被动了');

      // ⑥ 探针必须是活的：拿「把 照片\风光 当成一个目录名」的产物喂给同一套断言，必须判失败
      const flatStub = await runInWindowStub(FLAT_CATEGORY_PRODUCT, 'renderer(flat-category bait)', makeOrganizer({ files: { [srcFile]: true }, roots: [root], outputDir: c.out }).api);
      try {
        ok(!flatStub.error, `反证产物自己都没跑起来（那样探针不算活的）：${flatStub.error}`);
        const flatTree = flatStub.elements.get('preview-tree');
        flatStub.windowStub.organizer.pickFolders = async () => [root];
        flatStub.elements.get('pick-folders').dispatch('click');
        await flush();
        await flush();
        flatStub.elements.get('preview').dispatch('click');
        await flush();
        await flush();
        await flush();
        const flatEvidence = findFlatCategoryEvidence(flatTree, normalized.segments);
        ok(flatEvidence.length > 0, '反证产物（把多层分类名当成一个目录名）居然通过了探针 —— 探针是死的');
        const flatNest = findNotNestedEvidence(flatTree, normalized.segments);
        ok(flatNest.length > 0, '反证产物（两层并列、没有嵌套）居然通过了「必须嵌套」那条 —— 探针是死的');
      } finally {
        flatStub.restore();
      }
    } finally {
      stub.restore();
    }
  });

  /* ---------- 收尾：打印结论 ---------- */
  const failed = results.filter(([, pass]) => !pass).map(([name]) => name);
  log(`检查项：${results.length} 个，通过 ${results.length - failed.length} 个，失败 ${failed.length} 个`);
  if (uncaught.length > 0) {
    log(`未捕获异常：${uncaught.join(' | ')}`);
  }
  if (failed.length === 0 && uncaught.length === 0) {
    log('嵌套规则OK');
    process.exit(0);
  }
  console.log('验收失败:嵌套规则');
  process.exit(1);
})();
