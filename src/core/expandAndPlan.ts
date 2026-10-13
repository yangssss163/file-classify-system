/**
 * 纯逻辑：递归展开拖进来的文件夹 + 按「源文件夹各归各」算目标路径。**不依赖 Electron**。
 *
 * 用户定的硬要求：**不同源文件夹的文件永远不会落进同一个分类夹**。
 * 所以这里把「谁属于哪个源文件夹」当成一等公民（`SourceFolderOrigin` + `TrackedFile`），
 * 一路带到目标路径上：
 *
 *   输出根\
 *     下载\                 ← 拖入的那个源文件夹，输出根下同名一份
 *       01_图片\            ← 下载 根下散文件的分类夹
 *       照片\               ← 下载 里的子文件夹，自己独立一份
 *         01_图片\          ← 照片 里文件的分类夹（与「文档」那边完全分开）
 *         婚纱\
 *           01_图片\
 *       文档\
 *         02_文档\
 *
 * 铁律：
 *  - 递归只收**文件**；空文件夹不产生任何输出；
 *  - 读不了的子文件夹 → 跳过并记一行原因（`skipped`），绝不让整次展开失败；
 *  - 不跟随符号链接 / 快捷方式（一律跳过并记原因），避免绕圈；
 *  - 深度超过 `MAX_SCAN_DEPTH`（20）层就停下并说明原因；
 *  - 本文件只做只读的 fs.statSync / readdirSync，**不建目录、不写文件**。
 */
import * as fssync from 'fs';
import * as path from 'path';
import { pickUniqueName, MAX_RENAME_ATTEMPTS } from './classify';
import { classifyWithMeta } from './classifyWithMeta';
import type { RuleTable } from './rules';
import { describeError } from './copyFiles';

/** 递归深度上限：超过就停下并说明原因（防止循环/超深目录把程序拖死）。 */
export const MAX_SCAN_DEPTH = 20;

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 源文件夹（顶层或某一层子文件夹）的稳定身份。 */
export interface SourceFolderOrigin {
  /** 拖入的那个源文件夹的绝对路径（= 输出根下同名夹的来源） */
  rootPath: string;
  /** 源文件夹名 */
  rootName: string;
  /** 相对拖入点的各层子文件夹名；根自己就是 []，如 ['照片']、['照片','婚纱'] */
  chain: string[];
  /** 稳定身份键：由「根路径 + 各层名字」拼成（Windows 路径里不可能出现的分隔符），不会与别的源文件夹撞上 */
  key: string;
}

/** 展开出来的一个文件 + 它的源文件夹归属。 */
export interface TrackedFile {
  /**
   * 文件的绝对路径。
   * 注意字段名叫 `fullPath` 而不是 `path`：界面侧有一条从「拖入取路径」那一片传下来的纪律 ——
   * 产物里不许出现 `.path` 这种属性读法（那是 Electron 32 起被移除的 `File.path` 的写法）。
   * 纯逻辑侧本来不受这条管，但界面侧也会读这个字段，所以两边统一用 `fullPath`，免得那条探针误报。
   */
  fullPath: string;
  /** 文件名（含后缀） */
  name: string;
  /** 所属源文件夹（绝不为空——每个文件都必须有归属） */
  origin: SourceFolderOrigin;
}

/** 被跳过的子文件夹/路径（原因给人看，不抛异常）。 */
export interface SkippedPath {
  /** 出问题的那个路径 */
  fullPath: string;
  /** 它属于哪个源文件夹（顶层就是拖入的那个根） */
  originKey: string;
  /** 被跳过的那层子文件夹的名字（顶层路径没有这一项） */
  name?: string;
  /** 人话原因 */
  reason: string;
}

/** 展开结果：文件清单 + 源文件夹清单 + 被跳过的原因。 */
export interface ScanResult {
  /** 所有展开出来的文件（按遍历顺序），每个都带归属 */
  files: TrackedFile[];
  /** 所有产生过文件的源文件夹（含各层子文件夹；按发现顺序） */
  folders: SourceFolderOrigin[];
  /** 被跳过的路径与原因 */
  skipped: SkippedPath[];
}

/** 一个源文件夹在输出里的落点（含「同名不覆盖」的重命名结果）。 */
export interface PlannedFolder {
  origin: SourceFolderOrigin;
  /** 相对输出根的各层文件夹名（已按「同名不覆盖」改过名） */
  outputChain: string[];
  /** 该源文件夹自己的输出目录（绝对路径） */
  outputDir: string;
  /** 该源文件夹直属的文件个数（就是落到 outputDir\分类夹\ 的那些） */
  fileCount: number;
  /** 是否因为「有两个同名源文件夹」改过名（如「照片」→「照片 (2)」） */
  renamed: boolean;
}

/** 一个文件最终落到哪里（预览与执行**共用同一份**）。 */
export interface PlannedFile {
  /** 原文件路径（字段名同 `TrackedFile.fullPath`，避开 `.path` 那种旧写法） */
  fullPath: string;
  /** 最终文件名（同名冲突时可能已被换成「原名 (1).后缀」） */
  name: string;
  /** 目标分类文件夹名 */
  folder: string;
  /** 所属源文件夹 */
  origin: SourceFolderOrigin;
  /** 该源文件夹在输出里的落点 */
  plannedFolder: PlannedFolder;
  /** 最终目标目录（绝对路径）= 源文件夹落点 + 分类夹 */
  targetDir: string;
  /** 是否因同名冲突换过名 */
  renamed: boolean;
}

/** 同一层里已经被用掉的名字（大小写不敏感），避免同名源文件夹互相覆盖。 */
export type TakenScopes = ReadonlyMap<string, ReadonlySet<string>>;

export interface PlanOptions {
  /** 输出根目录 */
  outputDir: string;
  /** 展开结果（`expandFolders` / `scanFolders` 的产物） */
  scan: ScanResult;
  /** 分类规则表；不传就用默认规则 */
  rules?: RuleTable | null;
  /** 目标目录里已存在的名字：目标目录（小写）→ 名字集合。不传就当作都是空的（纯内存预览用） */
  takenByDir?: TakenScopes;
}

export interface PlanResult {
  /** 输出根 */
  outputDir: string;
  /** 所有源文件夹的落点 */
  folders: PlannedFolder[];
  /** 每个文件的最终落点（顺序与 `scan.files` 一致） */
  files: PlannedFile[];
  /** 被跳过的路径与原因（原样带过来） */
  skipped: SkippedPath[];
}

/* ------------------------------------------------------------------ *
 * 只读探测小工具
 * ------------------------------------------------------------------ */

interface StatInfo {
  isFile: boolean;
  isDirectory: boolean;
  /** 符号链接 / 快捷方式（不跟随） */
  isLink: boolean;
  /** 读不到时的原因 */
  error: string | null;
}

/** 只读探测：lstat（不跟随链接）+ stat（跟随），一眼看出「文件 / 文件夹 / 链接 / 读不到」。 */
export function probePath(target: string): StatInfo {
  const out: StatInfo = { isFile: false, isDirectory: false, isLink: false, error: null };
  try {
    out.isLink = fssync.lstatSync(target).isSymbolicLink();
  } catch (err) {
    out.error = describeError(err);
    return out;
  }
  try {
    const st = fssync.statSync(target);
    out.isFile = st.isFile();
    out.isDirectory = st.isDirectory();
    if (!out.isFile && !out.isDirectory) out.error = '这既不是文件也不是文件夹（插座/设备等特殊对象），已跳过';
  } catch (err) {
    out.error = describeError(err);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 递归展开
 * ------------------------------------------------------------------ */

/** 源文件夹的稳定身份键。 */
export function originKeyOf(rootPath: string, chain: readonly string[]): string {
  return [rootPath, ...chain].join('\u0000');
}

/** 路径拼接（不依赖输出根是不是以分隔符结尾）。 */
export function joinedPath(base: string, name: string): string {
  const sep = base.endsWith('\\') || base.endsWith('/') ? '' : path.sep;
  return `${base}${sep}${name}`;
}

/**
 * 递归展开一个源文件夹：只收文件、逐层各归各、空文件夹不产生输出。
 *
 * @param rootPath 拖入的源文件夹路径（绝对路径）
 * @param options.maxDepth 深度上限（默认 20）
 * @param options.ignoreMissingRoot 根自己读不到时是否算「正常跳过」（拖入后已被删掉的情形）
 */
export function scanFolders(
  rootPath: string,
  options: { maxDepth?: number; ignoreMissingRoot?: boolean; rootName?: string } = {},
): ScanResult {
  const root = String(rootPath ?? '');
  const maxDepth = Math.max(1, Math.min(Number(options?.maxDepth ?? MAX_SCAN_DEPTH) || MAX_SCAN_DEPTH, 200));
  const files: TrackedFile[] = [];
  const folderMap = new Map<string, SourceFolderOrigin>();
  const skipped: SkippedPath[] = [];
  const rootName = options?.rootName && options.rootName.length > 0 ? options.rootName : path.basename(root);

  const rootProbe = probePath(root);
  if (rootProbe.error || !rootProbe.isDirectory) {
    if (!options?.ignoreMissingRoot) {
      skipped.push({
        fullPath: root,
        originKey: originKeyOf(root, []),
        reason: rootProbe.error ?? '这不是一个文件夹',
      });
    }
    return { files, folders: [], skipped };
  }

  interface QueueItem {
    dir: string;
    chain: string[];
  }

  const queue: QueueItem[] = [{ dir: root, chain: [] }];
  const seenDirs = new Set<string>([root.toLowerCase()]);
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    const origin: SourceFolderOrigin = {
      rootPath: root,
      rootName,
      chain: current.chain,
      key: originKeyOf(root, current.chain),
    };
    if (!folderMap.has(origin.key)) folderMap.set(origin.key, origin);

    let entries: fssync.Dirent[];
    try {
      entries = fssync.readdirSync(current.dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ fullPath: current.dir, originKey: origin.key, reason: `读不了这个文件夹：${describeError(err)}` });
      continue;
    }

    for (const entry of entries) {
      const childPath = joinedPath(current.dir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push({
          fullPath: childPath,
          originKey: origin.key,
          name: entry.name,
          reason: '这是一个符号链接/快捷方式，本片不跟随（免得绕圈）',
        });
        continue;
      }
      if (entry.isFile()) {
        files.push({ fullPath: childPath, name: entry.name, origin });
        continue;
      }
      if (!entry.isDirectory()) {
        skipped.push({
          fullPath: childPath,
          originKey: origin.key,
          name: entry.name,
          reason: '这既不是文件也不是文件夹，已跳过',
        });
        continue;
      }

      const depth = current.chain.length + 1;
      if (depth > maxDepth) {
        skipped.push({
          fullPath: childPath,
          originKey: origin.key,
          name: entry.name,
          reason: `目录层级太深（超过 ${maxDepth} 层），已跳过（可能是循环链接或确实太深）`,
        });
        continue;
      }
      const lower = childPath.toLowerCase();
      if (seenDirs.has(lower)) {
        skipped.push({
          fullPath: childPath,
          originKey: origin.key,
          name: entry.name,
          reason: '这个文件夹又绕回来了（成环），已跳过',
        });
        continue;
      }
      seenDirs.add(lower);
      queue.push({ dir: childPath, chain: current.chain.concat([entry.name]) });
    }
  }

  // 全部展开到的源文件夹都留着（包括「自己根下没有文件、只有子文件夹里有」的那几层）：
  // 它们是输出路径上必须占位的一段；有没有文件由 `fileCount` 说话。
  const folders = Array.from(folderMap.values());
  // 先父后子（浅的在前）：算输出名时必须先知道父文件夹在输出里叫什么
  folders.sort((a, b) => a.chain.length - b.chain.length);
  return { files, folders, skipped };
}

/** 多个源文件夹一起展开（拖入多个文件夹 / 「选择文件夹」多选）。 */
export function expandFolders(
  rootPaths: readonly string[],
  options: { maxDepth?: number; ignoreMissingRoot?: boolean } = {},
): ScanResult {
  const files: TrackedFile[] = [];
  const folders: SourceFolderOrigin[] = [];
  const skipped: SkippedPath[] = [];
  const seenRoots = new Set<string>();
  for (const raw of rootPaths ?? []) {
    const root = String(raw);
    const lower = root.toLowerCase();
    if (seenRoots.has(lower)) {
      skipped.push({ fullPath: root, originKey: originKeyOf(root, []), reason: '这个文件夹重复拖入了，已跳过' });
      continue;
    }
    seenRoots.add(lower);
    const one = scanFolders(root, options);
    for (const f of one.files) files.push(f);
    for (const f of one.folders) folders.push(f);
    for (const s of one.skipped) skipped.push(s);
  }
  return { files, folders, skipped };
}

/* ------------------------------------------------------------------ *
 * 目标路径：同一层里同名源文件夹不覆盖
 * ------------------------------------------------------------------ */

/** 同一段输出路径里挑一个不冲突的文件夹名：原名可用就用原名，否则「原名 (2)」「原名 (3)」… */
function pickUniqueFolderName(baseName: string, scope: string, usedByScope: Map<string, Set<string>>): { name: string; renamed: boolean } {
  let used = usedByScope.get(scope);
  if (!used) {
    used = new Set<string>();
    usedByScope.set(scope, used);
  }
  let name = baseName;
  let attempt = 2;
  while (used.has(name.toLowerCase())) {
    if (attempt > MAX_RENAME_ATTEMPTS) return { name: baseName, renamed: true };
    name = `${baseName} (${attempt})`;
    attempt++;
  }
  used.add(name.toLowerCase());
  return { name, renamed: name !== baseName };
}

/** 输出根 + 各层文件夹名 → 目录绝对路径。 */
export function targetDirOf(outputDir: string, outputChain: readonly string[]): string {
  const sep = outputDir.endsWith('\\') || outputDir.endsWith('/') ? '' : path.sep;
  return outputChain.length === 0 ? outputDir : `${outputDir}${sep}${outputChain.join(path.sep)}`;
}

/**
 * 把「源文件夹」映射成「它在输出里的那一段路径」。**纯函数**，不碰磁盘。
 *
 * 关键点（本片踩过一次的坑）：
 *  - 顶层源文件夹在输出根下同名的不覆盖（`照片` / `照片 (2)`）；
 *  - 子文件夹的父段必须用**父文件夹在输出里的名字**，而不是源里的名字 —— 否则
 *    「下载\照片」与「另一处\照片」会因为名字一样被挤到同一个目录里去；
 *  - 父文件夹自己「直接躺着文件」时它有份、没有时它只是路径上的一段 ——
 *    **父段无论有没有文件都必须先分配好**，子文件夹才不会掉到输出根下。
 */
function allocateOutputChains(origins: readonly SourceFolderOrigin[]): Map<string, PlannedFolder> {
  const usedByScope = new Map<string, Set<string>>();
  const plannedByKey = new Map<string, PlannedFolder>();
  const outputChainOf = (origin: SourceFolderOrigin): string[] => {
    if (origin.chain.length === 0) return [];
    const parent = plannedByKey.get(originKeyOf(origin.rootPath, origin.chain.slice(0, -1)));
    return parent ? parent.outputChain : origin.chain.slice(0, -1);
  };

  // 先父后子：浅的在前（`scan.folders` 已经是这个顺序，这里再排一次保险）
  const ordered = origins.slice().sort((a, b) => a.chain.length - b.chain.length);
  for (const origin of ordered) {
    if (plannedByKey.has(origin.key)) continue;
    const parentOutputChain = outputChainOf(origin);
    const base = origin.chain.length > 0 ? origin.chain[origin.chain.length - 1] : origin.rootName;
    // 作用域 = 父段在输出里的路径（顶层就是输出根）：同段路径里同名才需要「(2)」
    const picked = pickUniqueFolderName(base, '\u0000' + parentOutputChain.join('\\').toLowerCase(), usedByScope);
    const planned: PlannedFolder = {
      origin,
      outputChain: parentOutputChain.concat([picked.name]),
      outputDir: '',
      fileCount: 0,
      renamed: picked.renamed,
    };
    plannedByKey.set(origin.key, planned);
  }
  return plannedByKey;
}

/**
 * 纯函数：把展开结果算成「每个文件落到哪个目录的哪个名字」。
 *
 * 关键保证（用户定的硬要求）：**同一个目标分类夹里的文件必然来自同一个源文件夹**。
 * 所以每个源文件夹在输出里都有自己的一段路径，绝不与别的源文件夹合并。
 * 命名（同名源文件夹不覆盖 / 文件同名换名）走的是与执行时**同一个** `pickUniqueName`。
 */
export function buildPlan(options: PlanOptions): PlanResult {
  const outputDir = String(options?.outputDir ?? '');
  const scan = options?.scan ?? { files: [], folders: [], skipped: [] };
  const rules = options?.rules ?? null;
  const takenByDir = options?.takenByDir ?? new Map<string, ReadonlySet<string>>();

  const cloneTaken = (dir: string): Set<string> => {
    const found = takenByDir.get(dir.toLowerCase());
    return new Set(Array.from(found ?? []).map((n) => n.toLowerCase()));
  };

  // 1. 先把「用得上的源文件夹」都找齐：有文件的那几份，各自也要有祖先那几段。
  //    例：源文件夹「另一处」自己根下没有文件、只有 另一处\照片 里有 —— 「另一处」这一段照样要占位。
  const needed = new Map<string, SourceFolderOrigin>();
  const addWithAncestors = (origin: SourceFolderOrigin): void => {
    let chain = origin.chain.slice();
    for (;;) {
      const key = originKeyOf(origin.rootPath, chain);
      if (needed.has(key)) break;
      needed.set(key, chain.length === origin.chain.length ? origin : { ...origin, chain: chain.slice(), key });
      if (chain.length === 0) break;
      chain = chain.slice(0, -1);
    }
  };
  for (const origin of scan.folders) addWithAncestors(origin);
  for (const file of scan.files) addWithAncestors(file.origin);

  const plannedByKey = allocateOutputChains(Array.from(needed.values()));
  for (const planned of plannedByKey.values()) planned.outputDir = targetDirOf(outputDir, planned.outputChain);

  // 2. 每个文件：先按规则分分类，再在「自己那一层的分类夹」里挑一个不冲突的文件名
  const batchTaken = new Map<string, Set<string>>();
  const files: PlannedFile[] = [];
  for (const file of scan.files) {
    const planned = plannedByKey.get(file.origin.key);
    if (!planned) continue;
    planned.fileCount++;
    const matched = classifyWithMeta(rules, file.fullPath, file.name);
    const targetDir = joinedPath(planned.outputDir, matched.folder);
    const dirKey = targetDir.toLowerCase();
    let taken = batchTaken.get(dirKey);
    if (!taken) {
      taken = cloneTaken(targetDir);
      batchTaken.set(dirKey, taken);
    }
    const picked = pickUniqueName(file.name, taken);
    const finalName = picked.name === null ? file.name : picked.name;
    taken.add(finalName.toLowerCase());
    files.push({
      fullPath: file.fullPath,
      name: finalName,
      folder: matched.folder,
      origin: file.origin,
      plannedFolder: planned,
      targetDir,
      renamed: picked.renamed,
    });
  }

  // 落点只列「真的有文件的那几份」（空文件夹不产生输出）；路径上纯占位的那几段不列
  const withFiles = new Set(scan.folders.map((f) => f.key));
  const plannedFolders: PlannedFolder[] = [];
  for (const origin of scan.folders) {
    const planned = plannedByKey.get(origin.key);
    if (planned && withFiles.has(origin.key) && planned.fileCount > 0) plannedFolders.push(planned);
  }

  return { outputDir, folders: plannedFolders, files, skipped: scan.skipped };
}

/* ------------------------------------------------------------------ *
 * 一次导出：展开 + 算目标路径
 * ------------------------------------------------------------------ */

/** `planFolders` 的结果：算好的目标路径 + 展开细节（跳过原因、读不到的目标目录）。 */
export interface FolderPlanOutcome {
  plan: PlanResult;
  scan: ScanResult;
  /** 读目标目录时读不到的目录与原因（不致命：当作里面是空的，但要在界面上说清） */
  takenReadErrors: SkippedPath[];
}

export interface FolderPlanInput {
  /** 拖入/选中的源文件夹路径（绝对路径） */
  roots: readonly string[];
  /** 输出根目录（可以还不存在——预览绝不创建它） */
  outputDir: string | null;
  rules?: RuleTable | null;
  /** 是否读目标目录里已有的名字（默认 true；纯内存场合可关掉） */
  checkExisting?: boolean;
}

/**
 * 展开 + 算目标路径。预览与执行都走这里，所以「预览说去 A、执行去了 B」不可能发生。
 * `checkExisting` 只做只读 readdir：
 *  - 目标目录不存在 / 读不了 → 当作空，并记进 `takenReadErrors`（不致命）。
 */
export function planFolders(input: FolderPlanInput): FolderPlanOutcome {
  const roots = Array.from(input?.roots ?? []).map((r) => String(r));
  const scan = expandFolders(roots);
  const outputDir = input?.outputDir === null || input?.outputDir === undefined ? '' : String(input.outputDir);
  const checkExisting = input?.checkExisting !== false;
  const takenByDir = new Map<string, Set<string>>();
  const takenReadErrors: SkippedPath[] = [];

  if (checkExisting && outputDir.length > 0) {
    // 只探测「按源文件夹原名算出来的落点目录」：算目标路径时只需要知道这些目录里已有什么名字
    const candidates = new Set<string>();
    for (const origin of scan.folders) {
      const chain = origin.chain.length > 0 ? origin.chain : [origin.rootName];
      candidates.add(targetDirOf(outputDir, chain));
    }
    for (const dir of candidates) {
      try {
        const names = fssync.readdirSync(dir);
        takenByDir.set(dir.toLowerCase(), new Set(names.map((n) => String(n).toLowerCase())));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code ?? '';
        if (code !== 'ENOENT') {
          // 目录真的在、但读不了：记一行原因（不致命）
          takenReadErrors.push({
            fullPath: dir,
            originKey: '',
            reason: `输出目录读不了，里面已有什么名字无法确认：${describeError(err)}`,
          });
        }
      }
    }
  }

  const plan = buildPlan({ outputDir, scan, rules: input?.rules ?? null, takenByDir });
  return { plan, scan, takenReadErrors };
}
