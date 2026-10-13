/**
 * 验收第 8 条：文件夹各归各（纯逻辑，真造临时目录与文件）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 本片的语义是**文件夹优先**（用户拍板）：
 *  1. 子文件夹里的文件**按原样保留相对路径**（`下载\照片\风景\a.jpg` → `<输出根>\下载\照片\风景\a.jpg`），不再按规则重分；
 *  2. **只有散在某个源文件夹自己那层根下的文件**才按规则分类（`下载\散1.jpg` → `<输出根>\下载\<规则算出的分类夹>\散1.jpg`）；
 *  3. 绝不混在一起：来自不同源文件夹的文件永远不会出现在同一个输出目录里；
 *  4. 同名不相撞：同段输出路径里同名的文件夹加序号（`备份`、`备份 (2)`）。
 *
 * 断言：
 *   一、展开正确：递归展开出来的文件与真结构逐条一致，且只包含文件；
 *   二、归属正确：每个文件都带着源文件夹归属，没有任何文件缺归属；
 *   三、原样保留（新语义核心之一）：子文件夹里的文件目标路径 = 输出根 + 原相对路径，没有被塞进任何分类夹；
 *   四、散文件按规则（新语义核心之二）：源文件夹根下的散文件进「规则现算出来的分类夹」；
 *   五、绝不混在一起：按源文件夹逐条查，任意两个不同源文件夹的文件都不在同一个输出目录里；
 *   六、同名子文件夹独立：下载\照片 与 另一处\照片 各自的目标路径互不相同且都唯一；
 *   七、同名顶层文件夹加序号：两个不同路径、同名的顶层文件夹 → 输出根下两个名字不同、各自唯一；
 *   八、空文件夹不产生输出；读不了的文件夹被跳过、有原因、不影响其它文件；
 *   九、真落盘一次：输出结构与上面全部预期一致，且原目录里的文件一个都没少。
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

/** 递归数一棵树里有多少文件、多少目录。 */
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
  console.log('=== accept-folder-plan-test: 文件夹优先（子文件夹原样保留 / 散文件按规则） ===');
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
    'FOLDER_KEEP_HINT',
  ]) {
    if (core[fn] === undefined) {
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
  // 造「太深」用的树放在 srcRoot 外面，免得搅乱原目录的文件数断言
  const deepRoot = path.join(tmpRoot, 'deep');

  writeFixture(srcRoot);
  fs.mkdirSync(空的, { recursive: true });
  // 「读不了的文件夹」用最可靠的等价做法：这个路径根本不是文件夹（真权限位在 Windows 上不可靠）
  fs.writeFileSync(读不了, 'not a folder', 'utf8');

  const roots = [下载, 另一处, 空的, 读不了];
  let outcome = null;
  let scan = null;

  /** 源文件 → 预期目标（预期从真结构 + 规则现算，不抄实现）。 */
  const expectedOf = () => {
    const map = new Map();
    for (const rel of Object.keys(FIXTURE)) {
      const parts = rel.split('/');
      const name = parts[parts.length - 1];
      const dirParts = parts.slice(0, -1);
      // 只有「源文件夹自己那层根下」的散文件才进分类夹；其余原样保留
      const isLoose = dirParts.length === 1;
      const category = isLoose ? core.classifyFile(parts.join(path.sep)) : null;
      const outParts = isLoose ? dirParts.concat([category]) : dirParts;
      map.set(path.join(srcRoot, ...parts), {
        sourceRel: parts.join('\\'),
        loose: isLoose,
        category,
        targetDir: path.join(outRoot, ...outParts),
        name,
      });
    }
    return map;
  };
  const expected = expectedOf();

  try {
    outcome = core.planFolders({ roots, outputDir: outRoot, rules: null });
    scan = outcome.scan;

    /* ---------- 一、展开正确 ---------- */
    await check('展开正确：递归展开出来的文件与真结构逐条一致（只收文件）', () => {
      const got = scan.files.map((f) => path.relative(srcRoot, f.fullPath).split(path.sep).join('/')).sort();
      const want = Object.keys(FIXTURE).sort();
      eq(got.length, want.length, '展开出来的文件个数');
      eq(JSON.stringify(got), JSON.stringify(want), '展开出来的文件路径');
      for (const f of scan.files) {
        ok(fs.statSync(f.fullPath).isFile(), `展开结果里混进了非文件：${f.fullPath}`);
      }
      for (const name of ['下载', '照片', '文档', '婚纱']) {
        ok(!scan.files.some((f) => path.basename(f.fullPath) === name), `子文件夹本身被当成文件了：${name}`);
      }
      console.log(`      展开 ${got.length} 个文件：${got.join(', ')}`);
    });

    /* ---------- 二、归属正确 ---------- */
    await check('归属正确：每个文件都带源文件夹归属，没有任何文件缺归属', () => {
      for (const f of scan.files) {
        ok(f && f.origin, `文件没有归属：${f && f.fullPath}`);
        ok(typeof f.origin.rootPath === 'string' && f.origin.rootPath.length > 0, `归属缺 rootPath：${f.fullPath}`);
        ok(Array.isArray(f.origin.chain), `归属缺 chain：${f.fullPath}`);
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
      console.log(`      归属覆盖 ${keys.size} 个源文件夹`);
    });

    /* ---------- 三、原样保留（新语义核心之一） ---------- */
    await check('原样保留：子文件夹里的文件目标路径 = 输出根 + 原相对路径，没进任何分类夹', () => {
      const kept = outcome.plan.files.filter((f) => f.placement === 'keep');
      eq(kept.length, 4, '原样保留的文件个数（文档/文1.docx、照片/图1.png、照片/婚纱/纱1.jpg、另一处/照片/图2.png）');
      for (const f of kept) {
        const want = expected.get(f.fullPath);
        ok(want && !want.loose, `原样保留的名单不对：${f.fullPath}`);
        eq(f.targetDir, want.targetDir, `${want.sourceRel} 的目标目录`);
        eq(f.name, want.name, `${want.sourceRel} 的目标文件名`);
        eq(f.category, null, `${want.sourceRel} 不该有分类夹`);
        const rel = path.relative(outRoot, path.join(f.targetDir, f.name)).split(path.sep).join('\\');
        eq(rel, want.sourceRel, `${want.sourceRel} 在输出里的相对路径（必须原样）`);
        ok(!/\\0[1-5]_/.test(path.join(f.targetDir, f.name)), `${want.sourceRel} 被塞进了分类夹：${f.targetDir}`);
      }
      // 单独点名两条（控制台明确要求）
      const 纱1 = outcome.plan.files.find((f) => path.basename(f.fullPath) === '纱1.jpg');
      eq(纱1.targetDir, path.join(outRoot, '下载', '照片', '婚纱'), '下载\\照片\\婚纱\\纱1.jpg 的目标目录');
      const 图2 = outcome.plan.files.find((f) => path.basename(f.fullPath) === '图2.png');
      eq(图2.targetDir, path.join(outRoot, '另一处', '照片'), '另一处\\照片\\图2.png 的目标目录');
      console.log(`      4 个原样保留：${kept.map((f) => path.relative(outRoot, path.join(f.targetDir, f.name))).join(' | ')}`);
    });

    /* ---------- 四、散文件按规则（新语义核心之二） ---------- */
    await check('散文件按规则：源文件夹自己那层根下的散文件进「规则现算出来的分类夹」', () => {
      const loose = outcome.plan.files.filter((f) => f.placement === 'classify');
      eq(loose.length, 2, '按规则分类的散文件个数（下载 根下的 散1.jpg、散2.pdf）');
      for (const f of loose) {
        const want = expected.get(f.fullPath);
        ok(want && want.loose, `按规则分类的名单不对：${f.fullPath}`);
        ok(want.category !== null && want.category.length > 0, `规则没算出分类夹：${want.sourceRel}`);
        eq(f.category, want.category, `${want.sourceRel} 的分类夹（规则算出来的）`);
        eq(f.targetDir, path.join(outRoot, '下载', want.category), `${want.sourceRel} 的目标目录`);
        eq(f.name, want.name, `${want.sourceRel} 的目标文件名`);
        // 分类夹名必须来自规则模块，不许写死
        eq(f.category, core.classifyFile(path.relative(srcRoot, f.fullPath)), `${want.sourceRel} 的分类夹应与规则求值一致`);
      }
      const 散1 = outcome.plan.files.find((f) => path.basename(f.fullPath) === '散1.jpg');
      eq(散1.category, core.classifyFile(path.join('下载', '散1.jpg')), '散1.jpg 的分类夹（按规则现算）');
      eq(散1.targetDir, path.join(outRoot, '下载', 散1.category), '散1.jpg 的目标目录');
      console.log(`      散文件 ${loose.length} 个按规则分类（分类夹名由规则现算：${loose.map((f) => f.category).join('/')}）`);
    });

    /* ---------- 五、绝不混在一起 ---------- */
    await check('绝不混在一起：任意两个不同源文件夹的文件都不在同一个输出目录里（逐条查）', () => {
      const byDir = new Map();
      for (const f of outcome.plan.files) {
        const key = f.targetDir.toLowerCase();
        if (!byDir.has(key)) byDir.set(key, { dir: f.targetDir, origins: new Set(), files: [] });
        byDir.get(key).origins.add(f.origin.key);
        byDir.get(key).files.push(f.fullPath);
      }
      const mixed = [];
      for (const [, bucket] of byDir) {
        if (bucket.origins.size > 1) mixed.push(`${bucket.dir} 里混了 ${bucket.origins.size} 个源文件夹`);
      }
      ok(mixed.length === 0, `不同源文件夹的文件混进了同一个输出目录（${mixed.length} 处）：${mixed.slice(0, 3).join(' | ')}`);

      // 逐对源文件夹再查一遍（不许只看总数）
      const dirsOfKey = new Map();
      for (const f of outcome.plan.files) {
        if (!dirsOfKey.has(f.origin.key)) dirsOfKey.set(f.origin.key, new Set());
        dirsOfKey.get(f.origin.key).add(f.targetDir.toLowerCase());
      }
      const keys = Array.from(dirsOfKey.keys());
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = dirsOfKey.get(keys[i]);
          const b = dirsOfKey.get(keys[j]);
          for (const d of a) {
            ok(
              !b.has(d),
              `源文件夹「${keys[i].split('\u0000').join('\\')}」与「${keys[j].split('\u0000').join('\\')}」共用了同一个目录：${d}`,
            );
          }
        }
      }
      console.log(`      共 ${byDir.size} 个输出目录，${keys.length} 个源文件夹两两无共用；逐对检查 ${(keys.length * (keys.length - 1)) / 2} 对`);
    });

    /* ---------- 六、同名子文件夹独立 ---------- */
    await check('同名子文件夹独立：下载\\照片 与 另一处\\照片 各自的目标路径互不相同且都唯一', () => {
      const dirOf = (rel) => {
        const f = outcome.plan.files.find((x) => path.relative(srcRoot, x.fullPath).split(path.sep).join('\\') === rel);
        ok(f, `计划里找不到 ${rel}`);
        return f.targetDir;
      };
      const a = dirOf('下载\\照片\\图1.png');
      const b = dirOf('另一处\\照片\\图2.png');
      eq(a, path.join(outRoot, '下载', '照片'), '下载\\照片 的目标目录');
      eq(b, path.join(outRoot, '另一处', '照片'), '另一处\\照片 的目标目录');
      ok(a.toLowerCase() !== b.toLowerCase(), `两份「照片」的目标目录撞上了：${a}`);
      console.log(`      同名子文件夹各待在各的父层下：${a} / ${b}`);
    });

    /* ---------- 七、同名顶层文件夹加序号 ---------- */
    await check('同名顶层文件夹加序号：两个同名顶层文件夹的输出名不同、各自唯一', () => {
      const A = path.join(tmpRoot, '同名用例A', '备份');
      const B = path.join(tmpRoot, '同名用例B', '备份');
      fs.mkdirSync(A, { recursive: true });
      fs.mkdirSync(B, { recursive: true });
      fs.writeFileSync(path.join(A, 'a.jpg'), 'a', 'utf8');
      fs.writeFileSync(path.join(B, 'b.jpg'), 'b', 'utf8');
      const clash = core.planFolders({ roots: [A, B], outputDir: path.join(tmpRoot, '同名输出'), rules: null });
      eq(clash.plan.roots.length, 2, '两份同名顶层文件夹的落点数');
      const names = clash.plan.roots.map((r) => r.outputName);
      ok(names[0] !== names[1], `两份同名顶层文件夹的输出名一样：都是「${names[0]}」`);
      ok(/\(2\)$/.test(names[1]), `后一个没有带序号：「${names[1]}」`);
      const dirs = clash.plan.files.map((f) => f.targetDir.toLowerCase());
      eq(new Set(dirs).size, 2, '两份同名顶层文件夹的目标目录数（必须各是各的）');
      console.log(`      顶层同名两份：${names[0]} / ${names[1]}`);
    });

    /* ---------- 八、空文件夹 + 跳过并记录 ---------- */
    await check('空文件夹不产生输出：不产生任何目标目录，也不出现在计划里', () => {
      ok(!outcome.plan.roots.some((r) => r.origin.rootPath === 空的), '空文件夹产生了输出落点');
      ok(!outcome.plan.files.some((f) => f.fullPath.toLowerCase().startsWith(空的.toLowerCase())), '空文件夹里冒出了文件');
    });

    await check('跳过并记录：读不了的文件夹被跳过、有原因、不影响其它文件继续展开与落盘', () => {
      const hit = outcome.plan.skipped.filter((s) => s.fullPath.toLowerCase() === 读不了.toLowerCase());
      ok(hit.length > 0, `「读不了的文件夹」（${读不了}）没有被记录跳过`);
      ok(typeof hit[0].reason === 'string' && hit[0].reason.length > 0, '跳过记录没有原因');
      eq(scan.files.length, Object.keys(FIXTURE).length, '跳过之后其它文件仍然全部展开');
      console.log(`      跳过原因：${hit[0].reason}`);
    });

    /* ---------- 九、真落盘一次 ---------- */
    await check('真落盘一次：输出结构与预期一致，且原目录里的文件一个都没少（内容一致）', async () => {
      const srcFilesOnDisk = countTree(srcRoot).files;
      eq(srcFilesOnDisk - 1, Object.keys(FIXTURE).length, '复制前原目录里的文件数（除「读不了」那个占位文件）');
      eq(scan.files.length, Object.keys(FIXTURE).length, '展开出来的文件数与原目录一致');
      ok(!fs.existsSync(outRoot), '输出根不该在复制前就存在（本用例用不存在的输出根）');

      const summary = await core.copyFiles({ outputDir: outRoot, files: scan.files.map((f) => f.fullPath), roots });
      eq(summary.total, Object.keys(FIXTURE).length, '复制总数');
      eq(
        summary.failureCount,
        0,
        `复制失败数（失败明细：${summary.results
          .filter((r) => !r.ok)
          .map((r) => `${path.basename(r.source)}:${r.error}`)
          .join(' | ')}）`,
      );

      // 每条结果的目标路径与预期逐条一致
      for (const [srcPath, want] of expected) {
        const r = summary.results.find((x) => x.source === srcPath);
        ok(r, `复制结果里找不到 ${srcPath}`);
        eq(r.ok, true, `${want.sourceRel} 复制成功`);
        eq(r.target, path.join(want.targetDir, want.name), `${want.sourceRel} 的落盘路径`);
      }

      // 磁盘上真的长成那样：逐条对着预期查
      for (const [srcPath, want] of expected) {
        ok(fs.existsSync(want.targetDir), `输出里没有这个目录：${want.targetDir}`);
        const full = path.join(want.targetDir, want.name);
        ok(fs.existsSync(full), `输出里没有这个文件：${full}`);
        eq(fs.readFileSync(full, 'utf8'), fs.readFileSync(srcPath, 'utf8'), `${want.name} 的内容与原文件一致`);
      }

      // 没混：从磁盘反查每个最终目录里的文件只来自唯一一个源文件夹
      const disk = countTree(outRoot);
      const originOfFile = (filePath) => {
        const rel = path.relative(outRoot, filePath).split(path.sep);
        const dirs = rel.slice(0, -1);
        // 如果最里层是「分类夹」（形如 0N_名字），去掉它 —— 剩下的就是源文件夹那几层
        if (dirs.length > 0 && /^0[1-9]_/.test(dirs[dirs.length - 1])) dirs.pop();
        return dirs.join('\\');
      };
      const seen = new Map();
      for (const p of disk.list) {
        const dir = path.dirname(p);
        if (!seen.has(dir)) seen.set(dir, new Set());
        seen.get(dir).add(originOfFile(p));
      }
      for (const [dir, origins] of seen) {
        ok(origins.size === 1, `磁盘上的目录混了多个来源：${dir} <- ${Array.from(origins).join(' + ')}`);
      }
      eq(disk.files, Object.keys(FIXTURE).length, '输出根里的文件总数');

      // 原目录里的文件一个都没少、内容也没变
      const after = countTree(srcRoot);
      eq(after.files, srcFilesOnDisk, '复制后原目录里的文件数（应当与复制前完全一样）');
      for (const [rel, content] of Object.entries(FIXTURE)) {
        const full = path.join(srcRoot, ...rel.split('/'));
        ok(fs.existsSync(full), `原文件不见了（绝不允许）：${full}`);
        eq(fs.readFileSync(full, 'utf8'), content, `原文件内容被改了：${rel}`);
      }
      console.log(`      落盘 ${summary.successCount} 个文件；原文件 ${after.files} 个全部健在且内容一致`);
      console.log(`      输出树：${disk.list.map((p) => path.relative(outRoot, p)).join(' | ')}`);
    });

    /* ---------- 附加：预览走同一套（同一求值入口，绝不落盘） ---------- */
    await check('预览与执行同一套：预览的分组、目标路径与执行计划逐条一致，且一份盘都没写', () => {
      const previewOut = path.join(tmpRoot, '预览用的空输出根');
      const diskBefore = countTree(srcRoot);
      const preview = core.buildPreviewTree({ files: [], roots, outputDir: previewOut, rules: null });
      ok(preview && preview.ok === true, `预览失败：${preview && preview.message}`);
      eq(preview.tree.total, Object.keys(FIXTURE).length, '预览里的文件总数');
      eq(preview.tree.classifyCount, 2, '预览里按规则分类的个数');
      eq(preview.tree.keepCount, 4, '预览里原样保留的个数');
      eq(preview.tree.rootCount, 2, '预览里的顶层源文件夹个数（下载 / 另一处）');
      eq(preview.tree.keepHint, core.FOLDER_KEEP_HINT, '预览里那句人话必须来自同一个来源');
      ok(
        /原样保留/.test(preview.tree.keepHint) && /散|分类/.test(preview.tree.keepHint),
        `那句人话没说清两条路：「${preview.tree.keepHint}」`,
      );
      const diskAfter = countTree(srcRoot);
      eq(diskAfter.files, diskBefore.files, '预览过程中原目录里的文件数');
      ok(!fs.existsSync(previewOut), '预览把输出目录建出来了（绝不允许）');
    });

    /* ---------- 十、太深与符号链接（放最后：临时目录里造的层级多） ---------- */
    let cursor = deepRoot;
    for (let i = 1; i <= 22; i++) {
      cursor = path.join(cursor, `L${i}`);
      fs.mkdirSync(cursor, { recursive: true });
      fs.writeFileSync(path.join(cursor, `f${i}.jpg`), `D${i}`, 'utf8');
    }

    await check('跳过并记录：目录超深（>20 层）与符号链接都能停下并说明原因', () => {
      const deepScan = core.expandFolders([deepRoot]);
      const folderDepthOf = (p) => String(p).slice(deepRoot.length + 1).split(path.sep).length - 1;
      const depths = deepScan.files.map((f) => folderDepthOf(f.fullPath));
      // 上限是 20 层：20 层以内的文件都收（20 个），再往里就停住并记原因
      eq(Math.max(...depths), core.MAX_SCAN_DEPTH, `最深收进来的文件夹层数（上限 ${core.MAX_SCAN_DEPTH}）`);
      eq(deepScan.files.length, core.MAX_SCAN_DEPTH, '收进来的文件数（第 1…20 层各一个）');
      ok(!deepScan.files.some((f) => folderDepthOf(f.fullPath) > core.MAX_SCAN_DEPTH), '收到了上限之外的层里的文件');
      const skippedDeep = deepScan.skipped.filter((s) => /太深/.test(s.reason));
      ok(skippedDeep.length > 0, '超过上限的那一层没有记「太深」的原因');
      ok(
        skippedDeep.some((s) => path.basename(s.fullPath) === `L${core.MAX_SCAN_DEPTH + 1}`),
        `「太深」记的应当正好是第 ${core.MAX_SCAN_DEPTH + 1} 层那个文件夹：${skippedDeep.map((s) => s.fullPath).join(' | ')}`,
      );
      console.log(
        `      深度上限 ${core.MAX_SCAN_DEPTH}：收进 ${deepScan.files.length} 个（最深第 ${Math.max(...depths)} 层），记下「太深」${skippedDeep.length} 条`,
      );

      // 符号链接：能造出来就要求「不跟随并记原因」；造不出来如实说明，不假装通过
      const linkBase = path.join(tmpRoot, 'linkbase');
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
  for (const [, pass] of results) {
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
