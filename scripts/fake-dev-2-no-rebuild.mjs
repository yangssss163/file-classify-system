/**
 * 验收探针夹具②：**假 dev —— 假装热加载，但从不重编译**。
 * 只在 accept-dev-hot-reload-test.js 的「探针有效性」自查里用：
 * 它一直活着、也照着格式打印「就绪 / 重编译 / 窗口刷新 / 主进程重启」这些口号，
 * 但从来不跑构建，所以 out/renderer/renderer.js 与 out/main.js 不会被重新生成。
 * 验收必须抓到这个差别（产物没被重新生成 = 没真热加载），否则这套断言就是死的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = process.env.DSH_DEV_STAGE || path.join(root, '.dsh-staging');
const buildLog = path.join(stage, 'fake-dev-2-build.log');

let n = 1;
process.stdout.write('[dev] 构建完成 build#1 renderer=yes main=yes\n');
process.stdout.write('[dev] 热加载就绪（dev-ready）：这里只是喊口号，不重编译\n');

// 假装在监听：按固定节奏打印「重编译好了、窗口刷新了」，但一个字节都没重新生成
setInterval(() => {
  n += 1;
  try {
    fs.appendFileSync(buildLog, `fake build#${n}\n`);
  } catch {
    /* ignore */
  }
  process.stdout.write(`[dev] 构建完成 build#${n} renderer=yes main=yes\n`);
  process.stdout.write('[dev] renderer 变了 → 已重编译，窗口已刷新\n');
  process.stdout.write('[dev] main 变了 → 已重编译，主进程已重启\n');
}, 400);

// 一直活着，等外面的 SIGTERM / SIGKILL 来收（不去碰 stdin：stdin 被接成空的时候会立刻 EOF）
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
