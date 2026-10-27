/**
 * 验收第 20 条：**删源文件**（用户明确确认之后，才把这一批的源文件移到回收站）。
 *
 * 这是全产品唯一一次「动用户的原始文件」，所以判据只认这几条红线：
 *   1. 只删「这一次整理里复制成功」的那几个源文件（记录里那份成功清单）；
 *   2. 删之前逐个核对**输出里那份还在**：输出里那份没了（被撤销 / 手动删了）→ 跳过并说明，不删源；
 *   3. 默认走回收站（主进程传 shell.trashItem）；**没有回收站能力时一个都不删**；
 *   4. 目录只 rmdir（只在空的时候才成功）：里面还有东西就留着；
 *   5. 幂等：删过一次再点只回一句人话，不再动手；
 *   6. 每个动作都写一行删除审计（与撤销同一份日志）。
 *
 * 全部通过：stdout 打印「删源文件OK」并 exit 0；任何一条不过：打印「验收失败:删源文件」并 exit 1。
 *
 * 跑法：node scripts\accept-delete-sources-test.js
 *       （由 scripts\验收.ps1 调用，必须先跑过 npm run build）
 *       记录与审计一律走临时路径，绝不碰用户 userData 下的真实文件。
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
async function check(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    log(`PASS  ${name}`);
    return true;
  } catch (err) {
    results.push([name, false]);
    log(`FAIL  ${name}`);
    log(`      ${(err && err.message) || err}`);
    return false;
  }
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}
function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content === undefined ? 'x' : content, 'utf8');
  return p;
}

/** 一个场景：源文件夹（含子目录）+ 空输出目录 + 临时记录/审计/回收站路径。 */
function makeCase(tmpRoot, name) {
  const dir = path.join(tmpRoot, name);
  const src = path.join(dir, '源');
  const files = [
    writeFile(path.join(src, 'a.jpg'), 'A'),
    writeFile(path.join(src, 'b.pdf'), 'B'),
    writeFile(path.join(src, '子', 'c.mp3'), 'C'),
  ];
  const out = path.join(dir, '输出');
  fs.mkdirSync(out, { recursive: true });
  return {
    dir,
    src,
    out,
    files,
    recordPath: path.join(dir, '记录.json'),
    auditPath: path.join(dir, '删除审计.log'),
    trashDir: path.join(dir, '回收站'),
  };
}

/** 假的回收站：真把文件挪进 trashDir（同一块盘，rename 就是「移进回收站」）。 */
function makeTrash(trashDir) {
  const moved = [];
  return {
    moved,
    fn: (filePath) => {
      fs.mkdirSync(trashDir, { recursive: true });
      const target = path.join(trashDir, `${moved.length + 1}-${path.basename(filePath)}`);
      fs.renameSync(filePath, target);
      moved.push(target);
    },
  };
}

function listRel(root) {
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
        out.push(`${path.relative(root, full)}/`);
        visit(full);
      } else {
        out.push(path.relative(root, full));
      }
    }
  };
  visit(root);
  return out.sort();
}

function countTree(root) {
  const acc = { files: 0, dirs: 0 };
  for (const rel of listRel(root)) {
    if (rel.endsWith('/')) acc.dirs++;
    else acc.files++;
  }
  return acc;
}

async function main() {
  log('=== accept-delete-sources-test: 删源文件（唯一一次动用户原件的动作，红线逐条核） ===');
  if (typeof core.deleteSourceFiles !== 'function' || typeof core.copyFiles !== 'function') {
    log('FAIL: out/core/index.js 没有导出 copyFiles / deleteSourceFiles');
    log('验收失败:删源文件');
    process.exitCode = 1;
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-delete-sources-'));
  log(`temp work dir: ${tmpRoot}`);

  try {
    /* ---------- 一、正常：输出里那份还在 → 源文件移到回收站，目录空了才清 ---------- */
    await check('正常：复制成功的三个源文件被移到回收站，输出里三份还在，空掉的源目录一并清掉，审计有记录', async () => {
      const c = makeCase(tmpRoot, '正常');
      const summary = await core.copyFiles({
        files: c.files,
        roots: [c.src],
        outputDir: c.out,
        rules: null,
        recordPath: c.recordPath,
      });
      eq(summary.successCount, 3, '前置：三份都该复制成功');
      const outBefore = countTree(c.out);
      eq(outBefore.files, 3, '前置：输出里应当有 3 个文件');

      const trash = makeTrash(c.trashDir);
      const res = await core.deleteSourceFiles(c.recordPath, {
        trash: trash.fn,
        auditPath: c.auditPath,
        now: new Date('2026-10-27T00:00:00Z'),
      });
      ok(res.ok, `删源应当成功：${res.message}`);
      eq(res.deletedFiles, 3, `应当删掉 3 个源文件（${JSON.stringify(res.files.map((f) => [f.action, f.source]))}）`);
      eq(res.skippedFiles, 0, '不该有跳过的');
      eq(trash.moved.length, 3, '回收站里应当有 3 个文件');
      ok(/回收站/.test(res.message), `人话里要说清是移到回收站（可以还原）：「${res.message}」`);

      for (const f of c.files) ok(!fs.existsSync(f), `源文件还在（应当已被移走）：${f}`);
      const outAfter = countTree(c.out);
      eq(JSON.stringify(outAfter), JSON.stringify(outBefore), '输出里那几份被动了（删源不该碰输出）');
      ok(!fs.existsSync(c.src), `源文件夹里的文件都删完了、目录也空了，应当被清掉：${c.src}`);

      ok(fs.existsSync(c.auditPath), '没写删除审计日志');
      const audit = fs.readFileSync(c.auditPath, 'utf8');
      const deletedLines = audit.split('\n').filter((l) => /文件 deleted /.test(l));
      eq(deletedLines.length, 3, `审计里应当逐条记下 3 个删掉的文件（实际 ${deletedLines.length} 行）`);

      const rec = JSON.parse(fs.readFileSync(c.recordPath, 'utf8'));
      ok(!!rec.sourcesDeletedAt, '记录里没盖上「已删源」');
    });

    /* ---------- 二、幂等：再点一次只回一句人话，不再动手 ---------- */
    await check('幂等：同一批再删一次 → 不再动手，只回一句「已经删过了」，回收站里不多东西', async () => {
      const c = makeCase(tmpRoot, '幂等');
      await core.copyFiles({ files: c.files, roots: [c.src], outputDir: c.out, rules: null, recordPath: c.recordPath });
      const trash = makeTrash(c.trashDir);
      const first = await core.deleteSourceFiles(c.recordPath, { trash: trash.fn, auditPath: c.auditPath });
      eq(first.deletedFiles, 3, '第一次应当删 3 个');
      const movedAfterFirst = trash.moved.length;

      const second = await core.deleteSourceFiles(c.recordPath, { trash: trash.fn, auditPath: c.auditPath });
      eq(second.changed, false, '第二次不该再动手');
      eq(second.deletedFiles, 0, '第二次不该再删文件');
      eq(trash.moved.length, movedAfterFirst, '第二次不该往回收站里多放东西');
      ok(/已经删过/.test(second.message), `第二次要说明「已经删过了」：「${second.message}」`);
    });

    /* ---------- 三、输出里那份没了 → 跳过并说明，源文件必须留着 ---------- */
    await check('输出里那份被删了（撤销/手删）→ 跳过并说明原因，那个源文件必须留着', async () => {
      const c = makeCase(tmpRoot, '输出没了');
      const summary = await core.copyFiles({
        files: c.files,
        roots: [c.src],
        outputDir: c.out,
        rules: null,
        recordPath: c.recordPath,
      });
      eq(summary.successCount, 3, '前置：三份都该复制成功');
      const rec = JSON.parse(fs.readFileSync(c.recordPath, 'utf8'));
      const entry = rec.files.find((f) => path.basename(String(f.source)) === 'a.jpg');
      ok(!!entry, '前置：记录里应当有 a.jpg 这条');
      fs.rmSync(entry.target, { force: true }); // 模拟「输出里那份被删了」

      const trash = makeTrash(c.trashDir);
      const res = await core.deleteSourceFiles(c.recordPath, { trash: trash.fn, auditPath: c.auditPath });
      const a = res.files.find((f) => path.basename(String(f.source)) === 'a.jpg');
      ok(!!a, '结果里应当有 a.jpg 这一条');
      eq(a.action, 'skipped', '输出里那份没了 → a.jpg 的源文件必须跳过');
      ok(/输出/.test(a.reason), `跳过的原因要说清是「输出里那份没了」：「${a.reason}」`);
      ok(fs.existsSync(entry.source), '输出里那份都没了，源文件居然被删了（这是真丢数据）');
      eq(res.deletedFiles, 2, '另外两个应当照删');
      ok(fs.existsSync(entry.source), 'a.jpg 的源文件必须还在');
    });

    /* ---------- 四、源文件夹里用户后来加的东西 → 不删，目录也留着 ---------- */
    await check('源文件夹里用户后来加的文件 → 一个都不碰，目录因为还有东西而留着', async () => {
      const c = makeCase(tmpRoot, '后加的文件');
      await core.copyFiles({
        files: [c.files[0]],
        roots: [c.src],
        outputDir: c.out,
        rules: null,
        recordPath: c.recordPath,
      });
      const extra = writeFile(path.join(c.src, '我的备忘.txt'), 'MINE');
      const trash = makeTrash(c.trashDir);
      const res = await core.deleteSourceFiles(c.recordPath, { trash: trash.fn, auditPath: c.auditPath });
      eq(res.deletedFiles, 1, '只该删记录里那一个');
      ok(fs.existsSync(extra), '用户自己加的文件被删了（红线）');
      ok(fs.existsSync(c.src), '源文件夹里还有东西，目录不该被删');
      const skippedDir = res.dirs.find((d) => d.action === 'skipped');
      ok(!!skippedDir, '目录应当被跳过（里面还有东西）');
      ok(/还有东西|不是空/.test(skippedDir.reason), `目录跳过的原因要说清：「${skippedDir.reason}」`);
    });

    /* ---------- 五、没有回收站能力 → 一个都不删 ---------- */
    await check('环境给不出回收站能力 → 一个文件都不删（宁可不动，也不许不可恢复）', async () => {
      const c = makeCase(tmpRoot, '没有回收站');
      await core.copyFiles({ files: c.files, roots: [c.src], outputDir: c.out, rules: null, recordPath: c.recordPath });
      const before = countTree(c.src);
      const res = await core.deleteSourceFiles(c.recordPath, { trash: null, auditPath: c.auditPath });
      eq(res.deletedFiles, 0, '没有回收站时不该删任何文件');
      eq(res.changed, false, '没有回收站时不该算「动过手」');
      ok(/回收站/.test(res.message), `要说明「这个环境不能移到回收站」：「${res.message}」`);
      eq(JSON.stringify(countTree(c.src)), JSON.stringify(before), '源目录被动过');
      for (const f of c.files) ok(fs.existsSync(f), `源文件被删了：${f}`);
    });

    /* ---------- 六、探针必须是活的 ---------- */
    await check('探针有效性自检：「不看输出就删」的朴素实现必须在同一个场景里被判失败', async () => {
      const c = makeCase(tmpRoot, '探针');
      await core.copyFiles({ files: c.files, roots: [c.src], outputDir: c.out, rules: null, recordPath: c.recordPath });
      const rec = JSON.parse(fs.readFileSync(c.recordPath, 'utf8'));
      const entry = rec.files.find((f) => path.basename(String(f.source)) === 'a.jpg');
      fs.rmSync(entry.target, { force: true }); // 输出里那份没了

      // 朴素实现：记录里的源文件一个不落地推进回收站（不看输出还在不在）
      const baitTrash = makeTrash(path.join(c.dir, '回收站-诱饵'));
      const baited = [];
      for (const f of rec.files) {
        try {
          baitTrash.fn(String(f.source));
          baited.push(String(f.source));
        } catch {
          /* 不存在的跳过 */
        }
      }
      ok(
        baited.some((s) => s.toLowerCase() === String(entry.source).toLowerCase()),
        '反证没成立：朴素实现竟然也没删掉那个源文件（那样探针不算活的）',
      );
      ok(!fs.existsSync(entry.source), '反证没成立：朴素实现应当把源文件删掉，这样才说明判据能分辨');

      // 真产物在同一个场景里必须保住它（第 3 条已经验过，这里再在同一个场景里对一次）
      const c2 = makeCase(tmpRoot, '探针-真产物');
      await core.copyFiles({ files: c2.files, roots: [c2.src], outputDir: c2.out, rules: null, recordPath: c2.recordPath });
      const rec2 = JSON.parse(fs.readFileSync(c2.recordPath, 'utf8'));
      const entry2 = rec2.files.find((f) => path.basename(String(f.source)) === 'a.jpg');
      fs.rmSync(entry2.target, { force: true });
      const trash2 = makeTrash(c2.trashDir);
      const res = await core.deleteSourceFiles(c2.recordPath, { trash: trash2.fn, auditPath: c2.auditPath });
      ok(fs.existsSync(entry2.source), '真产物在同一个场景里没能保住源文件');
      eq(res.skippedFiles, 1, '真产物应当正好跳过 1 个');
      log('      探针：不看输出的朴素实现会真丢文件（判失败），真产物保住了源文件（判通过）');
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
    log('删源文件OK');
    process.exitCode = 0;
  } else {
    log('验收失败:删源文件');
    process.exitCode = 1;
  }
}

main();
