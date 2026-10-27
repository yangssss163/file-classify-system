/**
 * 纯逻辑（不依赖 Electron）：把后缀分类 + 同名换名拼在一步。
 *
 * `classify.ts` 只回答「这个后缀去哪个文件夹」；
 * 本文件回答「这一批文件落到输出目录时，各自最终叫什么名字」。
 * 换名需要先知道目标文件夹里已有什么，所以真正的探测（fs）在 `copyFiles.ts` 里，
 * 这里只保留可脱离磁盘测试的纯函数。
 */
import { classifyFiles, classifyFile, pickUniqueName, type FileClassifyEntry, type RuleTable } from './classify';
import { normalizeCategoryPath } from './rules';

export { pickUniqueName, splitFileName, MAX_RENAME_ATTEMPTS } from './classify';
export type { UniqueNameResult, SplitName } from './classify';

/* ---------------- 显式分类（这次「谁去哪个夹」由调用方给，不再按规则算） ---------------- */

/**
 * 一条显式分类：`source` 是原文件完整路径，`category` 是分类夹名（可多级，如 `照片\风光`）。
 *
 * 用在哪：AI 分好之后直接按它的结论落盘（不必先翻译成规则再绕一圈）。
 * 只有**原本会按规则分类的那些文件**才看这张表；子文件夹里的文件仍原样保留，
 * 所以它替换的只是「按规则算分类名」这一步，其余规矩（同名下沉 / 各归各 / 不覆盖）一条不变。
 */
export interface CategoryAssignment {
  source: string;
  category: string;
}

/**
 * 把显式分类清单收成一张表：小写完整路径 → **归一化之后**的分类路径。
 *
 * 归一化用规则那套（与「规则里写的分类名」同一个函数）：非法 / 危险的分类名
 * （绝对路径、`..` 跳出、Windows 保留字…）**不进表** —— 那个文件自然回落到按规则算，
 * 绝不会因为模型给了个危险名字就写到源文件夹树之外。
 */
export function categoryTableOf(
  list: readonly CategoryAssignment[] | null | undefined,
): Map<string, string> {
  const table = new Map<string, string>();
  for (const item of list ?? []) {
    const source = String(item?.source ?? '').trim();
    if (source.length === 0) continue;
    const normalized = normalizeCategoryPath(String(item?.category ?? ''));
    if (!normalized.ok || normalized.path.length === 0) continue;
    table.set(source.toLowerCase(), normalized.path);
  }
  return table;
}

/** 目标路径拼接：输出根 + 分类文件夹 + 最终文件名 */
export function targetPathFor(outputDir: string, folder: string, fileName: string): string {
  const sep = outputDir.endsWith('/') || outputDir.endsWith('\\') ? '' : '\\';
  return `${outputDir}${sep}${folder}\\${fileName}`;
}

/**
 * 纯函数：已知「输出目录下各分类文件夹里已存在的文件名」时，
 * 为这一批文件各算出一个不冲突的最终文件名（批内也互相让位）。
 *
 * @param takenByFolder 文件夹名 → 该文件夹已存在的文件名集合
 */
export function planFileNames(
  filePaths: readonly string[],
  takenByFolder: Readonly<Record<string, Iterable<string>>> = {},
  rules?: RuleTable | null,
): Array<FileClassifyEntry & { finalName: string; attempt: number; renamed: boolean }> {
  const taken = new Map<string, Set<string>>();
  for (const [folder, names] of Object.entries(takenByFolder ?? {})) {
    taken.set(folder, new Set(Array.from(names).map((n) => n.toLowerCase())));
  }

  const result: Array<FileClassifyEntry & { finalName: string; attempt: number; renamed: boolean }> = [];
  for (const entry of classifyFiles(filePaths, rules).entries) {
    const folder = entry.folder;
    if (!taken.has(folder)) taken.set(folder, new Set<string>());
    const bucket = taken.get(folder)!;
    const picked = pickUniqueName(entry.name, bucket);
    if (picked.name === null) {
      // 999 个位子都占了：保留原名，让复制阶段报失败
      result.push({ ...entry, finalName: entry.name, attempt: picked.attempt, renamed: false });
      continue;
    }
    bucket.add(picked.name.toLowerCase());
    result.push({ ...entry, finalName: picked.name, attempt: picked.attempt, renamed: picked.renamed });
  }
  return result;
}

export { classifyFile, classifyFiles };
