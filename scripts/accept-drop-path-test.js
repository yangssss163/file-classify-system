/**
 * 第 5 条验收：拖入取路径 + 界面脚本能在窗口里跑到底。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 六条断言：
 *   一、探针有效：拿「还用 File.path 的旧版 renderer 源码字符串」与「带 exports 的旧版产物字符串」（纯内存）去检查，
 *       必须都判不合格；同一段旧产物在浏览器式作用域里执行必须失败、在 CommonJS 里能跑；正确写法不许被误判。
 *       （探针抓不住旧写法 = 探针是死的 = 直接失败）
 *   二、preload 侧：用了 webUtils.getPathForFile + 通过 contextBridge 暴露「File→路径字符串」的函数，且没有 File.path 写法；
 *   三、界面侧：drop 处理调用的是 preload 暴露的取路径函数，且不再用 .path 取文件路径；
 *   四、编译产物：out\preload.js 有 getPathForFile；out\renderer\renderer.js 调 preload 那个函数，
 *       且**不含 CommonJS 包装**（没有 exports / require / __esModule，否则在窗口里会 "exports is not defined" 当场死掉）；
 *   五、真的把 out\renderer\renderer.js 当脚本执行一遍（动态 import 真文件，不是字符串匹配、不是只 require 一下）：
 *       执行期任何未捕获异常/未处理 Promise 拒绝都算失败；执行后「选择文件」按钮点击会调到假的 api.pickFiles、
 *       拖拽区触发 drop 会走到取路径那条路并更新「已选 N 个文件」；
 *   六、不依赖真窗口的等价证明：最小 DOM 桩 + 假 window.organizer（取路径返回 5 个真实临时文件路径）；
 *       drop 5 个文件 → 「已选 5 个文件」；再 drop 一次不重复计数；全程磁盘不多出任何文件/目录。
 *
 * 六条都过：stdout 打印「拖入取路径OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:拖入取路径」并 exit 1。
 *
 * 说明：检查日志刻意用 ASCII，避免 Windows PowerShell 5.1 按别的编码解码日志时出现误解码；
 * 只有最后那句判定用中文（验收.ps1 同时按退出码判定，不依赖这句的编码）。
 * 跑法：node scripts\accept-drop-path-test.js   （由 scripts\验收.ps1 调用）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'out');
const PRELOAD_JS = path.join(outDir, 'preload.js');
const RENDERER_JS = path.join(outDir, 'renderer', 'renderer.js');

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

/* ------------------------------------------------------------------ *
 * 探针：把「取文件路径」的写法与「CommonJS 包装」找出来
 * ------------------------------------------------------------------ */

/**
 * 去掉注释与字符串/模板字面量的内容（保留换行，便于肉眼对数）。
 * 为什么要去：探针只该管「真的代码」——注释里写一句「File.path 已被移除」、提示语里出现
 * 「读不到这个文件的路径」都不算用 .path 取路径；不剥掉就会把正确实现误判成不合格。
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const modes = { code: 0, line: 1, block: 2, sq: 3, dq: 4, tpl: 5 };
  let mode = modes.code;
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (mode === modes.code) {
      if (c === '/' && next === '/') {
        mode = modes.line;
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        mode = modes.block;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        mode = c === "'" ? modes.sq : c === '"' ? modes.dq : modes.tpl;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === modes.line) {
      if (c === '\n') {
        out += c;
        mode = modes.code;
      }
      i += 1;
      continue;
    }
    if (mode === modes.block) {
      if (c === '*' && next === '/') {
        mode = modes.code;
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    const closer = mode === modes.sq ? "'" : mode === modes.dq ? '"' : '`';
    if (c === closer) {
      mode = modes.code;
      i += 1;
      continue;
    }
    if (c === '\n') out += c;
    i += 1;
  }
  return out;
}

/**
 * 探针本体：给定源码/产物字符串，判断里面还有没有「用 .path 取文件路径」的写法。
 * 返回命中的片段数组（空数组 = 合格）。
 */
function findLegacyPathReads(source) {
  const code = stripCommentsAndStrings(source);
  const hits = [];
  const add = (why, m) => hits.push(`${why}: ${String(m).trim().slice(0, 120)}`);

  // A. 任何 `.path` 属性读写（File.path / anyFile.path / f.path ...）
  //    排除 `.pathForFile(` 这类函数调用与 `.pathXxx` 这类别的名字：只认「后面不接标识符也不接左括号」的纯属性访问。
  let m;
  const dotPath = /\.path(?![\w(])/g;
  while ((m = dotPath.exec(code)) !== null) add('dot-path-prop', m[0]);

  // B. 中括号取 path：obj['path'] / obj["path"]
  const bracketPath = /\[\s*['"]path['"]\s*\]/g;
  while ((m = bracketPath.exec(code)) !== null) add('bracket-path-prop', m[0]);

  // C. 解构取 path
  const destructure = /\{[^}]*\bpath\b[^}]*\}\s*=/g;
  while ((m = destructure.exec(code)) !== null) add('destructure-path', m[0]);

  return hits;
}

/**
 * 探针本体：给定界面产物字符串，判断它是不是带 CommonJS 包装
 * （在窗口里加载时这类代码会在第一行就因 exports 未定义而崩）。
 * 返回命中的片段数组（空数组 = 干净）。
 */
function findCommonJsWrapper(productSource) {
  const code = stripCommentsAndStrings(productSource);
  const hits = [];
  const add = (why, m) => hits.push(`${why}: ${String(m).trim().slice(0, 120)}`);
  let m;
  const patterns = [
    // TypeScript 的 CJS 产物第一行就是这句（注意：字符串内容已被剥掉，所以不能靠 "__esModule" 字面量来认）
    ['cjs-exports-marker', /Object\.defineProperty\s*\([\s\S]{0,20}?exports\s*,/g],
    ['cjs-require-call', /(^|[^\w.$])require\s*\(/g],
    ['cjs-module-exports', /(^|[^\w.$])module\s*\.\s*exports/g],
    // 裸 exports：`exports.x = ...` / `exports[...]` / `exports,` / 行首 `exports = ...`
    ['cjs-bare-exports', /(^|[^\w.$])exports\s*(?:\[|\.|,)/g],
    ['cjs-bare-exports-assign', /(^|\n)\s*exports\s*=/g],
  ];
  for (const [why, re] of patterns) {
    while ((m = re.exec(code)) !== null) add(why, m[0]);
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * 旧写法样本（纯内存字符串，不落盘；断言一拿它们当靶子）
 * ------------------------------------------------------------------ */

// 旧版 renderer.ts 的写法：用 File.path 取路径
const OLD_RENDERER_SOURCE = [
  "const paths: string[] = [];",
  "for (const file of Array.from(dt.files)) {",
  "  const anyFile = file as File & { path?: string };",
  "  if (typeof anyFile.path === 'string' && anyFile.path.length > 0) paths.push(anyFile.path);",
  "}",
  "if (paths.length === 0) { notice('没拿到文件路径，请改用「选择文件」按钮'); return; }",
].join('\n');

// 旧版编译产物：commonjs 包装 + 一模一样的启动即崩
const OLD_RENDERER_BUNDLE = [
  '"use strict";',
  'Object.defineProperty(exports, "__esModule", { value: true });',
  'const api = window.organizer;',
  'window.__probe_side_effect = (window.__probe_side_effect || 0) + 1;',
  'document.getElementById("pick-files").addEventListener("click", () => { api.pickFiles(); });',
].join('\n');

/**
 * 把一段代码当成「窗口里的脚本」真执行一遍：作用域里**没有** exports / module / require
 * （普通 <script> 与 ES module 都没有这些绑定），所以旧产物那句 Object.defineProperty(exports, ...)
 * 会真的抛 ReferenceError: exports is not defined —— 这就是用户看到的启动即崩。
 * 注意：这不是「patch 一个假 exports」，恰恰相反：这里刻意不提供 exports，让漏网的写法自己炸出来。
 * 用真正的 ES module 作用域（vm.SourceTextModule），所以顶层 import/export 也能被如实处理。
 */
async function runAsBrowserScript(code, fileLabel, organizerStub) {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error(
      'node was started without --experimental-vm-modules, so a real ES-module scope cannot be built',
    );
  }
  // 用和断言五/六同一套最小 DOM 桩：跑的就是真产物在真桩上的行为
  const dom = createDomStub();
  dom.windowStub.organizer = organizerStub || makeInertOrganizerStub();
  const globalBefore = { window: global.window, document: global.document };
  global.window = dom.windowStub;
  global.document = dom.documentStub;
  try {
    const mod = new vm.SourceTextModule(code, { identifier: fileLabel });
    await mod.link(() => {
      throw new Error(`${fileLabel} must not import anything at load time`);
    });
    await mod.evaluate();
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: `${err.constructor.name}: ${err.message}` };
  } finally {
    global.window = globalBefore.window;
    global.document = globalBefore.document;
  }
}

/** 什么都不做的 organizer 桩：只用来判断「脚本能不能挂完监听器」。 */
function makeInertOrganizerStub() {
  return {
    pathForFile: () => null,
    pickFiles: async () => [],
    pickOutputDir: async () => null,
    exists: async () => ({}),
    preview: async () => ({ ok: false, reason: 'not-used', message: 'stub' }),
    organize: async () => ({ total: 0, successCount: 0, failureCount: 0, outputDir: '' }),
    openPath: async () => '',
    onProgress: () => {},
  };
}

/** 同一段代码当成 Node 的 CommonJS 跑（旧产物在 Node 里能跑，在窗口里不能）。 */
function runAsCommonJs(code) {
  const module = { exports: {} };
  const fn = new Function('exports', 'module', 'require', code);
  // 最小 window/document 桩：这一段只是要证明「同一段代码换到 CJS 环境里就不会因 exports 崩」
  const globalBefore = { window: global.window, document: global.document };
  global.window = { organizer: { pickFiles: async () => [] } };
  global.document = {
    getElementById() {
      return { addEventListener() {}, classList: { add() {}, remove() {} }, style: {} };
    },
  };
  try {
    fn(module.exports, module, require);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: `${err.constructor.name}: ${err.message}` };
  } finally {
    global.window = globalBefore.window;
    global.document = globalBefore.document;
  }
}

/* ------------------------------------------------------------------ *
 * 断言一：两个探针都有效
 * ------------------------------------------------------------------ */

async function assert1ProbesAreAlive() {
  log('');
  log('--- assert 1/6: probes are alive (legacy sources must be rejected) ---');

  const pathHits = findLegacyPathReads(OLD_RENDERER_SOURCE);
  if (pathHits.length === 0) {
    log('FAIL: probe said OK for the legacy File.path source -> the probe is dead');
    return false;
  }
  log(`OK: path probe rejected the legacy File.path source, ${pathHits.length} hit(s)`);
  for (const h of pathHits.slice(0, 5)) log(`  hit -> ${h}`);

  const goodSample = [
    "const p = api.pathForFile(file);",
    "const q = file.pathname;",
    "import * as path from 'path';",
    "const d = path.dirname(p);",
  ].join('\n');
  if (findLegacyPathReads(goodSample).length !== 0) {
    log('FAIL: path probe also rejected the correct sample (false positive)');
    for (const h of findLegacyPathReads(goodSample)) log(`  hit -> ${h}`);
    return false;
  }

  // CommonJS 包装探针：旧产物必须被抓到，正常 ES module 产物不许被抓到
  const cjsHits = findCommonJsWrapper(OLD_RENDERER_BUNDLE);
  if (cjsHits.length === 0) {
    log('FAIL: CJS-wrapper probe said OK for the legacy bundle -> the probe is dead');
    return false;
  }
  log(`OK: CJS-wrapper probe rejected the legacy bundle, ${cjsHits.length} hit(s)`);
  for (const h of cjsHits.slice(0, 5)) log(`  hit -> ${h}`);
  const esmSample = [
    "const api = window.organizer;",
    "const el = document.getElementById('drop');",
    "function createDropHandler() { return (ev) => { const p = api.pathForFile(ev.files[0]); return p; }; }",
    "el.addEventListener('drop', createDropHandler());",
  ].join('\n');
  if (findCommonJsWrapper(esmSample).length !== 0) {
    log('FAIL: CJS-wrapper probe rejected a clean ES-module sample (false positive)');
    for (const h of findCommonJsWrapper(esmSample)) log(`  hit -> ${h}`);
    return false;
  }

  // 执行层面也自证一次，并且拿真产物当对照：
  //   旧产物（带 exports 包装）在「窗口式」作用域里必须崩，
  //   同一段旧产物在 CommonJS 环境里能跑（证明「崩」不是代码本身有别的毛病），
  //   **当前真产物** out\renderer\renderer.js 在同一套窗口式桩里不许崩。
  const asBrowser = await runAsBrowserScript(OLD_RENDERER_BUNDLE, 'legacy-bundle.js');
  if (asBrowser.ok) {
    log('FAIL: the legacy bundle ran fine in a window-like scope -> the execution probe is dead');
    return false;
  }
  if (!/exports is not defined|exports is not a|Cannot read properties of undefined|Object\.defineProperty/.test(asBrowser.error)) {
    log(`FAIL: the legacy bundle failed for an unexpected reason (${asBrowser.error})`);
    return false;
  }  const asCjs = runAsCommonJs(OLD_RENDERER_BUNDLE);
  if (!asCjs.ok) {
    log(`FAIL: the legacy bundle could not even run as CommonJS (${asCjs.error})`);
    return false;
  }
  log(`OK: legacy bundle dies in a window-like scope (${asBrowser.error}) but runs as CommonJS`);

  // 重跑一次真实情况的 byte 检查：窗口真正加载的是 out/renderer/renderer.js
  // （声明文件 api-types.js 是主编译顺手编出来的空壳，index.html 不加载它，也不该由这条判据管）
  const realAsBrowser = await runAsBrowserScript(readText(RENDERER_JS), 'current-renderer.js');
  if (!realAsBrowser.ok) {
    log(`FAIL: the CURRENT out/renderer/renderer.js dies in a window-like scope (${realAsBrowser.error})`);
    return false;
  }
  log('OK: the current out/renderer/renderer.js runs in the same window-like scope');

  const html = readText(path.join(outDir, 'renderer', 'index.html'));
  const tagRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let tag;
  let scriptsFound = 0;
  while ((tag = tagRe.exec(html)) !== null) {
    const target = path.join(outDir, 'renderer', tag[1]);
    if (!fs.existsSync(target)) {
      log(`FAIL: out/renderer/index.html loads ${tag[1]}, which does not exist`);
      return false;
    }
    const loaded = await runAsBrowserScript(readText(target), `window-loads:${tag[1]}`);
    if (!loaded.ok) {
      log(`FAIL: ${tag[1]} (loaded by the window) dies -> ${loaded.error}`);
      return false;
    }
    scriptsFound++;
  }
  if (scriptsFound === 0) {
    log('FAIL: out/renderer/index.html loads no script at all');
    return false;
  }
  log(`OK: every script the window loads (${scriptsFound}) runs in a window-like scope`);

  // 断言二用的探针也自检：正确的接线必须被认出来，没接线的必须不被认出来
  const wiredSample = [
    "function pathForFile(file: File): string | null {",
    "  const p = webUtils.getPathForFile(file);",
    "  return typeof p === 'string' && p.length > 0 ? p : null;",
    "}",
    "const api = {",
    "  pathForFile,",
    "  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickFiles'),",
    "};",
    "contextBridge.exposeInMainWorld('organizer', api);",
  ].join('\n');
  const wired = findExposedPathFunction(wiredSample);
  const notWired = findExposedPathFunction(wiredSample.replace('  pathForFile,\n', ''));
  if (!wired || notWired) {
    log(`FAIL: exposed-function probe is not reliable (wired=${JSON.stringify(wired)}, notWired=${JSON.stringify(notWired)})`);
    return false;
  }
  log(`OK: exposed-function probe accepted the wired sample (${wired.apiName}.${wired.fnName}) and rejected the unwired one`);

  return true;
}

/* ------------------------------------------------------------------ *
 * 断言二 / 三：源码侧
 * ------------------------------------------------------------------ */

/**
 * 在 preload 源码里找：contextBridge 暴露的对象里，哪个「输入 File、返回路径字符串」的函数用了 getPathForFile。
 */
function findExposedPathFunction(source) {
  const fnRe =
    /function\s+([A-Za-z_$][\w$]*)\s*\(\s*[A-Za-z_$][\w$]*\s*(?::[^)]+)?\)\s*(?::[^={]+)?\{[\s\S]*?getPathForFile[\s\S]*?\n\}/;
  const fn = source.match(fnRe);
  if (!fn) return null;
  const fnName = fn[1];

  const bridge = source.match(/exposeInMainWorld\s*\(\s*['"][^'"]+['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (!bridge) return null;
  const apiName = bridge[1];

  // 暴露对象里必须真的登记这个函数：简写属性 `pathForFile,` 或 `pathForFile: (...) => {...}` 两种写法都认。
  const entryRe = new RegExp(`\\b${fnName}\\s*(?:=>|(?=[,}\\n])|:\\s*[A-Za-z_$][\\w$]*\\s*=>)`);
  const entry = source.match(entryRe);
  if (!entry) return null;

  return { fnName, apiName };
}

function assert2PreloadSource() {
  log('');
  log('--- assert 2/6: src/preload.ts ---');
  const srcPath = path.join(projectRoot, 'src', 'preload.ts');
  const source = readText(srcPath);
  let ok = true;

  if (!/\bwebUtils\b/.test(source)) {
    log('FAIL: src/preload.ts does not reference webUtils');
    ok = false;
  }
  if (!/getPathForFile/.test(source)) {
    log('FAIL: src/preload.ts does not use getPathForFile');
    ok = false;
  }

  const legacy = findLegacyPathReads(source);
  if (legacy.length > 0) {
    log('FAIL: src/preload.ts still reads file paths through .path');
    for (const h of legacy.slice(0, 5)) log(`  hit -> ${h}`);
    ok = false;
  }

  const found = findExposedPathFunction(source);
  if (!found) {
    log('FAIL: no contextBridge-exposed function takes a File and reads its path via getPathForFile');
    ok = false;
  } else {
    log(`OK: contextBridge.${found.apiName} exposes ${found.fnName}(<File>) -> path string via getPathForFile`);
  }

  if (ok) log('OK: src/preload.ts exposes a File-to-path function via webUtils.getPathForFile');
  return ok;
}

function assert3RendererSource() {
  log('');
  log('--- assert 3/6: src/renderer/renderer.ts ---');
  const srcPath = path.join(projectRoot, 'src', 'renderer', 'renderer.ts');
  const source = readText(srcPath);
  let ok = true;

  const legacy = findLegacyPathReads(source);
  if (legacy.length > 0) {
    log('FAIL: src/renderer/renderer.ts still reads file paths through .path');
    for (const h of legacy.slice(0, 5)) log(`  hit -> ${h}`);
    ok = false;
  }
  if (/getPathForFile/.test(stripCommentsAndStrings(source))) {
    log('FAIL: src/renderer/renderer.ts calls getPathForFile directly (must go through preload)');
    ok = false;
  }

  // drop 处理里必须调用 preload 暴露的取路径函数
  const scopeMatch = source.match(
    /createDropHandler[\s\S]*?\n\}|el\.drop\.addEventListener\(\s*['"]drop['"][\s\S]{0,2000}?\n\}\);/,
  );
  const scope = scopeMatch ? scopeMatch[0] : source;
  if (!/\.pathForFile\s*\(/.test(scope)) {
    log('FAIL: the drop handler does not call a preload path function (api.pathForFile)');
    ok = false;
  } else {
    log('OK: drop handler calls <preload api>.pathForFile(file)');
  }

  if (ok) log('OK: the renderer takes drop paths only from the preload function');
  return ok;
}

/* ------------------------------------------------------------------ *
 * 断言四：编译产物
 * ------------------------------------------------------------------ */

function assert4CompiledWiring() {
  log('');
  log('--- assert 4/6: compiled output out/ ---');
  let ok = true;
  for (const p of [PRELOAD_JS, RENDERER_JS]) {
    if (!fs.existsSync(p)) {
      log(`FAIL: missing ${p} (run npm run build first)`);
      ok = false;
    }
  }
  if (!ok) return false;

  const preloadJs = readText(PRELOAD_JS);
  if (!/getPathForFile/.test(preloadJs)) {
    log('FAIL: out/preload.js has no getPathForFile');
    ok = false;
  } else {
    log('OK: out/preload.js references getPathForFile');
  }
  if (!/exposeInMainWorld/.test(preloadJs)) {
    log('FAIL: out/preload.js has no exposeInMainWorld');
    ok = false;
  }

  const rendererJs = readText(RENDERER_JS);
  if (!/\.pathForFile\s*\(/.test(rendererJs)) {
    log('FAIL: out/renderer/renderer.js does not call the preload path function');
    ok = false;
  } else {
    log('OK: out/renderer/renderer.js calls the preload path function');
  }
  const legacy = findLegacyPathReads(rendererJs);
  if (legacy.length > 0) {
    log('FAIL: out/renderer/renderer.js still reads file paths through .path');
    for (const h of legacy.slice(0, 5)) log(`  hit -> ${h}`);
    ok = false;
  }

  // 界面产物不许带 CommonJS 包装：带上就会在窗口里「exports is not defined」启动即崩
  const cjs = findCommonJsWrapper(rendererJs);
  if (cjs.length > 0) {
    log('FAIL: out/renderer/renderer.js carries a CommonJS wrapper (it will crash in the window)');
    for (const h of cjs.slice(0, 5)) log(`  hit -> ${h}`);
    ok = false;
  } else {
    log('OK: out/renderer/renderer.js has no CommonJS wrapper (no exports/require/__esModule)');
  }

  if (ok) log('OK: compiled wiring is in place');
  return ok;
}

/* ------------------------------------------------------------------ *
 * 最小 DOM 桩
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
    style: {},
    children: [],
    listeners: new Map(),
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
      for (const h of list) h(event);
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

/* ---- 桩环境：整个脚本共用一份 DOM，organizer 的桩可以逐个断言替换（监听器是同一份，不会重复挂） ---- */

const stub = {
  elements: null,
  windowEl: null,
  calls: { pathForFile: 0, pickFiles: 0, exists: 0 },
};

/**
 * 最小 DOM 桩（断言五、六共用）。用 global.document / global.window 接上，
 * 同时把元素表返回出去，方便断言去「点按钮」和「触发 drop」。
 */
function createDomStub() {
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
    organizer: null,
    addEventListener(type, handler) {
      windowEl.addEventListener(type, handler);
    },
    removeEventListener(type, handler) {
      windowEl.removeEventListener(type, handler);
    },
  };
  return { documentStub, windowStub, elements, windowEl };
}

function installStubDom() {
  if (stub.elements) return;
  const dom = createDomStub();
  global.document = dom.documentStub;
  global.window = dom.windowStub;
  stub.elements = dom.elements;
  stub.windowEl = dom.windowEl;
  // 说明：window 只建一次——界面脚本在加载时就把 window.organizer 抓成了局部常量 api，
  // 所以后面换桩只能换 window.organizer 上的方法，不能把整个 window 换掉。
}

/**
 * 换掉 window.organizer 的桩。pathResolver: (file) => string|null
 * 注意：界面脚本加载时就把 window.organizer 抓成了局部常量 api，
 * 所以这里必须**改同一个对象上的方法**，不能换一个新对象（换了也白换）。
 */
function setOrganizerStub(pathResolver, pickFilesImpl) {
  stub.pathResolver = pathResolver;
  stub.pickFilesImpl = pickFilesImpl;
  if (stub.organizer) return stub.organizer;

  const organizer = {
    pathForFile(file) {
      stub.calls.pathForFile++;
      const out = stub.pathResolver(file);
      if (process.env.DSH_DEBUG_STUB) console.log('[debug] pathForFile <-', file && file.name, '=>', JSON.stringify(out));
      return out;
    },
    pickFiles: async () => {
      stub.calls.pickFiles++;
      return stub.pickFilesImpl ? await stub.pickFilesImpl() : [];
    },
    pickOutputDir: async () => null,
    exists: async (paths) => {
      stub.calls.exists++;
      const map = {};
      for (const p of paths) {
        try {
          map[p] = fs.statSync(p).isFile();
        } catch {
          map[p] = false;
        }
      }
      if (process.env.DSH_DEBUG_STUB) console.log('[debug] exists() <-', JSON.stringify(paths), '=>', JSON.stringify(map));
      return map;
    },
    preview: async () => ({ ok: false, reason: 'not-used', message: 'stub' }),
    organize: async () => ({ total: 0, successCount: 0, failureCount: 0, outputDir: '' }),
    openPath: async () => '',
    onProgress: () => {},
  };
  stub.organizer = organizer;
  global.window.organizer = organizer;
  return organizer;
}

/** 把 out/renderer/renderer.js 当脚本执行一次（同一个进程里只执行一次，避免重复挂监听器）。 */
const executed = { done: false, error: null };
async function executeRendererOnce() {
  if (executed.done) return executed.error;
  executed.done = true;
  const before = uncaught.length;
  try {
    await import(`${pathToFileURL(RENDERER_JS).href}?probe=${Date.now()}`);
  } catch (err) {
    executed.error = `${err.constructor.name}: ${err.message}`;
  }
  await flush();
  if (!executed.error && uncaught.length > before) {
    executed.error = `uncaught: ${uncaught.slice(before).join(' | ')}`;
  }
  return executed.error;
}

/* ------------------------------------------------------------------ *
 * 断言五：界面产物真的能当脚本跑到底，并且监听器都挂上了
 * ------------------------------------------------------------------ */

async function assert5RendererRunsAsScript() {
  log('');
  log('--- assert 5/6: out/renderer/renderer.js runs to the end and wires the listeners ---');

  installStubDom();
  setOrganizerStub(() => null);

  const err = await executeRendererOnce();
  if (err) {
    log(`FAIL: executing out/renderer/renderer.js failed -> ${err}`);
    return false;
  }
  log('OK: out/renderer/renderer.js executed to the end with no uncaught error');

  const dropEl = stub.elements.get('drop');
  const pickEl = stub.elements.get('pick-files');
  if (!dropEl || !pickEl) {
    log('FAIL: the renderer did not look up #drop / #pick-files');
    return false;
  }
  const dropListeners = (dropEl.listeners.get('drop') || []).length;
  const clickListeners = (pickEl.listeners.get('click') || []).length;
  if (dropListeners === 0) {
    log('FAIL: no drop listener was attached to #drop (the script probably died before wiring)');
    return false;
  }
  if (clickListeners === 0) {
    log('FAIL: no click listener was attached to the "pick files" button');
    return false;
  }
  log(`OK: listeners attached (drop on #drop x${dropListeners}, click on #pick-files x${clickListeners})`);

  // 点一下「选择文件」：必须真的调到 preload 暴露的 pickFiles
  const pickCallsBefore = stub.calls.pickFiles;
  pickEl.dispatch('click', { preventDefault() {} });
  await flush();
  if (stub.calls.pickFiles !== pickCallsBefore + 1) {
    log(`FAIL: clicking "pick files" did not reach api.pickFiles (calls ${pickCallsBefore} -> ${stub.calls.pickFiles})`);
    return false;
  }
  log('OK: clicking "pick files" reaches api.pickFiles');

  // 拖拽区触发 drop：必须走到取路径那条路，并更新「已选 N 个文件」
  const dropDir = path.join(os.tmpdir(), `dsh-drop-probe-${process.pid}`);
  fs.mkdirSync(dropDir, { recursive: true });
  const two = [path.join(dropDir, 'p1.jpg'), path.join(dropDir, 'p2.pdf')];
  for (const p of two) fs.writeFileSync(p, '');
  const byName = new Map(two.map((p) => [path.basename(p), p]));
  setOrganizerStub((file) => (file && byName.get(file.name)) || null);
  stub.calls.pathForFile = 0;

  dropEl.dispatch('drop', {
    preventDefault() {},
    dataTransfer: { files: two.map((p) => ({ name: path.basename(p) })) },
  });
  await flush();
  const countText = String(stub.elements.get('file-count').textContent);
  if (stub.calls.pathForFile < 2) {
    log(`FAIL: the drop went through the preload path function ${stub.calls.pathForFile} time(s), expected >= 2`);
    return false;
  }
  if (countText !== '已选 2 个文件') {
    log(`FAIL: after dropping 2 files the count text is "${countText}"`);
    return false;
  }
  log('OK: dropping files reaches the preload path function and the count text updates');

  try {
    fs.rmSync(dropDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判定 */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 断言六：不依赖真窗口的等价证明
 * ------------------------------------------------------------------ */

/** 把 out/preload.js 在桩环境里加载，返回它通过 contextBridge 暴露出来的那套东西（和真跑的同一份产物）。 */
function loadPreloadFromBundle(bus) {
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        bus.exposed[name] = api;
      },
    },
    ipcRenderer: {
      invoke: async () => null,
      on() {},
      send() {},
    },
    webUtils: { getPathForFile: undefined },
  };
  bus.electron = fakeElectron;

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(PRELOAD_JS)];
    require(PRELOAD_JS);
  } finally {
    Module._load = originalLoad;
  }
  return bus.exposed;
}

/** 递归数一下这个路径下有多少文件、多少子目录；路径不存在算 0/0。 */
function countTree(root) {  const acc = { dirs: 0, files: 0 };
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        acc.dirs++;
        walk(path.join(dir, e.name));
      } else {
        acc.files++;
      }
    }
  };
  walk(root);
  return acc;
}

async function assert6HeadlessEquivalence(tmpRoot) {
  log('');
  log('--- assert 6/6: headless equivalent proof (5 files, no double count, no disk writes) ---');

  const wrk = path.join(tmpRoot, 'wrk');
  const userDir = path.join(wrk, 'user'); // 只放本脚本自己造的 5 个真文件（测试夹具，不算「程序写盘」）
  const tmpOut = path.join(wrk, 'out-empty'); // 计划中的输出目录，必须始终是空的
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(tmpOut, { recursive: true });

  // 被观察的磁盘范围：临时输出目录（必须 0 文件 0 目录）+ 工作区里跑构建会动的目录
  const stage = process.env.DSH_ACCEPT_STAGE || path.join(projectRoot, '.dsh-staging');
  const watch = [tmpOut, stage, outDir, path.join(projectRoot, 'dist')];
  const snapshot = () =>
    watch.map((p) => {
      const c = countTree(p);
      return { p, ...c };
    });
  const before = snapshot();

  const names = ['a1.jpg', 'a2.pdf', 'a3.mp3', 'a4.zip', 'a5.xyz'];
  const realFiles = names.map((n) => {
    const p = path.join(userDir, n);
    fs.writeFileSync(p, '');
    return p;
  });

  // ---- preload 侧：把 bundle 加载起来，看它暴露了什么 ----
  const bus = { exposed: {} };
  let bridgeName;
  let fileToPath;
  try {
    const exposedMap = loadPreloadFromBundle(bus);
    bridgeName = Object.keys(exposedMap)[0];
    const exposed = exposedMap[bridgeName];
    if (!exposed || typeof exposed !== 'object') {
      log('FAIL: preload did not expose an object through contextBridge');
      return false;
    }
    log(`OK: loaded out/preload.js, it exposed window.${bridgeName} with keys: ${Object.keys(exposed).join(', ')}`);

    let foundFnName = null;
    fileToPath = Object.values(exposed).find((fn) => {
      const isIt = typeof fn === 'function' && fn.length === 1 && /getPathForFile/.test(fn.toString());
      if (isIt) foundFnName = Object.keys(exposed).find((k) => exposed[k] === fn);
      return isIt;
    });
    if (!fileToPath) {
      log('FAIL: none of the exposed functions reads a path through getPathForFile');
      return false;
    }
    log(`OK: contextBridge.${bridgeName} exposes ${foundFnName} (<File>) -> path string via webUtils.getPathForFile`);

    // 真的把桩的返回值接上：换一个哨兵路径，暴露出来的函数必须原样把它交回来
    const sentinel = path.join(tmpRoot, 'SENTINEL-PATH-PROOF', 'sentinel.jpg');
    bus.electron.webUtils.getPathForFile = () => sentinel;
    const got = fileToPath({ name: 'sentinel.jpg' });
    if (got !== sentinel) {
      log(`FAIL: the exposed path function returned ${JSON.stringify(got)} instead of the webUtils value`);
      return false;
    }
    // 取不到时必须给 null（而不是抛异常/给空串），界面才能据此给人话提示
    bus.electron.webUtils.getPathForFile = () => {
      throw new Error('no path');
    };
    if (fileToPath({ name: 'sentinel.jpg' }) !== null) {
      log('FAIL: the exposed path function does not turn a webUtils failure into null');
      return false;
    }
    log('OK: the exposed path function returns the webUtils value, and null when webUtils fails');
  } catch (err) {
    log(`FAIL: could not load out/preload.js -> ${(err && err.stack) || err}`);
    return false;
  }

  // ---- 界面侧：同一份 DOM 桩 + 换成「按索引给 5 个真实路径」的桩 ----
  installStubDom();
  setOrganizerStub((file) => {
    const i = file && typeof file._index === 'number' ? file._index : -1;
    return i >= 0 && i < realFiles.length ? realFiles[i] : null;
  });

  const err = await executeRendererOnce();
  if (err) {
    log(`FAIL: could not execute out/renderer/renderer.js -> ${err}`);
    return false;
  }
  log('OK: executed out/renderer/renderer.js against the DOM stub');

  const dropEl = stub.elements.get('drop');
  const countEl = stub.elements.get('file-count');
  const noticeEl = stub.elements.get('notice');
  if (!dropEl || !countEl) {
    log('FAIL: renderer did not register the expected elements');
    return false;
  }
  if ((dropEl.listeners.get('drop') || []).length === 0) {
    log('FAIL: renderer registered no drop listener on #drop');
    return false;
  }

  const makeFakeFiles = (indexes) =>
    indexes.map((i) => ({ name: realFiles[i].split(path.sep).pop(), _index: i }));

  /** 从「已选 N 个文件」里读数量；读不出来算 -1。 */
  const readCount = () => {
    const m = String(countEl.textContent).match(/已选\s*(\d+)\s*个文件/);
    return m ? Number(m[1]) : -1;
  };
  const baseline = readCount();
  if (baseline < 0) {
    log(`FAIL: could not read the file count from "${countEl.textContent}"`);
    return false;
  }
  log(`baseline count before the 5-file drop: ${baseline}`);

  // ---- 第一次 drop：5 个文件 ----
  const pathCallsBefore = stub.calls.pathForFile;
  dropEl.dispatch('drop', {
    preventDefault() {},
    dataTransfer: { files: makeFakeFiles([0, 1, 2, 3, 4]) },
  });
  await flush();
  const afterFirst = readCount();
  log(`count text after drop #1: ${countEl.textContent}`);
  if (afterFirst !== baseline + 5) {
    log(`FAIL: dropping 5 files changed the count from ${baseline} to ${afterFirst}, expected ${baseline + 5}`);
    return false;
  }
  if (stub.calls.pathForFile - pathCallsBefore < 5) {
    log(`FAIL: the preload path function was called ${stub.calls.pathForFile - pathCallsBefore} times, expected >= 5`);
    return false;
  }

  // ---- 第二次 drop：同样 5 个文件，不许重复计数 ----
  dropEl.dispatch('drop', {
    preventDefault() {},
    dataTransfer: { files: makeFakeFiles([0, 1, 2, 3, 4]) },
  });
  await flush();
  const afterSecond = readCount();
  const noticeText = String(noticeEl.textContent);
  log(`count text after drop #2 (same 5 files): ${countEl.textContent}`);
  log(`notice after drop #2: ${noticeText}`);
  if (afterSecond !== baseline + 5) {
    log(`FAIL: the second identical drop changed the total to ${afterSecond} (duplicates were double counted)`);
    return false;
  }
  if (!/5 个重复文件已跳过/.test(noticeText)) {
    log('WARN: no "duplicate skipped" notice, but the total stayed the same');
  }

  // ---- 磁盘：临时输出目录必须 0 文件 0 目录；被观察的每个位置都不许多出东西 ----
  const after = snapshot();
  let diskOk = true;
  for (let i = 0; i < watch.length; i++) {
    const b = before[i];
    const a = after[i];
    log(`disk ${b.p}: files ${b.files} -> ${a.files}, dirs ${b.dirs} -> ${a.dirs}`);
    if (i === 0 && (a.files !== 0 || a.dirs !== 0)) {
      log(`FAIL: the empty output dir is not empty any more (files=${a.files}, dirs=${a.dirs})`);
      diskOk = false;
    }
    if (a.files !== b.files || a.dirs !== b.dirs) {
      log('FAIL: the run created something on disk');
      diskOk = false;
    }
  }
  if (!diskOk) return false;

  log('OK: drop -> 5 files, second drop -> no double count, no disk writes');
  return true;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

(async () => {
  log('=== accept-drop-path-test: dropped files must yield real paths, and the UI script must run ===');
  log(`project root: ${projectRoot}`);

  const results = [];
  let tmpRoot = null;
  let diskTouched = true;

  // 这条验收要跑「真 ES module 作用域」，没有这个开关就建不出干净的作用域，直接判失败（不许悄悄降级）
  if (typeof vm.SourceTextModule !== 'function') {
    log('');
    log('FAIL: node must be started with --experimental-vm-modules for this check (see scripts/验收.ps1)');
    log('验收失败:拖入取路径');
    process.exitCode = 1;
    return;
  }

  try {
    results.push(['probe-is-alive', await assert1ProbesAreAlive()]);
    results.push(['preload-source', assert2PreloadSource()]);
    results.push(['renderer-source', assert3RendererSource()]);
    results.push(['compiled-wiring', assert4CompiledWiring()]);

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-drop-path-'));
    log(`temp work dir: ${tmpRoot}`);

    let five = false;
    try {
      five = await assert5RendererRunsAsScript();
    } catch (err) {
      log(`FAIL: plain-script execution check crashed -> ${(err && err.stack) || err}`);
      five = false;
    }
    results.push(['renderer-runs-as-script', five]);

    let six = false;
    try {
      six = await assert6HeadlessEquivalence(tmpRoot);
    } catch (err) {
      log(`FAIL: headless proof crashed -> ${(err && err.stack) || err}`);
      six = false;
    }
    results.push(['headless-equivalent-proof', six]);
    diskTouched = false;
  } catch (err) {
    log(`FAIL: unexpected error -> ${(err && err.stack) || err}`);
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
  let allOk = true;
  for (const [name, ok] of results) {
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allOk = false;
  }
  if (uncaught.length > 0) {
    for (const u of uncaught) log(`FAIL: uncaught during the whole run -> ${u}`);
    allOk = false;
  }
  if (diskTouched) log('WARN: the disk check did not run to completion');

  if (allOk) {
    log('拖入取路径OK');
    process.exitCode = 0;
  } else {
    log('验收失败:拖入取路径');
    process.exitCode = 1;
  }
})();
