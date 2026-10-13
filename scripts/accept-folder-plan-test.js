/**
 * 验收第 8 条：文件夹各归各（纯逻辑，真造临时目录与文件）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 最终语义（用户拍板：「散落的文件以子文件夹优先」）：
 *  1. 子文件夹里的文件**按原样保留相对路径**（不再按规则重分）；
 *  2. 散在某个源文件夹自己那层根下的文件：**先看这一层有没有同名子文件夹** ——
 *     有就并进去（不另建分类夹）；没有才按规则**新建分类夹**（分类夹名由规则现算）；
 *  3. 同名匹配大小写不敏感（Windows 语义）、只跟**同一层**的子文件夹比；被同名**文件**占位时退回规则并说明；
 *  4. 绝不混在一起：来自不同源文件夹的文件永远不会出现在同一个输出目录里；
 *  5. 同名顶层文件夹加序号（备份 / 备份 (2)）；空文件夹不产生输出；读不了的跳过并记原因。
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
  // 「下载」根下的散文件
  '下载/散1.jpg': 'A1', // 没得沉 → 按规则新建分类夹
  '下载/散2.pdf': 'A2', // 没得沉 → 按规则新建分类夹
  '下载/发票.pdf': 'A3', // 同名子文件夹「发票」→ 沉一层
  '下载/风景.jpg': 'A8', // 同名子文件夹「风景」（里只有 note.txt）→ 沉一层，留在 风景\
  '下载/照片.jpg': 'A9', // 同名子文件夹「照片」→ 沉一层
  '下载/一路沉.jpg': 'AE', // 同名子文件夹「一路沉」→ 里面还有同名的「一路沉」→ 沉两层
  '下载/发票夹.pdf': 'AF', // 同名子文件夹「发票夹」→ 沉一层，里面有 旧发票.pdf（不同名，互不干扰）
  // 「下载」的子文件夹：里面的文件也走同一套规矩（同名就沉，没得沉就留在原地）
  '下载/发票/老发票.pdf': 'A4',
  '下载/风景/note.txt': 'AC',
  '下载/照片/图1.png': 'A5',
  '下载/照片/婚纱/纱1.jpg': 'A6',
  '下载/文档/文1.docx': 'A7',
  '下载/一路沉/一路沉/在里面.txt': 'AG', // 沉两层后落点上的既有文件
  '下载/一路沉/别的东西.txt': 'AH', // 沉一层那层的既有文件
  '下载/发票夹/旧发票.pdf': 'AI', // 沉下去那一层的既有文件（与本文件不同名）
  '下载/只在树内.jpg': 'AL', // 同名子文件夹「只在树内」；用来证明下沉只在同一棵源文件夹树内
  '下载/只在树内/原来的.txt': 'AO', // 沉下去那一层的既有文件
  '下载/撞名.pdf': 'AJ', // 同名子文件夹「撞名」；最深处已有同名文件 → 换名不覆盖
  '下载/撞名/撞名.pdf': 'AK', // 最深处已有的同名文件（换名不覆盖用）
  // 另一个源文件夹
  '另一处/照片/图2.png': 'B1',
  // 大小写不敏感用例：子文件夹叫 Photos，散文件叫 photos.jpg
  '大小写用例/Photos/existing.png': 'C1',
  '大小写用例/photos.jpg': 'C2',
  // 被同名「文件」占位用例：这一层有个叫 01_图片 的文件
  '占位用例/01_图片': 'D0',
  '占位用例/d1.jpg': 'D1',
  // 被同名「文件」占着**规则分类夹名**的用例：这一层有个文件就叫 03_文档
  '占位用例2/03_文档': 'AM',
  '占位用例2/03_文档.pdf': 'AN',
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
  console.log('=== accept-folder-plan-test: 散落的文件以子文件夹优先（同名子文件夹收下散文件，否则按规则建分类夹） ===');
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
  const 大小写用例 = path.join(srcRoot, '大小写用例');
  const 占位用例 = path.join(srcRoot, '占位用例');
  const 占位用例2 = path.join(srcRoot, '占位用例2');
  const 空的 = path.join(srcRoot, '空的');
  const 读不了 = path.join(srcRoot, '读不了');
  const deepRoot = path.join(tmpRoot, 'deep');

  writeFixture(srcRoot);
  fs.mkdirSync(空的, { recursive: true });
  fs.writeFileSync(读不了, 'not a folder', 'utf8');

  const roots = [下载, 另一处, 大小写用例, 占位用例, 占位用例2, 空的, 读不了];
  let outcome = null;
  let scan = null;

  try {
    outcome = core.planFolders({ roots, outputDir: outRoot, rules: null });
    scan = outcome.scan;

    const byName = (name) => {
      const hits = outcome.plan.files.filter((f) => f.name === name);
      ok(hits.length === 1, `计划里 ${name} 应当正好一条，实际 ${hits.length} 条`);
      return hits[0];
    };
    const relOut = (p) => path.relative(outRoot, p).split(path.sep).join('\\');

    /* ---------- 一、展开正确 ---------- */
    await check('展开正确：递归展开出来的文件与真结构逐条一致（只收文件）', () => {
      const got = scan.files.map((f) => path.relative(srcRoot, f.fullPath).split(path.sep).join('/')).sort();
      const want = Object.keys(FIXTURE).sort();
      eq(got.length, want.length, '展开出来的文件个数');
      eq(JSON.stringify(got), JSON.stringify(want), '展开出来的文件路径');
      for (const f of scan.files) ok(fs.statSync(f.fullPath).isFile(), `展开结果里混进了非文件：${f.fullPath}`);
      for (const name of ['下载', '照片', '文档', '婚纱', '发票', 'Photos']) {
        ok(!scan.files.some((f) => path.basename(f.fullPath) === name), `子文件夹本身被当成文件了：${name}`);
      }
      console.log(`      展开 ${got.length} 个文件`);
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
      for (const key of [[下载], [下载, '照片'], [下载, '照片', '婚纱'], [下载, '文档'], [下载, '发票'], [另一处, '照片']]) {
        ok(
          scan.files.some((f) => f.origin.key === key.join('\u0000')),
          `缺少这个源文件夹的归属：${key.join('\\')}`,
        );
      }
      console.log('      归属覆盖所有源文件夹');
    });

    /* ---------- 三、子文件夹里的文件原样保留 ---------- */
    await check('子文件夹里的文件原样保留：目标路径 = 输出根 + 原相对路径，没进任何分类夹', () => {
      const kept = [
        ['下载\\照片\\图1.png', '下载\\照片\\图1.png'],
        ['下载\\照片\\婚纱\\纱1.jpg', '下载\\照片\\婚纱\\纱1.jpg'],
        ['下载\\文档\\文1.docx', '下载\\文档\\文1.docx'],
        ['下载\\发票\\老发票.pdf', '下载\\发票\\老发票.pdf'],
        ['另一处\\照片\\图2.png', '另一处\\照片\\图2.png'],
      ];
      for (const [srcRel, wantRel] of kept) {
        const f = outcome.plan.files.find(
          (x) => path.relative(srcRoot, x.fullPath).split(path.sep).join('\\') === srcRel,
        );
        ok(f, `计划里找不到 ${srcRel}`);
        eq(f.placement, 'keep', `${srcRel} 应当原样保留`);
        eq(f.category, null, `${srcRel} 不该有分类夹`);
        eq(relOut(path.join(f.targetDir, f.name)), wantRel, `${srcRel} 在输出里的相对路径`);
      }
      console.log(`      ${kept.length} 个子文件夹内的文件全部原样保留`);
    });

    /* ---------- 四、散文件：没有同名子文件夹 → 按规则新建分类夹 ---------- */
    await check('散文件：这一层没有同名子文件夹时按规则新建分类夹（分类夹名从规则现算，不许写死）', () => {
      const 散1 = byName('散1.jpg');
      eq(散1.placement, 'classify', '散1.jpg 应当走「按规则新建分类夹」');
      eq(散1.category, core.classifyFile(path.join('下载', '散1.jpg')), '散1.jpg 的分类夹（规则现算）');
      eq(relOut(path.join(散1.targetDir, 散1.name)), `下载\\${散1.category}\\散1.jpg`, '散1.jpg 的输出路径');
      ok(散1.mergeReason && /没有和它同名的子文件夹/.test(散1.mergeReason), `散1.jpg 应当有「没有同名子文件夹」的说明：${散1.mergeReason}`);

      const 散2 = byName('散2.pdf');
      eq(散2.placement, 'classify', '散2.pdf 应当走「按规则新建分类夹」');
      eq(散2.category, core.classifyFile(path.join('下载', '散2.pdf')), '散2.pdf 的分类夹（规则现算）');
      eq(relOut(path.join(散2.targetDir, 散2.name)), `下载\\${散2.category}\\散2.pdf`, '散2.pdf 的输出路径');

      ok(!fs.existsSync(path.join(下载, 散1.category)), `源里本来不该有 ${散1.category} 子文件夹`);
      console.log(`      散1.jpg → 下载\\${散1.category}\\，散2.pdf → 下载\\${散2.category}\\（都从规则现算）`);
    });

    /* ---------- 五、散文件：有同名子文件夹 → 并进去（本片最关键的一条） ---------- */
    await check('散文件：这一层有同名子文件夹时并进去，不另建分类夹', () => {
      const 发票 = byName('发票.pdf');
      eq(发票.placement, 'merge', '发票.pdf 应当并进已有的「发票」子文件夹');
      eq(发票.category, '发票', '发票.pdf 并入的子文件夹名');
      eq(relOut(path.join(发票.targetDir, 发票.name)), '下载\\发票\\发票.pdf', '发票.pdf 的输出路径');
      ok(发票.mergeReason && /和这一层根下的「发票」同名/.test(发票.mergeReason) && /沉进去/.test(发票.mergeReason), `发票.pdf 应当有并入说明（说清按文件名比对）：${发票.mergeReason}`);

      const 发票目录 = outcome.plan.files.map((f) => f.targetDir).filter((d) => path.basename(d) === '发票');
      eq(new Set(发票目录.map((d) => d.toLowerCase())).size, 1, '「发票」这个目录名只能有一个（不许另建分类夹）');
      eq(发票.targetDir, path.join(outRoot, '下载', '发票'), '发票.pdf 的目标目录必须是那个已有的子文件夹');

      const 老发票 = byName('老发票.pdf');
      eq(老发票.placement, 'keep', '老发票.pdf 应当原样保留');
      eq(老发票.targetDir, 发票.targetDir, '两份发票应当在同一个文件夹里');
      console.log('      发票.pdf 并进 下载\\发票\\（与老发票.pdf 同处），没有另建分类夹');
    });

    /* ---------- 五之二、主用例：名字相同就算一回事 + 一路沉到底（递归） ---------- */
    await check('一路沉到底：风景.jpg → 下载\\风景\\、照片.jpg → 下载\\照片\\、一路沉.jpg → 下载\\一路沉\\一路沉\\', () => {
      /**
       * 用户拍板：「还是并进去（名字相同就算一回事）」+ 第三种情况要**逐层往下沉**：
       * 沉进同名子文件夹后，用同一套规矩再看一遍，直到那一层没有同名的可沉 → 停在那一层。
       */
      const 风景 = byName('风景.jpg');
      eq(风景.placement, 'merge', '风景.jpg：同层有 风景\\（里只有 note.txt），名字相同 → 沉进去');
      eq(风景.category, '风景', '风景.jpg 停下的那一层');
      eq(relOut(path.join(风景.targetDir, 风景.name)), '下载\\风景\\风景.jpg', '风景.jpg 的输出路径');
      ok(
        风景.mergeReason && /同名/.test(风景.mergeReason) && /沉进去/.test(风景.mergeReason),
        `风景.jpg 应当说清「同名 → 沉进去」：${风景.mergeReason}`,
      );
      // 沉进去不许把原来那个文件挤走或改名
      const noteKeep = outcome.plan.files.find((f) => f.name === 'note.txt');
      eq(noteKeep.placement, 'keep', '风景\\note.txt 应当仍然原样保留');
      eq(relOut(path.join(noteKeep.targetDir, noteKeep.name)), '下载\\风景\\note.txt', '风景\\note.txt 的位置没被动过');
      eq(noteKeep.targetDir, 风景.targetDir, '风景.jpg 与 note.txt 都在 下载\\风景\\ 里');

      const 照片 = byName('照片.jpg');
      eq(照片.placement, 'merge', '照片.jpg：同层有 照片\\，名字相同 → 沉进去');
      eq(relOut(path.join(照片.targetDir, 照片.name)), '下载\\照片\\照片.jpg', '照片.jpg 的输出路径');

      // 递归：一路沉 里还有一路沉 → 沉两层
      const 一路沉 = byName('一路沉.jpg');
      eq(一路沉.placement, 'merge', '一路沉.jpg：同名 → 沉进去，里面还有同名的 → 继续沉');
      eq(relOut(path.join(一路沉.targetDir, 一路沉.name)), '下载\\一路沉\\一路沉\\一路沉.jpg', '一路沉.jpg 的输出路径（沉两层）');
      eq(一路沉.targetDir, path.join(outRoot, '下载', '一路沉', '一路沉'), '一路沉.jpg 停下的那一层');
      ok(/沉了 2 层/.test(一路沉.mergeReason || ''), `一路沉.jpg 应当说清沉了几层：${一路沉.mergeReason}`);
      // 沉两层的路上那些既有文件都没被动过
      const 在里面 = outcome.plan.files.find((f) => f.name === '在里面.txt');
      eq(relOut(path.join(在里面.targetDir, 在里面.name)), '下载\\一路沉\\一路沉\\在里面.txt', '在里面.txt 的位置没被动过');
      const 别的东西 = outcome.plan.files.find((f) => f.name === '别的东西.txt');
      eq(relOut(path.join(别的东西.targetDir, 别的东西.name)), '下载\\一路沉\\别的东西.txt', '别的东西.txt 的位置没被动过');

      // 这三条都没进分类夹：不能因为「名字相同」而**另外**产生分类夹
      for (const merged of [风景, 照片, 一路沉]) {
        ok(
          !outcome.plan.files.some(
            (f) => f !== merged && f.placement === 'classify' && f.targetDir.toLowerCase() === merged.targetDir.toLowerCase(),
          ),
          `${merged.name} 的目标目录里混进了「按规则新建分类夹」的文件：${merged.targetDir}`,
        );
      }
      console.log(`      风景.jpg → 下载\\风景\\风景.jpg（${风景.mergeReason}）`);
      console.log('      照片.jpg → 下载\\照片\\照片.jpg；一路沉.jpg → 下载\\一路沉\\一路沉\\一路沉.jpg（沉两层）');
    });

    /* ---------- 五之三、沉到底那一层已有同名文件 → 换名不覆盖 ---------- */
    await check('沉到底那一层已有同名文件时换名不覆盖（原名 (1).后缀），绝不删/改别人', () => {
      const 撞名 = byName('撞名 (1).pdf');
      eq(撞名.placement, 'merge', '撞名.pdf 应当沉进 撞名\\ 后因同名冲突换名，而不是退回规则');
      eq(撞名.renamed, true, '撞名.pdf 应当被标记为换过名');
      eq(relOut(path.join(撞名.targetDir, 撞名.name)), '下载\\撞名\\撞名 (1).pdf', '撞名.pdf 的输出路径');
      // 原来那个同名文件还在原地、没被覆盖
      const 原有 = outcome.plan.files.find((f) => f.name === '撞名.pdf');
      ok(原有, '原来那个 撞名.pdf 应当还在计划里');
      eq(原有.placement, 'keep', '原来那个 撞名.pdf 应当原样保留');
      eq(relOut(path.join(原有.targetDir, 原有.name)), '下载\\撞名\\撞名.pdf', '原来那个 撞名.pdf 的位置没被动过');
      ok(/换名/.test(撞名.mergeReason || ''), `应当说明按换名规则处理：${撞名.mergeReason}`);
      console.log(`      撞名.pdf → ${relOut(path.join(撞名.targetDir, 撞名.name))}（${撞名.mergeReason.slice(0, 40)}…）`);
    });

    /* ---------- 五之四、占位保护的覆盖位置说明 ----------
     * 「被同名的『文件』占着 → 不动它、退回规则」这条统一在下面「七」里覆盖
     * （那里把占位文件造在 01_图片 / 03_文档 这种**规则分类夹名**上，语义清晰）；
     * 这里不再另造「文件与同名子文件夹同处一层」的夹具 —— 那种情况下按口径就是沉进去，没有歧义。
     */

    /* ---------- 五之五、下沉只在同一棵源文件夹树内 ---------- */
    await check('下沉只在同一棵源文件夹树内：绝不会沉到别的源文件夹里去', () => {
      const 只在树内 = byName('只在树内.jpg');
      eq(只在树内.placement, 'merge', '只在树内.jpg：同层有同名的 只在树内\\ → 沉进去');
      // 每个文件的目标目录都必须在自己那棵源树（下载\）下面，不许跑到 另一处\ / 大小写用例\ 里
      for (const f of outcome.plan.files) {
        const target = f.targetDir.toLowerCase();
        const own = path.join(outRoot, path.basename(f.origin.rootPath)).toLowerCase();
        ok(
          target === own || target.startsWith(own + path.sep),
          `${f.name} 跑出了自己那棵源文件夹树：目标 ${f.targetDir} 不在 ${own} 下面`,
        );
      }
      // 反向：每个源树里只出现自己的文件（按树分组，逐棵检查）
      const byTree = new Map();
      for (const f of outcome.plan.files) {
        const tree = f.origin.rootPath.toLowerCase();
        if (!byTree.has(tree)) byTree.set(tree, new Set());
        byTree.get(tree).add(f.fullPath.toLowerCase());
      }
      for (const [tree, ownFiles] of byTree) {
        const prefix = tree + path.sep;
        for (const p of ownFiles) {
          ok(p.startsWith(prefix), `源树 ${tree} 里混进了不属于它的文件：${p}`);
        }
      }
      console.log(`      逐棵源树检查过：${byTree.size} 棵树，各自的目标都留在自己树下`);
    });

    /* ---------- 六、同名匹配大小写不敏感 + 只比同一层 ---------- */
    await check('同名匹配大小写不敏感（Windows 语义），且只跟同一层的子文件夹比、不跨层', () => {
      const photos = byName('photos.jpg');
      eq(photos.placement, 'merge', 'photos.jpg 应当并进同层的「Photos」子文件夹（大小写不敏感）');
      eq(photos.category, 'Photos', 'photos.jpg 并入的子文件夹名（保留源里的大小写）');
      eq(relOut(path.join(photos.targetDir, photos.name)), '大小写用例\\Photos\\photos.jpg', 'photos.jpg 的输出路径');
      eq(
        photos.targetDir,
        path.join(outRoot, '大小写用例', 'Photos'),
        'photos.jpg 的目标目录必须是那个既有的 Photos 子文件夹',
      );
      const 照片目录数 = outcome.plan.files
        .map((f) => f.targetDir)
        .filter((d) => path.basename(d).toLowerCase() === 'photos');
      eq(new Set(照片目录数).size, 1, 'Photos 这个目录名只能有一个');

      const 文1 = byName('文1.docx');
      eq(文1.placement, 'keep', '文1.docx 是子文件夹里的文件，不该被别的层的同名子文件夹影响');
      ok(!文1.targetDir.toLowerCase().includes('照片'), `文1.docx 被跨层匹配走了：${文1.targetDir}`);
      const 图2 = byName('图2.png');
      eq(relOut(path.join(图2.targetDir, 图2.name)), '另一处\\照片\\图2.png', '另一处\\照片\\图2.png 的输出路径');
      console.log('      photos.jpg 并进 Photos\\（大小写不敏感）；子文件夹里的文件没有被跨层匹配影响');
    });

    /* ---------- 七、被同名「文件」占位 → 退回规则建分类夹，不许覆盖 ---------- */
    await check('被同名「文件」占位时退回按规则建分类夹：不覆盖它，并有说明', () => {
      const 占位 = path.join(占位用例, '01_图片');
      ok(fs.statSync(占位).isFile(), '测试夹具本身不对：01_图片 应当是个文件');
      const d1 = byName('d1.jpg');
      eq(d1.placement, 'classify', 'd1.jpg 应当退回「按规则新建分类夹」');
      eq(d1.category, core.classifyFile(path.join('占位用例', 'd1.jpg')), 'd1.jpg 的分类夹（规则现算）');
      eq(d1.targetDir, path.join(outRoot, '占位用例', d1.category), 'd1.jpg 的目标目录');
      ok(d1.mergeReason && /「文件」/.test(d1.mergeReason), `应当有「被同名文件占位」的说明：${d1.mergeReason}`);
      eq(fs.readFileSync(占位, 'utf8'), 'D0', '占位文件被改了（绝不允许）');
      ok(fs.statSync(占位).isFile(), '占位文件被替换成了目录（绝不允许）');
      console.log(`      ${d1.mergeReason}`);

      // 第二种占位：那个名字正好是**规则算出来的分类夹名**（这一层有个文件就叫 03_文档）
      const 占位2 = path.join(占位用例2, '03_文档');
      ok(fs.statSync(占位2).isFile(), '测试夹具本身不对：03_文档 应当是个文件');
      const 占位2散文件 = byName('03_文档.pdf');
      eq(占位2散文件.placement, 'classify', '03_文档.pdf 应当退回「按规则新建分类夹」');
      eq(占位2散文件.category, core.classifyFile(path.join('占位用例2', '03_文档.pdf')), '03_文档.pdf 的分类夹（规则现算）');
      ok(/「文件」/.test(占位2散文件.mergeReason), `应当说明被同名文件占着：${占位2散文件.mergeReason}`);
      eq(fs.readFileSync(占位2, 'utf8'), 'AM', '占位文件「03_文档」的内容被改了（绝不允许）');
      ok(fs.statSync(占位2).isFile(), '占位文件「03_文档」被替换成了目录（绝不允许）');
      console.log(`      ${占位2散文件.mergeReason}`);
    });

    /* ---------- 八、绝不混在一起 ---------- */
    await check('绝不混在一起：不同源文件夹的文件/不同层级的子文件夹都不混进同一个输出目录（逐条查）', () => {
      const byDir = new Map();
      for (const f of outcome.plan.files) {
        const key = f.targetDir.toLowerCase();
        if (!byDir.has(key)) byDir.set(key, { dir: f.targetDir, origins: new Set(), files: [] });
        byDir.get(key).origins.add(f.origin.key);
        byDir.get(key).files.push(f);
      }
      // 每个输出目录里，除了「同一棵源树里被并进来的散文件」之外，来源必须唯一
      const mixed = [];
      for (const [, bucket] of byDir) {
        const roots = new Set(bucket.files.map((f) => f.origin.rootPath.toLowerCase()));
        if (roots.size > 1) {
          mixed.push(`${bucket.dir} 里混了 ${roots.size} 个源文件夹（不同拖入点）`);
          continue;
        }
        // 同一棵树里也可以共存：既有子文件夹原样带过来的，也有这次并进来的散文件；
        // 但不允许出现「两个不同层的子文件夹被合到一个目录」之外的情况 —— 这里只做记录，不做假设
        const kept = bucket.files.filter((f) => f.placement === 'keep');
        const mergedOrClassified = bucket.files.filter((f) => f.placement !== 'keep');
        if (kept.length > 0 && mergedOrClassified.length > 0) {
          // 只允许「同一个子文件夹」：并进来的散文件必须正好落在某个 keep 文件所在的那一层
          const dirs = new Set(kept.map((f) => f.targetDir.toLowerCase()));
          if (dirs.size > 1) {
            mixed.push(`${bucket.dir} 里把 ${dirs.size} 个不同子文件夹合到了一起`);
          }
        }
      }
      ok(mixed.length === 0, `输出目录出现了不该有的混合（${mixed.length} 处）：${mixed.slice(0, 3).join(' | ')}`);

      const dirsOfKey = new Map();
      for (const f of outcome.plan.files) {
        if (!dirsOfKey.has(f.origin.key)) dirsOfKey.set(f.origin.key, new Set());
        dirsOfKey.get(f.origin.key).add(f.targetDir.toLowerCase());
      }
      const keys = Array.from(dirsOfKey.keys());
      // 注意：把散文件并进既有子文件夹之后，**同一个源文件夹树**里的两层会共处一个目录
      // （下载\发票\ 里既有原来的 老发票.pdf，也有这次并进来的 发票.pdf）—— 这正是新语义要的效果。
      // 所以逐对查的是「不同源文件夹（不同拖入的顶层）之间」绝不许共用输出目录。
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const sameTree = keys[i].split('\u0000')[0].toLowerCase() === keys[j].split('\u0000')[0].toLowerCase();
          if (sameTree) continue;
          const a = dirsOfKey.get(keys[i]);
          const b = dirsOfKey.get(keys[j]);
          for (const d of a) {
            ok(
              !b.has(d),
              `不同源文件夹「${keys[i].split('\u0000').join('\\')}」与「${keys[j].split('\u0000').join('\\')}」共用了同一个输出目录：${d}`,
            );
          }
        }
      }
      console.log(`      共 ${byDir.size} 个输出目录；不同顶层源文件夹之间逐对检查过，没有共用`);
    });

    /* ---------- 九、同名顶层文件夹加序号 ---------- */
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
      console.log(`      顶层同名两份：${names[0]} / ${names[1]}`);
    });

    /* ---------- 十、空文件夹 + 跳过并记录 ---------- */
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

    /* ---------- 十一、真落盘一次 ---------- */
    await check('真落盘一次：输出结构与预期逐条一致，且原目录里的文件一个都没少（内容一致）', async () => {
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

      for (const f of outcome.plan.files) {
        const r = summary.results.find((x) => x.source === f.fullPath);
        ok(r, `复制结果里找不到 ${f.fullPath}`);
        eq(r.target, path.join(f.targetDir, f.name), `${path.basename(f.fullPath)} 的落盘路径`);
      }

      // 控制台给的例子：单独按那个结构再跑一遍完整落盘，逐条核对
      const demo = path.join(tmpRoot, '例子');
      const demoOut = path.join(tmpRoot, '例子输出');
      fs.mkdirSync(path.join(demo, '照片', '风景'), { recursive: true });
      fs.mkdirSync(path.join(demo, '文档'), { recursive: true });
      fs.mkdirSync(path.join(demo, '发票'), { recursive: true });
      fs.writeFileSync(path.join(demo, '照片', '风景', 'a.jpg'), 'a', 'utf8');
      fs.writeFileSync(path.join(demo, '照片', 'b.jpg'), 'b', 'utf8');
      fs.writeFileSync(path.join(demo, '文档', 'c.docx'), 'c', 'utf8');
      fs.writeFileSync(path.join(demo, '散1.jpg'), 's1', 'utf8');
      fs.writeFileSync(path.join(demo, '发票.pdf'), 'inv', 'utf8');
      fs.writeFileSync(path.join(demo, '发票', '老发票.pdf'), 'old', 'utf8');
      const demoScan = core.expandFolders([demo]);
      const demoSummary = await core.copyFiles({
        outputDir: demoOut,
        files: demoScan.files.map((f) => f.fullPath),
        roots: [demo],
      });
      eq(
        demoSummary.failureCount,
        0,
        `例子用例复制失败：${demoSummary.results.filter((r) => !r.ok).map((r) => r.error).join(' | ')}`,
      );
      const demoExpect = [
        '例子\\照片\\风景\\a.jpg',
        '例子\\照片\\b.jpg',
        '例子\\文档\\c.docx',
        '例子\\01_图片\\散1.jpg',
        '例子\\发票\\发票.pdf',
        '例子\\发票\\老发票.pdf',
      ];
      for (const rel of demoExpect) {
        const full = path.join(demoOut, ...rel.split('\\'));
        ok(fs.existsSync(full), `例子用例的输出里没有这个文件：${full}`);
      }
      const 发票目录们 = fs
        .readdirSync(path.join(demoOut, '例子'))
        .filter((n) => n.toLowerCase().startsWith('发票'));
      eq(发票目录们.length, 1, `例子用例里出现了多个「发票」目录：${发票目录们.join(' / ')}`);
      ok(
        !fs.existsSync(path.join(demoOut, '例子', '02_文档')),
        '例子用例里不该出现 02_文档（发票.pdf 应当并进那个同名的 发票 子文件夹）',
      );
      const 散1落点 = demoSummary.results.find((r) => path.basename(r.source) === '散1.jpg');
      ok(散1落点 && 散1落点.ok, '例子用例里 散1.jpg 没复制成功');
      eq(
        path.relative(demoOut, 散1落点.target).split(path.sep).join('\\'),
        '例子\\01_图片\\散1.jpg',
        '例子用例里 散1.jpg 的落点',
      );

      // 本用例（更复杂的夹具）逐条查：文件在、内容一致
      for (const f of outcome.plan.files) {
        const full = path.join(f.targetDir, f.name);
        ok(fs.existsSync(full), `输出里没有这个文件：${full}`);
        eq(fs.readFileSync(full, 'utf8'), fs.readFileSync(f.fullPath, 'utf8'), `${f.name} 的内容与原文件一致`);
      }
      const disk = countTree(outRoot);
      eq(disk.files, Object.keys(FIXTURE).length, '输出根里的文件总数');

      const after = countTree(srcRoot);
      eq(after.files, srcFilesOnDisk, '复制后原目录里的文件数（应当与复制前完全一样）');
      for (const [rel, content] of Object.entries(FIXTURE)) {
        const full = path.join(srcRoot, ...rel.split('/'));
        ok(fs.existsSync(full), `原文件不见了（绝不允许）：${full}`);
        eq(fs.readFileSync(full, 'utf8'), content, `原文件内容被改了：${rel}`);
      }
      console.log(`      落盘 ${summary.successCount} 个文件；例子用例逐条对上（${demoExpect.join(' | ')}）`);
      console.log(`      原文件 ${after.files} 个全部健在且内容一致`);
    });

    /* ---------- 十二、预览走同一套（同一求值入口，绝不落盘） ---------- */
    await check('预览与执行同一套：预览的分组与说明齐备，且一份盘都没写', () => {
      const previewOut = path.join(tmpRoot, '预览用的空输出根');
      const diskBefore = countTree(srcRoot);
      const preview = core.buildPreviewTree({ files: [], roots, outputDir: previewOut, rules: null });
      ok(preview && preview.ok === true, `预览失败：${preview && preview.message}`);
      eq(preview.tree.total, Object.keys(FIXTURE).length, '预览里的文件总数');
      eq(preview.tree.classifyCount, 6, '预览里「按规则新建分类夹」的个数');
      eq(preview.tree.mergeCount, 8, '预览里「沉进同名子文件夹」的个数');
      eq(preview.tree.keepCount, 12, '预览里「原样保留」的个数（子文件夹里的）');
      eq(preview.tree.keepHint, core.FOLDER_KEEP_HINT, '预览里那句人话必须来自同一个来源');
      eq(
        preview.tree.keepHint,
        '子文件夹里的文件按原样保留（连层级一起搬）；散在某一层根下的文件，若那一层有和它同名的子文件夹（按文件名去扩展名比对）就沉进去，进去了再按同一规矩往下看，直到没有同名的可沉；一次都没沉成的才按当前规则新建分类夹。',
        '界面上显示的那句说明必须与控制台给的最终措辞一字不差',
      );
      ok(/原样保留/.test(preview.tree.keepHint), `那句人话没说「原样保留」：「${preview.tree.keepHint}」`);
      ok(/同名的子文件夹/.test(preview.tree.keepHint), `那句人话没说「并进同名子文件夹」：「${preview.tree.keepHint}」`);
      ok(/规则/.test(preview.tree.keepHint), `那句人话没说「没有同名时才按规则」：「${preview.tree.keepHint}」`);

      const root下载 = preview.tree.roots.find((r) => r.name === '下载');
      ok(root下载, '预览里找不到「下载」这一组');
      const 发票子夹 = root下载.self.subfolders.find((s) => s.name === '发票');
      ok(发票子夹, '预览里找不到「发票」子文件夹');
      ok(
        (发票子夹.mergedIn || []).some((f) => f.name === '发票.pdf'),
        `预览里「发票」子文件夹没有标出并进来的散文件：${JSON.stringify(发票子夹.files.map((f) => f.name))}`,
      );
      eq(root下载.self.mergedCount, 7, '「下载」这一份里沉进子文件夹的散文件个数');

      const diskAfter = countTree(srcRoot);
      eq(diskAfter.files, diskBefore.files, '预览过程中原目录里的文件数');
      ok(!fs.existsSync(previewOut), '预览把输出目录建出来了（绝不允许）');
    });

    /* ---------- 十三、太深与符号链接（放最后：临时目录里造的层级多） ---------- */
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
      eq(Math.max(...depths), core.MAX_SCAN_DEPTH, `最深收进来的文件夹层数（上限 ${core.MAX_SCAN_DEPTH}）`);
      eq(deepScan.files.length, core.MAX_SCAN_DEPTH, '收进来的文件数（第 1…20 层各一个）');
      ok(!deepScan.files.some((f) => folderDepthOf(f.fullPath) > core.MAX_SCAN_DEPTH), '收到了上限之外的层里的文件');
      const skippedDeep = deepScan.skipped.filter((s) => /太深/.test(s.reason));
      ok(skippedDeep.length > 0, '超过上限的那一层没有记「太深」的原因');
      ok(
        skippedDeep.some((s) => path.basename(s.fullPath) === `L${core.MAX_SCAN_DEPTH + 1}`),
        `「太深」记的应当正好是第 ${core.MAX_SCAN_DEPTH + 1} 层那个文件夹`,
      );
      console.log(`      深度上限 ${core.MAX_SCAN_DEPTH}：收进 ${deepScan.files.length} 个，记下「太深」${skippedDeep.length} 条`);

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
