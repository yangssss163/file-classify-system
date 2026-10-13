/**
 * 纯逻辑：递归展开拖进来的文件夹 + 算每个文件的目标路径。**不依赖 Electron**。
 *
 * 本片的语义是**文件夹优先**（用户拍板的）：
 *
 *   1. **子文件夹里的文件按原样保留相对路径**：`下载\照片\风景\a.jpg` → `<输出根>\下载\照片\风景\a.jpg`
 *      —— 一路原样搬过去，**不再按规则重分**；源文件夹的层级结构原样保留。
 *   2. **只有散在「某个源文件夹自己那层根下」的文件才按规则分类**：
 *      `下载\散1.jpg` → `<输出根>\下载\<规则算出的分类夹>\散1.jpg`。
 *   3. **绝不混在一起**（用户硬要求）：来自不同源文件夹的文件永远不会出现在同一个输出目录里。
 *      新语义下这条天然成立且更强：整棵源文件夹树是按原路径搬的，只有各层根下的散文件进分类夹，
 *      而那些分类夹也各自待在**自己那一层**下面。
 *   4. **同名不相撞**：同一段输出路径里同名的文件夹要加序号（`备份`、`备份 (2)`）；
 *      不同父目录下的同名子文件夹各待在各的父层下面，本来就不撞。
 *
 * 结构示意（输出根下）：
 *   下载\                     ← 拖入的源文件夹，输出根下同名一份
 *     01_图片\                ← 「下载」根下散文件（散1.jpg）的分类夹
 *     散3.xlsx                ← 「下载」根下的散文件，规则算出来是 05_其他，所以直接在这层……
 *     照片\                   ← 「下载」的子文件夹：原样保留
 *       图1.png
 *       婚纱\
 *         纱1.jpg
 *   另一处\
 *     照片\
 *       图2.png
 *
 * 铁律：
 *  - 递归只收**文件**；空文件夹不产生输出；
 *  - 读不了的子文件夹 → 跳过并记一行原因（`skipped`），绝不让整次展开失败；
 *  - 不跟随符号链接 / 快捷方式（一律跳过并记原因），避免绕圈；
 *  - 深度超过 `MAX_SCAN_DEPTH`（20）层就停下并说明原因；
 *  - 本文件只做只读的 fs.statSync / readdirSync，**不建目录、不写文件**。
 */
import * as fssync from 'fs';
import * as path from 'path';
import { pickUniqueName, splitFileName, MAX_RENAME_ATTEMPTS } from './classify';
import { classifyWithMeta } from './classifyWithMeta';
import type { RuleTable } from './rules';
import { describeError } from './copyFiles';

/** 递归深度上限：超过就停下并说明原因（防止循环/超深目录把程序拖死）。 */
export const MAX_SCAN_DEPTH = 20;

/** 界面上那句人话（预览里必须明确写出来，也就是用户看到的那段说明）。只有这一个来源，不许在别处再写一份。 */
export const FOLDER_KEEP_HINT =
  '子文件夹里的文件按原样保留（连层级一起搬）；散在源文件夹自己那层根下的文件，若这一层有和它同名的子文件夹（按文件名去扩展名比对）就并进去，否则按当前规则新建分类夹。';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 源文件夹（顶层或某一层子文件夹）的稳定身份。 */
export interface SourceFolderOrigin {
  /** 拖入的那个源文件夹的绝对路径（= 输出根下同名夹的来源） */
  rootPath: string;
  /** 顶层源文件夹名 */
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
  /** 探到的源文件夹（含各层子文件夹；先父后子。空文件夹也在里面，有没有文件看 fileCount） */
  folders: SourceFolderOrigin[];
  /** 被跳过的路径与原因 */
  skipped: SkippedPath[];
}

/** 展开出来的目录树：每个源文件夹一个节点，子文件夹挂在 children 上。 */
export interface ScanNode {
  origin: SourceFolderOrigin;
  /** 这个节点在**源**里的目录（用来判断「同名位置上是不是被一个文件占着」） */
  dirPath: string;
  /** 直接躺在这一层根下的文件（这些才按规则处理） */
  looseFiles: TrackedFile[];
  /** 这一层的子文件夹（按名字排序，顺序稳定） */
  children: ScanNode[];
}

/**
 * 一个文件最终落到哪里（预览与执行**共用同一份**）。
 * `targetDir` 是最终目录（原样保留时 = 原目录在输出里的对应位置；分类/并入时 = 该层 + 子目录）。
 */
export interface PlannedFile {
  /** 原文件路径 */
  fullPath: string;
  /** 最终文件名（同名冲突时可能已被换成「原名 (1).后缀」） */
  name: string;
  /** 源文件所在的源文件夹 */
  origin: SourceFolderOrigin;
  /** 输出里的目标目录（绝对路径） */
  targetDir: string;
  /**
   * 这个文件是怎么安排的：
   *  - `keep`：子文件夹里的文件 → 按原样保留相对路径，不分类；
   *  - `classify`：源文件夹自己那层根下的散文件 → 进分类夹（`category` 是分类夹名）；
   *  - `merge`：源文件夹自己那层根下的散文件 → **并进已有的同名子文件夹**（`category` 是那个子文件夹名）。
   */
  placement: 'keep' | 'classify' | 'merge';
  /** 分类夹名（`classify`）或并入的子文件夹名（`merge`）；`keep` 时为 null */
  category: string | null;
  /** 并入/分类时的人话说明（给人看）；原样保留时为 null */
  mergeReason: string | null;
  /** 是否因同名冲突换过名 */
  renamed: boolean;
}

/**
 * 一个源文件夹在输出里的落点。
 * 列表只存**自己这一层**的东西（`keptFiles`/`categories`），
 * 子树里的文件留在各自的 `subfolders` 节点上 ——
 * 汇总个数一律现算（见 `countKeptOf` / `PlannedFolder.totalFileCount`），
 * 免得同一份文件在父节点和子节点里各存一份、被数两遍。
 */
export interface PlannedFolder {
  origin: SourceFolderOrigin;
  /** 输出里的名字（可能因为同名被改成「照片 (2)」） */
  outputName: string;
  /** 输出目录（绝对路径） */
  outputDir: string;
  /** 是否因为「同段路径里有同名文件夹」改过名 */
  renamed: boolean;

  /** 这一份（含子树）的文件总数 = 本层散文件 + 子树里原样保留的 */
  totalFileCount: number;
  /** 直接躺在这一层根下的散文件个数（顶层才按规则分类/并入同名子文件夹） */
  looseFileCount: number;
  /** 这一层原样保留的直接文件个数（子文件夹那几层才有） */
  keptFileCount: number;
  /** 这一层有多少散文件是「并进同名子文件夹」的（顶层才有） */
  mergedCount: number;
  /** 这一层有多少散文件是「按规则新建分类夹」的（顶层才有） */
  classifiedCount: number;

  /** 这一层根下散文件的分类夹（只含**新建**的分类夹；并进既有子文件夹的那些不在这里） */
  categories: Array<{ category: string; files: PlannedFile[] }>;
  /** 这一层**原样保留**的直接文件（只有子文件夹那几层才有；另有 `mergedInto` 里并入的散文件） */
  keptFiles: PlannedFile[];
  /** 并进这个子文件夹的散文件（只可能出现在子文件夹那一层；顶层为空） */
  mergedInto: PlannedFile[];
  /** 它下面的子文件夹（原样保留；空文件夹不列） */
  subfolders: PlannedFolder[];
}

/** 一棵完整的目标结构：一个顶层源文件夹一个节点。 */
export interface PlannedRoot {
  origin: SourceFolderOrigin;
  /** 输出根下这一份的名字（同名顶层源文件夹会被改成「备份 (2)」） */
  outputName: string;
  /** 输出根下的目录（绝对路径） */
  outputDir: string;
  renamed: boolean;
  /** 这一份的内容（和 `PlannedFolder` 同一套字段） */
  subtree: PlannedFolder;
  /** 这一份一共有几个文件（含子树） */
  totalFileCount: number;
}

export interface PlanOptions {
  /** 输出根目录 */
  outputDir: string;
  /** 展开结果（`expandFolders` / `scanFolders` 的产物；带 `tree`） */
  scan: ScanResult & { tree: ScanNode[] };
  /** 分类规则表；只对「源文件夹自己那层根下的散文件」起作用；不传就用默认规则 */
  rules?: RuleTable | null;
}

export interface PlanResult {
  /** 输出根 */
  outputDir: string;
  /** 顶层源文件夹的落点（一个拖入的源文件夹一个） */
  roots: PlannedRoot[];
  /** 所有文件的最终落点（顺序与 `scan.files` 一致） */
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
 * 递归展开（只读）
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

interface ScanOutcome {
  node: ScanNode;
  skipped: SkippedPath[];
}

/**
 * 只读递归一个源文件夹：只收文件、空文件夹不产生输出、读不了的跳过并记原因、
 * 不跟随符号链接、超过 `maxDepth` 层就停下并说明原因。
 */
function scanNodeAt(
  dir: string,
  rootPath: string,
  rootName: string,
  chain: string[],
  maxDepth: number,
  seenDirs: Set<string>,
): ScanOutcome {
  const origin: SourceFolderOrigin = { rootPath, rootName, chain, key: originKeyOf(rootPath, chain) };
  const node: ScanNode = { origin, dirPath: dir, looseFiles: [], children: [] };
  const skipped: SkippedPath[] = [];

  let entries: fssync.Dirent[];
  try {
    entries = fssync.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    skipped.push({ fullPath: dir, originKey: origin.key, reason: `读不了这个文件夹：${describeError(err)}` });
    return { node, skipped };
  }

  for (const entry of entries) {
    const childPath = joinedPath(dir, entry.name);
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
      node.looseFiles.push({ fullPath: childPath, name: entry.name, origin });
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

    // 深度上限：`chain.length` 就是「当前在第几层子文件夹」。
    // 到达上限后就不再往里建节点，并记一句原因 —— 免得循环链接或超深目录把程序拖住。
    const childDepth = chain.length + 1;
    if (childDepth > maxDepth) {
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

    const child = scanNodeAt(childPath, rootPath, rootName, chain.concat([entry.name]), maxDepth, seenDirs);
    node.children.push(child.node);
    for (const s of child.skipped) skipped.push(s);  }

  node.children.sort((a, b) => a.origin.chain[a.origin.chain.length - 1].localeCompare(b.origin.chain[b.origin.chain.length - 1]));
  return { node, skipped };
}

/** 深度优先把一棵树里的所有节点按「先父后子」摊平。 */
function flattenNodes(node: ScanNode, out: ScanNode[] = []): ScanNode[] {
  out.push(node);
  for (const child of node.children) flattenNodes(child, out);
  return out;
}

export interface ScanOptions {
  maxDepth?: number;
  /** 根自己读不到时是否算「正常跳过」（拖入后已被删掉的情形） */
  ignoreMissingRoot?: boolean;
  /** 只在内部用：给根起个别的显示名 */
  rootName?: string;
}

/** 递归展开一个源文件夹，返回「目录树 + 摊平的文件清单」。 */
export function scanFolders(rootPath: string, options: ScanOptions = {}): ScanResult & { tree: ScanNode[] } {
  const root = String(rootPath ?? '');
  const maxDepth = Math.max(1, Math.min(Number(options?.maxDepth ?? MAX_SCAN_DEPTH) || MAX_SCAN_DEPTH, 200));
  const rootName = options?.rootName && options.rootName.length > 0 ? options.rootName : path.basename(root);
  const skipped: SkippedPath[] = [];

  const rootProbe = probePath(root);
  if (rootProbe.error || !rootProbe.isDirectory) {
    if (!options?.ignoreMissingRoot) {
      skipped.push({ fullPath: root, originKey: originKeyOf(root, []), reason: rootProbe.error ?? '这不是一个文件夹' });
    }
    return { files: [], folders: [], skipped, tree: [] };
  }

  const seenDirs = new Set<string>([root.toLowerCase()]);
  const scan = scanNodeAt(root, root, rootName, [], maxDepth, seenDirs);
  const nodes = flattenNodes(scan.node);
  const files: TrackedFile[] = [];
  for (const node of nodes) for (const f of node.looseFiles) files.push(f);
  // 递归里收上来的跳过原因（太深 / 成环 / 读不了 / 符号链接）必须带出去，不能丢
  for (const s of scan.skipped) skipped.push(s);

  return { files, folders: nodes.map((n) => n.origin), skipped, tree: [scan.node] };
}

/** 多个源文件夹一起展开（拖入多个文件夹 / 「选择文件夹」多选）。 */
export function expandFolders(rootPaths: readonly string[], options: ScanOptions = {}): ScanResult & { tree: ScanNode[] } {
  const files: TrackedFile[] = [];
  const folders: SourceFolderOrigin[] = [];
  const skipped: SkippedPath[] = [];
  const tree: ScanNode[] = [];
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
    for (const t of one.tree) tree.push(t);
  }
  return { files, folders, skipped, tree };
}

/* ------------------------------------------------------------------ *
 * 目标路径
 * ------------------------------------------------------------------ */

/** 同一段输出路径里挑一个不冲突的文件夹名：原名可用就用原名，否则「原名 (2)」「原名 (3)」… */
function pickUniqueFolderName(
  baseName: string,
  scope: string,
  usedByScope: Map<string, Set<string>>,
): { name: string; renamed: boolean } {
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

/** 这一份（含子树）里所有「原样保留 + 并进来」的文件。 */
function allKeptOf(folder: PlannedFolder): PlannedFile[] {
  const out: PlannedFile[] = [];
  for (const f of folder.keptFiles) out.push(f);
  for (const f of folder.mergedInto) out.push(f);
  for (const sub of folder.subfolders) for (const f of allKeptOf(sub)) out.push(f);
  return out;
}

/** 这一份（含子树）原样保留 + 并入的文件个数（不含本层按规则分类的散文件）。 */
export function countKeptOf(folder: PlannedFolder): number {
  return allKeptOf(folder).length;
}

/** 这一份（含子树）里按规则新建分类夹放进去的散文件个数。 */
export function countClassifiedOf(folder: PlannedFolder): number {
  let n = folder.categories.reduce((sum, g) => sum + g.files.length, 0);
  for (const sub of folder.subfolders) n += countClassifiedOf(sub);
  return n;
}

/** 这一份（含子树）的文件总数。 */
function countFilesOf(folder: PlannedFolder): number {
  let n = folder.looseFileCount + folder.keptFiles.length + folder.mergedInto.length;
  for (const sub of folder.subfolders) n += countFilesOf(sub);
  return n;
}

/**
 * 纯函数：把展开出来的目录树算成「每个文件落到哪个目录的哪个名字」。
 *
 * 两条路（与用户定的新语义一一对应）：
 *  - 源文件夹自己那层根下的散文件 → 按规则进 `<该层>\<分类夹>\`，分类夹名由规则算出来；
 *  - 子文件夹里的文件 → **原样保留相对路径**，目录与源里一一对应，不分类。
 * 同一段输出路径里同名的文件夹加序号（`备份`、`备份 (2)`），文件同名沿用「原名 (1).后缀」。
 */
/** 一棵展开树里有多少个文件（含所有层；顶层自己根下的 + 子树里的）。 */
function countScanFiles(node: ScanNode): number {
  let n = node.looseFiles.length;
  for (const child of node.children) n += countScanFiles(child);
  return n;
}

export function buildPlan(options: PlanOptions): PlanResult {
  const outputDir = String(options?.outputDir ?? '');
  const scan = options?.scan ?? { files: [], folders: [], skipped: [], tree: [] };
  const rules = options?.rules ?? null;
  const usedByScope = new Map<string, Set<string>>();
  /** 目标目录（小写）→ 已经用掉的文件名，避免同一批里重名互撞 */
  const takenByDir = new Map<string, Set<string>>();
  const files: PlannedFile[] = [];

  /** 某个目标目录里已经用掉的名字（懒加载）。 */
  const takenIn = (dir: string): Set<string> => {
    const key = dir.toLowerCase();
    let taken = takenByDir.get(key);
    if (!taken) {
      taken = new Set<string>();
      takenByDir.set(key, taken);
    }
    return taken;
  };

  /** 在这个目录里挑一个不冲突的文件名，并把它记下来。 */
  const placeName = (dir: string, wanted: string): { name: string; renamed: boolean } => {
    const taken = takenIn(dir);
    const picked = pickUniqueName(wanted, taken);
    const finalName = picked.name === null ? wanted : picked.name;
    taken.add(finalName.toLowerCase());
    return { name: finalName, renamed: picked.renamed };
  };

  /**
   * 处理一个源文件夹节点。
   * @param classifyHere 这一层根下的散文件是否走「并入同名子文件夹 / 按规则分类」——**只有顶层源文件夹才是 true**；
   *   子文件夹里的文件一律**原样保留**（连层级一起搬，不再按规则重分）。
   */
  const processNode = (
    node: ScanNode,
    outputName: string,
    outputDirPath: string,
    classifyHere: boolean,
    renamed: boolean,
  ): PlannedFolder => {
    const planned: PlannedFolder = {
      origin: node.origin,
      outputName,
      outputDir: outputDirPath,
      renamed,
      subfolders: [],
      keptFiles: [],
      mergedInto: [],
      categories: [],
      looseFileCount: 0,
      keptFileCount: 0,
      mergedCount: 0,
      classifiedCount: 0,
      totalFileCount: 0,
    };

    // ① 先把子文件夹安顿好（原样保留，结构照搬；名字在同一段输出路径里不撞）。
    //    必须先做这一步：散文件要看「这一层有没有同名子文件夹」才能决定去处。
    for (const child of node.children) {
      const childName = child.origin.chain[child.origin.chain.length - 1];
      const picked = pickUniqueFolderName(childName, '\u0000' + outputDirPath.toLowerCase(), usedByScope);
      const childDir = joinedPath(outputDirPath, picked.name);
      planned.subfolders.push(processNode(child, picked.name, childDir, false, picked.renamed));
    }

    // ② 这一层根下的文件：
    //    - 顶层源文件夹的散文件：**先并进同名子文件夹**，没有同名子文件夹才按规则建分类夹；
    //    - 子文件夹里的文件：**原样保留**，直接待在 outputDirPath 这一层。
    for (const file of node.looseFiles) {
      if (!classifyHere) {
        const placed = placeName(outputDirPath, file.name);
        const entry: PlannedFile = {
          fullPath: file.fullPath,
          name: placed.name,
          origin: node.origin,
          targetDir: outputDirPath,
          placement: 'keep',
          category: null,
          mergeReason: null,
          renamed: placed.renamed,
        };
        files.push(entry);
        planned.keptFiles.push(entry);
        planned.keptFileCount++;
        continue;
      }

      // 散文件（只在这一层、只有顶层源文件夹走这条路）：按顺序判定，每一步都记一句人话原因。
      //  1. 这一层有**同名子文件夹**（名字 = 这个文件自己的名字去掉扩展名，大小写不敏感，只比同一层）→ 并进去；
      //  2. 被同名**文件**占位 → 不许覆盖它，退回第 3 步并说明；
      //  3. 按规则新建分类夹。
      // 第 1 步有一条**防误伤**的硬保护：如果那个同名子文件夹里已经有文件、但**一个**属于
      // 本文件该去的规则分类夹的文件都没有（说明它根本不是装这类东西的），就不硬塞，
      // 退回第 3 步并说明原因 —— 免得为了「同名」把既有的目录结构打乱。
      const stem = splitFileName(file.name).stem;
      const matched = classifyWithMeta(rules, file.fullPath, file.name);
      const categoryName = matched.folder;
      const sameNameDir = joinedPath(outputDirPath, stem);
      let mergeInto: PlannedFolder | null =
        planned.subfolders.find((s) => s.outputName.toLowerCase() === stem.toLowerCase()) ?? null;
      let mergeReason = mergeInto
        ? `这一层有和它同名的子文件夹 ${mergeInto.outputName}\\（按文件名「${stem}」比对），散文件并进它，不另建分类夹`
        : '';

      if (mergeInto) {
        // 保护一：同名位置上其实是个**文件**（不许覆盖）→ 退回按规则建分类夹
        try {
          const st = fssync.statSync(sameNameDir);
          if (!st.isDirectory()) {
            mergeReason = `这一层有个同名的「文件」占着 ${stem} 这个名字，没有动它；按规则新建分类夹`;
            mergeInto = null;
          }
        } catch {
          /* 目录还不存在，属正常 */
        }
      }

      if (mergeInto) {
        // 保护二（防误伤，硬保护）：同名子文件夹里**已经有文件**、但这些文件里**一个**属于
        // 本文件该去的规则分类夹的都没有（例如 照片\ 里只有 a.mp4，却想把 照片.jpg 塞进去）→
        // 不硬塞，退回按规则建分类夹并说明；
        // 同名子文件夹是**空的**、或者里面本来就有同一类的文件（例如 发票\ 里已有 老发票.pdf）
        // → 照常并进去，不打乱原有结构。
        const inside = allKeptOf(mergeInto);
        const insideCategories = inside.map((f) => classifyWithMeta(rules, f.fullPath, f.name).folder);
        if (inside.length > 0 && !insideCategories.includes(categoryName)) {
          mergeReason =
            `这一层有和它同名的子文件夹 ${mergeInto.outputName}\\，但它里面只有 ` +
            `${inside.map((f) => f.name).join('、')}（属于「${Array.from(new Set(insideCategories)).join('、')}」），` +
            `一个「${categoryName}」类的文件都没有、根本不是装这类东西的，所以没有硬塞进去；` +
            `按当前规则新建分类夹 ${categoryName}\\`;
          mergeInto = null;
        }
      }

      if (!mergeInto && mergeReason.length === 0) {
        // 没找到同名子文件夹：再确认一下「同名位置上是不是被一个**文件**占着」。两种都算：
        //  a) 这一层有个文件，名字正好等于本文件的名字（去掉扩展名）；
        //  b) 这一层有个文件，名字正好等于**规则算出来的分类夹名**（例如有个文件叫 01_图片）。
        const candidates = [stem, categoryName];
        for (const name of candidates) {
          if (name.length === 0) continue;
          try {
            const st = fssync.statSync(joinedPath(node.dirPath, name));
            if (!st.isDirectory()) {
              mergeReason = `这一层有个同名的「文件」占着 ${name} 这个名字，没有动它；按规则新建分类夹`;
              break;
            }
          } catch {
            /* 没有这个东西，属正常 */
          }
        }
      }

      if (mergeInto) {
        const placed = placeName(mergeInto.outputDir, file.name);
        const entry: PlannedFile = {
          fullPath: file.fullPath,
          name: placed.name,
          origin: node.origin,
          targetDir: mergeInto.outputDir,
          placement: 'merge',
          category: mergeInto.outputName,
          mergeReason,
          renamed: placed.renamed,
        };
        files.push(entry);
        mergeInto.mergedInto.push(entry);
        mergeInto.keptFileCount++;
        planned.looseFileCount++;
        planned.mergedCount++;
        continue;
      }

      const categoryDir = joinedPath(outputDirPath, categoryName);
      const placed = placeName(categoryDir, file.name);
      const entry: PlannedFile = {
        fullPath: file.fullPath,
        name: placed.name,
        origin: node.origin,
        targetDir: categoryDir,
        placement: 'classify',
        category: categoryName,
        mergeReason:
          mergeReason.length > 0
            ? mergeReason
            : `这一层没有同名的子文件夹，按规则算出来是「${categoryName}」，新建分类夹`,
        renamed: placed.renamed,
      };
      files.push(entry);
      planned.looseFileCount++;
      planned.classifiedCount++;
      let bucket = planned.categories.find((c) => c.category === categoryName);
      if (!bucket) {
        bucket = { category: categoryName, files: [] };
        planned.categories.push(bucket);
      }
      bucket.files.push(entry);
    }
    planned.categories.sort((a, b) => a.category.localeCompare(b.category));

    planned.totalFileCount = countFilesOf(planned);
    return planned;
  };

  const roots: PlannedRoot[] = [];
  for (const node of scan.tree ?? []) {
    // 空文件夹不产生任何输出：整棵子树一个文件都没有，就连落点/名字都不占
    if (countScanFiles(node) === 0) continue;
    const picked = pickUniqueFolderName(node.origin.rootName, '\u0000<输出根>', usedByScope);
    const rootOutputDir = targetDirOf(outputDir, [picked.name]);
    // 顶层源文件夹：这一层根下的散文件按规则分类（新语义的第一条路）
    const subtree = processNode(node, picked.name, rootOutputDir, true, picked.renamed);
    roots.push({
      origin: node.origin,
      outputName: picked.name,
      outputDir: rootOutputDir,
      renamed: picked.renamed,
      subtree,
      totalFileCount: subtree.totalFileCount,
    });
  }

  return { outputDir, roots, files, skipped: scan.skipped };
}

/* ------------------------------------------------------------------ *
 * 一次导出：展开 + 算目标路径
 * ------------------------------------------------------------------ */

export interface FolderPlanOutcome {
  plan: PlanResult;
  scan: ScanResult;
  /** 展开出来的目录树（预览按它画分组） */
  tree: ScanNode[];
}

export interface FolderPlanInput {
  /** 拖入/选中的源文件夹路径（绝对路径） */
  roots: readonly string[];
  /** 输出根目录（可以还不存在——预览绝不创建它） */
  outputDir: string | null;
  rules?: RuleTable | null;
}

/**
 * 展开 + 算目标路径。**预览与执行都走这里**，所以「预览说去 A、执行去了 B」不可能发生。
 * 本函数只做只读的 stat/readdir，绝不建目录、绝不写文件。
 */
export function planFolders(input: FolderPlanInput): FolderPlanOutcome {
  const roots = Array.from(input?.roots ?? []).map((r) => String(r));
  const scan = expandFolders(roots);
  const outputDir = input?.outputDir === null || input?.outputDir === undefined ? '' : String(input.outputDir);
  const plan = buildPlan({ outputDir, scan, rules: input?.rules ?? null });
  return { plan, scan, tree: scan.tree };
}
