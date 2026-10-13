/**
 * 纯逻辑（只读）：把「真实文件元信息 + 规则表」拼起来求分类。
 *
 * 为什么单独一个文件：**预览与执行必须用同一个求值入口**，
 * 否则会出现「预览说去 A、执行却去了 B」。所以两边都调这里的 `classifyWithMeta()`。
 * 本文件只做只读的 `stat`，不建目录、不写文件、不写配置，也不依赖 Electron。
 */
import * as fssync from 'fs';
import { baseName, extensionOf } from './classify';
import { defaultRules, matchRule, type FileInfo, type RuleMatch, type RuleTable } from './rules';

/** 只读探测一个文件的元信息；读不到就给 null（大小/时间条件视为不命中，绝不抛出去）。 */
export function readFileInfo(filePath: string): { size: number | null; mtimeMs: number | null } {
  try {
    const st = fssync.statSync(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { size: null, mtimeMs: null };
  }
}

/** 文件名 + 后缀 + 只读元信息 → 求值用的 FileInfo。 */
export function fileInfoWithMeta(filePath: string): FileInfo {
  const path = String(filePath ?? '');
  const name = baseName(path);
  const meta = readFileInfo(path);
  return { path, name, ext: extensionOf(path), size: meta.size, mtimeMs: meta.mtimeMs };
}

/**
 * 求值入口：按规则表算这条路径去哪个分类文件夹（含命中的是哪条规则）。
 * 元信息已经给定时（`info`）就不再读盘，便于纯内存测试。
 */
export function classifyWithMeta(
  rules: RuleTable | null | undefined,
  filePath: string,
  fileName?: string,
  info?: FileInfo,
): RuleMatch {
  const path = String(filePath ?? '');
  const name = fileName ?? baseName(path);
  const fileInfo: FileInfo = info ?? (() => {
    const meta = readFileInfo(path);
    return { path, name, ext: extensionOf(path), size: meta.size, mtimeMs: meta.mtimeMs };
  })();
  return matchRule(rules ?? defaultRules(), fileInfo);
}
