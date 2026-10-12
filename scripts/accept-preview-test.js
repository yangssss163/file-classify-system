/**
 * 验收第 4 条：预览不落盘（不需要界面）。
 * 用法：node accept-preview-test.js <编译输出目录> <空的输出目录> <base64(原文件路径)> ...
 *
 * 三条断言全满足打印「预览不落盘OK」并 exit 0，否则打印「验收失败:预览不落盘」并 exit 1。
 *
 * 断言一：预览树的分组 + 每个文件的目标分类，与「直接调用分类规则」的结果逐条一致
 *         （期望值由分类规则现算，不写死）。
 * 断言二：预览树里能查到每个分类的文件数与总数（总数 = 输入文件数，各分类数之和 = 总数）。
 * 断言三：预览前后，输出目录里的文件数与目录数必须都是 0（预览没建过任何目录、没写过任何文件）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
const previewOutputDir = process.argv[3];
const b64Paths = process.argv.slice(4);

if (!outDir || !previewOutputDir || b64Paths.length === 0) {
  console.log('NG 用法：node accept-preview-test.js <编译输出目录> <空的输出目录> <base64 路径>...');
  console.log('验收失败:预览不落盘');
  process.exit(1);
}

const srcFiles = b64Paths.map((b) => Buffer.from(b, 'base64').toString('utf8'));

let core;
try {
  core = require(path.join(outDir, 'core', 'index.js'));
} catch (err) {
  console.log(`NG 无法加载编译后的 core：${String(err && err.message)}`);
  console.log('验收失败:预览不落盘');
  process.exit(1);
}

const fail = (msg) => {
  console.log(`NG ${msg}`);
  console.log('验收失败:预览不落盘');
  process.exit(1);
};

if (typeof core.buildPreviewTree !== 'function') {
  fail('编译产物里没有 buildPreviewTree（预览函数不存在）');
}

/** 数一个目录树里的文件数与目录数（含隐藏项）。 */
function countTree(dir) {
  let files = 0;
  let dirs = 0;
  const walk = (d) => {
    for (const item of fs.readdirSync(d, { withFileTypes: true })) {
      if (item.isDirectory()) {
        dirs++;
        walk(path.join(d, item.name));
      } else {
        files++;
      }
    }
  };
  walk(dir);
  return { files, dirs };
}

try {
  // ---------- 预览前的输出目录：必须是空的 ----------
  if (!fs.existsSync(previewOutputDir)) fail(`输出目录不存在：${previewOutputDir}`);
  const before = countTree(previewOutputDir);
  console.log(`   预览前 输出目录：文件 ${before.files} 个，目录 ${before.dirs} 个`);

  // ---------- 调用预览（走编译产物，与第 1、2 条同样的调用方式） ----------
  const outcome = core.buildPreviewTree({ files: srcFiles, outputDir: previewOutputDir });
  if (!outcome || outcome.ok !== true) {
    fail(`预览没能给出树：${outcome && outcome.message ? outcome.message : JSON.stringify(outcome)}`);
  }
  const tree = outcome.tree;

  // ---------- 断言一：分组与每个文件的分类，和分类规则逐条一致 ----------
  // 期望值由 core.classifyFile 现算，不写死。
  const expectedByPath = new Map();
  for (const f of srcFiles) expectedByPath.set(f, core.classifyFile(f));

  const previewByPath = new Map();
  for (const f of tree.files) previewByPath.set(f.path, f);

  assert.strictEqual(tree.files.length, srcFiles.length, `预览明细条数期望 ${srcFiles.length}，实际 ${tree.files.length}`);
  for (const f of srcFiles) {
    const item = previewByPath.get(f);
    assert.ok(item, `预览里找不到这个文件：${path.basename(f)}`);
    const want = expectedByPath.get(f);
    assert.strictEqual(
      item.folder,
      want,
      `${path.basename(f)} 期望落在 ${want}，预览说 ${item.folder}`,
    );
  }

  // 每个分组里只放它自己的文件，且逐个分组里的文件都能在分类规则下对上
  const seenInGroups = [];
  const groupNames = tree.folders.map((g) => g.folder);
  for (const group of tree.folders) {
    for (const f of group.files) {
      assert.strictEqual(
        f.folder,
        group.folder,
        `分组 ${group.folder} 里混进了 ${f.folder} 的文件：${f.name}`,
      );
      assert.strictEqual(
        core.classifyFile(f.path),
        group.folder,
        `${f.name} 按分类规则应去 ${core.classifyFile(f.path)}，却被预览放进 ${group.folder}`,
      );
      seenInGroups.push(f.path);
    }
  }
  assert.strictEqual(
    new Set(seenInGroups).size,
    srcFiles.length,
    `分组里出现的文件数期望 ${srcFiles.length}，实际 ${new Set(seenInGroups).size}`,
  );
  // 分组名必须就是分类规则给出的文件夹名（同一套映射，不许自己另写一份）
  const ruleFolders = new Set(Array.from(expectedByPath.values()));
  for (const name of groupNames) {
    const isRuleFolder = ruleFolders.has(name) || name === core.classifyFile('x.noext-unknown');
    assert.ok(isRuleFolder, `出现了分类规则里没有的分组名：${name}`);
  }
  console.log(
    `   分组与分类规则逐条一致：${tree.folders.map((g) => `${g.folder}=${g.count}`).join(', ')}`,
  );

  // ---------- 断言二：能查到每个分类的文件数与总数 ----------
  let sum = 0;
  for (const group of tree.folders) {
    assert.strictEqual(
      typeof group.count,
      'number',
      `分组 ${group.folder} 没有文件数（count）`,
    );
    assert.strictEqual(
      group.count,
      group.files.length,
      `分组 ${group.folder} 的文件数 ${group.count} 与明细条数 ${group.files.length} 不符`,
    );
    assert.strictEqual(
      tree.counts[group.folder],
      group.count,
      `总表里 ${group.folder} 的文件数 ${tree.counts[group.folder]} 与分组自己的 ${group.count} 不符`,
    );
    sum += group.count;
  }
  assert.strictEqual(tree.total, srcFiles.length, `预览总数期望 ${srcFiles.length}，实际 ${tree.total}`);
  assert.strictEqual(sum, tree.total, `各分类文件数之和 ${sum} 与总数 ${tree.total} 不符`);
  console.log(`   文件数：总数 ${tree.total}，各分类之和 ${sum}，每个分类都有 count`);

  // ---------- 断言三：预览前后，输出目录的文件数与目录数都是 0 ----------
  const after = countTree(previewOutputDir);
  console.log(`   预览后 输出目录：文件 ${after.files} 个，目录 ${after.dirs} 个`);
  assert.strictEqual(after.files, 0, `预览写了文件：输出目录里有 ${after.files} 个文件`);
  assert.strictEqual(after.dirs, 0, `预览建了目录：输出目录里有 ${after.dirs} 个目录`);

  // 预览不该创建输出目录本身：给一个不存在的路径，预览完后它必须仍然不存在
  const ghostDir = path.join(path.dirname(previewOutputDir), 'never-created-preview-out');
  const ghost = core.buildPreviewTree({ files: srcFiles, outputDir: ghostDir });
  assert.strictEqual(ghost.ok, true, `给不存在的输出目录时预览失败了：${ghost && ghost.message}`);
  assert.strictEqual(
    fs.existsSync(ghostDir),
    false,
    `预览把不存在的输出目录创建出来了：${ghostDir}`,
  );

  // 没文件 / 没选输出目录：给一句人话提示，不抛错
  const noFiles = core.buildPreviewTree({ files: [], outputDir: previewOutputDir });
  assert.strictEqual(noFiles.ok, false, '没文件时预览应当给出提示而不是树');
  assert.ok(
    typeof noFiles.message === 'string' && noFiles.message.length > 0,
    '没文件时预览应当给出人话提示',
  );
  const noOut = core.buildPreviewTree({ files: srcFiles, outputDir: null });
  assert.strictEqual(noOut.ok, false, '没选输出文件夹时预览应当给出提示而不是树');
  assert.ok(
    typeof noOut.message === 'string' && noOut.message.length > 0,
    '没选输出文件夹时预览应当给出人话提示',
  );
  console.log(`   提示语：${JSON.stringify([noFiles.message, noOut.message])}`);
  const afterGhost = countTree(previewOutputDir);
  assert.strictEqual(afterGhost.files + afterGhost.dirs, 0, '边界情况调用后输出目录不再是空的');
} catch (err) {
  fail(String((err && err.message) || err));
}

console.log('预览不落盘OK');
process.exit(0);
