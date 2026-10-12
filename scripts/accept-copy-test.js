/**
 * 验收第 2 条：真实复制测试（不需要界面）。
 * 用法：node accept-copy-test.js <输出目录> <base64(原文件路径)> ...
 * 全部满足打印「复制落地OK」并 exit 0，否则 exit 1。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
const b64Paths = process.argv.slice(3);

if (!outDir || b64Paths.length === 0) {
  console.log('NG 用法：node accept-copy-test.js <输出目录> <base64 路径>...');
  process.exit(1);
}

const srcFiles = b64Paths.map((b) => Buffer.from(b, 'base64').toString('utf8'));

let core;
try {
  core = require(path.join(__dirname, '..', 'out', 'core', 'index.js'));
} catch (err) {
  console.log(`NG 无法加载编译后的复制模块：${String(err && err.message)}`);
  process.exit(1);
}

const fail = (msg) => {
  console.log(`NG ${msg}`);
  process.exit(1);
};

const FOLDERS = ['01_图片', '02_文档', '03_音视频', '04_压缩包', '05_其他'];

(async () => {
  try {
    const summary = await core.copyFiles({ outputDir: outDir, files: srcFiles });
    console.log(`   复制结果：共 ${summary.total}，成功 ${summary.successCount}，失败 ${summary.failureCount}`);
    for (const r of summary.results) {
      const line = `   ${r.ok ? '成功' : '失败'} ${path.basename(r.source)} -> ${r.folder}\\${r.finalName}`;
      console.log(r.ok ? line : `${line}  原因：${r.error}`);
    }

    assert.strictEqual(summary.total, srcFiles.length, `处理总数期望 ${srcFiles.length}，实际 ${summary.total}`);

    // 五个分类文件夹都被创建
    for (const folder of FOLDERS) {
      const dir = path.join(outDir, folder);
      assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `分类文件夹没建出来：${folder}`);
    }

    // 每个文件都在对应文件夹里（按「文件名 → 预期文件夹」逐一核对整棵输出树）
    const found = new Map(); // 文件名小写 -> 所在文件夹
    for (const folder of FOLDERS) {
      for (const name of fs.readdirSync(path.join(outDir, folder))) {
        found.set(name.toLowerCase(), folder);
      }
      console.log(`   ${folder}: ${fs.readdirSync(path.join(outDir, folder)).join(', ') || '(空)'}`);
    }

    for (const src of srcFiles) {
      const name = path.basename(src).toLowerCase();
      const wantFolder = core.classifyFile(src);
      const gotFolder = found.get(name);
      assert.ok(gotFolder !== undefined, `输出里找不到文件：${path.basename(src)}`);
      assert.strictEqual(gotFolder, wantFolder, `${path.basename(src)} 期望落在 ${wantFolder}，实际 ${gotFolder}`);
    }

    // 原文件依然存在
    for (const src of srcFiles) {
      assert.ok(fs.existsSync(src), `原文件不见了（绝不允许）：${src}`);
    }

    // 输出目录里文件总数 = 9
    let total = 0;
    for (const folder of FOLDERS) total += fs.readdirSync(path.join(outDir, folder)).length;
    assert.strictEqual(total, srcFiles.length, `输出目录里文件总数期望 ${srcFiles.length}，实际 ${total}`);
    console.log(`   原文件全部健在，输出目录文件总数 ${total}`);
  } catch (err) {
    fail(String((err && err.message) || err));
  }

  console.log('复制落地OK');
  process.exit(0);
})();
