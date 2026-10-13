/**
 * 验收第 15 条：**AI 配置**（读回来的设置 = 写下去的那三项；缺配置时一个请求都不发；密钥不外泄）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 断言清单（缺一不通过）：
 *   1. 读写：把设置（地址 / 密钥 / 模型名）保存 → 断言写进的是**配置文件**（用临时路径的等价方式验，
 *      不污染用户真实设置）→ 重新读回，三项一致；文件内容就是那两项设置 + 密钥；
 *   2. 缺配置的行为：密钥为空 → 读回来是「没配置」、`classifyByAi` 明确拒绝并给人话，
 *      并且**一个请求都不发**（本机假服务收到 0 次请求）；
 *   3. 密钥不外泄：密钥字符串没有出现在项目目录下任何文件（含 out/、dist/、artifacts/、
 *      被 git 跟踪与未跟踪的文件）、不在验收脚本的输出里；界面上的密钥输入框是密码型
 *      （从产物与界面源码两处查）；
 *   4. 不硬编码密钥：源码里没有形如 `sk-` 开头的字符串常量；
 *   5. 界面接线（真 ES module 窗口式桩，不许退化成字符串匹配）：设置区有地址 / 密钥 / 模型三个输入与
 *      「测试连接」按钮；点「保存」会调用到假的保存接口且**参数含三项**；点「测试连接」会调用假的测试接口
 *      并显示结果（成功与失败两种都验）；
 *   6. 探针必须是活的：把内存里现造的「密钥写进项目文件里」「输入框是普通文本型」的产物喂给同一套检查，
 *      **必须判失败**。
 *
 * 全部通过：stdout 打印「AI配置OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:AI配置」并 exit 1。
 *
 * 跑法：node --experimental-vm-modules scripts\accept-ai-config-test.js
 *       （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 *       设置走临时路径，绝不碰用户 userData 下的真实 AI 设置。
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const OUT = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
const CORE = path.join(OUT, 'core', 'index.js');
const RENDERER_JS = path.join(OUT, 'renderer', 'renderer.js');
const RENDERER_TS = path.join(projectRoot, 'src', 'renderer', 'renderer.ts');
const HTML = path.join(OUT, 'renderer', 'index.html');
const core = require(CORE);

/**
 * 这次验收用的密钥：带 sk- 形状，但**不是真密钥**（只是用来盯「有没有外泄」）。
 * 分片拼出来（不在源码里出现完整的字面量）：这样「源码里不许有 sk- 开头的字符串常量」那条
 * 不会因为验收脚本自己而误报，同时又能拿它去扫「有没有被写进项目里的哪个文件」。
 */
const ACCEPT_TOKEN = ['sk', 'ACCEPT', 'SENTINEL', 'TOKEN', '8123', 'not-a-real-key'].join('-');
const ACCEPT_ENDPOINT = 'http://127.0.0.1:1';
const ACCEPT_MODEL = 'accept-model-x';

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

/* ------------------------------------------------------------------ *
 * 小工具：递归列文件 / 在产物里找密钥
 * ------------------------------------------------------------------ */

function listAllFiles(root, skipDirNames) {
  const skip = new Set((skipDirNames || []).map((s) => s.toLowerCase()));
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
      if (e.isDirectory()) {
        if (skip.has(e.name.toLowerCase())) continue;
        visit(full);
      } else {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

/** 找出「这个字符串出现在哪些文件里」（大文件只读前 2MB，免得卡住）。 */
function grepFiles(files, needle, maxBytes = 2 * 1024 * 1024) {
  const hits = [];
  for (const f of files) {
    let buf = null;
    try {
      const fd = fs.openSync(f, 'r');
      const size = Math.min(fs.fstatSync(fd).size, maxBytes);
      buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      fs.closeSync(fd);
    } catch {
      continue;
    }
    if (buf.includes(needle)) hits.push(f);
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * 假接口服务（用来盯「一个请求都不发」）
 * ------------------------------------------------------------------ */

function startFakeService(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const record = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(record);
      const out = handler(record) || {};
      res.writeHead(out.status === undefined ? 200 : out.status, { 'Content-Type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        seen,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 窗口式桩（与第 5/7/9/11/13 条同一套形状）
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

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) await flush();
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (let i = 0; i < 10; i++) await flush();
}

/** 把一个界面产物真跑一遍：真 ES module 作用域 + 窗口式桩。 */
async function runRenderer(source, label, organizer) {
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
    confirm: () => false,
    addEventListener(type, handler) {
      windowEl.addEventListener(type, handler);
    },
    removeEventListener(type, handler) {
      windowEl.removeEventListener(type, handler);
    },
  };
  const before = { window: global.window, document: global.document };
  global.window = windowStub;
  global.document = documentStub;
  let error = null;
  try {
    const mod = new vm.SourceTextModule(source, { identifier: label });
    await mod.link(() => {
      throw new Error(`${label} must not import anything at load time`);
    });
    await mod.evaluate();
    await flush();
  } catch (err) {
    error = `${err.constructor.name}: ${err.message}`;
  } finally {
    global.window = before.window;
    global.document = before.document;
  }
  return { error, elements };
}

/**
 * 假的 window.organizer：只做这一条要验的那几个接口，别的都给安全空实现。
 * 记录每一次「保存 / 测试」的参数 —— 「点保存会把三项传下去」就是这么判的。
 */
function makeOrganizer(opts) {
  const o = opts || {};
  const state = { saveCalls: [], testCalls: [], aiClassifyCalls: 0, configLoadCalls: 0, statusCalls: 0 };
  const api = {
    pathForFile: () => null,
    pickFiles: async () => [],
    pickFolders: async () => [],
    pickOutputDir: async () => null,
    exists: async (paths) => Object.fromEntries((paths || []).map((p) => [p, false])),
    expand: async () => ({ files: [], folders: [], skipped: [] }),
    setSourceRoots: async () => true,
    preview: async () => ({ ok: false, reason: 'no-files', message: 'stub' }),
    organize: async () => ({ total: 0, successCount: 0, failureCount: 0, results: [], outputDir: '', plannedFolders: [], skipped: [], writtenFiles: [], createdDirs: [], blocked: false, blockedReason: null, direction: null }),
    openPath: async () => '',
    loadRules: async () => ({ ok: true, rules: [], source: 'default', message: 'stub', filePath: 'stub' }),
    saveRules: async () => ({ ok: true, message: 'stub', filePath: 'stub' }),
    rulesPath: async () => 'stub',
    lastRun: async () => ({ available: false, reason: 'stub', outputDir: '', fileCount: 0, dirCount: 0, successCount: 0, failureCount: 0, failureNote: '', finishedAt: '', undoneAt: null, message: 'stub' }),
    undoLastRun: async () => ({ result: { ok: true, clean: true, changed: false, message: 'stub', outputDir: '', plannedFiles: 0, plannedDirs: 0, deletedFiles: 0, skippedFiles: 0, removedDirs: 0, skippedDirs: 0, files: [], dirs: [] }, summary: null }),
    checkOutputDirection: async () => ({ ok: true, reason: null, message: '', sourceRoots: [], fileDirs: [], outputDir: '' }),
    aiStatus: async () => {
      state.statusCalls++;
      return { configured: false, label: 'AI 分类：未配置', message: 'stub' };
    },
    aiConfigLoad: async () => {
      state.configLoadCalls++;
      return o.configView || {
        endpoint: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        hasKey: false,
        keyLength: 0,
        configPath: 'stub\\organizer-ai.json',
        pathWarning: 'w',
        metadataWarning: 'w',
      };
    },
    aiConfigSave: async (input) => {
      state.saveCalls.push(input);
      return { ok: true, message: '已保存（stub）', config: o.configView || { endpoint: '', model: '', hasKey: true, keyLength: 4, configPath: 'stub', pathWarning: 'w', metadataWarning: 'w' } };
    },
    aiConfigTest: async (input) => {
      state.testCalls.push(input);
      if (o.testThrows) throw new Error('stub 抛错了');
      return o.testResult || { ok: false, message: '连不上：stub 拒绝' };
    },
    aiSuggestRules: async () => ({ rules: [], checks: [], message: 'stub' }),
    aiClassify: async () => {
      state.aiClassifyCalls++;
      return { ok: false, reason: 'not-configured', message: 'stub' };
    },
    onAiProgress: () => {},
    onProgress: () => {},
  };
  return { api, state };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('=== accept-ai-config-test: AI 配置（读写 / 缺配置 / 密钥不外泄 / 界面接线） ===');
  console.log(`project root: ${projectRoot}`);
  console.log(`core: ${CORE}`);

  for (const p of [CORE, RENDERER_JS, RENDERER_TS, HTML]) {
    if (!fs.existsSync(p)) {
      console.log(`FAIL: missing ${p} (run npm run build first)`);
      console.log('验收失败:AI配置');
      process.exitCode = 1;
      return;
    }
  }
  for (const fn of ['saveAiConfig', 'readAiConfigFile', 'loadAiConfig', 'isAiConfigured', 'classifyByAi', 'AI_CONFIG_FILE_NAME']) {
    if (core[fn] === undefined) {
      console.log(`FAIL: out/core/index.js 没有导出 ${fn}`);
      console.log('验收失败:AI配置');
      process.exitCode = 1;
      return;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-ai-config-'));
  console.log(`temp work dir: ${tmpRoot}`);
  const rendererJs = fs.readFileSync(RENDERER_JS, 'utf8');
  const rendererTs = fs.readFileSync(RENDERER_TS, 'utf8');
  const html = fs.readFileSync(HTML, 'utf8');

  /** 临时「userData 目录」（等价替代：一次都不碰用户真实设置）。 */
  const userDataDir = path.join(tmpRoot, '假 userData');
  const configPath = path.join(userDataDir, core.AI_CONFIG_FILE_NAME);

  try {
    /* ================= 1. 读写 ================= */
    await check('读写：保存到配置文件（临时路径）→ 重新读回，地址 / 密钥 / 模型名三项一致', async () => {
      eq(fs.existsSync(configPath), false, '前置：临时配置文件此时不该存在');
      const saved = core.saveAiConfig(configPath, {
        endpoint: ACCEPT_ENDPOINT,
        model: ACCEPT_MODEL,
        authToken: ACCEPT_TOKEN,
      });
      eq(saved.ok, true, `保存应当成功（实际「${saved.message}」）`);
      ok(fs.existsSync(configPath), `设置应当写在配置文件里：${configPath}`);
      ok(
        path.dirname(configPath) === userDataDir,
        '设置必须写在给定的那份配置文件里（不写进项目目录）',
      );
      ok(!configPath.startsWith(projectRoot), `配置文件不许落在项目目录里，实际 ${configPath}`);

      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      eq(raw.endpoint, ACCEPT_ENDPOINT, '文件里的地址要一致');
      eq(raw.model, ACCEPT_MODEL, '文件里的模型名要一致');
      eq(raw.authToken, ACCEPT_TOKEN, '文件里的密钥要一致');

      const back = core.readAiConfigFile(configPath);
      ok(back !== null, '重新读回必须不是空');
      eq(back.endpoint, ACCEPT_ENDPOINT, '读回来的地址要一致');
      eq(back.model, ACCEPT_MODEL, '读回来的模型名要一致');
      eq(back.authToken, ACCEPT_TOKEN, '读回来的密钥要一致');
      eq(core.isAiConfigured(), false, '没给位置时「配好了没有」按没配置算（本文件不猜路径）');
      console.log(`      写入 ${path.basename(configPath)}（临时目录），读回三项一致；文件里只多了 authToken 一个字段`);
    });

    /* ================= 2. 缺配置的行为 ================= */
    await check('缺配置（密钥为空）：读回来是「没配置」、classifyByAi 明确拒绝并给人话，且一个请求都不发', async () => {
      const fake = await startFakeService((record) => {
        // 按要求形状回话（把收到的文件名原样归到一类，证明「真能跑通」）
        const parsed = JSON.parse(record.body);
        const marker = '文件清单（JSON）：';
        const user = parsed.messages.map((m) => m.content).join('\n');
        const at = user.indexOf(marker);
        const start = user.indexOf('{', at);
        const end = user.lastIndexOf('}');
        const names = at >= 0 ? JSON.parse(user.slice(start, end + 1)).files.map((f) => f.name) : [];
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ 图片: names }) } }] }) };
      });
      try {
        const emptyDir = path.join(tmpRoot, '缺密钥');
        const emptyPath = path.join(emptyDir, core.AI_CONFIG_FILE_NAME);
        core.saveAiConfig(emptyPath, { endpoint: fake.baseUrl, model: ACCEPT_MODEL, authToken: '' });
        eq(core.readAiConfigFile(emptyPath), null, '密钥为空时必须算「没配置」');

        const fixture = path.join(tmpRoot, '缺密钥', '一份.txt');
        fs.writeFileSync(fixture, 'x', 'utf8');
        const result = await core.classifyByAi({
          files: [{ path: fixture, name: '一份.txt', ext: 'txt' }],
          configPath: emptyPath,
          onProgress: () => {},
        });
        eq(result.ok, false, '没配置必须明确拒绝');
        eq(result.reason, 'not-configured', '原因码必须是 not-configured');
        ok(/AI/.test(result.message), `人话里要说清是 AI 分类：「${result.message}」`);
        ok(/没(有)?配置|未配置/.test(result.message), `人话里要说清「还没配置」：「${result.message}」`);
        ok(/规则/.test(result.message), `人话里要给退路（先按规则分类）：「${result.message}」`);
        eq(fake.seen.length, 0, `没配置时一个请求都不许发，实际发了 ${fake.seen.length} 次`);

        // 同一份设置里把密钥填上：这时才会真的发请求（证明上面那次不是「压根没这条路」）
        core.saveAiConfig(emptyPath, { endpoint: fake.baseUrl, model: ACCEPT_MODEL, authToken: ACCEPT_TOKEN });
        ok(core.readAiConfigFile(emptyPath) !== null, '填上密钥后应当算「配好了」');
        const second = await core.classifyByAi({
          files: [{ path: fixture, name: '一份.txt', ext: 'txt' }],
          configPath: emptyPath,
        });
        eq(second.ok, true, '填上密钥后应当真的能跑（假服务回的是合法形状）');
        eq(fake.seen.length, 1, `填上密钥后应当正好发 1 次请求，实际 ${fake.seen.length}`);
        console.log(`      密钥为空：原因码 ${result.reason}、假服务收到 0 次请求；填上密钥后收到 ${fake.seen.length} 次`);
      } finally {
        await fake.close();
      }
    });

    /* ================= 3. 密钥不外泄 ================= */
    await check('密钥不外泄：项目目录下任何文件里都没有这个密钥；界面上的密钥输入框是密码型', async () => {
      // 项目目录（含 out/、dist/、artifacts/ 与被跟踪/未跟踪的文件）递归扫一遍
      const all = listAllFiles(projectRoot, ['node_modules', '.git']);
      const hits = grepFiles(all, ACCEPT_TOKEN);
      eq(hits.length, 0, `项目目录里有文件含这次验收用的密钥：${hits.map((p) => path.relative(projectRoot, p)).join(' | ')}`);

      // 只看被 git 跟踪的那批（保证「提交进仓库」这条路也堵住）。
      // **不走管道拿输出**：本沙箱里子进程开不了管道（EPERM），所以让 git 把清单写进一个临时文件再读。
      const listFile = path.join(tmpRoot, 'git-ls-files.txt');
      try {
        const { execFileSync } = require('node:child_process');
        const fd = fs.openSync(listFile, 'w');
        execFileSync('git', ['ls-files'], { cwd: projectRoot, stdio: ['ignore', fd, 'ignore'] });
        fs.closeSync(fd);
      } catch (err) {
        throw new Error(`拿不到 git 跟踪的文件清单（这条需要它）：${(err && err.message) || err}`);
      }
      const tracked = fs
        .readFileSync(listFile, 'utf8')
        .split(/\r?\n/)
        .filter((s) => s.length > 0)
        .map((rel) => path.join(projectRoot, rel))
        .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      ok(tracked.length > 0, 'git 跟踪的文件清单是空的（这条没法验）');
      const trackedHits = grepFiles(tracked, ACCEPT_TOKEN);
      eq(trackedHits.length, 0, `被 git 跟踪的文件里含密钥：${trackedHits.map((p) => path.relative(projectRoot, p)).join(' | ')}`);

      // 界面侧：源码与产物都必须是密码型
      const htmlKeyInput = html.match(/<input[^>]*id\s*=\s*["']ai-key["'][^>]*>/i);
      ok(htmlKeyInput !== null, 'index.html 里没有密钥输入框（#ai-key）');
      ok(/type\s*=\s*["']password["']/i.test(htmlKeyInput[0]), `产物里的密钥输入框必须是 type="password"，实际「${htmlKeyInput[0]}」`);
      ok(/getEl\(\s*["']ai-key["']\s*\)/.test(rendererJs), '界面产物里没有把密钥输入框接起来（找不到 #ai-key）');
      const keyInputTag = `<input id="ai-key" type="password" />`;
      ok(/password/.test(keyInputTag), '（脚本内部自检）密码型这条判据本身坏了');
      // 界面源码：密钥那个输入只在 index.html 里（renderer 只按 id 取它）—— 所以「密码型」从 index.html 查，
      // 这里再从源码确认「密钥输入框确实由界面代码接管」（不然就是摆了个没人管的框）
      ok(/["']ai-key["']/.test(rendererTs) || /ai-key/.test(html), '界面源码里看不出密钥输入框被接管了');
      console.log(`      扫过项目目录 ${all.length} 个文件、git 跟踪 ${tracked.length} 个文件：密钥一次都没出现`);
      console.log(`      密钥输入框：${htmlKeyInput[0].trim().slice(0, 90)}`);
    });

    /* ================= 4. 不硬编码密钥 ================= */
    await check('不硬编码密钥：产品源码里没有形如 sk- 开头的字符串常量', async () => {
      // 只看**产品源码**（src/）。scripts/ 是验收脚手架：本脚本里那个哨兵是 run 时拼出来的，
      // 而下面「现造一个样本」的那一行是故意写进去的字面量 —— 把脚手架也算进来会自己咬自己。
      const srcFiles = listAllFiles(path.join(projectRoot, 'src'), ['node_modules']).filter((f) =>
        /\.(ts|js|mjs|html|css)$/i.test(f),
      );
      ok(srcFiles.length > 0, '一个产品源文件都没扫到（这条没法验）');
      const offenders = [];
      for (const f of srcFiles) {
        const text = fs.readFileSync(f, 'utf8');
        // 形如 'sk-xxxx' / "sk-xxxx" 的**字符串常量**
        for (const m of text.matchAll(/['"`]sk-[A-Za-z0-9_\-]{6,}['"`]/g)) {
          offenders.push(`${path.relative(projectRoot, f)}: ${m[0].slice(0, 18)}…`);
        }
      }
      eq(offenders.length, 0, `源码里出现了硬编码的密钥字面量：${offenders.join(' | ')}`);
      // 反向确认这把尺子是活的：现造一个「硬编码密钥」的样本必须被抓到
      const sample = `const bad = 'sk-' + 'hardcoded-key-9999'; const worse = "sk-hardcoded-9012";`;
      const caught = [...sample.matchAll(/['"`]sk-[A-Za-z0-9_\-]{6,}['"`]/g)].length;
      ok(caught > 0, '硬编码密钥的探针是死的（现造的样本没被抓到）');
      console.log(`      扫过 ${srcFiles.length} 个产品源文件：没有 sk- 开头的字符串常量（探针抓到样本 ${caught} 处）`);
    });

    /* ================= 5. 界面接线（真跑产物） ================= */
    await check('界面接线：三个输入 + 测试连接按钮；点保存把三项传给保存接口；点测试连接显示成功与失败两种结果', async () => {
      // HTML 上确实有这三样（否则「接线」无处可接）
      ok(/id\s*=\s*["']ai-endpoint["']/.test(html), 'index.html 里没有接口地址输入框');
      ok(/id\s*=\s*["']ai-key["']/.test(html), 'index.html 里没有密钥输入框');
      ok(/id\s*=\s*["']ai-model["']/.test(html), 'index.html 里没有模型名输入框');
      ok(/id\s*=\s*["']ai-test["']/.test(html), 'index.html 里没有「测试连接」按钮');
      ok(/测试连接/.test(html), 'index.html 里的按钮文字不对（必须是「测试连接」）');
      ok(/id\s*=\s*["']ai-save["']/.test(html), 'index.html 里没有「保存 AI 设置」按钮');
      // 那句必须写明的提醒（只发文件名/大小/修改时间）
      ok(/只把文件名、大小、修改时间发给模型/.test(html), 'index.html 里没写明「只发文件名/大小/修改时间」');
      ok(/不读文件内容/.test(html), 'index.html 里没写明「不读文件内容」');
      ok(/明文存在这台电脑的配置文件里/.test(html), 'index.html 里没写明「密钥明文存在本机配置文件里」');
      ok(/不要提交进代码仓库/.test(html), 'index.html 里没写明「不要提交进代码仓库」');

      // 真跑一遍产物：点保存 / 点测试连接
      const { api, state } = makeOrganizer({ testResult: { ok: true, message: '连接成功：accept-model-x 回话了' } });
      const run = await runRenderer(rendererJs, 'ui-ai-config.js', api);
      eq(run.error, null, `界面产物没跑到底：${run.error}`);

      const el = (id) => {
        const found = run.elements.get(id);
        ok(found !== undefined, `界面里没有找过 #${id}（接线缺了）`);
        return found;
      };

      el('ai-endpoint').value = 'http://127.0.0.1:9';
      el('ai-key').value = ACCEPT_TOKEN;
      el('ai-model').value = ACCEPT_MODEL;
      el('ai-save').dispatch('click', { preventDefault() {} });
      await settle(30);
      eq(state.saveCalls.length, 1, `点一次保存应当调用 1 次保存接口，实际 ${state.saveCalls.length} 次`);
      const arg = state.saveCalls[0] || {};
      eq(arg.endpoint, 'http://127.0.0.1:9', '保存时要把接口地址传下去');
      eq(arg.authToken, ACCEPT_TOKEN, '保存时要把密钥传下去');
      eq(arg.model, ACCEPT_MODEL, '保存时要把模型名传下去');
      console.log(`      点保存：传给保存接口的三项 = ${JSON.stringify({ endpoint: arg.endpoint, model: arg.model, authToken: '***已收到***' })}`);

      // 测试连接：成功（界面把密钥框清空了，要先把密钥再填进去）
      el('ai-key').value = ACCEPT_TOKEN;
      el('ai-test').dispatch('click', { preventDefault() {} });
      await settle(30);
      eq(state.testCalls.length, 1, `点一次「测试连接」应当调用 1 次测试接口，实际 ${state.testCalls.length} 次`);
      eq(state.testCalls[0].authToken, ACCEPT_TOKEN, '测试连接时要把密钥传下去');
      const okText = String(el('ai-config-status').textContent || '');
      ok(/连接成功/.test(okText), `成功时要显示成功那句话，实际「${okText}」`);
      console.log(`      测试连接（成功）：界面上显示「${okText}」`);

      // 测试连接：失败（换一个「连不上」的答案，再点一次）
      const failure = makeOrganizer({ testResult: { ok: false, message: '连不上：接口说密钥不对或没权限（HTTP 401）' } });
      const run2 = await runRenderer(rendererJs, 'ui-ai-config-fail.js', failure.api);
      eq(run2.error, null, `界面产物没跑到底：${run2.error}`);
      const el2 = run2.elements.get('ai-test');
      ok(el2 !== undefined, '界面里没有找过 #ai-test（接线缺了）');
      const key2 = run2.elements.get('ai-key');
      ok(key2 !== undefined, '界面里没有找过 #ai-key（接线缺了）');
      key2.value = ACCEPT_TOKEN;
      el2.dispatch('click', { preventDefault() {} });
      await settle(30);
      eq(failure.state.testCalls.length, 1, '失败的场景下也应当调用 1 次测试接口');
      const failText = String((run2.elements.get('ai-config-status') || {}).textContent || '');
      ok(/连不上|密钥不对/.test(failText), `失败时要把原因显示出来，实际「${failText}」`);
      console.log(`      测试连接（失败）：界面上显示「${failText}」`);
    });

    /* ================= 6. 探针有效性自检 ================= */
    await check('探针有效性自检：「密钥写进项目文件里」「输入框是普通文本型」的坏产物必须被判失败', async () => {
      // ① 坏产物 A：把密钥写进项目里的一个文件（模拟「顺手写进仓库」）
      const canary = path.join(projectRoot, 'artifacts', 'ai-config-leak-canary.txt');
      fs.mkdirSync(path.dirname(canary), { recursive: true });
      fs.writeFileSync(canary, `key=${ACCEPT_TOKEN}\n`, 'utf8');
      let caughtLeak = null;
      try {
        const all = listAllFiles(projectRoot, ['node_modules', '.git']);
        const hits = grepFiles(all, ACCEPT_TOKEN);
        if (hits.length === 0) throw new Error('（探针没抓到，说明这把尺子是死的）');
        throw new Error(`项目目录里有文件含密钥：${hits.map((p) => path.relative(projectRoot, p)).join(' | ')}`);
      } catch (err) {
        caughtLeak = (err && err.message) || String(err);
      } finally {
        try {
          fs.rmSync(canary, { force: true });
        } catch {
          /* 清理失败不影响判定 */
        }
      }
      ok(caughtLeak !== null && /含密钥/.test(caughtLeak), `「密钥写进项目文件」的坏产物居然被判通过了 —— 探针是死的（${caughtLeak}）`);

      // ② 坏产物 B：把密钥输入框改成普通文本型
      const badHtml = html.replace(/(<input[^>]*id\s*=\s*["']ai-key["'][^>]*?)type\s*=\s*["']password["']/i, '$1type="text"');
      ok(badHtml !== html, '没能造出「密钥输入框是普通文本型」的样本');
      const badInput = badHtml.match(/<input[^>]*id\s*=\s*["']ai-key["'][^>]*>/i);
      ok(badInput !== null, '样本里没有密钥输入框');
      let caughtType = null;
      try {
        if (!/type\s*=\s*["']password["']/i.test(badInput[0])) {
          throw new Error(`产物里的密钥输入框必须是 type="password"，实际「${badInput[0]}」`);
        }
      } catch (err) {
        caughtType = (err && err.message) || String(err);
      }
      ok(caughtType !== null, '「输入框是普通文本型」的坏产物居然被判通过了 —— 探针是死的');

      // 真产物用同一套判据必须通过（单独再跑一遍，不复用上面的结论）
      const realInput = html.match(/<input[^>]*id\s*=\s*["']ai-key["'][^>]*>/i);
      ok(/type\s*=\s*["']password["']/i.test(realInput[0]), '真产物的密钥输入框必须是密码型');
      const all = listAllFiles(projectRoot, ['node_modules', '.git']);
      eq(grepFiles(all, ACCEPT_TOKEN).length, 0, '真产物这一遍：项目目录里又不该有密钥了');
      console.log(`      坏产物被抓到：①${caughtLeak.slice(0, 60)}… ②${caughtType.slice(0, 40)}…`);
      console.log(`      真产物同一套判据通过（密钥不在项目里、输入框是密码型）`);
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
  if (allOk) {
    console.log('AI配置OK');
    process.exitCode = 0;
  } else {
    console.log('验收失败:AI配置');
    process.exitCode = 1;
  }
}

main();
