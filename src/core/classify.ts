/**
 * 纯逻辑：文件 → 目标分类文件夹名。
 *
 * 本文件**不依赖 Electron**，只用路径字符串运算，可被 node 直接 require，
 * 也可以在没有界面的情况下独立测试。
 *
 * 分类规则本身在 `rules.ts` 里（用户可自定义的规则表）。本文件提供：
 *   - 五个固定分类文件夹名与后缀分组（`EXT_GROUPS`）——默认规则表的**唯一来源**；
 *   - 路径运算（取文件名 / 取后缀）；
 *   - 同名冲突换名。
 * 求值一律走 `rules.ts` 的 `matchRule`，不存在第二份分类逻辑。
 */
import {
  FALLBACK_FOLDER,
  defaultRules,
  folderNamesOf,
  matchRule,
  type FileInfo,
  type RuleTable,
} from './rules';

export { FALLBACK_FOLDER };
export {
  FALLBACK_RULE_NAME,
  MOD_TIME_BUCKETS,
  MOD_TIME_LABELS,
  defaultRules,
  createDefaultRules,
  knownExtensions,
  bucketOf,
  evaluateFile,
  matchRule,
  matchesRule,
  folderNamesOf,
  activeFolderNamesOf,
} from './rules';
export type { FileInfo, ModTimeBucket, Rule, RuleCondition, RuleMatch, RuleTable } from './rules';

/** 本片写死的五个分类文件夹（顺序即展示顺序）。 */
export const FOLDER_IMAGES = '01_图片';
export const FOLDER_DOCUMENTS = '02_文档';
export const FOLDER_MEDIA = '03_音视频';
export const FOLDER_ARCHIVES = '04_压缩包';
export const FOLDER_OTHERS = '05_其他';

/** 五个分类文件夹的固定顺序。 */
export const CATEGORY_ORDER: readonly string[] = [
  FOLDER_IMAGES,
  FOLDER_DOCUMENTS,
  FOLDER_MEDIA,
  FOLDER_ARCHIVES,
  FOLDER_OTHERS,
];

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
const DOCUMENT_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'];
const MEDIA_EXTS = ['mp3', 'wav', 'mp4', 'mov', 'avi', 'mkv'];
const ARCHIVE_EXTS = ['zip', 'rar', '7z', 'tar', 'gz'];

/**
 * 后缀分组：默认规则表的唯一来源（`rules.ts` 据此生成「按后缀分五类」的默认规则）。
 * 不许在别处再写一份后缀表。
 */
export const EXT_GROUPS: ReadonlyArray<{ folder: string; extensions: readonly string[] }> = [
  { folder: FOLDER_IMAGES, extensions: IMAGE_EXTS },
  { folder: FOLDER_DOCUMENTS, extensions: DOCUMENT_EXTS },
  { folder: FOLDER_MEDIA, extensions: MEDIA_EXTS },
  { folder: FOLDER_ARCHIVES, extensions: ARCHIVE_EXTS },
];

/** 后缀（小写，不含点） → 文件夹名（只用于给人看的说明；求值一律走规则表）。 */
export const EXT_TO_FOLDER: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const group of EXT_GROUPS) {
    for (const ext of group.extensions) {
      map.set(ext, group.folder);
    }
  }
  return map;
})();

/** 取路径最后一段（文件名）。同时接受 `/` 与 `\` 分隔符。 */
export function baseName(filePath: string): string {
  const cleaned = String(filePath ?? '').replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * 取文件后缀，小写、不含点。
 * 规则：
 *  - 没有任何后缀（`noext`）→ 空字符串，归类到 05_其他
 *  - 只以点开头的隐藏文件（`.gitignore`）→ 视作没有后缀
 *  - 结尾的点（`a.`）→ 视作没有后缀
 */
export function extensionOf(filePath: string): string {
  const name = baseName(filePath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 只凭路径能给出的文件信息（没有大小与时间——那两样要真读文件属性，读盘的事在别处做）。
 * 这里只负责后缀/文件名，供只做纯字符串运算的场合使用。
 */
export function fileInfoOf(filePath: string): FileInfo {
  return { path: String(filePath ?? ''), name: baseName(filePath), ext: extensionOf(filePath), size: null, mtimeMs: null };
}

/**
 * 单个路径 → 目标分类文件夹名（用默认规则表）。
 * 大小与时间条件需要读文件属性，这里给不出（视为「不参与判断」），所以本函数只适合
 * 只按后缀/关键词判断的默认规则；真正整理与预览走 `rules.ts` 的求值 + 真实元信息。
 */
export function classifyFile(filePath: string, rules?: RuleTable | null): string {
  const table = rules ?? defaultRules();
  return matchRule(table, fileInfoOf(filePath)).folder;
}

/** 「文件 → 目标文件夹」的一条映射。 */
export interface FileClassifyEntry {
  /** 原文件路径（原样保留，不改写） */
  path: string;
  /** 文件名（含后缀） */
  name: string;
  /** 小写后缀，不含点；无后缀为 '' */
  ext: string;
  /** 目标分类文件夹名 */
  folder: string;
}

/** 按文件夹分组的树：文件夹名 → 该组下的文件条目。 */
export type ClassifyTree = Record<string, FileClassifyEntry[]>;

export interface ClassifyResult {
  /** 文件 → 目标文件夹 的映射（顺序与输入一致） */
  entries: FileClassifyEntry[];
  /** 按文件夹分组的树（固定包含五个分类文件夹，空分组也在，便于后面建目录） */
  tree: ClassifyTree;
  /** 每个文件夹里的文件条数 */
  counts: Record<string, number>;
}

/** 纯函数：输入文件路径列表，输出「文件 → 目标文件夹」映射 + 按文件夹分组的树。 */
export function classifyFiles(filePaths: readonly string[], rules?: RuleTable | null): ClassifyResult {
  const table = rules ?? defaultRules();
  const entries: FileClassifyEntry[] = [];
  const tree: ClassifyTree = {};
  const counts: Record<string, number> = {};

  for (const folder of folderNamesOf(table)) {
    tree[folder] = [];
    counts[folder] = 0;
  }

  for (const raw of filePaths ?? []) {
    const p = String(raw);
    const info = fileInfoOf(p);
    const entry: FileClassifyEntry = {
      path: p,
      name: info.name ?? baseName(p),
      ext: info.ext ?? extensionOf(p),
      folder: matchRule(table, info).folder,
    };
    entries.push(entry);
    if (!tree[entry.folder]) {
      tree[entry.folder] = [];
      counts[entry.folder] = 0;
    }
    tree[entry.folder].push(entry);
    counts[entry.folder] = (counts[entry.folder] ?? 0) + 1;
  }

  return { entries, tree, counts };
}

/* ------------------------------------------------------------------ *
 * 同名冲突换名规则（纯函数，无 IO）
 * ------------------------------------------------------------------ */

/** 换名最多试到 999，再冲突就判失败。 */
export const MAX_RENAME_ATTEMPTS = 999;

export interface SplitName {
  /** 主名（不含后缀） */
  stem: string;
  /** 后缀，含点；无后缀为 '' */
  extension: string;
}

/** `a.jpg` → { stem: 'a', extension: '.jpg' }；`noext` → { stem: 'noext', extension: '' } */
export function splitFileName(name: string): SplitName {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

export interface UniqueNameResult {
  /** 可用的文件名；取不到时为 null */
  name: string | null;
  /** 实际用的序号，0 表示原名直接可用 */
  attempt: number;
  /** 是否发生了换名 */
  renamed: boolean;
}

/**
 * 纯函数：在给定「已占用名字集合」下找一个不冲突的文件名。
 *
 * 规则：原名可用就用原名；否则依次试 `原名 (1).后缀` … `原名 (999).后缀`（不含 0 号）。
 * 全都被占用则返回 `{ name: null, attempt: 999, renamed: true }`，由调用方记为失败。
 * 查重大小写不敏感（Windows 文件系统语义）。
 * 本函数不真正探测磁盘，由调用方把已存在的文件名喂进 `taken`。
 */
export function pickUniqueName(
  originalName: string,
  taken: ReadonlySet<string>,
  maxAttempts: number = MAX_RENAME_ATTEMPTS,
): UniqueNameResult {
  const { stem, extension } = splitFileName(originalName);
  const lower = (s: string) => s.toLowerCase();

  const occupied = new Set<string>();
  for (const t of taken) occupied.add(lower(t));

  const candidate = (attempt: number) =>
    attempt === 0 ? `${stem}${extension}` : `${stem} (${attempt})${extension}`;

  const limit = Math.max(0, Math.min(maxAttempts, MAX_RENAME_ATTEMPTS));
  for (let attempt = 0; attempt <= limit; attempt++) {
    const name = candidate(attempt);
    if (!occupied.has(lower(name))) {
      return { name, attempt, renamed: attempt !== 0 };
    }
  }
  return { name: null, attempt: limit, renamed: true };
}
