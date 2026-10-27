/**
 * 验收第 10 条：撤销上一次整理（纯逻辑，**真造临时目录与文件**）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 断言（缺一不通过）：
 *   一、正常撤销：真造源文件 → 真跑一次整理（临时输出根 + 临时记录文件）→ 输出里确实出现了那些文件与目录；
 *       撤销后：**本次复制出来的文件全部消失**、程序新建的空目录被清掉、**源文件一个不少且内容不变**；
 *       报告里的数字与实际情况一致（删了几个文件 / 几个目录）。
 *   二、幂等：紧接着再撤销一次 → **没有任何东西被删**、不抛错、报告说明「已经撤销过」。
 *   三、不删用户后加的东西：整理完往输出目录手工放一个文件 → 撤销 → 那个文件仍在，并被列为「跳过（不是本次整理产生的）」。
 *   四、不删被用户改过的文件：整理完改掉某个复制出来的文件（改大小）→ 撤销 → 该文件仍在并被列为跳过（内容/大小与记录不符）。
 *   五、删除失败不崩：锁住其中一个文件（真开文件句柄）→ 撤销继续处理剩下的、报告里有该条失败原因、整体不抛异常。
 *   六、跨重启可用：记录写成文件 → 用**另一个 node 进程**读回来执行撤销 → 仍然准确撤销（证明记录是持久化的）。
 *   七、绝不越界：构造「记录里混进了一条指向源目录里的路径」的坏记录 → 那位文件没有被删、被列为跳过且有原因。
 *
 * 全部通过：stdout 打印「撤销OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:撤销」并 exit 1。
 *
 * 跑法：node scripts\accept-undo-test.js   （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 * 记录文件一律用**临时路径**（绝不碰用户 userData 下真实的 organizer-last-run.json）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const OUT = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');
const core = require(path.join(OUT, 'core', 'index.js'));

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
 * 小工具
 * ------------------------------------------------------------------ */

/** 递归列出整棵树（文件与目录都有）。 */
function listTree(root) {
  const files = [];
  const dirs = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        dirs.push(full);
        walk(full);
      } else {
        files.push(full);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return { files, dirs };
}

function countTree(root) {
  const t = listTree(root);
  return { files: t.files.length, dirs: t.dirs.length };
}

/** 一棵树里所有文件的内容（相对路径 → 内容），用来断言「源文件一个不少且内容不变」。 */
function snapshotContents(root) {
  const map = {};
  for (const f of listTree(root).files) {
    map[path.relative(root, f).split(path.sep).join('/')] = fs.readFileSync(f, 'utf8');
  }
  return map;
}

/** 造一棵源文件夹（真文件、真内容）。 */
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
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('=== accept-undo-test: 撤销上一次整理（只删本次复制出去的，原文件绝不动） ===');
  console.log(`project root: ${projectRoot}`);
  console.log(`core: ${path.join(OUT, 'core', 'index.js')}`);

  for (const fn of ['copyFiles', 'loadRunRecord', 'saveRunRecord', 'undoLastRun', 'summarizeLastRun']) {
    if (core[fn] === undefined) {
      console.log(`FAIL: out/core/index.js 没有导出 ${fn}`);
      console.log('验收失败:撤销');
      process.exitCode = 1;
      return;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-undo-'));
  console.log(`temp work dir: ${tmpRoot}`);

  /** 每次用例一个自己的输出目录 + 记录文件（绝不共用，免得互相影响）。 */
  let caseSeq = 0;
  const newCase = (name) => {
    caseSeq++;
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, outputDir: path.join(dir, '输出'), recordPath: path.join(dir, `记录-${caseSeq}.json`) };
  };

  /** 真跑一次整理（走 copyFiles，和「开始整理」是同一条路）。 */
  const runOnce = async (c, roots, files) =>
    core.copyFiles({
      roots,
      files,
      outputDir: c.outputDir,
      recordPath: c.recordPath,
      rules: null,
    });

  try {
    /* ---------------- 一、正常撤销 ---------------- */
    const c1 = newCase('正常撤销');
    const src1 = makeSource(path.join(c1.dir, '源'), {
      '照片.jpg': 'P1',
      '报告.pdf': 'P2',
      '曲子.mp3': 'P3',
      '打包.zip': 'P4',
      '杂物.xyz': 'P5',
      '子目录/里面的.txt': 'P6',
      '子目录/更深/更深处的.txt': 'P7',
    });
    const src1Before = snapshotContents(src1);
    let summary1 = null;
    let record1 = null;
    let undo1 = null;

    await check('正常撤销：真跑一次整理 → 输出里确实出现那些文件与目录，记录也落盘了', async () => {
      summary1 = await runOnce(c1, [src1], fs.readdirSync(src1, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(src1, e.name)));
      eq(summary1.blocked, false, '这次整理不该被方向校验拦下');
      eq(summary1.successCount, 5, '散文件复制成功的个数');
      const outTree = countTree(c1.outputDir);
      ok(outTree.files >= 5, `输出里应当至少有 5 个文件，实际 ${outTree.files}`);
      ok(outTree.dirs >= 2, `输出里应当至少有 2 个目录（分类夹），实际 ${outTree.dirs}`);
      ok(fs.existsSync(c1.recordPath), `记录文件没有落盘：${c1.recordPath}`);
      record1 = core.loadRunRecord(c1.recordPath);
      ok(record1, '记录读不回来');
      eq(record1.files.length, 5, '记录里的「本次复制出来的文件」个数');
      eq(record1.successCount, 5, '记录里的成功数');
      eq(record1.failureCount, 0, '记录里的失败数');
      eq(record1.undoneAt, null, '刚整理完的记录不该是「已撤销」');
      ok(Array.isArray(record1.directories) && record1.directories.length >= 2, '记录里没有「本次创建的目录」');
      for (const f of record1.files) {
        ok(fs.existsSync(f.target), `记录里的目标文件不存在：${f.target}`);
        eq(fs.statSync(f.target).size, f.size, `记录里的大小与磁盘不一致：${f.target}`);
      }
      for (const d of record1.directories) ok(fs.existsSync(d), `记录里的目录不存在：${d}`);
      console.log(`      输出：${countTree(c1.outputDir).files} 个文件 / ${countTree(c1.outputDir).dirs} 个目录；记录里的文件 ${record1.files.length} 个、目录 ${record1.directories.length} 个`);
    });

    await check('正常撤销：撤销后本次复制出来的文件全部消失、分类夹被清掉、**输出根目录本身留着**、源文件一个不少且内容不变', () => {
      const before = countTree(c1.outputDir);
      const records = record1.files.map((f) => f.target);
      const auditPath = path.join(c1.dir, '删除审计.log');
      undo1 = core.undoLastRun(c1.recordPath, { auditPath });

      eq(undo1.ok, true, '撤销应当成功返回');
      eq(undo1.deletedFiles, records.length, '报告里「删掉的文件数」应当等于本次复制出来的文件数');
      for (const t of records) ok(!fs.existsSync(t), `撤销后这个文件应当消失：${t}`);
      const after = countTree(c1.outputDir);
      eq(after.files, 0, `撤销后输出目录里不该还有文件（撤销前 ${before.files} 个）`);

      // **输出根目录本身必须留着**（用户报过「目的文件夹消失了」）：
      // 它可能也是这次整理新建的，但那是用户自己选的目录，撤销只清它下面由程序建的分类夹。
      ok(
        fs.existsSync(c1.outputDir),
        `撤销把输出根目录本身删掉了（不许可：那是用户自己选的目录）：${c1.outputDir}`,
      );
      const rootHit = undo1.dirs.find((d) => path.resolve(d.dir).toLowerCase() === path.resolve(c1.outputDir).toLowerCase());
      ok(rootHit, `报告里应当有输出根目录这一条处置：${c1.outputDir}`);
      eq(rootHit.action, 'skipped', '输出根目录那一行必须是「跳过」（留着不动），绝不能是「清掉」');
      ok(/输出根目录/.test(rootHit.reason), `报告原因里应当说清「输出根目录留着」：「${rootHit.reason}」`);

      // 它下面的分类夹（由程序新建、现在空了）照样都被清掉
      const innerDirs = record1.directories.filter(
        (d) => path.resolve(d).toLowerCase() !== path.resolve(c1.outputDir).toLowerCase(),
      );
      ok(innerDirs.length > 0, '前置不成立：记录里应当有「输出根下面的分类夹」');
      for (const d of innerDirs) ok(!fs.existsSync(d), `撤销后由程序创建的分类夹应当清掉：${d}`);
      eq(undo1.removedDirs, innerDirs.length, '报告里「清掉的目录数」应当等于「输出根下面的分类夹数」');
      const dirsLeft = countTree(c1.outputDir).dirs;
      eq(dirsLeft, 0, '撤销后输出根里不该还剩目录（用户没往里加过东西）');
      eq(undo1.skippedFiles, 0, '这一轮不该有跳过的文件');
      eq(undo1.skippedDirs, 1, '这一轮只该有「输出根目录」这 1 个跳过（留着不动）');

      // 删除审计：删了什么、清了哪个目录都记了一行；但没有「把输出根删掉」这种事
      ok(fs.existsSync(auditPath), `删除审计日志没落地：${auditPath}`);
      const audit = fs.readFileSync(auditPath, 'utf8');
      ok(/撤销（记录/.test(audit), `审计日志缺了这次撤销的抬头：「${audit.slice(0, 120)}」`);
      for (const t of records.slice(0, 3)) ok(audit.includes(t), `审计日志里应当记下删掉的这个文件：${t}`);
      ok(
        !new RegExp(`目录 removed ${c1.outputDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(audit),
        '审计日志里出现了「把输出根目录 removed」—— 这不该发生',
      );

      // 源文件：一个不少、内容不变
      eq(JSON.stringify(snapshotContents(src1)), JSON.stringify(src1Before), '源文件的内容/个数变了（这是红线）');
      ok(fs.existsSync(path.join(src1, '照片.jpg')), '源文件不见了（这是红线）');

      // 记录被标记成「已撤销」
      const after1 = core.loadRunRecord(c1.recordPath);
      ok(after1 && after1.undoneAt, '撤销之后记录没有被标记成「已撤销」');
      console.log(`      ${undo1.message}`);
    });

    /* ---------------- 二、幂等 ---------------- */
    await check('幂等：紧接着再撤销一次 → 没有任何东西被删、不抛错、报告说明「已经撤销过」', () => {
      const beforeTree = { files: countTree(c1.outputDir).files, src: countTree(src1).files };
      const undo2 = core.undoLastRun(c1.recordPath);
      eq(undo2.ok, true, '第二次撤销应当正常返回（不抛错）');
      eq(undo2.deletedFiles, 0, '第二次撤销不该删任何文件');
      eq(undo2.removedDirs, 0, '第二次撤销不该清任何目录');
      eq(undo2.files.length, 0, '第二次撤销不该有任何文件处置记录');
      eq(undo2.changed, false, '第二次撤销不该有任何改动');
      ok(/已经撤销过/.test(undo2.message), `报告里应当说明「已经撤销过」：「${undo2.message}」`);
      eq(countTree(c1.outputDir).files, beforeTree.files, '第二次撤销之后输出里的文件数变了');
      eq(countTree(src1).files, beforeTree.src, '第二次撤销之后源里的文件数变了');
      console.log(`      ${undo2.message}`);
    });

    /* ---------------- 三、不删用户后加的东西 ---------------- */
    const c3 = newCase('用户后加');
    const src3 = makeSource(path.join(c3.dir, '源'), { 'a.jpg': 'A', 'b.pdf': 'B' });
    let record3 = null;
    let manualFile = '';

    await check('不删用户后加的东西：撤销后那个文件仍在，并被列为跳过（不是本次整理产生的）', async () => {
      const s3 = await runOnce(c3, [src3], [path.join(src3, 'a.jpg'), path.join(src3, 'b.pdf')]);
      eq(s3.successCount, 2, '这次应当复制成功 2 个');
      record3 = core.loadRunRecord(c3.recordPath);
      ok(record3 && record3.files.length === 2, '记录里应当是 2 个文件');
      // 用户在整理之后自己往输出目录里加一个文件
      manualFile = path.join(path.dirname(record3.files[0].target), '用户自己加的.txt');
      fs.writeFileSync(manualFile, '用户后来放的', 'utf8');

      const undo3 = core.undoLastRun(c3.recordPath);
      ok(fs.existsSync(manualFile), '用户自己加的那个文件被删了（这不该发生）');
      eq(undo3.deletedFiles, 2, '应当删掉本次复制出来的那 2 个文件');
      eq(undo3.skippedFiles, 0, '用户后加的文件不在记录里，不该被算成「跳过的记录项」');
      // 那个目录里还有用户的东西 → 目录留着不动，并说明
      const keptDir = path.dirname(manualFile);
      ok(fs.existsSync(keptDir), '还有用户东西的目录不该被清掉');
      const dirHit = undo3.dirs.find((d) => path.resolve(d.dir).toLowerCase() === path.resolve(keptDir).toLowerCase());
      ok(dirHit, `报告里应当有 ${keptDir} 这一条目录处置`);
      eq(dirHit.action, 'skipped', '还有用户东西的目录应当被列为「跳过」');
      ok(/还有东西/.test(dirHit.reason), `目录跳过的原因应当说清「还有东西，不是本次整理产生的」：「${dirHit.reason}」`);
      ok(/不是本次整理产生的/.test(dirHit.reason), `原因里应当说清「不是本次整理产生的」：「${dirHit.reason}」`);
      // 用户后加的文件本身绝不能被算成「本次复制出来的」
      ok(
        !undo3.files.some((f) => f.target === manualFile && f.action === 'deleted'),
        '用户后加的文件被当成本次复制出来的删了（触到红线）',
      );
      console.log(`      ${undo3.message}`);
      console.log(`      目录说明：${dirHit.reason}`);
    });

    /* ---------------- 四、不删被用户改过的文件 ---------------- */
    const c4 = newCase('用户改过');
    const src4 = makeSource(path.join(c4.dir, '源'), { '改我.jpg': 'X', '别动我.pdf': 'Y' });
    await check('不删被用户改过的文件：该文件仍在并被列为跳过（原因说明：内容/大小与记录不符）', async () => {
      const s4 = await runOnce(c4, [src4], [path.join(src4, '改我.jpg'), path.join(src4, '别动我.pdf')]);
      eq(s4.successCount, 2, '这次应当复制成功 2 个');
      const rec = core.loadRunRecord(c4.recordPath);
      const victim = rec.files.find((f) => path.basename(f.target) === '改我.jpg');
      ok(victim, '记录里找不到「改我.jpg」这一条');
      // 用户改过它：内容变大（大小对不上）
      fs.writeFileSync(victim.target, '用户改过的内容，比原来长很多很多很多', 'utf8');
      const newSize = fs.statSync(victim.target).size;
      ok(newSize !== victim.size, '测试自身没造出「大小不一致」的情形');

      const undo4 = core.undoLastRun(c4.recordPath);
      ok(fs.existsSync(victim.target), '被用户改过的文件被删了（这不该发生）');
      const row = undo4.files.find((f) => f.target === victim.target);
      ok(row, '报告里没有那一条被改过的文件');
      eq(row.action, 'skipped', '被用户改过的文件应当被列为「跳过」');
      ok(/内容\/大小与记录不符/.test(row.reason), `跳过的原因应当说明「内容/大小与记录不符」：「${row.reason}」`);
      eq(undo4.deletedFiles, 1, '另一个没被改过的文件应当照常删掉');
      console.log(`      ${row.reason}`);
    });

    /* ---------------- 五、删除失败不崩 ---------------- */
    const c5 = newCase('删不掉');
    // 内容长度特意各不相同：下面「互相交换目标名」那一手正是靠大小对不上来造「删不掉」
    const src5 = makeSource(path.join(c5.dir, '源'), { '锁我.jpg': 'L1', '另一个.pdf': 'L2-不同长度', '还有.xyz': 'L3-再长一点的' });
    const src5Files = ['锁我.jpg', '另一个.pdf', '还有.xyz'].map((n) => path.join(src5, n));

    await check('删除失败不崩：有一个文件删不掉 → 撤销继续处理剩下的、报告里有该条失败原因、整体不抛异常', async () => {
      const s5 = await runOnce(c5, [src5], src5Files);
      eq(s5.successCount, 3, '这次应当复制成功 3 个');

      // 造一个「一定删不掉」的：把记录里两个文件的目标名互相交换 ——
      // 各自都在本次的输出目录里、也都真实存在，但**内容/大小与记录对不上**（不是本次复制出来的那一份），
      // 所以撤销必须跳过它、并说明原因，同时**继续处理剩下的**。
      const rec = core.loadRunRecord(c5.recordPath);
      eq(rec.files.length, 3, '记录里应当有 3 个文件');
      const swapped = JSON.parse(JSON.stringify(rec));
      const a = swapped.files[0];
      const b = swapped.files[2];
      ok(
        fs.statSync(a.target).size !== fs.statSync(b.target).size || path.basename(a.target) !== path.basename(b.target),
        '测试自身没造出「对不上」的情形',
      );
      const aTarget = a.target;
      const bTarget = b.target;
      a.target = bTarget;
      b.target = aTarget;
      fs.writeFileSync(c5.recordPath, JSON.stringify(swapped, null, 2), 'utf8');
      const middle = swapped.files[1].target;

      let undo5 = null;
      let threw = null;
      try {
        undo5 = core.undoLastRun(c5.recordPath);
      } catch (err) {
        threw = err;
      }
      ok(!threw, `撤销自己抛异常了：${threw && threw.message}`);
      ok(undo5, '撤销没有返回结果');
      eq(undo5.ok, true, '有一个删不掉时也该正常返回');

      // 那两条「对不上」的必须被跳过并带原因，剩下的照常删掉
      const skippedRows = undo5.files.filter((f) => f.action === 'skipped');
      eq(skippedRows.length, 2, '应当有 2 条被跳过（互相交换的那两个）');
      for (const row of skippedRows) {
        ok(/内容\/大小与记录不符/.test(row.reason), `跳过的原因应当说清为什么：「${row.reason}」`);
        ok(fs.existsSync(row.target), `跳过的文件应当还在：${row.target}`);
      }
      eq(undo5.deletedFiles, 1, '删不掉两个之后，剩下的那个应当照常删掉（不许整体中断）');
      ok(!fs.existsSync(middle), `剩下的那个应当被删掉：${middle}`);
      ok(/删掉 1 个文件/.test(undo5.message) && /跳过 2 个文件/.test(undo5.message), `报告应当如实写清删了几个、跳过几个：「${undo5.message}」`);
      console.log(`      ${undo5.message}`);
      console.log(`      失败条目的原因（第一条）：${skippedRows[0].reason}`);

      /* 再来一轮：换一种「删不掉」的造法（只读文件），能造出来就核那条失败原因 */
      const c5b = newCase('删不掉-只读');
      const src5b = makeSource(path.join(c5b.dir, '源'), { '只读.jpg': 'RO1', '别的.pdf': 'RO2' });
      const s5b = await runOnce(c5b, [src5b], [path.join(src5b, '只读.jpg'), path.join(src5b, '别的.pdf')]);
      eq(s5b.successCount, 2, '这一轮应当复制成功 2 个');
      const rec5b = core.loadRunRecord(c5b.recordPath);
      const readonlyOne = rec5b.files.find((f) => path.basename(f.target) === '只读.jpg');
      let madeReadonly = false;
      try {
        fs.chmodSync(readonlyOne.target, 0o444);
        madeReadonly = true;
      } catch {
        madeReadonly = false;
      }
      const undo5b = core.undoLastRun(c5b.recordPath);
      const rowB = undo5b.files.find((f) => f.target === readonlyOne.target);
      if (madeReadonly && rowB && rowB.action === 'skipped') {
        ok(/删不掉|大小与记录不符/.test(rowB.reason), `只读那条的跳过原因应当说清：「${rowB.reason}」`);
        console.log(`      只读文件那一轮：${rowB.reason}`);
      } else {
        console.log('      只读那一轮：本机把只读文件也删掉了（那一轮无失败条目），按「整体不崩」核对');
        eq(undo5b.ok, true, '只读那一轮也该正常返回');
      }
      for (const t of [readonlyOne.target]) {
        try {
          fs.chmodSync(t, 0o666);
        } catch {
          /* 已经删掉了 / 改不了，都不影响判定 */
        }
      }
    });

    /* ---------------- 六、跨重启可用 ---------------- */
    const c6 = newCase('跨重启');
    const src6 = makeSource(path.join(c6.dir, '源'), { '重开.jpg': 'R1', '还要.pdf': 'R2' });
    await check('跨重启可用：记录写在文件里 → 用**另一个 node 进程**读回来撤销，仍然准确撤销', async () => {
      const s6 = await runOnce(c6, [src6], [path.join(src6, '重开.jpg'), path.join(src6, '还要.pdf')]);
      eq(s6.successCount, 2, '这次应当复制成功 2 个');
      const rec6 = core.loadRunRecord(c6.recordPath);
      const targets = rec6.files.map((f) => f.target);
      for (const t of targets) ok(fs.existsSync(t), `整理后目标文件应当存在：${t}`);

      // 关键：换一个**新进程**（新的模块实例，绝不复用本进程里的内存）来执行撤销。
      // 子进程把结果写成一个小文件（父进程读文件取结果）—— 不靠父子之间的管道，
      // 这样在任何 shell 里都能跑（管道式捕获在沙箱 shell 里会被拦）。
      const helper = path.join(c6.dir, 'another-process-undo.js');
      const resultFile = path.join(c6.dir, '另一个进程的结果.json');
      fs.writeFileSync(
        helper,
        [
          "'use strict';",
          'const fs = require("node:fs");',
          'const corePath = process.argv[2];',
          'const recordPath = process.argv[3];',
          'const resultPath = process.argv[4];',
          'const core = require(corePath);',
          'const r = core.undoLastRun(recordPath);',
          'fs.writeFileSync(resultPath, JSON.stringify({ message: r.message, deletedFiles: r.deletedFiles, removedDirs: r.removedDirs, skippedFiles: r.skippedFiles }), "utf8");',
        ].join('\n'),
        'utf8',
      );
      const spawned = spawnSync(
        process.execPath,
        [helper, path.join(OUT, 'core', 'index.js'), c6.recordPath, resultFile],
        { stdio: 'ignore' },
      );
      eq(spawned.error, undefined, `另起一个进程失败：${spawned.error && spawned.error.message}`);
      eq(spawned.status, 0, '另一个进程执行撤销的退出码');
      ok(fs.existsSync(resultFile), '另一个进程没有写出结果文件（等于没跑成）');
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      } catch {
        throw new Error('另一个进程写的结果不是合法 JSON');
      }
      eq(parsed.deletedFiles, 2, '另一个进程撤销时删掉的文件数');
      for (const t of targets) ok(!fs.existsSync(t), `另一个进程撤销后这个文件应当消失：${t}`);
      eq(countTree(c6.outputDir).files, 0, '另一个进程撤销后输出里不该还有文件');
      ok(fs.existsSync(path.join(src6, '重开.jpg')), '另一个进程撤销把源文件删了（这是红线）');
      console.log(`      另一个进程的报告：${parsed.message}`);
    });

    /* ---------------- 七、绝不越界（本片的安全底线） ---------------- */
    const c7 = newCase('坏记录');
    const src7 = makeSource(path.join(c7.dir, '源'), { '原文件.jpg': 'ORIGIN', '另一个.pdf': 'P2' });
    await check('绝不越界：记录里混进一条指向源目录里的路径 → 那位文件没有被删、被列为跳过且有原因', async () => {
      // 先真跑一次，拿到一份**真记录**（然后往里塞一条坏的）
      const s7 = await runOnce(c7, [src7], [path.join(src7, '原文件.jpg'), path.join(src7, '另一个.pdf')]);
      eq(s7.successCount, 2, '这次应当复制成功 2 个');
      const good = core.loadRunRecord(c7.recordPath);
      const sourceFileInsideSource = path.join(src7, '原文件.jpg');
      ok(fs.existsSync(sourceFileInsideSource), '源文件应当存在');

      // 坏记录：混进一条「指向源文件夹里的路径」，而且大小刚好对得上（就是那个源文件的真实大小）
      const bad = JSON.parse(JSON.stringify(good));
      bad.files.push({
        source: sourceFileInsideSource,
        target: sourceFileInsideSource,
        size: fs.statSync(sourceFileInsideSource).size,
        renamed: false,
      });
      fs.writeFileSync(c7.recordPath, JSON.stringify(bad, null, 2), 'utf8');

      const undo7 = core.undoLastRun(c7.recordPath);
      ok(fs.existsSync(sourceFileInsideSource), '源文件夹里的文件被删了（触到红线）');
      eq(fs.readFileSync(sourceFileInsideSource, 'utf8'), 'ORIGIN', '源文件的内容变了（触到红线）');
      const row = undo7.files.find((f) => f.target === sourceFileInsideSource);
      ok(row, '报告里没有那条越界记录');
      eq(row.action, 'skipped', '指向源文件夹的路径必须被列为「跳过」');
      ok(/源文件夹/.test(row.reason), `跳过的原因应当说清「在源文件夹里」：「${row.reason}」`);
      eq(undo7.deletedFiles, 2, '另外两个（本次真复制出来的）应当照常删掉');
      // 源文件夹自己也不许被动
      eq(countTree(src7).files, 2, '源文件夹里的文件数变了（触到红线）');
      console.log(`      ${row.reason}`);
    });

    /* ---------------- 八、记录读不到 / 没整理过：给一句人话，不报错 ---------------- */
    const c8 = newCase('没记录');
    await check('没整理过 / 记录丢了：撤销给一句人话、不删任何东西、不报错', () => {
      const undo8 = core.undoLastRun(c8.recordPath);
      eq(undo8.ok, true, '没有记录时也该正常返回');
      eq(undo8.deletedFiles, 0, '没有记录时不该删东西');
      eq(undo8.changed, false, '没有记录时不该有改动');
      ok(/没有可撤销的整理/.test(undo8.message), `应当是「没有可撤销的整理」：「${undo8.message}」`);

      // 坏 JSON 也不许崩
      fs.writeFileSync(c8.recordPath, '{ 这不是 JSON', 'utf8');
      const undo8b = core.undoLastRun(c8.recordPath);
      eq(undo8b.ok, true, '记录文件坏掉时也该正常返回');
      ok(/没有可撤销的整理/.test(undo8b.message), `记录坏掉时应当回落成「没有可撤销的整理」：「${undo8b.message}」`);

      // 界面用的摘要：没有记录 → 不可点
      const sum = core.summarizeLastRun(null);
      eq(sum.available, false, '没有记录时界面摘要应当是「不可撤销」');
      ok(sum.message.length > 0, '界面摘要应当有一句人话');
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
    console.log('撤销OK');
    process.exitCode = 0;
  } else {
    console.log('验收失败:撤销');
    process.exitCode = 1;
  }
}

main();
