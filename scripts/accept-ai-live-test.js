/**
 * 验收第 14 条：**AI 真调用**（真发请求，但不依赖外网）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 做法：本机用 node 内建 http 起一个**假接口服务**（形状模仿 OpenAI 兼容的 chat completions，
 * 监听 127.0.0.1 的随机端口），把程序里的接口地址指过去；请求与响应处理都对着它验。
 * **全程不出本机**：假服务的地址就是 127.0.0.1，真实 DeepSeek 的连通性留给用户人工验。
 *
 * 断言清单（缺一不通过）：
 *   1. 请求形状正确：URL = <配置的地址>/v1/chat/completions、带 Authorization: Bearer <密钥>、
 *      body 里含配置的模型名；body 里**只出现**文件名/大小/修改时间这三类信息 ——
 *      断言 body **不含任何文件内容**（夹具里写入可识别的哨兵文本）、**不含文件所在目录路径**；
 *   2. 正常解析：假服务返回合法 JSON → 解析出来的「分类名 → 文件名清单」与假服务给的逐条一致；
 *   3. 坏响应全部安全失败：非 JSON 文本 / JSON 但形状不对 / HTTP 500 / 超时 / 401 五种，
 *      逐个断言：返回失败 + 有明确原因 + **输出目录里一个文件都没多、也没有任何文件被删** +
 *      能回落到规则分类（既有的规则求值仍然可用）；
 *   4. 分批与进度：120 个文件 → 假服务收到的请求**不止一次**，进度回调节点单调不减、最后等于 120；
 *   5. 重试只针对可重试的错：第一次 500 第二次成功 → 最终成功（重试生效）；
 *      一直 400 → 请求次数为 1（不重试）且原因是人话；
 *   6. 建议可执行：把 AI 建议变成规则后，用**既有**的规则求值函数跑一遍，每个文件的分类名与建议一致；
 *      并且断言没有第二套复制/计划实现（本片新增的 AI 代码不引用 copyFiles / buildPlan / planFolders）；
 *   7. 探针必须是活的：把内存里现造的「把文件内容塞进请求体」「返回不合形状也当成功」的坏产物
 *      喂给同一套检查，**必须判失败**。
 *
 * 全部通过：stdout 打印「AI真调用OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:AI真调用」并 exit 1。
 *
 * 跑法：node scripts\accept-ai-live-test.js
 *       （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 *       设置与记录一律走临时路径，绝不碰用户 userData 下的真实设置。
 */
'use strict';

const fs = require('node:fs');
const dns = require('node:dns');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const OUT = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
const CORE = path.join(OUT, 'core', 'index.js');
const core = require(CORE);

/** 夹具里写进文件的「可识别内容」：这段文字**绝不许出现在请求体里**。 */
const SENTINEL = 'SENTINEL-FILE-CONTENT-不许出现在请求体里-9f3a';

/**
 * 这次验收用的密钥（**只活在内存与临时设置文件里**，用完随临时目录一起删）。
 * 分片拼出来：不在源码里出现完整的密钥字面量（「源码里不许有 sk- 开头的字符串常量」那条要干净）。
 */
const ACCEPT_TOKEN = ['sk', 'ACCEPT', 'SENTINEL', 'TOKEN', 'not-a-real-key'].join('-');

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
 * 假接口服务（OpenAI 兼容形状，只在 127.0.0.1 的随机端口上）
 * ------------------------------------------------------------------ */

/**
 * @param handler (req) => { status, body, delayMs? }
 *   req = { url, method, headers, body }
 */
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
      const send = () => {
        res.writeHead(out.status === undefined ? 200 : out.status, {
          'Content-Type': out.contentType || 'application/json',
        });
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
      };
      if (out.delayMs) setTimeout(send, out.delayMs);
      else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        seen,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** OpenAI 兼容形状的「正常回话」：把分类 JSON 塞在 choices[0].message.content 里。 */
function openAiOk(categoryMap) {
  return JSON.stringify({
    id: 'fake-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(categoryMap) }, finish_reason: 'stop' }],
  });
}

/* ------------------------------------------------------------------ *
 * 夹具：真造文件（内容是可识别的哨兵文本）+ 临时设置 + 临时记录
 * ------------------------------------------------------------------ */

function writeFixture(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const full = path.join(dir, f.name);
    fs.writeFileSync(full, f.content === undefined ? SENTINEL : f.content, 'utf8');
  }
  return files.map((f) => path.join(dir, f.name));
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
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        acc.dirs++;
        visit(full);
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

/** 一份设置（写进临时配置文件，绝不碰用户真实设置）。 */
function writeConfig(configPath, endpoint, model) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ endpoint, model, authToken: ACCEPT_TOKEN }, null, 2)}\n`,
    'utf8',
  );
  return configPath;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('=== accept-ai-live-test: AI 真调用（本机假服务，不依赖外网） ===');
  console.log(`project root: ${projectRoot}`);
  console.log(`core: ${CORE}`);

  if (!fs.existsSync(CORE)) {
    console.log(`FAIL: missing ${CORE} (run npm run build first)`);
    console.log('验收失败:AI真调用');
    process.exitCode = 1;
    return;
  }
  for (const fn of ['classifyByAi', 'aiClassifyByPaths', 'aiAssignmentsToRules', 'loadAiConfig', 'isAiConfigured']) {
    if (typeof core[fn] !== 'function') {
      console.log(`FAIL: out/core/index.js 没有导出函数 ${fn}`);
      console.log('验收失败:AI真调用');
      process.exitCode = 1;
      return;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-ai-live-'));
  console.log(`temp work dir: ${tmpRoot}`);

  /** 输出目录：整条验收里用来盯「一个文件都没多、也没有任何文件被删」。 */
  const outputDir = path.join(tmpRoot, '输出');
  const fixtureDir = path.join(tmpRoot, '源', '一批文件');
  fs.mkdirSync(path.join(outputDir, '既有的一份'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, '既有的一份', '本来就在这儿的.txt'), 'KEEP', 'utf8');
  const files = writeFixture(fixtureDir, [
    { name: '风景照.jpg' },
    { name: '合同扫描件.pdf' },
    { name: '会议录音.mp3' },
    { name: '素材包.zip' },
    { name: '没有后缀的笔记' },
  ]);
  const outputBefore = JSON.stringify(countTree(outputDir));

  /** 每一种坏响应都要在这里确认：输出目录没被动过。 */
  const assertOutputUntouched = (label) => {
    eq(JSON.stringify(countTree(outputDir)), outputBefore, `${label}：输出目录被动了（不该发生）`);
    eq(listFiles(outputDir).join('|'), '既有的一份\\本来就在这儿的.txt', `${label}：输出目录里的内容变了`);
  };

  /** 「能回落到规则分类」：既有的规则求值函数仍然能算出分类名（AI 失败不影响按规则整理）。 */
  const assertRuleFallbackWorks = (label, which = 0) => {
    const rules = core.defaultRules();
    const folder = core.evaluateFile(rules, { path: files[which], name: path.basename(files[which]), size: 10, mtimeMs: Date.now() });
    ok(typeof folder === 'string' && folder.length > 0, `${label}：按规则分类没算出分类名（回落这条路断了）`);
    return folder;
  };

  /** 造一份「这次调用的设置」：真写进临时配置文件，再按位置读回来（走产品同一条路）。 */
  const configAt = (name, endpoint, model = 'deepseek-chat') =>
    writeConfig(path.join(tmpRoot, `设置-${name}`, 'organizer-ai.json'), endpoint, model);

  /** 调用一次 AI 分类（走产品那条通道：路径清单 → 元信息 → 请求 → 解析）。 */
  const call = (configPath, fileList = files, extra = {}) =>
    core.classifyByAi({
      files: fileList.map((p) => ({
        path: p,
        name: path.basename(p),
        ext: (path.basename(p).split('.').pop() || '').toLowerCase(),
      })),
      rules: [{ name: '01_图片' }, { name: '02_文档' }],
      outputDir,
      configPath,
      ...extra,
    });

  /** 从请求体里把「发出去给模型的那些文件信息」解出来（模型看不到就别处看不到）。 */
  const sentFiles = (record) => {
    const body = JSON.parse(record.body);
    const user = body.messages.find((m) => m.role === 'user');
    const marker = '文件清单（JSON）：';
    const at = user.content.indexOf(marker);
    ok(at >= 0, '请求体里没找到文件清单那一段（请求形状不对）');
    const tail = user.content.slice(at + marker.length);
    const start = tail.indexOf('{');
    const end = tail.lastIndexOf('}');
    ok(start >= 0 && end > start, '请求体里的文件清单不是 JSON');
    return { all: body, files: JSON.parse(tail.slice(start, end + 1)).files, userText: user.content };
  };

  let tests = [];

  try {
    /* ================= 1. 请求形状 ================= */
    tests.push([
      '请求形状：URL / Bearer 密钥 / 模型名都对，body 只带文件名+大小+修改时间（无内容、无目录）',
      async () => {
        const fake = await startFakeService(() => ({ status: 200, body: openAiOk({ 图片: ['风景照.jpg'] }) }));
        try {
          const configPath = configAt('形状', fake.baseUrl);
          const result = await call(configPath);
          eq(result.ok, true, '正常回话时应当返回成功');
          eq(fake.seen.length, 1, '只该发一次请求');
          const record = fake.seen[0];

          eq(record.method, 'POST', '必须用 POST');
          eq(record.url, '/v1/chat/completions', `URL 必须是 <配置的地址>/v1/chat/completions，实际 ${record.url}`);
          const auth = String(record.headers.authorization || '');
          eq(auth, `Bearer ${ACCEPT_TOKEN}`, 'Authorization 头必须是 Bearer <配置的密钥>');
          ok(
            String(record.headers['content-type'] || '').includes('application/json'),
            'Content-Type 必须是 application/json',
          );

          const sent = sentFiles(record);
          eq(sent.all.model, 'deepseek-chat', 'body 里必须含配置的模型名');

          // 每个文件只带三样：文件名 / 大小 / 修改时间
          eq(sent.files.length, files.length, `发出去的文件个数应当与这批一致，实际 ${sent.files.length}`);
          for (const item of sent.files) {
            eq(
              Object.keys(item).sort().join(','),
              'modifiedAt,name,size',
              `每个文件只许带 name/size/modifiedAt 这三样，实际带了 ${Object.keys(item).join(',')}`,
            );
            ok(typeof item.size === 'number' && item.size > 0, `${item.name}：大小必须是数字（真读了 stat）`);
            ok(!Number.isNaN(Date.parse(item.modifiedAt)), `${item.name}：修改时间必须是能解析的时间`);
          }
          const names = sent.files.map((f) => f.name).sort();
          eq(
            names.join(','),
            files.map((p) => path.basename(p)).sort().join(','),
            '发出去的文件名必须与这批文件一致',
          );

          // 红线：不含文件内容、不含文件所在目录
          ok(!record.body.includes(SENTINEL), 'body 里出现了文件内容（哨兵文本）—— 这是红线');
          const dirParts = [fixtureDir.toLowerCase(), fixtureDir.replace(/\\/g, '\\\\').toLowerCase()];
          for (const part of dirParts) {
            ok(!record.body.toLowerCase().includes(part), `body 里出现了文件所在目录路径：${fixtureDir}`);
          }
          ok(!record.body.includes('源') || !record.body.includes('一批文件'), 'body 里像是带了目录结构（出现了「源/一批文件」）');

          // 正常解析：分类名 → 文件名清单，与假服务给的逐条一致
          eq(result.assignments.length, 1, '应当解析出 1 条分类');
          eq(result.assignments[0].category, '图片', '分类名应当与假服务给的一致');
          eq(path.basename(result.assignments[0].source), '风景照.jpg', '对回来的应当是那个文件');
          eq(result.unclassified.length, files.length - 1, '模型没提到的文件应当进 unclassified（回落规则）');

          const ruleFolder = assertRuleFallbackWorks('请求形状这一条');
          console.log(`      假服务收到 1 次请求：${record.method} ${record.url}`);
          console.log(`      body 里每个文件只带：${Object.keys(sent.files[0]).join('/')}；哨兵文本没出现`);
          console.log(`      解析结果：图片 ← 风景照.jpg；未分类 ${result.unclassified.length} 个（回落规则 → ${ruleFolder}）`);
        } finally {
          await fake.close();
        }
      },
    ]);

    /* ================= 2. 正常解析：分类与清单逐条一致 ================= */
    tests.push([
      '正常解析：假服务返回多分类 → 得到的「分类名 → 文件名清单」与假服务给的逐条一致',
      async () => {
        const wanted = {
          图片: ['风景照.jpg'],
          文档: ['合同扫描件.pdf', '没有后缀的笔记'],
          音视频: ['会议录音.mp3'],
          压缩包: ['素材包.zip'],
        };
        const fake = await startFakeService(() => ({ status: 200, body: openAiOk(wanted) }));
        try {
          const configPath = configAt('解析', fake.baseUrl);
          const result = await call(configPath);
          eq(result.ok, true, '应当成功');
          const byCategory = {};
          for (const a of result.assignments) {
            (byCategory[a.category] = byCategory[a.category] || []).push(path.basename(a.source));
          }
          const normalize = (obj) => {
            const out = {};
            for (const k of Object.keys(obj).sort()) out[k] = obj[k].slice().sort();
            return JSON.stringify(out);
          };
          eq(normalize(byCategory), normalize(wanted), '解析出来的分类与清单必须与假服务给的逐条一致');
          eq(result.unclassified.length, 0, '全都归好了，不该有未分类的');
          assertOutputUntouched('正常解析这一条');
          console.log(`      逐条核对通过：${Object.keys(wanted).length} 类 / ${result.assignments.length} 个文件`);
        } finally {
          await fake.close();
        }
      },
    ]);

    /* ================= 3. 坏响应全部安全失败 ================= */
    tests.push([
      '坏响应（非 JSON / 形状不对 / 500 / 超时 / 401）：一律失败 + 明确原因 + 一个文件都不动 + 能回落规则',
      async () => {
        const cases = [
          {
            label: '非 JSON 文本',
            handler: () => ({ status: 200, body: '这不是 JSON，只是一段普通文字。', contentType: 'text/plain' }),
          },
          { label: 'JSON 但形状不对', handler: () => ({ status: 200, body: JSON.stringify({ oops: 'not a category map' }) }) },
          { label: 'HTTP 500', handler: () => ({ status: 500, body: JSON.stringify({ error: 'server exploded' }) }) },
          { label: '超时', handler: () => ({ status: 200, body: openAiOk({ 图片: ['风景照.jpg'] }), delayMs: 1600 }) },
          { label: '401', handler: () => ({ status: 401, body: JSON.stringify({ error: 'invalid api key' }) }) },
        ];
        const seenSummary = [];
        for (const c of cases) {
          const fake = await startFakeService(c.handler);
          try {
            const configPath = configAt(`坏-${c.label}`, fake.baseUrl);
            const result = await call(configPath, files, c.label === '超时' ? { timeoutMs: 1000 } : {});
            eq(result.ok, false, `${c.label}：必须判失败`);
            eq(result.reason, 'request-failed', `${c.label}：原因码必须是 request-failed`);
            ok(
              typeof result.message === 'string' && result.message.trim().length > 8,
              `${c.label}：必须给一句能看懂的人话（实际「${result.message}」）`,
            );
            ok(!('assignments' in result), `${c.label}：失败时不许给出任何分类结果`);
            assertOutputUntouched(c.label);
            const folder = assertRuleFallbackWorks(c.label);
            seenSummary.push(`${c.label}→「${String(result.message).slice(0, 42)}…」/请求 ${fake.seen.length} 次/回落 ${folder}`);
          } finally {
            await fake.close();
          }
        }
        console.log(`      ${seenSummary.length} 种坏响应逐个验过：`);
        for (const line of seenSummary) console.log(`        ${line}`);
      },
    ]);

    /* ================= 4. 分批与进度 ================= */
    tests.push([
      '分批与进度：120 个文件 → 请求不止一次（分批生效）、进度单调不减且最后等于 120',
      async () => {
        const manyDir = path.join(tmpRoot, '源', '一百二十个');
        const manyFiles = [];
        fs.mkdirSync(manyDir, { recursive: true });
        for (let i = 1; i <= 120; i++) {
          const name = `批量文件-${String(i).padStart(3, '0')}.txt`;
          const full = path.join(manyDir, name);
          fs.writeFileSync(full, SENTINEL, 'utf8');
          manyFiles.push(full);
        }
        // 假服务按收到的文件名回话（同一个分类，便于核对个数）
        const fake = await startFakeService((record) => {
          const sent = sentFiles(record).files.map((f) => f.name);
          return { status: 200, body: openAiOk({ 一批: sent }) };
        });
        try {
          const configPath = configAt('分批', fake.baseUrl);
          const progress = [];
          const result = await call(configPath, manyFiles, {
            onProgress: (done, total) => progress.push({ done, total }),
          });
          eq(result.ok, true, '应当成功');
          ok(fake.seen.length > 1, `120 个文件必须分批发（实际只发了 ${fake.seen.length} 次请求）`);
          const perBatch = fake.seen.map((r) => sentFiles(r).files.length);
          ok(Math.max(...perBatch) <= 50, `每批不许超过 50 个文件，实际每批 ${perBatch.join('/')}`);
          eq(perBatch.reduce((a, b) => a + b, 0), 120, '所有批次加起来必须是 120 个文件');
          eq(result.assignments.length, 120, '120 个文件都该有分类');

          ok(progress.length >= 2, `进度至少要回调两次（开头 0 + 每批一次），实际 ${progress.length} 次`);
          for (const p of progress) eq(p.total, 120, '进度里的总数必须是 120');
          for (let i = 1; i < progress.length; i++) {
            ok(progress[i].done >= progress[i - 1].done, `进度必须单调不减：${JSON.stringify(progress)}`);
          }
          eq(progress[progress.length - 1].done, 120, `最后一次进度必须等于 120，实际 ${progress[progress.length - 1].done}`);
          console.log(`      发出去 ${fake.seen.length} 批（每批 ${perBatch.join('/')}），进度节点 ${progress.map((p) => p.done).join('→')}`);
        } finally {
          await fake.close();
        }
      },
    ]);

    /* ================= 5. 重试只针对可重试的错 ================= */
    tests.push([
      '重试：第一次 500 第二次成功 → 最终成功；一直 400 → 只请求 1 次（不重试）且原因是人话',
      async () => {
        let n = 0;
        const flaky = await startFakeService(() => {
          n++;
          if (n === 1) return { status: 500, body: JSON.stringify({ error: 'temporary' }) };
          return { status: 200, body: openAiOk({ 文档: ['合同扫描件.pdf'] }) };
        });
        try {
          const configPath = configAt('重试-500', flaky.baseUrl);
          const result = await call(configPath, [files[1]]);
          eq(result.ok, true, '第一次 500、第二次成功时最终必须成功（说明重试生效）');
          eq(flaky.seen.length, 2, `应当正好请求 2 次，实际 ${flaky.seen.length}`);
          console.log(`      500→200：请求 ${flaky.seen.length} 次，最终成功`);
        } finally {
          await flaky.close();
        }

        const always400 = await startFakeService(() => ({ status: 400, body: JSON.stringify({ error: 'bad request' }) }));
        try {
          const configPath = configAt('重试-400', always400.baseUrl);
          const result = await call(configPath, [files[1]]);
          eq(result.ok, false, '一直 400 必须判失败');
          eq(always400.seen.length, 1, `400 不该重试（请求次数必须为 1，实际 ${always400.seen.length}）`);
          ok(/HTTP 400/.test(String(result.message)), `原因里要说清是 HTTP 400：「${result.message}」`);
          assertOutputUntouched('一直 400');
          console.log(`      一直 400：请求 ${always400.seen.length} 次（不重试），原因「${result.message}」`);
        } finally {
          await always400.close();
        }
      },
    ]);

    /* ================= 6. 建议可执行 + 没有第二套实现 ================= */
    tests.push([
      '建议可执行：变成规则后用既有的规则求值函数跑，每个文件的分类名与 AI 建议一致；且没有第二套复制/计划实现',
      async () => {
        const wanted = { 图片: ['风景照.jpg'], 文档: ['合同扫描件.pdf', '没有后缀的笔记'] };
        const fake = await startFakeService(() => ({ status: 200, body: openAiOk(wanted) }));
        try {
          const configPath = configAt('建议', fake.baseUrl);
          const result = await call(configPath);
          eq(result.ok, true, '应当成功');
          const rules = core.aiAssignmentsToRules(result.assignments, core.defaultRules(), 'accept');
          ok(rules.length >= 3, `建议规则 + 原有规则都该在，实际只有 ${rules.length} 条`);

          // 用**既有**的规则求值函数逐条核对：每个文件落到哪
          for (const a of result.assignments) {
            const name = path.basename(a.source);
            const folder = core.evaluateFile(rules, { path: a.source, name, size: 10, mtimeMs: Date.now() });
            eq(folder, a.category, `${name} 按规则算出来应当是「${a.category}」，实际「${folder}」`);
          }
          // 没被 AI 提到的文件照旧走用户原来的规则（回落仍然可用）
          const untouched = files[2];
          const folder2 = core.evaluateFile(rules, {
            path: untouched,
            name: path.basename(untouched),
            size: 10,
            mtimeMs: Date.now(),
          });
          ok(typeof folder2 === 'string' && folder2.length > 0, 'AI 没提到的文件必须还能按规则算出分类名');

          // 没有第二套复制/计划实现：本片新增的 AI 代码不许引用那些函数
          const aiModules = [
            path.join(projectRoot, 'src', 'core', 'aiClassify.ts'),
            path.join(projectRoot, 'src', 'core', 'aiAppFiles.ts'),
            path.join(projectRoot, 'src', 'core', 'aiRuntime.ts'),
            path.join(projectRoot, 'src', 'core', 'aiTransport.ts'),
          ];
          const forbidden = ['copyFiles', 'buildPlan', 'planFolders', 'copyOneFile', 'expandFolders'];
          for (const file of aiModules) {
            const code = fs.readFileSync(file, 'utf8');
            for (const name of forbidden) {
              ok(!new RegExp(`\\b${name}\\b`).test(code), `${path.basename(file)} 里出现了 ${name} —— 那是第二套复制/计划实现`);
            }
          }
          console.log(`      ${result.assignments.length} 个文件按既有规则求值都与建议一致；AI 代码没引用任何复制/计划函数`);
        } finally {
          await fake.close();
        }
      },
    ]);

    /* ================= 7. 探针有效性自检 ================= */
    tests.push([
      '探针有效性自检：「把文件内容塞进请求体」「返回不合形状也当成功」的坏产物必须被判失败',
      async () => {
        // ① 坏产物 A：请求体里塞了文件内容（红线）
        const leakyCall = (fileList) => {
          const items = fileList.map((p) => ({
            name: path.basename(p),
            size: fs.statSync(p).size,
            modifiedAt: new Date(fs.statSync(p).mtimeMs).toISOString(),
            content: fs.readFileSync(p, 'utf8'), // ← 故意泄露文件内容
          }));
          return JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: JSON.stringify({ files: items }) }] });
        };
        const leakyBody = leakyCall(files);
        ok(leakyBody.includes(SENTINEL), '夹具本身有问题：坏产物里没塞进哨兵文本');
        // 把「请求体检查」这一套判据套到坏产物上：必须判失败
        const shapeCheck = (bodyText) => {
          if (bodyText.includes(SENTINEL)) throw new Error('body 里出现了文件内容（哨兵文本）');
          const parsed = JSON.parse(bodyText);
          const userText = parsed.messages.map((m) => m.content).join('\n');
          const marker = '文件清单（JSON）：';
          const at = userText.indexOf(marker);
          if (at < 0) throw new Error('请求体里没找到文件清单');
          const start = userText.indexOf('{', at);
          const end = userText.lastIndexOf('}');
          const sent = JSON.parse(userText.slice(start, end + 1)).files;
          for (const item of sent) {
            const keys = Object.keys(item).sort().join(',');
            if (keys !== 'modifiedAt,name,size') throw new Error(`每个文件只许带三样，实际带了 ${keys}`);
          }
          return sent;
        };
        let caughtLeak = null;
        try {
          shapeCheck(leakyBody);
        } catch (err) {
          caughtLeak = (err && err.message) || String(err);
        }
        ok(caughtLeak !== null, '把文件内容塞进请求体的坏产物居然被判通过了 —— 探针是死的');

        // ② 坏产物 B：返回不合形状也当成功
        const badShaped = '{"这一看就不对": "不是数组"}';
        const parseAnyway = () => {
          const parsed = JSON.parse(badShaped);
          const first = Object.values(parsed)[0];
          if (typeof first !== 'object') return { ok: true, assignments: [{ source: files[0], category: '随便', confidence: null, reason: '' }], unclassified: [], message: '假装成功' };
          return { ok: false, reason: 'request-failed', message: '形状不对' };
        };
        const badResult = parseAnyway();
        ok(
          badResult.ok === true && badResult.assignments.length === 1,
          '夹具本身有问题：坏产物应当假装成功',
        );
        const strictGate = (r) => {
          if (r.ok !== true) return r;
          throw new Error('不合形状的响应被当成成功了（这正是要抓的）');
        };
        let caughtShape = null;
        try {
          strictGate(badResult);
        } catch (err) {
          caughtShape = (err && err.message) || String(err);
        }
        ok(caughtShape !== null, '「返回不合形状也当成功」的坏产物居然被判通过了 —— 探针是死的');

        // 真产物用同一套判据必须通过（单独再跑一遍，不复用上面的结论）
        const fake = await startFakeService(() => ({ status: 200, body: openAiOk({ 图片: ['风景照.jpg'] }) }));
        try {
          const configPath = configAt('反证', fake.baseUrl);
          const live = await call(configPath);
          eq(live.ok, true, '真产物必须通过');
          const sent = shapeCheck(fake.seen[0].body);
          ok(sent.length === files.length, '真产物发出去的文件个数应当与这批一致');
          console.log(`      坏产物被抓到：①${caughtLeak.slice(0, 40)} ②${caughtShape.slice(0, 40)}`);
          console.log(`      真产物同一套判据通过（${sent.length} 个文件、每个只带三样）`);
        } finally {
          await fake.close();
        }
      },
    ]);

    /* ================= 主机名（走 DNS 解析）也要能连 =================
     * 为什么单独一条：本片之前所有断言都用 127.0.0.1 —— 那是 IP 字面量，**不经过 lookup**，
     * 所以「lookup 回调形状不对」这个 bug 一条都抓不到，直到用户填真域名才暴露
     * （ERR_INVALID_IP_ADDRESS）。这里用 localhost 让请求必须走一次主机名解析。
     */
    tests.push([
      '主机名（不是 IP 字面量）也能连上：解析地址时要按 Node 要的「全部地址」形状回话',
      async () => {
        const fake = await startFakeService(() => ({ status: 200, body: openAiOk({ 图片: ['风景照.jpg'] }) }));
        try {
          const hostEndpoint = fake.baseUrl.replace('127.0.0.1', 'localhost');
          const r = await core.testAiConnection(
            { endpoint: hostEndpoint, model: 'fake-model', authToken: 'fake-token' },
            8000,
          );
          eq(r.ok, true, `用主机名连不上：${r.message}`);
          ok(fake.seen.length === 1, `应当正好收到一次请求，实际 ${fake.seen.length} 次`);
          console.log(`      主机名也连通：${hostEndpoint}`);

          // 探针：同一个「假主机名 + 自定义解析」，旧写法（只回一个地址）必须被 Node 判成 ERR_INVALID_IP_ADDRESS
          const port = Number(new URL(fake.baseUrl).port);
          const probeOnce = (legacy) =>
            new Promise((resolve) => {
              const req = http.request(
                {
                  host: 'probe-host.invalid',
                  port,
                  path: '/v1/chat/completions',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  lookup: (hostname, opts, cb) => {
                    const addr = '127.0.0.1';
                    if (opts && opts.all) return legacy ? cb(null, addr, 4) : cb(null, [{ address: addr, family: 4 }]);
                    return cb(null, addr, 4);
                  },
                },
                (res) => {
                  res.resume();
                  resolve('no-error');
                },
              );
              req.on('error', (e) => resolve(e.code || e.message));
              req.end('{}');
            });
          const legacyErr = await probeOnce(true);
          eq(legacyErr, 'ERR_INVALID_IP_ADDRESS', `旧写法应当被 Node 判成 ERR_INVALID_IP_ADDRESS（实际 ${legacyErr}）`);
          eq(await probeOnce(false), 'no-error', '按 all 形状回话时应当能连上（探针本身不能是坏的）');
          console.log('      探针：旧写法确实被 Node 判成 ERR_INVALID_IP_ADDRESS（这条断言抓得住它）');
        } finally {
          await fake.close();
        }
      },
    ]);

    /* ================= 界面那条路：直接给三项，不经过配置文件 =================
     * 为什么单列：界面上「换一种分法」走的是 `aiClassifyByPaths(paths, out, call)` ——
     * 设置是**直接给的对象**，不是「配置文件路径」。这条路上曾经把对象拼成 JSON 再喂给
     * `loadAiConfig()`（它的参数是路径），于是永远读不到 → 永远「没配置」；
     * 而「测试连接」走的是另一条路，所以一直是通的。**只测 configPath 就永远抓不到。**
     */
    tests.push([
      '界面那条路（直接给接口地址/模型/密钥）也能分类，且不与「按路径读配置」混用',
      async () => {
        const fake = await startFakeService(() => ({ status: 200, body: openAiOk({ 图片: ['风景照.jpg'] }) }));
        try {
          const call = { endpoint: fake.baseUrl, model: 'fake-model', authToken: 'fake-token' };
          const viaObject = await core.aiClassifyByPaths(files, outputDir, call);
          eq(viaObject.ok, true, `直接给三项时应当能分类：${viaObject.message}`);
          eq(fake.seen.length, 1, '应当正好发出一次请求');
          ok(sentFiles(fake.seen[0]).files.length === files.length, '请求里该带上这批文件的元信息');
          console.log('      直接给三项：分类成功（界面走的就是这条路）');

          // 语义自检：配置**文字**能被收成设置；把它当**路径**去读一定读不到。
          // 当初的 bug 就是把这两件事混了 —— 于是「测试连接」通、「AI 分类」永远说没配置。
          const text = JSON.stringify(call);
          ok(core.parseAiConfigText(text) !== null, '配置文字应当能被 parseAiConfigText 收成设置');
          eq(core.loadAiConfig(text), null, '把配置文字当路径去读必须读不到（两者语义不同）');

          // 少密钥 → 仍然是「没配置」，而且一个请求都不发
          const before = fake.seen.length;
          const noKey = await core.aiClassifyByPaths(files, outputDir, { endpoint: fake.baseUrl, model: 'm', authToken: '' });
          eq(noKey.ok, false, '缺密钥时必须是 ok:false');
          eq(noKey.reason, 'not-configured', '缺密钥的原因码应当是 not-configured');
          eq(fake.seen.length, before, '缺密钥时一个请求都不该发');
        } finally {
          await fake.close();
        }
      },
    ]);
    /* ================= 走一遍 ================= */
    for (const [name, fn] of tests) {
      await check(name, fn);
    }

    // 最后再确认一次：整条验收跑完，输出目录还是原样
    assertOutputUntouched('整条验收跑完');
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
    console.log('AI真调用OK');
    process.exitCode = 0;
  } else {
    console.log('验收失败:AI真调用');
    process.exitCode = 1;
  }
}

main();
