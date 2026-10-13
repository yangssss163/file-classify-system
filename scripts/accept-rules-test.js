/**
 * 验收第 6 条：规则引擎（不依赖界面，纯逻辑）。
 * 标准由控制台写死，工作台只执行，不放宽。
 *
 * 断言：
 *   一、关键词规则：文件名含「发票」的进该规则指定的分类，不含的不会被误分；
 *   二、大小规则：真在临时目录里造一个 2KB 文件与一个 3MB 文件，分别落进「小」「大」两条规则指定的分类；
 *   三、时间规则：把一个文件的修改时间设成「去年」，落进「去年」那条规则指定的分类（取修改时间）；
 *   四、顺序优先（核心）：`*.txt → A` 与更靠上的「关键词含 abc → B」同时存在时 `abc.txt` 进 B；
 *       两条顺序对调后，同一个文件必须进 A —— 真的验证了顺序会改变结果；
 *   五、组合条件：「后缀是 txt」且「关键词含 abc」对 `abc.txt` 命中、对 `xyz.txt` 不命中；
 *   六、兜底：所有规则都不命中的文件进「其他」，且这个名字与既有实现用的完全一致（不许写死第二份）；
 *   七、默认规则等价：用「默认规则表」跑一遍既有后缀分类用例（五组 + 无后缀文件），
 *       结果与第 1 条断言的期望逐条一致（改成规则表之后行为没变）。
 *
 * 全部通过：stdout 打印「规则引擎OK」并 exit 0；
 * 任何一条不过：stdout 打印「验收失败:规则引擎」并 exit 1。
 *
 * 只往系统临时目录里写自己造的测试文件，不碰用户的规则文件、不碰输出文件夹。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outDir = process.env.DSH_ACCEPT_OUT || path.join(projectRoot, 'out');

function log(line) {
  console.log(line);
}

const results = [];
function check(name, fn) {
  try {
    fn();
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

function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

/** 文件信息（纯内存给，不读盘）。 */
function info(over) {
  return { path: '', name: '', ext: '', size: null, mtimeMs: null, ...over };
}

/** 造一条规则。 */
function rule(name, condition, enabled) {
  return { id: `r-${name}`, name, enabled: enabled !== false, condition: condition || {} };
}

/** 规则：后缀（不限就传空数组）。 */
const byExt = (...exts) => ({ extensions: exts });
/** 规则：关键词。 */
const byKey = (...keys) => ({ keywords: keys });
/** 规则：大小档（字节；null = 不限那一侧）。 */
const bySize = (min, max) => ({ minSize: min, maxSize: max });
/** 规则：修改时间档。 */
const byTime = (bucket) => ({ modTime: bucket });

const MB = 1024 * 1024;

let core = null;
let tmpRoot = null;

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

(async () => {
  log('=== accept-rules-test: the rule engine must classify by user-defined rules ===');
  log(`project root: ${projectRoot}`);

  try {
    core = require(path.join(outDir, 'core', 'index.js'));
  } catch (err) {
    log(`FAIL: 无法加载编译后的 core：${path.join(outDir, 'core', 'index.js')}`);
    log(String((err && err.message) || err));
    log('验收失败:规则引擎');
    process.exitCode = 1;
    return;
  }

  for (const fn of ['matchRule', 'evaluateFile', 'matchesRule', 'defaultRules', 'FALLBACK_FOLDER', 'bucketOf']) {
    if (core[fn] === undefined) {
      log(`FAIL: 编译产物里没有 ${fn}（规则引擎不完整）`);
      log('验收失败:规则引擎');
      process.exitCode = 1;
      return;
    }
  }

  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-rules-'));
    log(`temp work dir: ${tmpRoot}`);

    const folderOf = (table, fileInfo) => core.matchRule(table, fileInfo).folder;

    /* ---------- 一、关键词规则 ---------- */
    check('keyword: 文件名含「发票」→ 发票；不含的不被误分', () => {
      const table = [rule('发票', byKey('发票'))];
      eq(folderOf(table, info({ name: '2026年发票.txt', ext: 'txt' })), '发票', '含「发票」的文件');
      eq(folderOf(table, info({ name: '发票扫描.pdf', ext: 'pdf' })), '发票', '含「发票」的 pdf');
      eq(folderOf(table, info({ name: '账单.txt', ext: 'txt' })), core.FALLBACK_FOLDER, '不含「发票」的文件');
      // 大小写不敏感
      eq(folderOf([rule('票', byKey('INVOICE'))], info({ name: 'my-invoice-2026.pdf', ext: 'pdf' })), '票', '关键词大小写不敏感');
      eq(folderOf([rule('票', byKey('INVOICE'))], info({ name: 'INVOICE.PDF', ext: 'pdf' })), '票', '关键词大小写不敏感（大写文件名）');
    });

    /* ---------- 二、大小规则（真造文件） ---------- */
    check('size: 2KB → 小，3MB → 大（真读文件属性）', () => {
      const small = path.join(tmpRoot, 'small-2kb.bin');
      const large = path.join(tmpRoot, 'large-3mb.bin');
      fs.writeFileSync(small, Buffer.alloc(2 * 1024, 1));
      fs.writeFileSync(large, Buffer.alloc(3 * MB, 2));
      eq(fs.statSync(small).size, 2 * 1024, '2KB 文件的实际大小');
      eq(fs.statSync(large).size, 3 * MB, '3MB 文件的实际大小');

      const table = [
        rule('小', bySize(null, 1 * MB)),
        rule('大', bySize(1 * MB, 100 * MB)),
      ];
      eq(core.evaluateFile(table, { path: small, name: 'small-2kb.bin', ext: 'bin', size: 2 * 1024, mtimeMs: Date.now() }), '小', '2KB 文件');
      eq(core.evaluateFile(table, { path: large, name: 'large-3mb.bin', ext: 'bin', size: 3 * MB, mtimeMs: Date.now() }), '大', '3MB 文件');
      // 上界 100MB 不含：100MB 既不进小也不进大，落兜底
      const hundred = 100 * MB;
      eq(core.evaluateFile(table, info({ name: 'huge.bin', ext: 'bin', size: hundred })), core.FALLBACK_FOLDER, '100MB 文件（上界不含）');
    });

    /* ---------- 三、时间规则（真的改 mtime） ---------- */
    check('time: 修改时间设成「去年」→ 去年那条规则指定的分类', () => {
      const file = path.join(tmpRoot, 'old-photo.jpg');
      fs.writeFileSync(file, 'x');
      // 去年年初之后一小时：无论哪天跑都稳稳落在去年
      const st = fs.statSync(file);
      const lastYearStart = new Date(new Date().getFullYear() - 1, 0, 1, 1, 0, 0).getTime();
      fs.utimesSync(file, new Date(lastYearStart), new Date(lastYearStart));
      const st2 = fs.statSync(file);
      const realYear = new Date(st2.mtimeMs).getFullYear();
      ok(realYear === new Date().getFullYear() - 1, `测试文件的修改时间年份期望去年，实际 ${realYear}`);

      const table = [
        rule('今年', byTime('this-year')),
        rule('去年', byTime('last-year')),
        rule('更早', byTime('earlier')),
      ];
      eq(core.evaluateFile(table, { path: file, name: 'old-photo.jpg', ext: 'jpg', size: st2.size, mtimeMs: st2.mtimeMs }), '去年', '去年修改的文件');
      eq(core.evaluateFile(table, info({ name: 'now.jpg', ext: 'jpg', size: 1, mtimeMs: Date.now() })), '今年', '今年修改的文件');
      eq(core.evaluateFile(table, info({ name: 'ancient.jpg', ext: 'jpg', size: 1, mtimeMs: new Date(2000, 5, 5).getTime() })), '更早', '更早修改的文件');
      // 分档函数本身
      const now = new Date(2026, 5, 1).getTime();
      eq(core.bucketOf(new Date(2026, 0, 1).getTime(), now), 'this-year', '分档：今年');
      eq(core.bucketOf(new Date(2025, 0, 1).getTime(), now), 'last-year', '分档：去年');
      eq(core.bucketOf(new Date(2024, 11, 31).getTime(), now), 'earlier', '分档：更早');
      // 读不到时间时，「时间」这一项不算命中
      eq(core.evaluateFile([rule('去年', byTime('last-year'))], info({ name: 'no-time.jpg', ext: 'jpg', size: 1, mtimeMs: null })), core.FALLBACK_FOLDER, '读不到时间不许误判成去年');
    });

    /* ---------- 四、顺序优先（核心） ---------- */
    check('order: 第一条命中的生效，对调顺序会改变结果', () => {
      const txtFirst = [rule('A', byExt('txt')), rule('B', byKey('abc'))];
      const keyFirst = [rule('B', byKey('abc')), rule('A', byExt('txt'))];
      const abcTxt = info({ name: 'abc.txt', ext: 'txt', size: 10, mtimeMs: Date.now() });
      const plainTxt = info({ name: 'plain.txt', ext: 'txt', size: 10, mtimeMs: Date.now() });
      const abcPng = info({ name: 'abc.png', ext: 'png', size: 10, mtimeMs: Date.now() });

      eq(core.evaluateFile(txtFirst, abcTxt), 'A', '后缀规则在上时 abc.txt');
      eq(core.evaluateFile(keyFirst, abcTxt), 'B', '关键词规则在上时 abc.txt（同一文件，结果必须不同）');
      ok(
        core.evaluateFile(txtFirst, abcTxt) !== core.evaluateFile(keyFirst, abcTxt),
        '顺序对调后同一个文件的结果必须改变（顺序真的起作用）',
      );
      eq(core.evaluateFile(keyFirst, plainTxt), 'A', '不含 abc 的 txt 仍进 A');
      eq(core.evaluateFile(keyFirst, abcPng), 'B', '含 abc 的 png 进 B');
      // 命中的是哪条规则 / 是不是兜底，也要如实给出
      const m = core.matchRule(keyFirst, abcTxt);
      eq(m.index, 0, '命中的规则下标');
      eq(m.rule && m.rule.name, 'B', '命中的规则名');
      eq(m.fallback, false, '命中时 fallback 必须是 false');
    });

    /* ---------- 五、组合条件（同一条规则里不同种类是「并且」） ---------- */
    check('combine: 后缀 txt 且 关键词 abc —— abc.txt 命中，xyz.txt 不命中', () => {
      const table = [rule('组合', { extensions: ['txt'], keywords: ['abc'] })];
      eq(core.evaluateFile(table, info({ name: 'abc.txt', ext: 'txt', size: 1, mtimeMs: Date.now() })), '组合', 'abc.txt');
      eq(core.evaluateFile(table, info({ name: 'xyz.txt', ext: 'txt', size: 1, mtimeMs: Date.now() })), core.FALLBACK_FOLDER, 'xyz.txt 不该命中');
      eq(core.evaluateFile(table, info({ name: 'abc.pdf', ext: 'pdf', size: 1, mtimeMs: Date.now() })), core.FALLBACK_FOLDER, 'abc.pdf 不该命中（后缀不符）');
      // 同一种条件里多个值是「或者」
      const orTable = [rule('图片或文档', { extensions: ['jpg', 'pdf'] })];
      eq(core.evaluateFile(orTable, info({ name: 'a.jpg', ext: 'jpg', size: 1, mtimeMs: Date.now() })), '图片或文档', '同种条件多个值：jpg');
      eq(core.evaluateFile(orTable, info({ name: 'a.pdf', ext: 'pdf', size: 1, mtimeMs: Date.now() })), '图片或文档', '同种条件多个值：pdf');
      eq(core.evaluateFile(orTable, info({ name: 'a.png', ext: 'png', size: 1, mtimeMs: Date.now() })), core.FALLBACK_FOLDER, '同种条件多个值：png 不在表里');
      // 后缀大小写不敏感
      eq(core.evaluateFile(orTable, info({ name: 'a.JPG', ext: 'jpg', size: 1, mtimeMs: Date.now() })), '图片或文档', '后缀大小写不敏感（大写文件名的 jpg）');
      // 停用的规则直接跳过
      const disabled = [rule('停用的', byExt('txt'), false), rule('真规则', byExt('txt'))];
      eq(core.evaluateFile(disabled, info({ name: 'a.txt', ext: 'txt', size: 1, mtimeMs: Date.now() })), '真规则', '停用的规则必须被跳过');
    });

    /* ---------- 六、兜底分类 ---------- */
    check('fallback: 都不命中进「其他」，名字与既有实现完全一致', () => {
      const fallback = core.FALLBACK_FOLDER;
      eq(fallback, core.FOLDER_OTHERS, '兜底分类名必须就是既有实现的 FOLDER_OTHERS');
      eq(fallback, '05_其他', '兜底分类的名字');
      // 既有实现里那个名字也是从同一个常量来的：classifyFile 对未知后缀给的就是它
      eq(core.classifyFile('D:\\收件箱\\unknown.xyz'), fallback, '既有的 classifyFile 对未知后缀的兜底');
      const table = [rule('媒体', byExt('mp4')), rule('文档', byExt('pdf'))];
      eq(core.evaluateFile(table, info({ name: 'a.xyz', ext: 'xyz', size: 1, mtimeMs: Date.now() })), fallback, '都不命中 → 兜底');
      // 空规则表：全都进兜底
      eq(core.evaluateFile([], info({ name: 'a.jpg', ext: 'jpg', size: 1, mtimeMs: Date.now() })), fallback, '一条规则都没有 → 兜底');
    });

    /* ---------- 七、默认规则表与原后缀分类逐条一致 ---------- */
    check('default: 默认规则表跑既有后缀分类用例，结果与第 1 条断言的期望逐条一致', () => {
      const expectFolder = {
        'a.JPG': '01_图片',
        'b.pdf': '02_文档',
        'c.mp3': '03_音视频',
        'd.zip': '04_压缩包',
        'e.xyz': '05_其他',
        noext: '05_其他',
        'f.png': '01_图片',
        'g.txt': '02_文档',
        'h.mkv': '03_音视频',
      };
      const table = core.defaultRules();
      ok(Array.isArray(table) && table.length > 0, '默认规则表不能为空');
      for (const [name, want] of Object.entries(expectFolder)) {
        const got = core.evaluateFile(table, { path: `D:\\收件箱\\${name}`, name, ext: core.extensionOf(name), size: null, mtimeMs: null });
        eq(got, want, `${name} 在默认规则表下的分类`);
        eq(core.classifyFile(`D:\\收件箱\\${name}`), want, `${name} 按既有实现的分类`);
      }
      // 默认规则表给出来的文件夹名，必须与既有实现的五个分类完全一致
      const names = table.map((r) => r.name);
      for (const want of ['01_图片', '02_文档', '03_音视频', '04_压缩包', '05_其他']) {
        ok(names.includes(want), `默认规则表里缺少 ${want}（实际：${names.join(', ')}）`);
      }
      // 默认规则表每次都是新的副本，用户改了不许污染默认表
      const copy = core.defaultRules();
      copy[0].name = '改坏了';
      eq(core.defaultRules()[0].name, '01_图片', '默认规则表必须是每次新的一份');
    });

    /* ---------- 规则能存能读（写盘只落在临时目录） ---------- */
    check('store: 规则能保存再读回；文件坏了/不存在都回落默认规则且不崩', () => {
      const dir = path.join(tmpRoot, 'store');
      const file = path.join(dir, 'organizer-rules.json');
      const mine = [rule('发票', byKey('发票')), rule('大文件', bySize(100 * MB, null))];
      const saved = core.saveRulesToFile(file, mine);
      eq(saved.ok, true, `保存规则应当成功（${saved.message}）`);
      ok(fs.existsSync(file), '规则文件必须真的写出来');

      const loaded = core.loadRulesFromFile(file);
      eq(loaded.ok, true, '读回规则应当成功');
      eq(loaded.source, 'file', '读回的来源应当是文件');
      eq(loaded.rules.length, 2, '读回的规则条数');
      eq(loaded.rules[0].name, '发票', '读回的第一条规则名');
      eq(JSON.stringify(loaded.rules[0].condition.keywords), JSON.stringify(['发票']), '读回的关键词条件');
      eq(loaded.rules[1].condition.minSize, 100 * MB, '读回的大小条件');

      // 文件不存在 → 默认规则 + 人话（不是崩）
      const missing = core.loadRulesFromFile(path.join(tmpRoot, 'store', 'never-written.json'));
      eq(missing.ok, true, '文件不存在时应当回落默认规则而不是失败');
      eq(missing.source, 'default', '文件不存在时的来源');
      eq(missing.rules.length, core.defaultRules().length, '文件不存在时给的是默认规则');
      ok(typeof missing.message === 'string' && missing.message.length > 0, '文件不存在时要给人话提示');

      // 坏文件 → 默认规则 + 人话（不是崩）
      fs.writeFileSync(file, '{ 这不是 JSON');
      const broken = core.loadRulesFromFile(file);
      eq(broken.ok, false, '坏文件应当如实报告 ok=false');
      eq(broken.source, 'default', '坏文件时的来源必须是默认规则');
      eq(broken.rules.length, core.defaultRules().length, '坏文件时给的是默认规则');
      ok(typeof broken.message === 'string' && broken.message.length > 0, '坏文件时要给人话提示');

      // 合法但空的规则表：文件名都在，只是没有规则 → 全部兜底（不许悄悄换成默认规则）
      const emptyPath = path.join(tmpRoot, 'store', 'empty-rules.json');
      core.saveRulesToFile(emptyPath, []);
      const emptyLoaded = core.loadRulesFromFile(emptyPath);
      eq(emptyLoaded.ok, true, '合法但空的规则文件应当被接受');
      eq(emptyLoaded.rules.length, 0, '合法但空的规则文件读回 0 条');
      eq(core.evaluateFile(emptyLoaded.rules, info({ name: 'a.jpg', ext: 'jpg', size: 1, mtimeMs: Date.now() })), core.FALLBACK_FOLDER, '空规则表 → 全部兜底');
    });
  } catch (err) {
    log(`FAIL: 测试过程本身出错 -> ${(err && err.stack) || err}`);
    results.push(['unexpected-error', false]);
  } finally {
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判定 */
      }
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
    log('规则引擎OK');
    process.exitCode = 0;
  } else {
    log('验收失败:规则引擎');
    process.exitCode = 1;
  }
})();
