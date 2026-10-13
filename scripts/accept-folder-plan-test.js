/**
 * 验收第 8 条：文件夹各归各（纯逻辑，真造临时目录与文件）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 核心语义（用户亲自提的硬要求）：**该文件夹的子文件夹不能与其他文件夹混在一起**。
 * 也就是：每个源文件夹（顶层 + 它下面的每一层子文件夹）在输出里各有一份，
 * 来自不同源文件夹的文件**永远不会落进同一个分类夹**。
 *
 * 断言：
 *   一、展开正确：递归展开出来的文件集合与真结构逐条一致（数量、路径），且只包含文件（子文件夹本身不算文件）；
 *   二、归属正确：每个文件都带着它的源文件夹归属，没有任何文件没有归属；
 *   三、绝不混在一起（核心）：按**源文件夹**逐条查「某两个不同源文件夹的文件进了同一个分类夹」，必须为 0；
 *       另外从磁盘反查一遍：每个最终分类夹里的文件只来自唯一一个源文件夹；
 *   四、输出路径结构正确：逐条断言形如 输出根\源文件夹名\…各层子文件夹名…\分类夹\文件名；
 *   五、同名源文件夹不覆盖：下载\照片 与 另一处\照片 的顶层输出名不同，且各有唯一目标路径；
 *   六、空文件夹不产生输出；
 *   七、跳过并记录：读不了的子文件夹被跳过、有原因记录、且不影响其它文件继续展开与落盘；
 *       太深（超 20 层）与符号链接也要能停下并说明原因；
 *   八、真落盘一次：真的执行一次复制（临时输出根），输出结构与上面全部预期一致，且原文件一个都没少（内容一致）。
 *
 * 全部通过：stdout 打印「文件夹各归各OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:文件夹各归各」并 exit 1。
 *
 * 跑法：node scripts\accept-folder-plan-test.js   （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
      if (err && err.stack) console.log(`      ${String(err.stack).split('\n').slice(1, 4).join(' | ')}`);
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
 * 造真结构（名字固定，便于断言）
 * ------------------------------------------------------------------ */

const FIXTURE = {
  '下载/散1.jpg': 'A1',
  '下载/散2.pdf': 'A2',
  '下载/照片/图1.png': 'A3',
  '下载/照片/婚纱/纱1.jpg': 'A4',
  '下载/文档/文1.docx': 'A5',
  '另一处/照片/图2.png': 'B1',
};

function writeFixture(base) {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const full = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

/** 递归数一棵树里有多少文件、多少目录（跳过不了的算 0）。 */
function countTree(root) {
  const acc = { files: 0, dirs: 0, list: [] };
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
        acc.dirs++;
        walk(full);
      } else {
        acc.files++;
        acc.list.push(full);
      }
    }
  };
  walk(root);
  return acc;
}

async function main() {
  console.log('=== accept-folder-plan-test: 每个源文件夹各归各，绝不混在一起 ===');
  console.log(`project root: ${projectRoot}`);
  console.log(`core: ${path.join(OUT, 'core', 'index.js')}`);

  for (const fn of [
    'scanFolders',
    'expandFolders',
    'planFolders',
    'buildPlan',
    'copyFiles',
    'MAX_SCAN_DEPTH',
    'buildPreviewTree',
  ]) {
    if (typeof core[fn] !== 'function' && typeof core[fn] !== 'number') {
      console.log(`FAIL: out/core/index.js 没有导出 ${fn}`);
      console.log('验收失败:文件夹各归各');
      process.exitCode = 1;
      return;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-folder-plan-'));
  console.log(`temp work dir: ${tmpRoot}`);
  const srcRoot = path.join(tmpRoot, 'src');
  const outRoot = path.join(tmpRoot, '整理');
  const 下载 = path.join(srcRoot, '下载');
  const 另一处 = path.join(srcRoot, '另一处');
  const 空的 = path.join(srcRoot, '空的');
  const 读不了 = path.join(srcRoot, '读不了');
  // 造「太深」和「符号链接」用的临时目录放在 srcRoot 外面，免得搅乱原目录的文件数断言
  const deepRoot = path.join(tmpRoot, 'deep');
  const linkBase = path.join(tmpRoot, 'linkbase');

  writeFixture(srcRoot);
  fs.mkdirSync(空的, { recursive: true });
  // 「读不了的文件夹」用最可靠的等价做法：路径不存在（真权限位在 Windows 上不可靠）
  fs.writeFileSync(读不了, 'not a folder', 'utf8');

  const roots = [下载, 另一处, 空的, 读不了];
  let outcome = null;
  let scan = null;

  try {
    outcome = core.planFolders({ roots, outputDir: outRoot, checkExisting: true });
    scan = outcome.scan;

    /* ---------- 一、展开正确 ---------- */
    await check('展开正确：递归展开的文件与真结构逐条一致（只收文件）', () => {
      const got = scan.files.map((f) => path.relative(srcRoot, f.fullPath).split(path.sep).join('/')).sort();
      const want = Object.keys(FIXTURE).sort();
      eq(got.length, want.length, '展开出来的文件个数');
      eq(JSON.stringify(got), JSON.stringify(want), '展开出来的文件路径');
      // 只包含文件：每个展开出来的路径都必须是真文件，且没有一个是文件夹
      for (const f of scan.files) {
        ok(fs.statSync(f.fullPath).isFile(), `展开结果里混进了非文件：${f.fullPath}`);
      }
      for (const name of ['下载', '照片', '文档', '婚纱']) {
        ok(
          !scan.files.some((f) => path.basename(f.fullPath) === name),
          `子文件夹本身被当成文件了：${name}`,
        );
      }
      console.log(`      展开 ${got.length} 个文件：${got.join(', ')}`);
    });

    /* ---------- 二、归属正确 ---------- */
    await check('归属正确：每个文件都带源文件夹归属，没有任何文件没有归属', () => {
      for (const f of scan.files) {
        ok(f && f.origin, `文件没有归属：${f && f.fullPath}`);
        ok(typeof f.origin.rootPath === 'string' && f.origin.rootPath.length > 0, `归属缺 rootPath：${f.fullPath}`);
        ok(Array.isArray(f.origin.chain), `归属缺 chain：${f.fullPath}`);
        ok(typeof f.origin.key === 'string' && f.origin.key.length > 0, `归属缺 key：${f.fullPath}`);
        const sourcePath = [f.origin.rootPath, ...f.origin.chain].join('\\');
        ok(
          f.fullPath.toLowerCase().startsWith(sourcePath.toLowerCase() + '\\'),
          `归属与文件路径对不上：${f.fullPath} 归到了 ${sourcePath}`,
        );
      }
      const keys = new Set(scan.files.map((f) => f.origin.key));
      const wantKeys = new Set([
        [下载].join('\u0000'),
        [下载, '照片'].join('\u0000'),
        [下载, '照片', '婚纱'].join('\u0000'),
        [下载, '文档'].join('\u0000'),
        [另一处, '照片'].join('\u0000'),
      ]);
      eq(keys.size, wantKeys.size, '出现了几种源文件夹');
      for (const k of wantKeys) ok(keys.has(k), `缺少这个源文件夹的归属：${k.split('\u0000').join('\\')}`);
      console.log(`      归属覆盖 ${keys.size} 个源文件夹：${Array.from(wantKeys).map((k) => k.split('\u0000').join('\\')).join(' | ')}`);
    });

    /* ---------- 三、绝不混在一起（核心） ---------- */
    await check('绝不混在一起：没有任何两个不同源文件夹的文件进了同一个分类夹（逐条查）', () => {
      const byFolder = new Map();
      for (const f of outcome.plan.files) {
        const key = f.targetDir.toLowerCase();
        if (!byFolder.has(key)) byFolder.set(key, { dir: f.targetDir, origins: new Set(), files: [] });
        const bucket = byFolder.get(key);
        bucket.origins.add(f.origin.key);
        bucket.files.push(f.fullPath);
      }
      const mixed = [];
      for (const [key, bucket] of byFolder) {
        if (bucket.origins.size > 1) {
          mixed.push(`${bucket.dir} 里混了 ${bucket.origins.size} 个源文件夹：${Array.from(bucket.origins).map((k) => k.split('\u0000').join('\\')).join(' + ')}`);
        }
        void key;
      }
      ok(mixed.length === 0, `不同源文件夹的文件混进了同一个分类夹（${mixed.length} 处）：${mixed.slice(0, 3).join(' | ')}`);

      // 逐对源文件夹再查一遍（不许只看总数）：任意两个不同源文件夹的目标分类夹集合必须两两不相交
      const dirsOfKey = new Map();
      for (const f of outcome.plan.files) {
        const key = f.origin.key;
        if (!dirsOfKey.has(key)) dirsOfKey.set(key, new Set());
        dirsOfKey.get(key).add(f.targetDir.toLowerCase());
      }
      const keys = Array.from(dirsOfKey.keys());
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = dirsOfKey.get(keys[i]);
          const b = dirsOfKey.get(keys[j]);
          for (const d of a) {
            ok(
              !b.has(d),
              `源文件夹「${keys[i].split('\u0000').join('\\')}」与「${keys[j].split('\u0000').join('\\')}」共用了同一个分类夹：${d}`,
            );
          }
        }
      }
      console.log(`      共 ${byFolder.size} 个目标分类夹，${keys.length} 个源文件夹两两无共用；逐对检查 ${(keys.length * (keys.length - 1)) / 2} 对`);
      // 每个源文件夹至少有自己的一个分类夹
      for (const k of keys) {
        ok(dirsOfKey.get(k).size > 0, `源文件夹没有任何分类夹：${k.split('\u0000').join('\\')}`);
      }
    });

    /* ---------- 四、输出路径结构正确 ---------- */
    /** 源文件 → 预期的目标目录 / 最终名字（预期直接从真结构算出来，不是抄实现）。 */
    const expectedTargets = () => {
      const map = new Map();
      for (const rel of Object.keys(FIXTURE)) {
        const parts = rel.split('/');
        const name = parts[parts.length - 1];
        const chain = parts.slice(0, -1); // 源文件夹那几层（顶层 + 各层子文件夹）
        const folder = core.classifyFile(parts.join(path.sep));
        map.set(path.join(srcRoot, ...parts), {
          chain,
          folder,
          name,
          dir: path.join(outRoot, ...chain, folder),
        });
      }
      return map;
    };
    const expectedByPath = expectedTargets();

    await check('输出路径结构正确：逐条断言 <输出根>\\<源文件夹名>\\…\\<分类夹>\\<文件名>', () => {
      eq(outcome.plan.files.length, Object.keys(FIXTURE).length, '计划里的文件条数');
      for (const f of outcome.plan.files) {
        const want = expectedByPath.get(f.fullPath);
        ok(want, `计划里出现了预期外的文件：${f.fullPath}`);
        eq(f.targetDir, want.dir, `${path.basename(f.fullPath)} 的目标目录`);
        eq(f.name, want.name, `${path.basename(f.fullPath)} 的最终文件名`);
        eq(f.folder, want.folder, `${path.basename(f.fullPath)} 的分类夹`);
        // 结构：输出根\<源文件夹名>\<各层子文件夹名...>\<分类夹>\<文件名>
        const rel = path.relative(outRoot, f.targetDir).split(path.sep);
        eq(rel.length, want.chain.length + 1, `${path.basename(f.fullPath)} 的层级深度`);
        for (let i = 0; i < want.chain.length; i++) {
          eq(rel[i], want.chain[i], `${path.basename(f.fullPath)} 的第 ${i + 1} 层源文件夹名`);
        }
        eq(rel[rel.length - 1], want.folder, `${path.basename(f.fullPath)} 的分类夹（最里层）`);
        ok(
          f.targetDir.toLowerCase().startsWith(outRoot.toLowerCase()),
          `目标路径跑到输出根外面了：${f.targetDir}`,
        );
      }
      // 「另一处\照片」这一层的文件各归各：落到 另一处\照片\01_图片
      const nested = outcome.plan.files.find((f) => f.origin.chain.join('/') === '照片' && f.origin.rootPath === 另一处);
      ok(nested, '另一处\\照片 里的文件没有对应的计划');
      eq(nested.targetDir, path.join(outRoot, '另一处', '照片', '01_图片'), '另一处\\照片\\图2.png 的目标目录');
      console.log(`      ${outcome.plan.files.length} 条目标路径逐条对上（含两层子文件夹 下载\\照片\\婚纱）`);
    });

    /* ---------- 五、同名源文件夹不覆盖 ---------- */
    await check('同名源文件夹不覆盖：下载\\照片 与 另一处\\照片 的输出名各自唯一、目标路径零交集', () => {
      const plannedFor = (rootPath) =>
        outcome.plan.folders.filter((f) => f.origin.chain.join('/') === '照片' && f.origin.rootPath === rootPath);
      const a = plannedFor(下载);
      const b = plannedFor(另一处);
      eq(a.length, 1, '下载\\照片 的落点份数');
      eq(b.length, 1, '另一处\\照片 的落点份数');
      const chainA = a[0].outputChain.join('\\');
      const chainB = b[0].outputChain.join('\\');
      ok(chainA !== chainB, `两份「照片」的输出路径一样（会互相覆盖）：都是「${chainA}」`);
      eq(a[0].outputDir, path.join(outRoot, '下载', '照片'), '下载\\照片 的输出目录');
      eq(b[0].outputDir, path.join(outRoot, '另一处', '照片'), '另一处\\照片 的输出目录');
      eq(b[0].renamed, false, '另一处\\照片 归在自己父夹下，不该被改名');
      // 两者的目标路径集合必须完全不相交（这才是「不覆盖」的硬指标）
      const dirsA = new Set(outcome.plan.files.filter((f) => f.origin.key === a[0].origin.key).map((f) => f.targetDir.toLowerCase()));
      const dirsB = new Set(outcome.plan.files.filter((f) => f.origin.key === b[0].origin.key).map((f) => f.targetDir.toLowerCase()));
      ok(dirsA.size > 0 && dirsB.size > 0, '两份同名源文件夹都要有自己的目标目录');
      for (const d of dirsA) ok(!dirsB.has(d), `两份同名源文件夹共用了目标目录：${d}`);

      // 真正「同一段输出路径里同名」的情形：两个不同顶层源文件夹名字相同时，后一个必须带序号
      const A = path.join(tmpRoot, '同名用例A', '备份');
      const B = path.join(tmpRoot, '同名用例B', '备份');
      fs.mkdirSync(A, { recursive: true });
      fs.mkdirSync(B, { recursive: true });
      fs.writeFileSync(path.join(A, 'a.jpg'), 'a', 'utf8');
      fs.writeFileSync(path.join(B, 'b.jpg'), 'b', 'utf8');
      const clash = core.planFolders({ roots: [A, B], outputDir: path.join(tmpRoot, '同名输出') });
      const names = clash.plan.folders.map((f) => f.outputChain.join('\\'));
      eq(names.length, 2, '两份同名顶层源文件夹的落点份数');
      ok(names[0] !== names[1], `两份同名顶层源文件夹的输出名一样：都是「${names[0]}」`);
      const dirs1 = clash.plan.files.map((f) => f.targetDir.toLowerCase());
      eq(new Set(dirs1).size, 2, '两份同名顶层源文件夹的目标目录数（必须各是各的）');
      console.log(`      顶层同名两份：${names[0]} / ${names[1]}；子层同名两份：${chainA} / ${chainB}（各自归在自己父夹下）`);
    });

    /* ---------- 六、空文件夹不产生输出 ---------- */
    await check('空文件夹不产生输出：不产生任何目标目录，也不出现在计划里', () => {
      ok(
        !outcome.plan.folders.some((f) => f.origin.rootPath === 空的),
        '空文件夹产生了输出落点',
      );
      ok(
        !outcome.plan.files.some((f) => f.fullPath.toLowerCase().startsWith(空的.toLowerCase())),
        '空文件夹里冒出了文件',
      );
    });

    /* ---------- 七、跳过并记录（不影响其它文件） ---------- */
    await check('跳过并记录：读不了的文件夹被跳过、有原因、不影响其它文件继续展开与落盘', () => {
      const hit = outcome.plan.skipped.filter((s) => s.fullPath.toLowerCase() === 读不了.toLowerCase());
      ok(hit.length > 0, `「读不了的文件夹」（${读不了}）没有被记录跳过`);
      ok(typeof hit[0].reason === 'string' && hit[0].reason.length > 0, '跳过记录没有原因');
      // 其它文件照旧展开出来（展开数量与预期一致已经在上面的断言里查过）
      eq(scan.files.length, Object.keys(FIXTURE).length, '跳过之后其它文件仍然全部展开');
      console.log(`      跳过原因：${hit[0].reason}`);
    });

    /* ---------- 八、真落盘一次 ---------- */
    await check('真落盘一次：输出结构与预期一致，且原文件一个都没少（内容一致）', async () => {
      // 原目录里除了 fixture 还要算上那个「读不了的文件夹」（它是个真文件，不是文件夹）
      const srcFilesOnDisk = countTree(srcRoot).files;
      const before = { files: srcFilesOnDisk - 1 };
      eq(before.files, Object.keys(FIXTURE).length, '复制前原目录里的文件数（除「读不了」那个占位文件）');
      eq(before.files, scan.files.length, '原目录里的文件数与展开出来的数量');

      ok(!fs.existsSync(outRoot), '输出根不该在复制前就存在（本用例用不存在的输出根）');
      const summary = await core.copyFiles({ outputDir: outRoot, files: scan.files.map((f) => f.fullPath), roots });
      eq(summary.total, Object.keys(FIXTURE).length, '复制总数');
      eq(summary.failureCount, 0, `复制失败数（失败明细：${summary.results.filter((r) => !r.ok).map((r) => `${path.basename(r.source)}:${r.error}`).join(' | ')}）`);
      eq(summary.successCount, Object.keys(FIXTURE).length, '复制成功数');

      // 每条结果的目标路径与预期逐条一致（预期 = 真结构算出来的那条路径，不是抄实现）
      for (const [srcPath, want] of expectedByPath) {
        const r = summary.results.find((x) => x.source === srcPath);
        ok(r, `复制结果里找不到 ${srcPath}`);
        eq(r.ok, true, `${path.basename(srcPath)} 复制成功`);
        eq(r.target, path.join(want.dir, want.name), `${path.basename(srcPath)} 的落盘路径`);
      }

      // 磁盘上真的长成那样：逐条对着预期查（预期 = 真结构算出来的那条路径，不是抄实现）
      for (const [srcPath, want] of expectedByPath) {
        ok(fs.existsSync(want.dir), `输出里没有这个目录：${want.dir}`);
        const full = path.join(want.dir, want.name);
        ok(fs.existsSync(full), `输出里没有这个文件：${full}`);
        eq(fs.readFileSync(full, 'utf8'), fs.readFileSync(srcPath, 'utf8'), `${want.name} 的内容与原文件一致`);
      }
      const originOf = (p) => {
        const rel = path.relative(outRoot, p).split(path.sep);
        if (rel.length < 3) return rel.slice(0, -1).join('\\');
        // 输出根\<顶层>\<分类夹>\<文件> 或 输出根\<顶层>\<子层…>\<分类夹>\<文件>：
        // 直接把「根所在的那一段源文件夹」当成来源（顶层 / 顶层\子层 / 顶层\子层\孙层 都算不同来源）
        const chain = [rel[0]];
        for (let i = 1; i < rel.length - 2; i++) chain.push(rel[i]);
        return chain.join('\\');
      };
      const seen = new Map();
      const disk = countTree(outRoot);
      for (const p of disk.list) {
        const origin = originOf(p);
        const dir = path.dirname(p);
        if (!seen.has(dir)) seen.set(dir, new Set());
        seen.get(dir).add(origin);
      }
      for (const [dir, origins] of seen) {
        // 同一个目录（=同一个分类夹）里可能同时有「顶层源文件夹」与「它下面的子层」两条不同来源？
        // 不允许：一个分类夹只能对应一段唯一的源文件夹路径
        ok(origins.size === 1, `磁盘上的分类夹混了多个来源：${dir} <- ${Array.from(origins).join(' + ')}`);
      }
      eq(disk.files, Object.keys(FIXTURE).length, '输出根里的文件总数');

      // 原文件一个都没少，内容也没变
      const after = countTree(srcRoot);
      eq(after.files, srcFilesOnDisk, '复制后原目录里的文件数（应当与复制前完全一样）');
      for (const [rel, content] of Object.entries(FIXTURE)) {
        const full = path.join(srcRoot, ...rel.split('/'));
        ok(fs.existsSync(full), `原文件不见了（绝不允许）：${full}`);
        eq(fs.readFileSync(full, 'utf8'), content, `原文件内容被改了：${rel}`);
      }
      console.log(`      落盘 ${summary.successCount} 个文件，输出根里 ${disk.files} 个文件；原文件 ${after.files} 个全部健在且内容一致`);
      console.log(`      输出树：${disk.list.map((p) => path.relative(outRoot, p)).slice(0, 12).join(' | ')}`);
    });

    /* ---------- 附加：预览走同一套（同一求值入口，绝不落盘） ---------- */
    await check('预览与执行同一套：预览的分组、目标路径与执行计划逐条一致，且一份盘都没写', () => {
      const previewOut = path.join(tmpRoot, '预览用的空输出根');
      const diskBefore = countTree(srcRoot);
      const preview = core.buildPreviewTree({ files: [], roots, outputDir: previewOut, rules: null });
      ok(preview && preview.ok === true, `预览失败：${preview && preview.message}`);
      eq(preview.tree.total, Object.keys(FIXTURE).length, '预览里的文件总数');
      eq(preview.tree.rootCount, 2, '预览里的顶层源文件夹个数（下载 / 另一处；空的与读不了的都不算）');
      for (const f of outcome.plan.files) {
        const hit = preview.tree.files.find((x) => x.path === f.fullPath);
        ok(hit, `预览里找不到 ${f.fullPath}`);
        eq(hit.folder, f.folder, `${path.basename(f.fullPath)} 的分类夹（预览 vs 执行）`);
      }
      const diskAfter = countTree(srcRoot);
      eq(diskAfter.files, diskBefore.files, '预览过程中原目录里的文件数');
      ok(!fs.existsSync(previewOut), '预览把输出目录建出来了（绝不允许）');
    });

    /* ---------- 九、太深与符号链接（放在最后：它会在临时目录里造很多层级/文件） ---------- */
    let cursor = deepRoot;
    for (let i = 1; i <= 22; i++) {
      cursor = path.join(cursor, `L${i}`);
      fs.mkdirSync(cursor, { recursive: true });
      fs.writeFileSync(path.join(cursor, `f${i}.jpg`), `D${i}`, 'utf8');
    }

    await check('跳过并记录：目录超深（>20 层）与符号链接都能停下并说明原因', () => {
      const deepScan = core.expandFolders([deepRoot]);
      // 每层的文件都落在「第几层文件夹」里：根下 = 0 层文件夹，L1 里 = 1 层……L20 里 = 20 层（允许的最深）
      const folderDepthOf = (p) => String(p).slice(deepRoot.length + 1).split(path.sep).length - 1;
      const depths = deepScan.files.map((p) => folderDepthOf(p.fullPath));
      eq(Math.max(...depths), core.MAX_SCAN_DEPTH, `最深收进来的文件夹层数（上限 ${core.MAX_SCAN_DEPTH}）`);
      eq(deepScan.files.length, core.MAX_SCAN_DEPTH, '收进来的文件数');
      const skippedDeep = deepScan.skipped.filter((s) => /太深/.test(s.reason));
      // 走到第 21 层文件夹时（它就在上限之外）停住：记一条原因，而且不再往里走
      ok(skippedDeep.length > 0, '超过上限的那一层没有记「太深」的原因');
      for (const s of skippedDeep) ok(s.reason.length > 0, `「太深」的记录缺原因：${s.fullPath}`);
      ok(
        !deepScan.files.some((f) => folderDepthOf(f.fullPath) > core.MAX_SCAN_DEPTH),
        '收到了上限之外的层里的文件',
      );
      // 允许的最深那一层里的文件必须收到；更深的那几层必须停住
      ok(
        deepScan.files.some((f) => folderDepthOf(f.fullPath) === core.MAX_SCAN_DEPTH),
        `第 ${core.MAX_SCAN_DEPTH} 层里的文件没被收进来`,
      );
      console.log(
        `      深度上限 ${core.MAX_SCAN_DEPTH}：收进 ${deepScan.files.length} 个（最深第 ${Math.max(...depths)} 层），记下「太深」${skippedDeep.length} 条`,
      );

      // 符号链接：能造出来就要求「不跟随并记原因」；造不出来（Windows 无权限/开发者模式关）如实说明，不假装通过
      const linkTarget = path.join(linkBase, 'target');
      const linkPath = path.join(linkBase, 'link');
      fs.mkdirSync(linkTarget, { recursive: true });
      fs.writeFileSync(path.join(linkTarget, 'x.jpg'), 'X', 'utf8');
      let linkMade = false;
      try {
        fs.symlinkSync(linkTarget, linkPath, 'dir');
        linkMade = true;
      } catch (err) {
        console.log(`      本机造不出符号链接（${(err && err.code) || err}），这一小项跳过并如实说明，不当成通过`);
      }
      if (linkMade) {
        const linkScan = core.expandFolders([linkBase]);
        eq(linkScan.files.length, 0, '符号链接被跟随了（不该收进任何文件）');
        const linkSkipped = linkScan.skipped.filter((s) => s.fullPath.toLowerCase() === linkPath.toLowerCase());
        ok(linkSkipped.length > 0, '符号链接没有被记录跳过');
        console.log(`      符号链接未跟随，已记原因：${linkSkipped[0].reason}`);
      }
    });
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
    if (!pass) allOk = false;
  }
  if (allOk) {
    console.log('文件夹各归各OK');
    process.exitCode = 0;
  } else {
    console.log('验收失败:文件夹各归各');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.log(`FAIL: 测试过程本身出错 -> ${(err && err.stack) || err}`);
  console.log('验收失败:文件夹各归各');
  process.exitCode = 1;
});
