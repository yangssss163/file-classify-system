/**
 * 验收第 12 条：**AI 策略壳**（纯逻辑，不联网络）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 断言清单（缺一不通过）：
 *   1. 未配置：`isAiConfigured()` 为 false；`classifyByAi(...)` 回 `ok:false`、`reason:'not-configured'`，
 *      并且 `message` 是人话（说清「还没配置」）；
 *   2. 绝不联网络：这个模块的**源码代码体**（注释与字符串已剥掉）里没有任何网络调用标识
 *      （fetch / XMLHttpRequest / WebSocket / axios / net / socket / ssh / io / request / http(s) / ws 等）；
 *      并且调用它时**不会**产生任何网络请求 —— 用一个「会抛错的哨兵」顶掉全局的
 *      fetch / XMLHttpRequest / WebSocket / XMLHttpRequestUpload 与 navigator.sendBeacon，调完之后哨兵一个都没被碰过；
 *   3. 不读密钥：这个模块的代码体里不出现 apiKey / API_KEY / accessKey / secretKey / process.env / env[...]；
 *      预留的空配置读取函数（`loadAiConfig`）存在，但**恒**返回空（没配置）；
 *   4. 不写盘、不删东西：调 `classifyByAi` 前后，被观察目录的文件数与目录数不变；
 *   5. 策略骨架可扩展：导出的接口形状齐全（配置类型占位 / 配置读取 / 配置查询 / 分类调用 / 状态查询），
 *      并且**产品里没有第二处 AI 实现**（代码体 + 界面产物 + 预加载产物 + 主进程产物一起扫，
 *      只有模块自己那个文件里允许出现这些标识）。
 *
 * 全部通过：stdout 打印「AI策略壳OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:AI策略壳」并 exit 1。
 *
 * 跑法：node scripts\accept-ai-strategy-test.js
 *       （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 *       记录一律走临时路径，绝不碰用户 userData 下的真实记录与规则文件。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const OUT = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
const CORE = path.join(OUT, 'core', 'index.js');
const MODULE_STEM = 'aiClassify';
const core = require(CORE);

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

/* ------------------------------------------------------------------ *
 * 源码扫描：先把注释与字符串字面量剥掉，只留**代码体**，再按关键字找。
 * （不剥的话，注释里写「不联网络」这类正常说明会被误判成「有网络调用」。）
 * ------------------------------------------------------------------ */

/** 剥掉块注释 / 行注释 / 字符串字面量，只留代码体（正则字符串里的内容也会被剥掉，够用）。 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 联网调用的标识（在代码体里出现任何一个都算「联了网络」）。 */
const NETWORK_CODE = /\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\baxios\b|\bnode-fetch\b|\bnet\b|\bsocket\b|\bssh\b|\bio\b|\brequest\b|https?|wss?:|sendBeacon/i;

/** 取密钥的写法（在代码体里出现任何一个都算「读了密钥」）。 */
const SECRET_CODE = /apiKey|API_KEY|apikey|access[_-]?key|secretKey|process\.env|env\[/i;

function hits(pattern, text) {
  const found = new Set();
  for (const m of text.matchAll(new RegExp(pattern.source, 'gi'))) found.add(m[0]);
  return [...found];
}

/**
 * 在代码体里找出「真的在调」某个实现标识的地方：直接调用（名字后面紧跟左括号）。
 * 只写类型标注、只把函数当值传出去、只 import 都不算「第二处实现」——
 * 通道那一层本来就要把实现转出去。反过来，谁想照抄一份实现，绕不开「自己定义一份同名函数」
 * 或者「直接调一次」。所以这里同时看这两件事：自己定义（`function 名字` / `const 名字 =`）与直接调用。
 */
const DEF_BEFORE = /(?:^|[\s;{}(,=])(?:export\s+)?(?:async\s+)?(?:declare\s+)?(?:function|interface|type|class|enum)\s+$/;
const DEF_ASSIGN = /(?:^|[\s;{}(,])(?:export\s+)?(?:const|let|var)\s+$/;

function realUses(ident, code) {
  const out = [];
  const re = new RegExp(`\\b${ident}\\b`, 'g');
  for (const m of code.matchAll(re)) {
    const before = code.slice(0, m.index);
    const after = code.slice(m.index + ident.length);
    if (DEF_BEFORE.test(before)) {
      out.push(`自己定义了一份 ${ident}`);
      continue;
    }
    if (DEF_ASSIGN.test(before) && /^\s*=/.test(after)) {
      out.push(`自己写了一份 ${ident}`);
      continue;
    }
    if (/^\s*\(/.test(after)) {
      out.push(`直接调用了 ${ident}`);
      continue;
    }
  }
  return [...new Set(out)];
}

/** 找出 AI 分类模块的源码与编译产物（两处都要扫）。 */
function moduleFiles() {
  const candidates = [
    path.join(projectRoot, 'src', 'core', `${MODULE_STEM}.ts`),
    path.join(OUT, 'core', `${MODULE_STEM}.js`),
  ];
  const found = candidates.filter((p) => fs.existsSync(p));
  if (found.length === 0) throw new Error(`找不到 AI 分类模块（找过：${candidates.join(' | ')}）`);
  return found;
}

/** 产品里其它地方（会被扫「有没有第二份 AI 实现」的那些文件）。 */
function otherProductFiles() {
  const list = [];
  const push = (p) => {
    if (fs.existsSync(p)) list.push(p);
  };
  const walkTs = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkTs(full);
      else if (e.name.endsWith('.ts')) push(full);
    }
  };
  walkTs(path.join(projectRoot, 'src'));
  push(path.join(OUT, 'renderer', 'renderer.js'));
  push(path.join(OUT, 'preload.js'));
  push(path.join(OUT, 'main.js'));
  const mods = new Set(moduleFiles().map((p) => path.resolve(p).toLowerCase()));
  return list.filter((p) => !mods.has(path.resolve(p).toLowerCase()));
}

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

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('=== accept-ai-strategy-test: AI 策略壳（只搭壳，不联网络、不读密钥、不写盘） ===');
  console.log(`project root: ${projectRoot}`);
  console.log(`core: ${CORE}`);

  if (!fs.existsSync(CORE)) {
    console.log(`FAIL: missing ${CORE} (run npm run build first)`);
    console.log('验收失败:AI策略壳');
    process.exitCode = 1;
    return;
  }
  for (const fn of ['isAiConfigured', 'classifyByAi', 'loadAiConfig', 'formatAiStatus', 'aiClassifyByPaths']) {
    if (typeof core[fn] !== 'function') {
      console.log(`FAIL: out/core/index.js 没有导出函数 ${fn}`);
      console.log('验收失败:AI策略壳');
      process.exitCode = 1;
      return;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-ai-strategy-'));
  console.log(`temp work dir: ${tmpRoot}`);
  let modFiles = [];
  let modSources = [];
  try {
    modFiles = moduleFiles();
    modSources = modFiles.map((p) => ({ file: p, raw: fs.readFileSync(p, 'utf8') }));
    for (const m of modSources) m.code = stripCommentsAndStrings(m.raw);
    console.log(`module files: ${modFiles.join(' | ')}`);
  } catch (err) {
    console.log(`FAIL: ${(err && err.message) || err}`);
    console.log('验收失败:AI策略壳');
    process.exitCode = 1;
    return;
  }

  const sampleInput = () => ({
    files: [
      { path: path.join(tmpRoot, '源', 'a.jpg'), name: 'a.jpg', ext: 'jpg' },
      { path: path.join(tmpRoot, '源', 'b.pdf'), name: 'b.pdf', ext: 'pdf' },
      { path: path.join(tmpRoot, '源', 'noext'), name: 'noext', ext: '' },
    ],
    rules: [{ name: '01_图片' }, { name: '02_文档' }],
    outputDir: path.join(tmpRoot, '输出'),
  });

  try {
    /** 模块以外那些「会被扫有没有第二处 AI 实现」的产品代码（注释与字符串已剥掉）。 */
    const otherCodeOf = () => {
      const map = new Map();
      for (const p of otherProductFiles()) {
        map.set(path.relative(projectRoot, p), stripCommentsAndStrings(fs.readFileSync(p, 'utf8')));
      }
      return map;
    };

    /* ================= 一：未配置 ================= */
    await check('未配置：isAiConfigured() 为 false，classifyByAi 回 ok:false + 人话（说清「还没配置」）', async () => {
      eq(core.isAiConfigured(), false, 'isAiConfigured() 现在必须是 false（产品里还没有配置来源）');
      const result = await core.classifyByAi(sampleInput());
      eq(result.ok, false, '未配置时必须是 ok:false');
      eq(result.reason, 'not-configured', '未配置时原因码必须是 not-configured');
      ok(typeof result.message === 'string' && result.message.trim().length > 0, '必须给一句人话');
      ok(/AI/.test(result.message), `人话里要说清是「AI 分类」这件事：「${result.message}」`);
      ok(/没(有)?配置|未配置/.test(result.message), `人话里要说清「还没配置」：「${result.message}」`);
      ok(/规则/.test(result.message), `人话里要给退路（先按规则分类）：「${result.message}」`);
      ok(!('assignments' in result), '没配置时不该给出任何分类结果');
      // 传了不存在的路径也一样：不抛异常、还是同一句人话
      const again = await core.classifyByAi({
        files: [{ path: path.join(tmpRoot, '根本不存在', 'x.bin'), name: 'x.bin', ext: 'bin' }],
        outputDir: path.join(tmpRoot, '输出'),
      });
      eq(again.ok, false, '文件根本不存在时也必须是 ok:false（本片不碰磁盘，绝不抛）');
      eq(again.reason, 'not-configured', '原因码不变');
      // 顺带钉一条：通道层唯一要调的那个入口也要在（主进程只转调它，不自己组装元信息）
      const viaPaths = await core.aiClassifyByPaths([path.join(tmpRoot, '源', 'a.jpg')], path.join(tmpRoot, '输出'));
      eq(viaPaths.ok, false, 'aiClassifyByPaths 必须与 classifyByAi 同一条路（同样回「未配置」）');
      eq(viaPaths.reason, 'not-configured', 'aiClassifyByPaths 的原因码不变');
      console.log(`      人话：${result.message}`);
    });

    /* ================= 二：绝不联网络 ================= */
    await check('绝不联网络：模块代码体里没有任何网络调用标识，且调用时哨兵没被碰过（一个请求都没发）', async () => {
      const netHits = [];
      for (const m of modSources) {
        const list = hits(NETWORK_CODE, m.code);
        if (list.length > 0) netHits.push(`${path.basename(m.file)}: ${list.join(', ')}`);
      }
      ok(netHits.length === 0, `模块代码体里出现了联网调用的标识：${netHits.join(' | ')}`);
      // 顺带钉一条：编译产物里连 require 都没有（运行时零依赖，谈不上「偷偷要求一个联网库」）
      const jsFile = modSources.find((m) => m.file.endsWith('.js'));
      if (jsFile) {
        eq(hits(/\brequire\b/, jsFile.code).length, 0, `编译产物里不该有任何 require：${jsFile.file}`);
      }

      // 哨兵：把能联网的入口全换成「一碰就抛错并记账」的函数
      const touched = [];
      const target = globalThis;
      const saved = new Map();
      const spy = (name) => {
        if (!(name in target)) return;
        saved.set(name, target[name]);
        target[name] = function sentinel() {
          touched.push(name);
          throw new Error(`sentinel ${name} was touched`);
        };
      };
      for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'XMLHttpRequestUpload']) spy(name);
      const nav = target.navigator;
      let navSentinel = null;
      if (nav && 'sendBeacon' in nav) {
        navSentinel = nav.sendBeacon;
        try {
          nav.sendBeacon = function sentinel() {
            touched.push('navigator.sendBeacon');
            throw new Error('sentinel navigator.sendBeacon was touched');
          };
        } catch {
          navSentinel = null;
        }
      }

      let result = null;
      try {
        result = await core.classifyByAi(sampleInput());
      } finally {
        for (const [name, value] of saved) target[name] = value;
        if (nav && navSentinel) {
          try {
            nav.sendBeacon = navSentinel;
          } catch {
            /* 还原失败不改判定 */
          }
        }
      }
      const watched = [...saved.keys()].concat(nav && navSentinel ? ['navigator.sendBeacon'] : []);
      ok(watched.length > 0, '一个哨兵都没装上（这样证明不了「没联网」）');
      eq(touched.length, 0, `调用时碰到了联网入口：${touched.join(', ')}`);
      eq(result.ok, false, '哨兵场景下返回值仍必须是「未配置」');
      console.log(`      哨兵装上了：${watched.join(', ')}；调用后碰到 0 个`);
    });

    /* ================= 三：不读密钥 ================= */
    await check('不读密钥：代码体里没有取密钥的写法；预留的配置读取函数存在但恒返回空', async () => {
      const secretHits = [];
      for (const m of modSources) {
        const list = hits(SECRET_CODE, m.code);
        if (list.length > 0) secretHits.push(`${path.basename(m.file)}: ${list.join(', ')}`);
      }
      ok(secretHits.length === 0, `模块代码体里出现了取密钥的写法：${secretHits.join(' | ')}`);

      const cfg = core.loadAiConfig();
      ok(cfg === null || cfg === undefined, `预留的配置读取函数必须返回空（= 没配置），实际 ${JSON.stringify(cfg)}`);
      eq(core.loadAiConfig(path.join(tmpRoot, '并不存在-的配置.json')), null, '给了位置也照样是「没配置」');
      ok(typeof core.AI_NOT_CONFIGURED_MESSAGE === 'string' && core.AI_NOT_CONFIGURED_MESSAGE.length > 0, '模块要导出那句人话（界面照抄，别处不许再写一份）');
      console.log(`      空配置读取：loadAiConfig() -> ${JSON.stringify(cfg)}`);
    });

    /* ================= 四：不写盘、不删东西 ================= */
    await check('不写盘、不删东西：调 classifyByAi 前后，被观察目录的文件数与目录数不变', async () => {
      const dir = path.join(tmpRoot, '不写盘');
      const src = path.join(dir, '源');
      const out = path.join(dir, '输出');
      fs.mkdirSync(path.join(src, '子'), { recursive: true });
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(src, 'a.jpg'), 'A', 'utf8');
      fs.writeFileSync(path.join(src, 'b.pdf'), 'B', 'utf8');
      fs.writeFileSync(path.join(src, '子', 'c.txt'), 'C', 'utf8');
      fs.writeFileSync(path.join(out, '已复制的一份.jpg'), 'A', 'utf8');

      const beforeSrc = countTree(src);
      const beforeOut = countTree(out);
      ok(beforeSrc.files === 3 && beforeSrc.dirs === 1, `造场失败：源目录应有 3 个文件 / 1 个目录，实际 ${JSON.stringify(beforeSrc)}`);

      const result = await core.classifyByAi({
        files: [
          { path: path.join(src, 'a.jpg'), name: 'a.jpg', ext: 'jpg' },
          { path: path.join(src, 'b.pdf'), name: 'b.pdf', ext: 'pdf' },
          { path: path.join(src, '子', 'c.txt'), name: 'c.txt', ext: 'txt' },
        ],
        rules: [{ name: '01_图片' }],
        outputDir: out,
      });
      eq(result.ok, false, '未配置时必须是 ok:false');

      eq(JSON.stringify(countTree(src)), JSON.stringify(beforeSrc), '源目录被动了（文件数或目录数变了）');
      eq(JSON.stringify(countTree(out)), JSON.stringify(beforeOut), '输出目录被动了（文件数或目录数变了）');
      ok(fs.existsSync(path.join(src, 'a.jpg')), '源文件必须还在');
      console.log(`      源 ${JSON.stringify(beforeSrc)} -> ${JSON.stringify(countTree(src))}；输出 ${JSON.stringify(beforeOut)} -> ${JSON.stringify(countTree(out))}`);
    });

    /* ================= 五：策略骨架可扩展 + 没有第二处 AI 实现 ================= */
    await check('策略骨架可扩展：接口形状齐全（配置类型占位 / 读取 / 查询 / 分类 / 状态），且产品里没有第二处 AI 实现', async () => {
      const raw = modSources[0].raw;
      ok(/export\s+interface\s+AiConfig\b/.test(raw), '缺少配置类型占位（AiConfig）');
      ok(/export\s+function\s+loadAiConfig\b/.test(raw), '缺少配置读取函数（loadAiConfig）');
      ok(/export\s+function\s+isAiConfigured\b/.test(raw), '缺少配置查询（isAiConfigured）');
      ok(/export\s+(async\s+)?function\s+classifyByAi\b/.test(raw), '缺少 AI 分类调用（classifyByAi）');
      for (const name of ['AiClassifyInput', 'AiClassifyInputFile', 'AiAssignment', 'AiClassifyResult', 'AiReason', 'AiStatus']) {
        ok(new RegExp(`export\\s+(interface|type)\\s+${name}\\b`).test(raw), `缺少接口形状 ${name}`);
      }
      ok(/export\s+function\s+formatAiStatus\b/.test(raw), '缺少界面状态查询（formatAiStatus）');
      ok(/export\s+(async\s+)?function\s+aiClassifyByPaths\b/.test(raw), '缺少通道层唯一要调的入口（aiClassifyByPaths）');
      // 将来接大模型的形状（输入：文件列表与元信息；输出：文件 -> 分类名）必须写在这份文件的注释里
      ok(/将来接大模型/.test(raw) && /文件\s*→\s*分类名/.test(raw), '文件头里没写明将来接大模型时的输入/输出形状');

      // 没有第二处 AI 实现：模块自己的文件以外，「自己定义一份实现」或「直接调一次实现」都不许有 ——
      // 只允许主进程那两个「门」各转调一次（这是通道层，不是第二处实现，逐条钉死在下面）。
      const implIdents = [
        'classifyByAi',
        'isAiConfigured',
        'loadAiConfig',
        'formatAiStatus',
        'toAiInputFiles',
        'aiClassifyByPaths',
        'AI_NOT_CONFIGURED_MESSAGE',
        'AI_STATUS_LABEL',
        'AiConfig',
        'AiClassifyInputFile',
        'AiClassifyInput',
        'AiClassifyResult',
        'AiAssignment',
        'AiReason',
        'AiStatus',
      ];
      const otherCode = otherCodeOf();
      const foundUses = [];
      for (const [rel, code] of otherCode) {
        for (const ident of implIdents) {
          for (const use of realUses(ident, code)) foundUses.push({ rel, use });
        }
      }
      // 允许清单：只有主进程那两个门，各转调一次（多一条、少一条都算不过）
      const allowed = [
        { rel: path.join('src', 'main.ts'), use: '直接调用了 formatAiStatus' },
        { rel: path.join('src', 'main.ts'), use: '直接调用了 aiClassifyByPaths' },
      ];
      const key = (x) => `${String(x.rel).toLowerCase()}|${x.use}`;
      const allowedKeys = new Set(allowed.map(key));
      const unexpected = foundUses.filter((x) => !allowedKeys.has(key(x)));
      ok(
        unexpected.length === 0,
        `产品里出现了第二处 AI 实现 / 多出来的实现调用（只允许那个模块自己 + 主进程那两个门）：${unexpected
          .map((x) => `${x.rel}: ${x.use}`)
          .join(' | ')}`,
      );
      for (const a of allowed) {
        const list = [...otherCode.keys()].find((r) => r.toLowerCase() === a.rel.toLowerCase());
        ok(list !== undefined, `允许清单里的 ${a.rel} 不存在（扫不到这个文件）`);
        ok(
          foundUses.some((x) => key(x) === key(a)),
          `主进程那两个门没接上（${a.rel} 里没找到「${a.use}」）—— 界面按钮点下去就到不了这个模块`,
        );
      }
      console.log(`      模块文件 ${modFiles.length} 个；扫过其它产品文件 ${otherCode.size} 个；实现调用只出现在主进程那两个门上（各 1 处）`);
    });

    /* ================= 六：探针有效性自检（这几个扫描器不是死的） ================= */
    await check('探针有效性自检：凭空造出的「偷偷联网」「另写一份配置读取」「别处又抄一份实现」的产物必须被判失败', async () => {
      const src = modSources[0];
      // ① 联网探针：往真产物里塞一行 fetch(...) → 联网扫描必须抓到
      const netCrippled = src.code.replace('function isAiConfigured()', 'function sneakyProbe(){ fetch("x"); }\nfunction isAiConfigured()');
      ok(netCrippled !== src.code, '没能造出「偷偷联网」的样本');
      const netCaught = hits(NETWORK_CODE, netCrippled);
      ok(netCaught.length > 0, '塞了 fetch 的产物没被联网扫描抓到 —— 探针是死的');

      // ② 密钥探针：塞一行读环境变量 → 密钥扫描必须抓到
      const secretCrippled = src.code.replace('return null;', 'return process.env.SOME_KEY || null;');
      ok(secretCrippled !== src.code, '没能造出「读环境变量」的样本');
      const secretCaught = hits(SECRET_CODE, secretCrippled);
      ok(secretCaught.length > 0, '塞了 process.env 的产物没被密钥扫描抓到 —— 探针是死的');

      // ③ 第二处实现探针：把真文件当成「有人偷偷照抄一份实现」的样子 → 调用扫描必须抓到
      const victimRel = path.join('src', 'renderer', 'renderer.ts');
      const victim = [...otherCodeOf()].find(([rel]) => rel.toLowerCase() === victimRel.toLowerCase());
      ok(victim !== undefined, `找不到 ${victimRel}（第二处实现探针没法做）`);
      const before = realUses('classifyByAi', victim[1]);
      ok(before.length === 0, '真产物里本来就不该有人调 classifyByAi');
      const crippled = `${victim[1]}\nfunction copyOfAi(){ return classifyByAi({ files: [] }); }\n`;
      const after = realUses('classifyByAi', stripCommentsAndStrings(crippled));
      ok(after.length > 0, '另抄一份实现的产物没被调用扫描抓到 —— 探针是死的');
      // 真产物必须通过（单独再扫一遍，不复用上面的结论）
      const liveHit = [...otherCodeOf()].some(([, c]) => realUses('classifyByAi', c).length > 0);
      ok(liveHit === false, '真产物里有人直接调了 classifyByAi（那就不只是主进程那两个门了）');
      console.log(`      联网探针抓到：${netCaught.join(', ')}；密钥探针抓到：${secretCaught.join(', ')}；第二处实现探针抓到：${after.join(' / ')}`);
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
    console.log('AI策略壳OK');
    process.exitCode = 0;
  } else {
    console.log('验收失败:AI策略壳');
    process.exitCode = 1;
  }
}

main();
