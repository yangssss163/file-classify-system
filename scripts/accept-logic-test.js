/**
 * 验收第 1 条：纯逻辑测试（不需要界面）。
 * 用法：node accept-logic-test.js <编译输出目录>
 * 全部通过打印「分类逻辑OK」并 exit 0，否则 exit 1。
 */
'use strict';

const assert = require('assert');
const path = require('path');

const outDir = process.argv[2];
if (!outDir) {
  console.log('NG 缺少参数：编译输出目录');
  process.exit(1);
}

let core;
try {
  core = require(path.join(outDir, 'core', 'index.js'));
} catch (err) {
  console.log(`NG 无法加载编译后的分类模块：${path.join(outDir, 'core', 'index.js')}`);
  console.log(String(err && err.message));
  process.exit(1);
}

const fail = (msg) => {
  console.log(`NG ${msg}`);
  process.exit(1);
};

try {
  // --- 断言组 1：后缀 → 文件夹名 ---
  const expectFolder = {
    'a.JPG': '01_图片',
    'b.pdf': '02_文档',
    'c.mp3': '03_音视频',
    'd.zip': '04_压缩包',
    'e.xyz': '05_其他',
    noext: '05_其他',
  };
  for (const [name, want] of Object.entries(expectFolder)) {
    const got = core.classifyFile(`D:\\收件箱\\${name}`);
    assert.strictEqual(got, want, `${name} 期望 ${want}，实际 ${got}`);
    console.log(`   ok ${name} -> ${got}`);
  }

  // --- 断言组 2：同名冲突换名 ---
  const taken = new Set(['a.jpg']);
  const second = core.pickUniqueName('a.jpg', taken);
  assert.strictEqual(second.name, 'a (1).jpg', `第二个 a.jpg 期望 a (1).jpg，实际 ${second.name}`);
  taken.add(second.name.toLowerCase());
  const third = core.pickUniqueName('a.jpg', taken);
  assert.strictEqual(third.name, 'a (2).jpg', `第三个 a.jpg 期望 a (2).jpg，实际 ${third.name}`);
  console.log(`   ok 同名冲突 -> ${second.name} / ${third.name}`);

  // --- 断言组 3：100 个混合文件 ---
  const exts = ['jpg', 'pdf', 'mp3', 'zip', 'xyz'];
  const expectedByExt = {
    jpg: '01_图片',
    pdf: '02_文档',
    mp3: '03_音视频',
    zip: '04_压缩包',
    xyz: '05_其他',
  };
  const mixed = [];
  const expectMap = {};
  for (let i = 0; i < 100; i++) {
    const useNoExt = i >= 90;
    const ext = exts[i % exts.length];
    const name = `f${i}${useNoExt ? '' : '.' + ext}`;
    const p = `D:\\收件箱\\mixed\\${name}`;
    mixed.push(p);
    expectMap[p] = useNoExt ? '05_其他' : expectedByExt[ext];
  }

  const res = core.classifyFiles(mixed);
  assert.strictEqual(res.entries.length, 100, `映射条数期望 100，实际 ${res.entries.length}`);

  for (const entry of res.entries) {
    const want = expectMap[entry.path];
    if (entry.folder !== want) fail(`${entry.path} 期望 ${want}，实际 ${entry.folder}`);
  }

  const allowed = new Set(Object.values(expectedByExt).concat(['05_其他']));
  for (const folder of Object.keys(res.tree)) {
    if (!allowed.has(folder)) fail(`出现了预期之外的分组：${folder}`);
    for (const entry of res.tree[folder]) {
      if (entry.folder !== folder) fail(`分组 ${folder} 里混进了 ${entry.folder} 的文件`);
    }
  }
  const grouped = Object.values(res.tree).reduce((n, list) => n + list.length, 0);
  assert.strictEqual(grouped, 100, `按文件夹分组的文件总数期望 100，实际 ${grouped}`);
  console.log(`   ok 100 个混合文件：条数 ${res.entries.length}，分组 ${JSON.stringify(res.counts)}`);
} catch (err) {
  fail(String((err && err.message) || err));
}

console.log('分类逻辑OK');
process.exit(0);
