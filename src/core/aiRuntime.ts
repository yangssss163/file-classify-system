/**
 * 纯逻辑：**AI 分类器要用到的「跑起来才知道」的那几件事**。**不依赖 Electron**。
 *
 * 为什么单独一个文件：`aiClassify.ts` 那一边是「怎么算」（地址、请求体、解析、对上原文件、
 * 分批与重试），它编译出来的产物要能当普通脚本直接跑（**连 `require` 都不许有**）。
 * 所以凡是需要 node 内建能力的事都挪到这里：
 *   · `readFileMetadata` —— 只读 stat 拿「大小 + 修改时间」（**绝不读文件内容**）；
 *   · `hookAiRuntime`     —— 把这两件事接到 `aiClassify.ts` 上（用动态载入，载入的是本文件）。
 *
 * 纪律：本文件**只读**（stat），不建目录、不写文件、不删东西。
 */
import * as fs from 'fs';
import { hookAiRuntime, type AiFileMetadata, type AiRuntimeHooks } from './aiClassify';

/**
 * 只读元信息（大小 + 修改时间）；读不到就留 0 / 空串，绝不抛。**不读文件内容。**
 * 参数按形状收（不点名引用别的模块的类型）：只用到「文件名」这一样。
 */
function readFileMetadata(files: readonly { name?: string; path?: string }[]): AiFileMetadata[] {
  const out: AiFileMetadata[] = [];
  for (const f of files ?? []) {
    let size = 0;
    let modifiedAt = '';
    try {
      const st = fs.statSync(String(f?.path ?? ''));
      size = Number.isFinite(st.size) ? st.size : 0;
      modifiedAt = new Date(st.mtimeMs).toISOString();
    } catch {
      /* 读不到元信息不算致命：文件名还在，照样能送去分类 */
    }
    out.push({ name: String(f?.name ?? ''), size, modifiedAt });
  }
  return out;
}

const hooks: AiRuntimeHooks = { readFileMetadata };

/** 接上（`aiClassify.ts` 第一次真要发请求时会动态载入本文件，载入即接上）。 */
export function hookAiRuntimeHere(): void {
  hookAiRuntime(hooks);
}

hookAiRuntimeHere();
