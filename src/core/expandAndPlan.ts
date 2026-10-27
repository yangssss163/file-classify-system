/**
 * 纯逻辑：递归展开拖进来的文件夹 + 算每个文件的目标路径。**不依赖 Electron**。
 *
 * ============================================================================================
 * 统一规则（用户 2026-10 定稿）—— 本文件是这套行为的权威实现，下面四条为准
 * ============================================================================================
 * 1. **批量处理文件（不是文件夹）**：每个文件各自按「规则」分类；输出根下直接出分类夹。
 *    → 本文件里对应 `flat`（不传 roots）那条路：`buildPreviewTree` / `copyFiles` 保持原行为。
 * 2. **单个文件夹（本身没有子文件夹）**：在这个文件夹里，把它的文件按同一套规则分类。
 *    → 对应「顶层那一层的文件走 `sinkOne()`：同名可沉就沉、没得沉就按规则建分类夹」。
 * 3. **嵌套多层文件夹**：先 DFS 遍历整棵树、记录所有文件的索引；再重构文件夹结构 ——
 *    保留原有「里面有文件」的那部分层级（空文件夹、只剩空壳的分支不重建），
 *    在每一层为「这一层的散文件」按规则加上分类夹，然后按记录把文件复制进去。
 *    **同一套规矩对每一层都适用**（含「文件名与同层子文件夹同名就沉进去」这条）。
 *    → 对应 `scanNodeAt()`（DFS 记录）+ `processNode()`（逐层重建）+ `pruneEmptyBranches()`（只留有文件的层级）。
 * 4. **预览里把重建后的完整文件树展示出来**。
 *    → 对应 `preview.ts` 的 `PreviewTree.roots`（每一份 → 原样保留的子树 + 这一层新建的分类夹）。
 *
 * --------------------------------------------------------------------------------------------
 * 本片此前几轮的细节口径（都属于上面 1~3 的展开，不改变四条本身）
 * --------------------------------------------------------------------------------------------
 *   · **子文件夹里的文件按原样保留相对路径**：`下载\照片\风景\a.jpg` → `<输出根>\下载\照片\风景\a.jpg`；
 *   · **某一层根下的散文件「往下沉到底」**：那一层若有和它同名的子文件夹（文件自己的名字去扩展名、
 *     大小写不敏感、只比同一层）就沉进去，进去后按同一规矩继续看，直到没有同名的可沉 → 停在那一层；
 *     一次都没沉成才按规则新建分类夹；沉到底那层已有同名文件 → 按「原名 (1).后缀」换名、绝不覆盖；
 *     出发那层被同名**文件**占着 → 不动它、退回规则并说明；下沉只在同一棵源文件夹树内；
 *   · **绝不混在一起**（用户硬要求）：来自不同源文件夹的文件永远不会出现在同一个输出目录里；
 *   · **同名不相撞**：同一段输出路径里同名的文件夹加序号（`备份`、`备份 (2)`）；
 *   · **分类名可以是「相对这一层的多级路径」**（本片新增）：规则里写 `照片\风光` 就在这一层下面
 *     逐层建 `照片\` 与 `风光\`（`\` 与 `/` 等价），文件落进最里面那一层；只写 `01_图片` 与以前**完全一致**（一层）。
 *     多级分类名同样受上面那几条管：先看同名子文件夹、再按规则落分类夹；同一深度同名同样不覆盖（`原名 (1).后缀`）。
 *     分类名归一只在 `rules.ts` 那一处（安全校验也在那里）：绝对路径 / `..` / 非法字符 / 保留设备名 /
 *     头尾空格与结尾点一律**拒绝**并给人话原因，那个文件回落兜底分类 —— 绝不许写到源文件夹树外面去。
 *
 * 结构示意（输出根下）：
 *   下载\                     ← 拖入的源文件夹，输出根下同名一份
 *     01_图片\                ← 「下载」根下散文件（散1.jpg）的分类夹
 *     照片\风光\              ← 规则名写成两级时的分类路径（逐层建目录）
 *       散2.jpg
 *     一路沉\                 ← 「下载」根下 一路沉.jpg 与它同名 → 沉进去
 *       一路沉\               ← 里面还有同名的 → 继续沉
 *         一路沉.jpg
 *     照片\                   ← 「下载」的子文件夹：原样保留（空文件夹/空壳分支不重建）
 *       图1.png
 *       婚纱\
 *         纱1.jpg
 *   另一处\
 *     照片\
 *       图2.png
 *
 * 铁律：
 *  - 递归只收**文件**；空文件夹不产生输出（只剩空壳的分支也不重建）；
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
import { categoryTableOf, type CategoryAssignment } from './plan';
import { describeError } from './copyFiles';

/** 递归深度上限：超过就停下并说明原因（防止循环/超深目录把程序拖死）。 */
export const MAX_SCAN_DEPTH = 20;

/** 界面上那句人话（预览里必须明确写出来，也就是用户看到的那段说明）。只有这一个来源，不许在别处再写一份。 */
export const FOLDER_KEEP_HINT =
  '子文件夹里的文件按原样保留（连层级一起搬）；散在某一层根下的文件，若那一层有和它同名的子文件夹（按文件名去扩展名比对）就沉进去，进去了再按同一规矩往下看，直到没有同名的可沉；一次都没沉成的才按当前规则新建分类夹。';

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
   *  - `keep`：本来就在子文件夹里、且没得可沉 → 按原样保留相对路径；
   *  - `classify`：某一层根下的文件，没得可沉（或同名位置被文件占着）→ 按规则进分类夹（`category` 是分类夹名）；
   *  - `merge`：某一层根下的文件**沉进了同名的子文件夹**，一直沉到没有同名的可沉为止 → 留在那一层
   *    （`category` 是最后停下的那一层的名字）。
   */
  placement: 'keep' | 'classify' | 'merge';
  /** 分类夹名（`classify`）或最后停下的那一层子文件夹名（`merge`）；`keep` 时为 null */
  category: string | null;
  /** 这个文件原来在**源的哪一层**（相对拖入点）；界面据此算「沉了几层」 */
  originChain: string[];
  /** 沉/分类/占位的人话说明（给人看）；原样保留时为 null */
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
  /**
   * 显式分类表（小写完整路径 → 归一化后的分类路径）。
   * 给了它的文件**不再按规则算分类名**；没给（或不在表里）的照旧按规则算。
   * 只影响「本来就会按规则建分类夹」的那些散文件，子文件夹里的文件仍原样保留。
   */
  assignments?: ReadonlyMap<string, string> | null;
  /**
   * 这次给进来的 `assignments` 是不是「最终定稿的方案」（用户在预览里确认过的那份）。
   * 默认 false = 建议性质的分类（比如 AI 给的）：只对「本来就会按规则建分类夹」的散文件起作用，
   * 子文件夹里的文件仍原样保留；为 true 时，**表里有的文件一律按它给的分类落盘**，
   * 相对的是「这个源文件夹在输出里的落点」（子文件夹里的文件也能被手动挪到别的分类）。
   */
  assignmentsAreFinal?: boolean;
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
  /** 这次「谁去哪个夹」如果调用方已经给了结论（比如 AI 分好了），就按它走；没给的仍按规则算。 */
  const assignments = options?.assignments ?? null;
  /** 见 `PlanOptions.assignmentsAreFinal`：true 时表里的文件（含子文件夹里的）一律按它给的分类落盘。 */
  const assignmentsAreFinal = options?.assignmentsAreFinal === true;
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
    rootOutputDir: string,
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
      planned.subfolders.push(processNode(child, picked.name, childDir, false, picked.renamed, rootOutputDir));
    }

    // ② 这一层根下的文件：**同一套规矩**（不给谁开特例）。规矩 = 「同名就往下沉，沉到底」：
    //    这一层若有和它同名的子文件夹（文件自己的名字去扩展名、大小写不敏感、只比同一层）→ 沉进去，
    //    进去以后再按同一规矩往下看，直到那一层没有同名的可沉 → 就停在那一层（不再按规则另建分类夹）。
    //    一次都没沉成（连第一层都没有同名的）→ 按规则新建分类夹。
    //    明细见 `sinkOne()`。
    for (const file of node.looseFiles) {
      sinkOne(node, file, planned, outputDirPath, /* allowClassify */ classifyHere, rootOutputDir);
    }
    planned.categories.sort((a, b) => a.category.localeCompare(b.category));

    planned.totalFileCount = countFilesOf(planned);
    return planned;
  };

  /**
   * ③ 「只保留有文件的那部分层级」：子树里一个文件都没有的分支（空文件夹、只剩空壳的分支）
   *    **不重建** —— 从计划里去掉，免得预演出一个磁盘上根本不会建的目录
   *    （磁盘那边只为「真的有文件落进去」的目录建夹，两边由此保持一致）。
   * 注意：必须在**所有文件都放好之后**才修剪 —— 否则会把散文件待会儿要沉进去的那个子文件夹先删掉。
   */
  const pruneEmptyBranches = (folder: PlannedFolder): void => {
    folder.subfolders = folder.subfolders.filter((sub) => sub.totalFileCount > 0);
    for (const sub of folder.subfolders) pruneEmptyBranches(sub);
    folder.totalFileCount = countFilesOf(folder);
  };

  /**
   * 把一个「某一层根下的文件」按规矩放下去：**同名就往下沉，沉到底**。
   *
   * 停下来的三种情形：
   *  - 抵达最深处的那个同名子文件夹里、且它下面没有同名的可沉 → **留在那一层**（placement = 'merge'，不按规则另建分类夹）；
   *  - 一次都没沉成（`sank === 0`）→ 按规则新建分类夹（placement = 'classify'）；
   *  - 沉到的那一层被一个**同名文件**占着 → 不动那个文件，退回规则建分类夹并说明（沿用既有保护）。
   *
   * 下沉只在**同一个源文件夹树内**往下走（用节点自己的子树找同名子文件夹），绝不会跨源文件夹。
   * 深度上限沿用 `MAX_SCAN_DEPTH`：到顶就停下并在原因里说明。
   *
   * @param allowClassify 只对**顶层源文件夹那层**的散文件为 true（它们才是「按规则分类」的对象）；
   *   子文件夹里的文件同样走「同名就下沉」，但一次没沉成就**留在原地**（不按规则另建分类夹）。
   */
  const sinkOne = (
    node: ScanNode,
    file: TrackedFile,
    top: PlannedFolder,
    outputDirPath: string,
    allowClassify: boolean,
    rootOutputDir: string,
  ): void => {
    const stem = splitFileName(file.name).stem;
    // 规则求值：`matched.folder` 已是**归一化之后**的分类路径（可以有多级：`照片\风光`）。
    // `matched.invalidReason` 非空 = 规则名危险（绝对路径 / `..` / 非法字符…）→ 这个文件落到兜底分类，
    // 并把那句人话原因带上；**绝不**按危险名字建目录。
    //
    // 如果这次调用方已经给了「这个文件去哪个夹」（AI 分好的结论），就直接用它 ——
    // 它同样在进表之前归一化过，危险名字根本到不了这里；表里没有的照旧按规则算。
    const given = assignments?.get(file.fullPath.toLowerCase());

    // 最终定稿方案（用户确认过的那份）：表里有的文件**一律**按它给的分类落盘，相对的是源文件夹落点。
    // 这样「手动把子文件夹里的文件拖到别的分类」才会真的生效，而不是被「子文件夹原样保留」吃掉。
    if (assignmentsAreFinal && given && given.length > 0) {
      const categoryDir = joinedPath(rootOutputDir, given);
      const placed = placeName(categoryDir, file.name);
      const entry: PlannedFile = {
        fullPath: file.fullPath,
        name: placed.name,
        origin: node.origin,
        targetDir: categoryDir,
        placement: 'classify',
        category: given,
        originChain: node.origin.chain.slice(),
        mergeReason: '按预览里定稿的分类落盘',
        renamed: placed.renamed,
      };
      files.push(entry);
      return;
    }

    const matched =
      given && given.length > 0
        ? { folder: given, invalidReason: '' }
        : classifyWithMeta(rules, file.fullPath, file.name);
    const categoryName = matched.folder;
    /** 按规则新建的分类夹目录（多级就是「这一层 + 各层名字」拼出来的那条路径）。 */
    const categoryDir = joinedPath(outputDirPath, categoryName);
    const categoryReason =
      matched.invalidReason.length > 0
        ? `规则算出来的分类名不能用，所以按兜底分类「${categoryName}」走：${matched.invalidReason}`
        : '';
    const depthCap = MAX_SCAN_DEPTH;

    interface SinkStep {
      name: string;
      /** 这一层是「同名」沉下去的，还是「只有一条路」顺下去的 */
      viaSameName?: boolean;
    }
    const steps: SinkStep[] = [];
    let curNode: ScanNode = node;
    let curOut = outputDirPath;
    /** 下沉经过的每一层计划节点（第 0 个就是起点那一层），用来在下沉后刷新各层文件数 */
    const chainPlans: PlannedFolder[] = [top];
    let guard = 0;

    /** 在计划树里按输出名找这一层对应的那一份（用于登记并进来的文件）。 */
    const plannedAt = (chain: string[]): PlannedFolder | null => {
      let cursor: PlannedFolder | null = top;
      for (const seg of chain) {
        if (!cursor) return null;
        cursor = cursor.subfolders.find((s) => s.outputName === seg) ?? null;
      }
      return cursor;
    };

    for (;;) {
      if (++guard > depthCap + 2) break; // 兜底：绝不可能无限循环
      // 这一层有和它同名的子文件夹吗？（只比同一层、大小写不敏感）
      const children: ScanNode[] = curNode.children;
      const hit = children.find((c) => {
        const name = c.origin.chain[c.origin.chain.length - 1];
        return name.toLowerCase() === stem.toLowerCase();
      });
      if (process.env.DSH_DEBUG_SINK) {
        console.log(
          `[dbg-loop] guard=${guard} stem=${stem} curNode=${JSON.stringify(curNode.origin.chain)} kids=${JSON.stringify(
            children.map((k) => k.origin.chain.join('/')),
          )} hit=${!!hit}`,
        );
      }
      if (!hit) break; // 这一层没有同名的可沉 → 停下来
      const chain: string[] = hit.origin.chain;
      if (chain.length > depthCap) {
        break; // 已经到深度上限，停在这里并在下面说明
      }
      const plannedHit = plannedAt(chain);
      if (process.env.DSH_DEBUG_SINK) {
        console.log(
          `[dbg-hit] file=${file.name} chain=${JSON.stringify(chain)} hit=${!!plannedHit} topKids=${JSON.stringify(
            top.subfolders.map((s) => `${s.outputName}:${s.totalFileCount}:${s.keptFiles.length}:${s.mergedInto.length}`),
          )}`,
        );
      }
      if (!plannedHit) break;
      steps.push({ name: plannedHit.outputName });
      chainPlans.push(plannedHit);
      curNode = hit;
      curOut = plannedHit.outputDir;
    }

    const sank = steps.length;
    const pathText = steps.map((s) => s.name + '\\').join('');
    const deepestDir = curOut;

    if (sank === 0) {
      if (!allowClassify) {
        // 子文件夹里的文件，没得可沉 → 留在原地（不按规则另建分类夹）
        const placed = placeName(outputDirPath, file.name);
        const entry: PlannedFile = {
          fullPath: file.fullPath,
          name: placed.name,
          origin: node.origin,
          targetDir: outputDirPath,
          placement: 'keep',
          category: null,
          originChain: node.origin.chain.slice(),
          mergeReason: null,
          renamed: placed.renamed,
        };
        files.push(entry);
        top.keptFiles.push(entry);
        top.keptFileCount++;
        return;
      }
      // 顶层源文件夹的散文件，没得可沉 → 按规则新建分类夹（既有行为；分类名可以有多级）
      let reason = `这一层没有和它同名的子文件夹，没得可沉；按规则算出来是「${categoryName}」，新建分类夹`;
      if (categoryReason.length > 0) reason = `这一层没有和它同名的子文件夹，没得可沉；${categoryReason}`;
      // 同名位置被一个**文件**占着（或规则分类夹名被一个文件占着）→ 说明一下，不许覆盖它
      for (const name of [stem, categoryName]) {
        if (name.length === 0) continue;
        try {
          const st = fssync.statSync(joinedPath(node.dirPath, name));
          if (!st.isDirectory()) {
            reason = `这一层有个同名的「文件」占着 ${name} 这个名字，没有动它；按规则新建分类夹`;
            break;
          }
        } catch {
          /* 没有这个东西，属正常 */
        }
      }
      const placed = placeName(categoryDir, file.name);
      const entry: PlannedFile = {
        fullPath: file.fullPath,
        name: placed.name,
        origin: node.origin,
        targetDir: categoryDir,
        placement: 'classify',
        category: categoryName,
        originChain: node.origin.chain.slice(),
        mergeReason: reason,
        renamed: placed.renamed,
      };
      files.push(entry);
      top.looseFileCount++;
      top.classifiedCount++;
      let bucket = top.categories.find((c) => c.category === categoryDir);
      if (!bucket) {
        bucket = { category: categoryName, files: [] };
        top.categories.push(bucket);
      }
      bucket.files.push(entry);
      return;
    }

    // 沉过之后：分两种情况
    //  · 最深处那层已经有**同名文件** → 沿用既有换名规则（「原名 (1).后缀」），**绝不覆盖**；
    //  · 出发那一层就有个同名的**文件**占着（例如 撞名.pdf 与文件「撞名」同处一层）→
    //    不动那个文件，退回规则建分类夹并说明。
    const deepestPlanned = plannedAt(curNode.origin.chain);
    const deepestHasSameFile = deepestPlanned
      ? deepestPlanned.keptFiles.some((f) => f.name.toLowerCase() === file.name.toLowerCase())
      : false;
    const startHasSameFile = (() => {
      try {
        const st = fssync.statSync(joinedPath(node.dirPath, stem));
        return !st.isDirectory();
      } catch {
        return false;
      }
    })();
    if (deepestHasSameFile) {
      const placed = placeName(deepestDir, file.name);
      const entry: PlannedFile = {
        fullPath: file.fullPath,
        name: placed.name,
        origin: node.origin,
        targetDir: deepestDir,
        placement: 'merge',
        category: steps[steps.length - 1].name,
        originChain: node.origin.chain.slice(),
        mergeReason: `和这一层根下的「${steps[0].name}」同名，沉了 ${sank} 层（${pathText}）留在这里；那一层已经有同名文件，按换名规则改成「${placed.name}」，绝不覆盖`,
        renamed: placed.renamed,
      };
      files.push(entry);
      const owner = deepestPlanned ?? top;
      owner.mergedInto.push(entry);
      owner.keptFileCount++;
      top.looseFileCount++;
      top.mergedCount++;
      return;
    }
    if (startHasSameFile && allowClassify) {
      const placed = placeName(categoryDir, file.name);
      const entry: PlannedFile = {
        fullPath: file.fullPath,
        name: placed.name,
        origin: node.origin,
        targetDir: categoryDir,
        placement: 'classify',
        category: categoryName,
        originChain: node.origin.chain.slice(),
        mergeReason:
          `这一层有个同名的「文件」占着 ${stem} 这个名字，没有动它；按规则新建分类夹 ${categoryName}\\` +
          (categoryReason.length > 0 ? `；${categoryReason}` : ''),
        renamed: placed.renamed,
      };
      files.push(entry);
      top.looseFileCount++;
      top.classifiedCount++;
      let bucket = top.categories.find((c) => c.category === categoryDir);
      if (!bucket) {
        bucket = { category: categoryName, files: [] };
        top.categories.push(bucket);
      }
      bucket.files.push(entry);
      return;
    }

    // 留在最深的那一层
    const placed = placeName(deepestDir, file.name);
    const entry: PlannedFile = {
      fullPath: file.fullPath,
      name: placed.name,
      origin: node.origin,
      targetDir: deepestDir,
      placement: 'merge',
      category: steps[steps.length - 1].name,
      originChain: node.origin.chain.slice(),
      mergeReason:
        `和这一层根下的「${steps[0].name}」同名，沉进去；又按同一规矩往下看${
          sank > 1 ? `，一共沉了 ${sank} 层（${pathText}）` : ''
        }，` + `最深处没有同名的可沉了，就留在这里（不另建分类夹）`,
      renamed: placed.renamed,
    };
    files.push(entry);
    const owner = deepestPlanned ?? top;
    owner.mergedInto.push(entry);
    owner.keptFileCount++;
    top.looseFileCount++;
    top.mergedCount++;
    // 重要：往下沉到子层之后，那条链上每一层的文件数都要跟着刷新 ——
    // 否则「空壳分支」的修剪会把刚刚收下文件的这一层误当成空分支删掉（磁盘那边其实是对的）。
    for (let i = chainPlans.length - 1; i >= 0; i--) {
      chainPlans[i].totalFileCount = countFilesOf(chainPlans[i]);
    }
    void owner;
  };

  const roots: PlannedRoot[] = [];
  for (const node of scan.tree ?? []) {
    // 空文件夹不产生任何输出：整棵子树一个文件都没有，就连落点/名字都不占
    if (countScanFiles(node) === 0) continue;
    const picked = pickUniqueFolderName(node.origin.rootName, '\u0000<输出根>', usedByScope);
    const rootOutputDir = targetDirOf(outputDir, [picked.name]);
    // 顶层源文件夹：这一层根下的散文件按规则分类/下沉
    const subtree = processNode(node, picked.name, rootOutputDir, true, picked.renamed, rootOutputDir);
    roots.push({
      origin: node.origin,
      outputName: picked.name,
      outputDir: rootOutputDir,
      renamed: picked.renamed,
      subtree,
      totalFileCount: subtree.totalFileCount,
    });
  }

  // ③ 所有文件都放好之后，再把「一个文件都没有」的分支（空文件夹、只剩空壳的分支）修剪掉：
  //    这些分支**不重建**，免得预演出磁盘上根本不会建的目录。
  for (const root of roots) pruneEmptyBranches(root.subtree);
  for (const root of roots) root.totalFileCount = root.subtree.totalFileCount;

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
  /** 显式分类（`source` 完整路径 → `category` 分类名）；给了就优先于规则，见 `categoryTableOf` */
  assignments?: readonly CategoryAssignment[] | null;
  /** 这次的 assignments 是不是「最终定稿的方案」（用户确认过的那份），语义见 `PlanOptions.assignmentsAreFinal` */
  assignmentsAreFinal?: boolean;
}

/**
 * 展开 + 算目标路径。**预览与执行都走这里**，所以「预览说去 A、执行去了 B」不可能发生。
 * 本函数只做只读的 stat/readdir，绝不建目录、绝不写文件。
 */
export function planFolders(input: FolderPlanInput): FolderPlanOutcome {
  const roots = Array.from(input?.roots ?? []).map((r) => String(r));
  const scan = expandFolders(roots);
  const outputDir = input?.outputDir === null || input?.outputDir === undefined ? '' : String(input.outputDir);
  const plan = buildPlan({
    outputDir,
    scan,
    rules: input?.rules ?? null,
    assignments: categoryTableOf(input?.assignments),
    assignmentsAreFinal: input?.assignmentsAreFinal === true,
  });
  return { plan, scan, tree: scan.tree };
}
