/**
 * 验收第 19 条：**AI 在原文件夹已有的目录结构上分类**（用户要求 1）。
 *
 * 用户的原话：「原文件夹的已有目录结构被 AI 解析后保留为分类规则，AI 分类在此基础上分类」。
 * 也就是说：用户已经把「票据 / 文档 / 图片」这些夹子建好了，散在根上的新文件应当被放进**这些已有的夹子**，
 * 而不是每次都被 AI 另起一套新名字。
 *
 * 断言清单（缺一不通过）：
 *   1. 结构能读出来：`existingSchemeOf(files, roots)` 从文件路径里读出**相对源文件夹**的分类目录
 *      （大小写按原样、多级归一成 `a/b`），而且**不吐绝对路径、不吐盘符**；不给源文件夹 → 空（旧行为）；
 *   2. 提示词里说得明白：`buildOpenAiRequestBody` 带上「原文件夹里已经分好的目录」那一句与这些名字，
 *      并且**不含**绝对路径与盘符（只发相对目录名）；
 *   3. 真调用（本机假接口服务，不出本机）：请求体里确实带了这些已有分类；返回的 `existingCategories` 与之一致，
 *      人话里说「沿用了原文件夹已有的 N 个分类」；
 *   4. **落盘实证**：AI 分好的散文件与原来就在那个子文件夹里的文件**落进同一个分类夹**
 *      （`输出\报销材料\票据\` 下面既有老文件也有 AI 分进来的新文件），源文件一个没动；
 *   5. 探针必须是活的：把 `roots` 抽掉再跑一遍（= 旧行为），拿同一套「请求体必须带已有分类」的判据去喂，
 *      **必须判失败**。
 *
 * 全部通过：stdout 打印「AI结构OK」并 exit 0；任何一条不过：打印「验收失败:AI结构」并 exit 1。
 *
 * 跑法：node scripts\accept-ai-structure-test.js（由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 *       设置一律走内存里给的这一份，绝不读、也绝不碰用户真实保存的 AI 设置。
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const OUT = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
const core = require(path.join(OUT, 'core', 'index.js'));

/** 写进文件里的可识别内容：**绝不许出现在请求体里**（红线：不读文件内容）。 */
const SENTINEL = 'SENTINEL-不许出现在请求体里-7c1d';

/** 这次验收用的密钥（只活在内存里；分片拼出来，源码里不出现完整字面量）。 */
const TOKEN = ['sk', 'ACCEPT', 'STRUCT', 'not-a-real-key'].join('-');

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
/** 集合级比较（顺序无关）：分类名的取出顺序不该成为判据。 */
function sameSet(got, want, what) {
  const a = Array.from(got || []).slice().sort();
  const b = Array.from(want || []).slice().sort();
  eq(JSON.stringify(a), JSON.stringify(b), what);
}

/* ------------------------------------------------------------------ *
 * 假接口服务（OpenAI 兼容形状，只在 127.0.0.1 的随机端口上）
 * ------------------------------------------------------------------ */

function startFakeService(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const record = { url: req.url, method: req.method, headers: req.headers, body };
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

/** OpenAI 兼容形状的正常回话。 */
function openAiOk(categoryMap) {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: JSON.stringify(categoryMap) } }],
  });
}

/** 从请求体里取出「给模型看的那段话」与「文件清单」。 */
function partsOf(record) {
  const body = JSON.parse(record.body);
  const user = body.messages.find((m) => m.role === 'user');
  const marker = '文件清单（JSON）：';
  const at = user.content.indexOf(marker);
  ok(at >= 0, '请求体里没找到文件清单那一段（请求形状不对）');
  const tail = user.content.slice(at + marker.length);
  const start = tail.indexOf('{');
  const end = tail.lastIndexOf('}');
  return { all: body, userText: user.content, files: JSON.parse(tail.slice(start, end + 1)).files };
}

/* ------------------------------------------------------------------ *
 * 夹具：一个有现成目录结构的源文件夹
 * ------------------------------------------------------------------ */

function makeFixture(base) {
  const root = path.join(base, '源', '报销材料');
  const spec = {
    '十月打车发票.pdf': SENTINEL, // 散在根上：要 AI 分类
    '客户会议纪要.docx': SENTINEL, // 散在根上：要 AI 分类
    '票据/已有发票1.pdf': SENTINEL, // 本来就在「票据」里：原样保留
    '文档/已有纪要1.docx': SENTINEL, // 本来就在「文档」里：原样保留
  };
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  const files = [
    path.join(root, '十月打车发票.pdf'),
    path.join(root, '客户会议纪要.docx'),
    path.join(root, '票据', '已有发票1.pdf'),
    path.join(root, '文档', '已有纪要1.docx'),
  ];
  return { root, files };
}

/** 目录里的全部文件（相对路径，正斜杠），用来核对落盘结果。 */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('=== accept-ai-structure-test: AI 在原文件夹已有的目录结构上分类 ===');
  console.log(`project root: ${projectRoot}`);
  console.log(`core: ${path.join(OUT, 'core', 'index.js')}`);

  for (const fn of ['classifyByAi', 'aiClassifyByPaths', 'existingSchemeOf', 'buildOpenAiRequestBody', 'copyFiles', 'toAiInputFiles']) {
    if (typeof core[fn] !== 'function') {
      console.log(`FAIL: out/core/index.js 没有导出 ${fn}`);
      console.log('验收失败:AI结构');
      process.exitCode = 1;
      return;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-ai-structure-'));
  console.log(`temp work dir: ${tmpRoot}`);

  try {
    const fx = makeFixture(tmpRoot);
    const names = fx.files.map((p) => path.basename(p));

    /* ================= 一：结构读得出来，且只吐相对目录名 ================= */
    await check('结构读得出来：从文件路径里认出「票据 / 文档」，只有相对目录名（没有绝对路径、没有盘符）', () => {
      const scheme = core.existingSchemeOf(core.toAiInputFiles(fx.files), [fx.root]);
      sameSet(scheme.categories, ['票据', '文档'], '读出来的已有分类不对');
      eq(scheme.insideCount, 2, '本来就在已有分类里的文件数不对（应当是票据/文档里那 2 个）');
      for (const c of scheme.categories) {
        ok(!c.includes(':'), `分类名里出现了盘符：「${c}」`);
        ok(!c.includes('\\'), `分类名的分隔符没归一（出现了反斜杠）：「${c}」`);
        ok(!c.toLowerCase().includes(fx.root.toLowerCase()), `分类名里出现了绝对路径：「${c}」`);
        ok(!c.includes('报销材料'), `分类名里混进了源文件夹自身的名字：「${c}」`);
      }

      // 不给源文件夹 → 读不出结构（旧行为保持不变）
      sameSet(core.existingSchemeOf(core.toAiInputFiles(fx.files), null).categories, [], '没有源文件夹时不该猜结构');

      // 多级目录：相对名用 / 连接
      const multi = core.existingSchemeOf(
        core.toAiInputFiles([path.join(fx.root, '2024', '合同', 'a.pdf'), path.join(fx.root, 'b.pdf')]),
        [fx.root],
      );
      sameSet(multi.categories, ['2024/合同'], '多级分类名应当归一成 2024/合同');
      console.log(`      已有分类：${scheme.categories.join('、')}（命中 ${scheme.insideCount} 份；多级示例 ${multi.categories[0]}）`);
    });

    /* ================= 二：提示词（纯拼，不联网） ================= */
    await check('提示词：写明「原文件夹里已经分好的目录」并给出这些名字；不含绝对路径与盘符', () => {
      const meta = [{ name: '十月打车发票.pdf', size: 10, modifiedAt: new Date().toISOString() }];
      const withScheme = core.buildOpenAiRequestBody('m', meta, null, '', ['票据', '文档']);
      ok(/原文件夹里已经分好的目录/.test(withScheme), '请求体里没有「已有分类」那一句（模型不知道要沿用）');
      ok(withScheme.includes('票据') && withScheme.includes('文档'), '请求体里没有把已有分类名给模型');
      ok(/一字不差/.test(withScheme), '请求体里没要求「名字一字不差地用已有分类」');
      ok(!withScheme.includes(fx.root), '请求体里出现了源文件夹的绝对路径');
      ok(!withScheme.includes('报销材料'), '请求体里出现了源文件夹的名字（不该发）');
      ok(!/\\\\/.test(withScheme) && !/[A-Za-z]:\\\\/.test(withScheme), '请求体里出现了 Windows 绝对路径形状');

      // 探针：不给已有分类时，这一句就不该在 —— 说明上面那条断言抓得住东西
      const without = core.buildOpenAiRequestBody('m', meta, null, '', null);
      ok(!/原文件夹里已经分好的目录/.test(without), '没给已有分类时却说「原文件夹里已经分好的目录」—— 探针是死的');
      console.log('      提示词里那句：「…原文件夹里已经分好的目录（这些会原样保留，不用你重新分）：票据、文档。」');
    });

    /* ================= 三 + 四：真调用 + 落盘实证 ================= */
    let bodyRecord = null;
    await check('真调用 + 落盘：AI 只用了已有分类名（票据/文档），散文件与老文件落进同一个分类夹，源文件没动', async () => {
      const fake = await startFakeService(() =>
        // 模型按「已有分类」回话：名字与已有的完全一致（这就是用户要的效果）
        ({ status: 200, body: openAiOk({ 票据: ['十月打车发票.pdf'], 文档: ['客户会议纪要.docx'] }) }),
      );
      try {
        const call = { endpoint: fake.baseUrl, model: 'm', authToken: TOKEN };
        const res = await core.classifyByAi({
          files: core.toAiInputFiles(fx.files),
          roots: [fx.root],
          call,
        });
        eq(res.ok, true, `分类应当成功：${res.message}`);
        eq(fake.seen.length, 1, '这一批应当只发一次请求');
        bodyRecord = fake.seen[0];

        // 请求体：带上了已有分类；不含绝对路径；不含文件内容（红线）
        const sent = partsOf(bodyRecord);
        ok(/原文件夹里已经分好的目录/.test(sent.userText), '请求体里没有「已有分类」那一句');
        ok(sent.userText.includes('票据') && sent.userText.includes('文档'), '请求体里没有已有分类名');
        ok(!bodyRecord.body.includes(fx.root), '请求体里出现了源文件夹的绝对路径');
        ok(!bodyRecord.body.includes('报销材料'), '请求体里出现了源文件夹的名字');
        ok(!bodyRecord.body.includes(SENTINEL), '请求体里出现了文件内容（哨兵）—— 红线');
        eq(sent.files.length, fx.files.length, '发出去的文件数应当与这批一致');

        // 结果：分类名就是已有分类名，人话里说清「沿用」
        sameSet(res.existingCategories, ['票据', '文档'], '结果里的 existingCategories 不对');
        sameSet(res.newCategories, [], '这次不该新起分类（模型给的都是已有分类）');
        ok(/沿用/.test(res.message), `人话里应当说「沿用」已有分类：「${res.message}」`);
        sameSet(
          res.assignments.map((a) => a.category),
          ['票据', '文档'],
          'AI 给的分类名必须就是已有分类名（一字不差）',
        );

        // 落盘：走既有的复制管线（AI 的结论直接当显式分类用）
        const outputDir = path.join(tmpRoot, '输出');
        const copied = await core.copyFiles({
          roots: [fx.root],
          files: fx.files,
          outputDir,
          rules: null,
          assignments: res.assignments.map((a) => ({ source: a.source, category: a.category })),
        });
        ok(copied.blocked !== true, `这次不该被方向校验拦下：${copied.blockedReason}`);
        const tree = listFiles(outputDir);
        const want = [
          '报销材料/票据/十月打车发票.pdf', // AI 分进来的
          '报销材料/票据/已有发票1.pdf', // 本来就在那个夹子里的
          '报销材料/文档/客户会议纪要.docx', // AI 分进来的
          '报销材料/文档/已有纪要1.docx', // 本来就在那个夹子里的
        ].sort();
        eq(JSON.stringify(tree), JSON.stringify(want), '落盘结果：AI 应当把散文件放进原有的分类夹里（同夹共存）');

        // 源文件一个没动（只复制）
        eq(listFiles(fx.root).length, fx.files.length, '源文件夹里的文件数变了（这是红线）');
        for (const p of fx.files) ok(fs.existsSync(p), `源文件不见了：${p}`);
        console.log(`      假服务收到 1 次请求；落盘：${tree.join(' | ')}`);
        console.log(`      人话：「${res.message}」`);
      } finally {
        await fake.close();
      }
    });

    /* ================= 五：探针有效性自检 ================= */
    await check('探针有效性自检：把源文件夹抽掉再跑一遍（= 旧行为），请求体里就没有已有分类了 —— 同一套判据必须判失败', async () => {
      ok(bodyRecord, '上一条没跑成，这一条没法验');
      const fake = await startFakeService(() => ({ status: 200, body: openAiOk({ 票据: ['十月打车发票.pdf'] }) }));
      let blind = null;
      try {
        const call = { endpoint: fake.baseUrl, model: 'm', authToken: TOKEN };
        // 不给 roots：这正是「以前只会靠文件名猜」的那条路
        blind = await core.classifyByAi({ files: core.toAiInputFiles(fx.files), roots: null, call });
      } finally {
        await fake.close();
      }
      const blindText = partsOf(fake.seen[0]).userText;
      let caught = null;
      try {
        ok(/原文件夹里已经分好的目录/.test(blindText), '（探针）抽掉源文件夹之后仍然说有已有分类 —— 探针是死的');
      } catch (err) {
        caught = (err && err.message) || String(err);
      }
      ok(caught !== null, '「抽掉源文件夹」的产物居然被判通过了 —— 探针是死的');
      sameSet(blind.existingCategories || [], [], '没有源文件夹时，结果里的 existingCategories 应当是空');
      console.log(`      探针抓到：${caught.slice(0, 120)}`);
      console.log(`      无源文件夹那一趟的人话：「${blind.message}」`);
    });

    /* ================= 六：不许另起一套实现 ================= */
    await check('只有一处实现：结构读取与提示词都在 core 里，主进程只递参数（产品代码里没有第二份）', () => {
      const src = fs.readFileSync(path.join(projectRoot, 'src', 'core', 'aiClassify.ts'), 'utf8');
      ok(/export function existingSchemeOf/.test(src), 'aiClassify.ts 里没有 existingSchemeOf 这一处实现');
      const hits = [];
      for (const rel of ['src/main.ts', 'src/preload.ts', 'src/renderer/renderer.ts']) {
        const text = fs.readFileSync(path.join(projectRoot, ...rel.split('/')), 'utf8');
        if (/existingSchemeOf|原文件夹里已经分好的目录/.test(text)) hits.push(rel);
      }
      eq(hits.length, 0, `这些文件里又抄了一份结构读取/提示词：${hits.join(', ')}`);
      const mainTs = fs.readFileSync(path.join(projectRoot, 'src', 'main.ts'), 'utf8');
      ok(/payload\?\.roots/.test(mainTs), '主进程没有把源文件夹递给 AI 分类那一层（界面带了也白带）');
      console.log('      aiClassify.ts 一处实现；main/preload/renderer 只递参数');
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
    console.log('AI结构OK');
    process.exitCode = 0;
  } else {
    console.log('验收失败:AI结构');
    process.exitCode = 1;
  }
}

main();
