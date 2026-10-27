/**
 * 验收第 18 条：**AI 分好的结论直接落地**（显式分类 → 预览 / 分拣 / 撤销，不经过规则表）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 为什么单列一条：AI 分类的「算」在前面的条目里验过了（假服务 + 请求形状），
 * 但「算出来的那张表怎么变成磁盘上的目录」一直没被钉住 ——
 * 之前只能把建议翻译成规则再绕一圈，落点其实由规则二次决定。这条钉的就是**不绕**的那条路。
 *
 * 断言（缺一不通过）：
 *   一、散文件：给了显式分类的文件按它落盘（含多级分类名），没给的按规则回落；
 *   二、源文件夹：只影响「本来会按规则建分类夹」的散文件；子文件夹里的文件仍原样保留、不被 AI 改道；
 *   三、危险分类名（`..\..\外面` / `C:\temp\x` / `CON`）一律不进表 → 回落规则，源树之外的哨兵一个字节都不多；
 *   四、输出方向校验照旧：输出 = 源 → blocked，一个字节都不写；
 *   五、预览与落盘同一套：`buildPreviewTree({assignments})` 的分类名与真实落盘的目录逐条一致；
 *   六、撤销照旧：记了账就能把这次复制出去的那份删掉，原文件一个不动；
 *   七、探针有效性自检：把同一批文件的 assignments 抽掉再跑一遍，落点必须变回「按规则」——
 *      抓不住这点 = 这条断言是死的。
 *
 * 全部通过：stdout 打印「AI分类落地OK」并 exit 0；任何一条不过：打印「验收失败:AI分类落地」并 exit 1。
 *
 * 跑法：node scripts/accept-ai-organize-test.js（由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const OUT = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
const core = require(path.join(OUT, 'core', 'index.js'));

const results = [];
function log(line) {
  console.log(line);
}
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push([name, true]);
      log(`PASS  ${name}`);
    })
    .catch((err) => {
      results.push([name, false]);
      log(`FAIL  ${name}`);
      log(`      ${(err && err.stack) || err}`);
    });
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}
function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

function writeFile(full, body) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  return full;
}

/** 输出目录里的文件（相对路径，用 / 归一，排序）。 */
function listFiles(dir) {
  const out = [];
  const walk = (cur, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const next = path.join(cur, e.name);
      const nextRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(next, nextRel);
      else out.push(nextRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** 输出目录里的目录（相对路径，含中间层；排序）。 */
function listDirs(dir) {
  const out = [];
  const walk = (cur, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const nextRel = rel ? `${rel}/${e.name}` : e.name;
      out.push(nextRel);
      walk(path.join(cur, e.name), nextRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** 数一棵树里的文件与目录（哨兵目录前后对比用）。 */
function countTree(root) {
  let files = 0;
  let dirs = 0;
  const walk = (cur) => {
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        dirs++;
        walk(path.join(cur, e.name));
      } else files++;
    }
  };
  walk(root);
  return { files, dirs };
}

(async () => {
  log('=== accept-ai-organize-test: AI 分好的结论直接落地（预览 / 分拣 / 撤销） ===');
  log(`project root: ${projectRoot}`);
  for (const fn of ['copyFiles', 'buildPreviewTree', 'undoLastRun', 'defaultRules', 'evaluateFile', 'normalizeCategoryPath']) {
    if (typeof core[fn] !== 'function') {
      log(`FAIL: out/core/index.js 没有导出 ${fn}`);
      log('验收失败:AI分类落地');
      process.exitCode = 1;
      return;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-ai-organize-'));
  log(`temp work dir: ${tmpRoot}`);

  try {
    /* ================= 一：散文件（不传 roots） ================= */
    await check('散文件：给了分类的按它落（含多级），没给的按规则回落', async () => {
      const dir = path.join(tmpRoot, '散文件');
      const src = path.join(dir, '源');
      const out = path.join(dir, '输出');
      const a = writeFile(path.join(src, '旅行照.jpg'), 'A');
      const b = writeFile(path.join(src, '合同扫描件.pdf'), 'B');
      const c = writeFile(path.join(src, '随手记.txt'), 'C');

      // 期望值不写死：没给分类的那个文件，按默认规则现算它该去哪个夹
      const rules = core.defaultRules();
      const folderOfC = core.evaluateFile(rules, { path: c, name: '随手记.txt', size: 1, mtimeMs: Date.now() });
      ok(typeof folderOfC === 'string' && folderOfC.length > 0, '默认规则应当能算出「随手记.txt」的分类');

      const summary = await core.copyFiles({
        files: [a, b, c],
        outputDir: out,
        rules,
        assignments: [
          { source: a, category: '照片' },
          { source: b, category: '文档\\合同' },
          // c 故意不给：应当按规则回落
        ],
      });

      eq(summary.blocked, false, '正常方向不该被拦下');
      eq(summary.successCount, 3, `三个文件都该复制成功（实际 ${summary.successCount}）`);
      const files = listFiles(out);
      const want = ['照片/旅行照.jpg', `文档/合同/合同扫描件.pdf`, `${folderOfC}/随手记.txt`].sort();
      eq(files.join('|'), want.join('|'), '落盘结构应当与「AI 给的两个 + 规则回落的那个」一致');
      ok(fs.existsSync(a) && fs.existsSync(b) && fs.existsSync(c), '原文件必须一个不少');
      log(`      落点：${files.join(' ｜ ')}（最后一个按规则算出「${folderOfC}」）`);
    });

    /* ================= 二：源文件夹各归各 + 子文件夹原样保留 ================= */
    await check('源文件夹：只改「会按规则建分类夹」的散文件，子文件夹里的仍原样保留', async () => {
      const dir = path.join(tmpRoot, '带文件夹');
      const root = path.join(dir, '一批');
      const out = path.join(dir, '输出');
      const looseA = writeFile(path.join(root, '海边.jpg'), 'A');
      const looseB = writeFile(path.join(root, '发票.pdf'), 'B');
      const inner = writeFile(path.join(root, '原片', '内部.jpg'), 'IN');

      const summary = await core.copyFiles({
        files: [looseA, looseB, inner],
        roots: [root],
        outputDir: out,
        rules: core.defaultRules(),
        assignments: [
          { source: looseA, category: 'AI_风景' },
          { source: looseB, category: 'AI_票据' },
          // 子文件夹里的文件就算给了分类也不该改道（原样保留优先）
          { source: inner, category: 'AI_不该用到' },
        ],
      });

      eq(summary.blocked, false, '正常方向不该被拦下');
      const files = listFiles(out);
      ok(files.indexOf('一批/AI_风景/海边.jpg') >= 0, `散文件应当进 AI 的分类夹：${files.join(' | ')}`);
      ok(files.indexOf('一批/AI_票据/发票.pdf') >= 0, `散文件应当进 AI 的分类夹：${files.join(' | ')}`);
      ok(files.indexOf('一批/原片/内部.jpg') >= 0, `子文件夹里的文件必须原样保留：${files.join(' | ')}`);
      ok(!fs.existsSync(path.join(out, '一批', 'AI_不该用到')), '子文件夹里的文件不该被 AI 改道');
      ok(fs.existsSync(inner), '原文件必须还在');
      log(`      落点：${files.join(' ｜ ')}`);
    });

    /* ================= 三：危险分类名一律不进表 ================= */
    await check('危险分类名（跳出源树 / 绝对路径 / 保留设备名）不进表，回落规则，源树之外一个字节都不多', async () => {
      const dir = path.join(tmpRoot, '危险名字');
      const root = path.join(dir, '源');
      const out = path.join(dir, '输出');
      const sentinelDir = path.join(dir, '哨兵');
      writeFile(path.join(sentinelDir, '不许被动.txt'), 'KEEP');
      const before = JSON.stringify(countTree(sentinelDir));

      const f1 = writeFile(path.join(root, 'a.pdf'), 'A');
      const f2 = writeFile(path.join(root, 'b.pdf'), 'B');
      const f3 = writeFile(path.join(root, 'c.pdf'), 'C');

      const rules = core.defaultRules();
      const fallback = core.evaluateFile(rules, { path: f1, name: 'a.pdf', size: 1, mtimeMs: Date.now() });

      const summary = await core.copyFiles({
        files: [f1, f2, f3],
        outputDir: out,
        rules,
        assignments: [
          { source: f1, category: '..\\..\\外面' },
          { source: f2, category: 'C:\\temp\\x' },
          { source: f3, category: 'CON' },
        ],
      });

      eq(summary.blocked, false, '危险的是分类名，不是输出方向：这次可以开工');
      const files = listFiles(out);
      ok(
        files.every((rel) => rel.startsWith(`${fallback}/`)),
        `三个文件都该回落到「${fallback}」这一层：${files.join(' | ')}`,
      );
      eq(files.length, 3, '三个文件都要落在输出里（不许因为名字危险就丢文件）');
      eq(JSON.stringify(countTree(sentinelDir)), before, '源树之外（哨兵目录）不许被动');
      ok(!fs.existsSync(path.join(dir, '外面')), '不许按 ..\\..\\外面 建出目录');
      for (const rel of core.normalizeCategoryPath ? [] : []) void rel;
      log(`      三个危险名字都被拒，全部回落到「${fallback}」；哨兵目录前后一致`);
    });

    /* ================= 四：输出方向校验照旧 ================= */
    await check('输出方向照旧：输出 = 源文件夹本身 → blocked，一个字节都不写', async () => {
      const dir = path.join(tmpRoot, '方向危险');
      const root = path.join(dir, '源');
      const f1 = writeFile(path.join(root, 'a.jpg'), 'A');
      const before = countTree(root);
      const summary = await core.copyFiles({
        files: [f1],
        roots: [root],
        outputDir: root,
        rules: core.defaultRules(),
        assignments: [{ source: f1, category: '随便' }],
      });
      eq(summary.blocked, true, '输出 = 源时必须拦下');
      eq(summary.writtenFiles.length, 0, '被拦下时不许写出任何文件');
      eq(JSON.stringify(countTree(root)), JSON.stringify(before), '源目录不许被动');
      log(`      拒绝理由：${summary.blockedReason}`);
    });

    /* ================= 五：预览与落盘同一套 ================= */
    await check('预览与落盘同一套：预览里 AI 的分类名与真实落盘的目录逐条一致', async () => {
      const dir = path.join(tmpRoot, '预览一致');
      const srcDir = path.join(dir, '源');
      const out = path.join(dir, '输出');
      const a = writeFile(path.join(srcDir, '图1.jpg'), 'A');
      const b = writeFile(path.join(srcDir, '文1.pdf'), 'B');
      const assignments = [
        { source: a, category: 'AI_图片' },
        { source: b, category: 'AI_文档\\扫描件' },
      ];

      const preview = core.buildPreviewTree({
        files: [a, b],
        outputDir: out,
        rules: core.defaultRules(),
        assignments,
      });
      eq(preview.ok, true, `预览应当成功：${preview.ok === false ? preview.message : ''}`);
      // 预览的 folders 是按层挂的树（多级分类挂在 children 里），落盘看到的是完整目录路径 —— 两边都展开成完整路径再比
      const flatten = (folders, prefix) => {
        const out = [];
        for (const f of folders ?? []) {
          const full = prefix ? `${prefix}/${f.folder}` : f.folder;
          out.push(full);
          out.push(...flatten(f.children, full));
        }
        return out;
      };
      const previewNames = flatten(preview.tree.folders, '').sort();

      // 预览不许写盘
      eq(fs.existsSync(out) ? listFiles(out).length : 0, 0, '预览阶段一个文件都不该写');

      const summary = await core.copyFiles({ files: [a, b], outputDir: out, rules: core.defaultRules(), assignments });
      eq(summary.successCount, 2, '两个文件都该复制成功');
      // 落盘这边要按**目录**比（多级分类的中间层也得算上，磁盘上确实建了它）
      const realDirs = listDirs(out);
      eq(realDirs.join('|'), previewNames.join('|'), '预览里的分类夹与落盘的目录必须一模一样');
      log(`      预览 = 落盘：${realDirs.join(' ｜ ')}`);
    });

    /* ================= 六：撤销照旧 ================= */
    await check('撤销照旧：记了账就能把这次复制出去的那份清掉，原文件一个不动', async () => {
      const dir = path.join(tmpRoot, '撤销');
      const srcDir = path.join(dir, '源');
      const out = path.join(dir, '输出');
      const recordPath = path.join(dir, 'last-run.json');
      const a = writeFile(path.join(srcDir, '可以撤.jpg'), 'A');

      const summary = await core.copyFiles({
        files: [a],
        outputDir: out,
        rules: core.defaultRules(),
        assignments: [{ source: a, category: 'AI_可撤' }],
        recordPath,
      });
      eq(summary.successCount, 1, '先要复制成功');
      eq(listFiles(out).join('|'), 'AI_可撤/可以撤.jpg', '落点应当是 AI 分类夹');

      const undo = core.undoLastRun(recordPath);
      eq(undo.ok, true, `撤销应当成功：${undo.message}`);
      eq(listFiles(out).length, 0, '撤销之后输出里不该剩下文件');
      ok(fs.existsSync(a), '原文件必须还在（撤销的红线）');
      eq(fs.readFileSync(a, 'utf8'), 'A', '原文件内容不许被改');
      log(`      撤销：${undo.message}`);
    });

    /* ================= 七：探针有效性自检 ================= */
    await check('探针有效性自检：抽掉 assignments 再跑一遍，落点必须变回「按规则」', async () => {
      const dir = path.join(tmpRoot, '探针');
      const srcDir = path.join(dir, '源');
      const a = writeFile(path.join(srcDir, '抽掉试试.jpg'), 'A');
      const rules = core.defaultRules();
      const byRule = core.evaluateFile(rules, { path: a, name: '抽掉试试.jpg', size: 1, mtimeMs: Date.now() });

      // 带表：落到 AI 给的夹
      const outWith = path.join(dir, '带表');
      await core.copyFiles({
        files: [a],
        outputDir: outWith,
        rules,
        assignments: [{ source: a, category: 'AI_专用夹' }],
      });
      eq(listFiles(outWith).join('|'), 'AI_专用夹/抽掉试试.jpg', '带表时应当落到 AI 的分类夹');

      // 抽掉表：必须回到规则算出来的那个夹（如果这里仍然进 AI_专用夹，说明表根本没生效）
      const outWithout = path.join(dir, '不带表');
      await core.copyFiles({ files: [a], outputDir: outWithout, rules });
      eq(
        listFiles(outWithout).join('|'),
        `${byRule}/抽掉试试.jpg`,
        `抽掉表之后应当回到规则分类「${byRule}」`,
      );
      ok(byRule !== 'AI_专用夹', '规则算出来的夹不可能与 AI 的夹同名（否则这条自检没意义）');
      log(`      带表 → AI_专用夹；抽掉表 → ${byRule}（探针是活的）`);
    });
  } catch (err) {
    log(`FAIL: 测试过程本身出错 -> ${(err && err.stack) || err}`);
    results.push(['unexpected-error', false]);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定 */
    }
  }

  log('');
  log('--- summary ---');
  let allOk = results.length > 0;
  for (const [name, pass] of results) {
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) allOk = false;
  }
  if (allOk) {
    log('AI分类落地OK');
    process.exitCode = 0;
  } else {
    log('验收失败:AI分类落地');
    process.exitCode = 1;
  }
})();
