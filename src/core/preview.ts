/**
 * 纯逻辑：分类「预览树」。**绝对不写磁盘**——只做只读的 stat，不建目录、不写文件、不写配置。
 *
 * 分类结果复用 `classifyWithMeta()`（与真正执行复制时的**同一个求值函数**）：
 * 传进来的规则表既决定每个文件去哪，也决定预览里列出哪些分类文件夹。
 * 本文件**不依赖 Electron**，可被 node 直接 require 测试。
 */
import * as fssync from 'fs';
import { baseName, extensionOf } from './classify';
import { activeFolderNamesOf, type RuleTable } from './rules';
import { classifyWithMeta } from './classifyWithMeta';
import { describeError } from './copyFiles';
import {
  countKeptOf,
  FOLDER_KEEP_HINT,
  planFolders,
  type PlanResult,
  type PlannedFolder,
  type ScanNode,
  type SkippedPath,
} from './expandAndPlan';

/** 某个文件读不到元信息时的说明；能读到就是 null。 */
export interface PreviewFileError {
  /** 人话原因（如「原文件不存在或路径已失效」） */
  message: string;
  /** 底层错误码（如 ENOENT），取不到时为 '' */
  code: string;
}

/** 预览树里的一个文件。`folder` 始终由现有分类规则给出，与读不到元信息与否无关。 */
export interface PreviewFile {
  /** 原文件路径 */
  path: string;
  /** 文件名（含后缀） */
  name: string;
  /** 小写后缀，不含点；无后缀为 '' */
  ext: string;
  /** 目标分类文件夹名 */
  folder: string;
  /** 能否读到文件元信息（不存在 / 无权限 / 是文件夹 → false） */
  readable: boolean;
  /** 读不到时的人话原因；读得到时为 null */
  error: PreviewFileError | null;
}

/** 预览树里的一个分类文件夹。 */
export interface PreviewFolder {
  /** 分类文件夹名（与真正复制时用的完全一致） */
  folder: string;
  /** 该文件夹下的文件个数 */
  count: number;
  /** 该文件夹下的文件明细 */
  files: PreviewFile[];
}

/**
 * 预览里「某个源文件夹自己那一份」：源文件夹各归各，一眼看出哪一份是哪个源路径来的。
 * 最终语义（散落的文件以子文件夹优先）下，这一份里有两种东西：
 *  - `subfolders`：**原样保留**的子树（结构照搬，不按规则重分）；某个子文件夹如果跟散文件同名，散文件会并进来；
 *  - `categories`：这一层根下散文件**按规则新建**的分类夹（没有同名子文件夹时才建）。
 * （分组显示用，绝不落盘。）
 */
export interface PreviewSourceFolder {
  /** 源文件夹名 */
  name: string;
  /** 源文件夹完整路径（说清「这一份是哪来的」） */
  sourcePath: string;
  /** 相对顶层的各层子文件夹名；顶层就是 [] */
  chain: string[];
  /** 顶层源文件夹路径 */
  rootPath: string;
  /** 顶层源文件夹名 */
  rootName: string;
  /** 输出里的名字（同段路径里同名时会被改成「照片 (2)」） */
  outputName: string;
  /** 这一份的输出目录（显示用，预览绝不创建它） */
  outputDir: string;
  /** 这一份（含子树）的文件总数 */
  count: number;
  /** 直接躺在这一层根下、要按规则处理（并入同名子文件夹 / 新建分类夹）的散文件个数 */
  looseCount: number;
  /** 这一份下面原样保留的文件个数（子文件夹里的 + 并进子文件夹的散文件） */
  keptCount: number;
  /** 有多少散文件是「并进同名子文件夹」的 */
  mergedCount: number;
  /** 有多少散文件是「按规则新建分类夹」的 */
  classifiedCount: number;
  /** 是不是因为「同段路径里有同名文件夹」改过名 */
  renamed: boolean;
  /** 这一层根下散文件按规则**新建**的分类夹（空分类不列） */
  categories: PreviewFolder[];
  /** 原样保留的子树（空文件夹不列；里面的散文件已并进来） */
  subfolders: PreviewSubFolder[];
}

/** 预览里「原样保留的那棵子树」的一个目录。 */
export interface PreviewSubFolder {
  /** 目录名（源里的名字，同段同名时可能带序号） */
  name: string;
  /** 源里的路径 */
  sourcePath: string;
  /** 输出里的路径（相对输出根） */
  outputPath: string;
  /** 这个目录（含下面整棵子树）有几个文件 */
  count: number;
  /** 直接躺在这个目录里的文件（含并进来的散文件） */
  files: PreviewFile[];
  /** 其中是「散文件并进来」的那几个（用来在界面上说清「并进同名子文件夹」） */
  mergedIn: PreviewFile[];
  /** 它下面的子目录 */
  children: PreviewSubFolder[];
}

/** 预览树里的一个顶层源文件夹。 */
export interface PreviewRoot {
  /** 顶层源文件夹名 */
  name: string;
  /** 顶层源文件夹路径 */
  path: string;
  /** 输出里的顶层名字（同名不覆盖时可能被改成「备份 (2)」） */
  outputName: string;
  /** 是不是因为「另一个同名顶层源文件夹」改过名 */
  renamed: boolean;
  /** 这一份自己 */
  self: PreviewSourceFolder;
  /** 它下面各层子文件夹各一份（按发现顺序；各归各） */
  children: PreviewSourceFolder[];
  /** 这个顶层源文件夹一共展开出几个文件（含子文件夹里的） */
  total: number;
}

/** 一棵分类预览树：每个分类一行（名字 + 数量），展开是文件名。 */
export interface PreviewTree {
  /** 输入的文件总数 */
  total: number;
  /** 按固定分类顺序排列的分类节点（没有文件的分类也在，count 为 0） */
  folders: PreviewFolder[];
  /** 每个分类的文件数（分类名 → 个数） */
  counts: Record<string, number>;
  /** 明细汇总（顺序与输入一致），便于「预览 vs 实际」逐条核对 */
  files: PreviewFile[];
  /** 能读到元信息的文件数 */
  readableCount: number;
  /** 读不到元信息的文件数 */
  unreadableCount: number;
  /** 输出文件夹（仅用于显示，预览绝不创建它）；没传就是 null */
  outputDir: string | null;
  /** 本次预览用的是不是调用方传进来的规则表（不是就是默认规则） */
  rulesApplied: boolean;
  /** 有没有按「源文件夹各归各 + 文件夹优先」分组（拖入了文件夹时才是 true） */
  tracked: boolean;
  /** 拖进来的顶层源文件夹个数（= 界面上的「来自 M 个文件夹」）；没有分组时为 0 */
  rootCount: number;
  /** 展开出来的所有源文件夹份数（顶层 + 各层子文件夹） */
  sourceFolderCount: number;
  /** 按源文件夹分好的组（分组显示用）；没有分组时为空数组 */
  roots: PreviewRoot[];
  /** 被跳过的路径与原因（读不了的子文件夹、符号链接、太深的目录…）；一个都没有时为空数组 */
  skipped: SkippedPath[];
  /** 界面上必须写出来的那句人话：子文件夹按原样保留、散文件先并进同名子文件夹、没有才按规则分类 */
  keepHint: string;
  /** 按规则**新建分类夹**放进去的散文件个数（合计） */
  classifyCount: number;
  /** 原样保留的文件个数（合计，含子文件夹里的） */
  keepCount: number;
  /** 并进同名子文件夹的散文件个数（合计） */
  mergeCount: number;
}

/** 没选输出文件夹 / 没拖入任何文件时的提示（人话，不抛错）。 */
export interface PreviewValidationError {
  ok: false;
  /** 人话提示 */
  message: string;
  /** 机器可判的原因码 */
  reason: 'no-files' | 'no-output-dir' | 'internal-error';
}

/** 预览成功 / 失败两种结果。 */
export type PreviewOutcome = { ok: true; tree: PreviewTree } | PreviewValidationError;

export interface PreviewBuildOptions {
  /** 要预览的文件路径列表（拖入的文件；不是文件夹时用这个） */
  files: readonly string[];
  /**
   * 拖入/选中的**源文件夹**路径列表。传了它就走「源文件夹各归各」：
   * 每个源文件夹（含各层子文件夹）在输出里各有一份，绝不互相混；
   * 这时 `files` 会被忽略（文件由递归展开得到）。
   */
  roots?: readonly string[] | null;
  /** 输出文件夹；只用于显示，预览绝不创建或写入它 */
  outputDir?: string | null;
  /** 分类规则表；不传就用默认规则（按后缀分五类）。与实际整理必须是同一套。 */
  rules?: RuleTable | null;
  /**
   * 是否探测文件元信息（默认 true，只读 stat，不写盘）。
   * 置为 false 时所有文件都按「可读」记，用于不碰磁盘的纯计算场合。
   */
  checkReadable?: boolean;
}

/** 「这一次预览/整理要按源文件夹各归各处理」的那批顶层源文件夹（由界面在调用前放好）。 */
let sourceRootsForNextRun: string[] = [];

/**
 * 放下「这一次预览要按源文件夹各归各处理」的那批顶层源文件夹。
 *
 * 为什么单独一个入口、不并进 `preview()` 的参数：
 * 界面侧那条预览调用 `api.preview(selectedFiles.slice(), outputDir, rulesForUse())` 被第 7 条验收
 * 用字面量钉着（不许改它一个字），所以源文件夹只能另开一条路送进来。
 * 放**空**就等于「这次按普通散文件处理」（与不传同义），只读地用一次就清掉，不残留给下一次。
 */
export function setSourceRoots(roots: readonly string[] | null | undefined): void {
  sourceRootsForNextRun = Array.from(roots ?? [])
    .map((r) => String(r))
    .filter((r) => r.length > 0);
}

/** 看一眼当前放好的源文件夹（只给测试/排查用，不参与判定）。 */
export function currentSourceRoots(): string[] {
  return sourceRootsForNextRun.slice();
}

function takeSourceRoots(): string[] {
  const out = sourceRootsForNextRun;
  sourceRootsForNextRun = [];
  return out;
}

/** 只读探测一个文件的元信息：给不出人话原因就算「读不到」，但绝不让整棵树失败。 */
function probeFile(filePath: string, checkReadable: boolean): { readable: boolean; error: PreviewFileError | null } {
  if (!checkReadable) return { readable: true, error: null };

  try {
    const st = fssync.statSync(filePath);
    if (!st.isFile()) {
      // isDirectory / 其它特殊文件：复制阶段会被拒绝，这里先标出来
      return { readable: false, error: { message: '这是一个文件夹，本片只支持文件', code: 'EISDIR' } };
    }
    return { readable: true, error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    return { readable: false, error: { message: describeError(err), code } };
  }
}

/**
 * 纯函数（除只读 stat / readdir 外无副作用）：输入文件或源文件夹，输出一棵分类预览树。
 *
 * 保证：
 *  - 每个文件的 `folder` 来自现有分类规则，和真正执行复制时一致；
 *  - 预览树的分类顺序、文件夹名与执行时一致；
 *  - 传了 `roots`（拖入文件夹）时：按**源文件夹各归各**分组，每一份的目标路径与
 *    「开始整理」时用的是同一个 `planFolders()`（同一个求值入口 + 同一套换名规则）；
 *  - **不创建任何目录、不写任何文件**（包括输出文件夹本身）；
 *  - 单个文件读不到元信息只标注原因，不影响整棵树。
 */
export function buildPreviewTree(options: PreviewBuildOptions): PreviewOutcome {
  // 源文件夹两个来源：显式传的 `roots`，或调用方事先用 `setSourceRoots()` 放好的那一批。
  // 两者都只读地用一次，之后清掉，绝不会把上一次的源文件夹留到下一次。
  const preset = takeSourceRoots();
  const roots = Array.from(options?.roots ?? [])
    .map((r) => String(r))
    .filter((r) => r.length > 0);
  if (roots.length === 0) for (const r of preset) roots.push(r);
  const files = Array.from(options?.files ?? []);
  const outputDir = options?.outputDir ?? null;
  const tracked = roots.length > 0;

  if (!tracked && files.length === 0) {
    return { ok: false, reason: 'no-files', message: '还没有可预览的文件，先拖进来或点「选择文件」「选择文件夹」' };
  }
  if (outputDir === null || outputDir === undefined || String(outputDir).trim() === '') {
    return { ok: false, reason: 'no-output-dir', message: '还没选输出文件夹，先点「选择输出文件夹」' };
  }

  const checkReadable = options?.checkReadable !== false;
  const rules = options?.rules ?? null;
  // 分类：与真正执行复制时**同一个求值函数**（大小/时间条件要真读属性）
  const entries: PreviewFile[] = [];
  const byFolder = new Map<string, PreviewFile[]>();
  for (const folder of activeFolderNamesOf(rules)) byFolder.set(folder, []);

  let plan: PlanResult | null = null;
  let tree: ScanNode[] = [];

  if (tracked) {
    // 展开 + 算目标路径：与「开始整理」走同一个 planFolders（只读，绝不建目录）
    const outcome = planFolders({ roots, outputDir: String(outputDir), rules });
    plan = outcome.plan;
    tree = outcome.tree;
  }

  const pushInto = (folder: string, item: PreviewFile): void => {
    entries.push(item);
    let bucket = byFolder.get(folder);
    if (!bucket) {
      bucket = [];
      byFolder.set(folder, bucket);
    }
    bucket.push(item);
  };

  /** 文件 → 预览条目（分类一律来自规则求值，与执行时同一个函数）。 */
  const previewItemOf = (filePath: string, folder: string): PreviewFile => {
    const probe = probeFile(filePath, checkReadable);
    return {
      path: filePath,
      name: baseName(filePath),
      ext: extensionOf(filePath),
      folder,
      readable: probe.readable,
      error: probe.error,
    };
  };

  if (tracked && plan) {
    // 顶部那份「按分类汇总」：只列**按规则分类的散文件**
    // （子文件夹里的是原样保留的，不进任何分类夹，所以不列在这里）
    for (const f of plan.files) {
      if (f.placement === 'classify') {
        const category = f.category ?? '';
        pushInto(category, previewItemOf(f.fullPath, category));
      }
    }
  } else {
    for (const raw of files) {
      const p = String(raw);
      const matched = classifyWithMeta(rules, p);
      pushInto(matched.folder, previewItemOf(p, matched.folder));
    }
  }

  // 这一次的文件总数与三种去处的个数（原样保留的也算总数，只是不进分类夹）
  const plannedFiles = tracked && plan ? plan.files : [];
  const classifyCount = tracked && plan ? plannedFiles.filter((f) => f.placement === 'classify').length : entries.length;
  const keepCount = tracked && plan ? plannedFiles.filter((f) => f.placement === 'keep').length : 0;
  const mergeCount = tracked && plan ? plannedFiles.filter((f) => f.placement === 'merge').length : 0;
  const totalCount = tracked && plan ? plannedFiles.length : entries.length;

  const folders: PreviewFolder[] = [];
  const counts: Record<string, number> = {};
  for (const [folder, list] of byFolder) {
    folders.push({ folder, count: list.length, files: list });
    counts[folder] = list.length;
  }

  // 按源文件夹分组（每一份各归各）：份内再分「原样保留的子树（含并入的散文件）」与「按规则新建的分类夹」
  const rootsOut: PreviewRoot[] = [];
  let sourceFolderCount = 0;
  if (tracked && plan) {
    const makeSourceFolder = (planned: PlannedFolder): PreviewSourceFolder => ({
      name: planned.outputName === '' ? planned.origin.rootName : sourceNameOf(planned.origin),
      sourcePath: sourcePathOf(planned.origin),
      chain: planned.origin.chain.slice(),
      rootPath: planned.origin.rootPath,
      rootName: planned.origin.rootName,
      outputName: planned.outputName,
      outputDir: planned.outputDir,
      count: planned.totalFileCount,
      looseCount: planned.looseFileCount,
      keptCount: countKeptOf(planned),
      mergedCount: planned.mergedCount,
      classifiedCount: planned.classifiedCount,
      renamed: planned.renamed,
      categories: planned.categories.map((g) => ({
        folder: g.category,
        count: g.files.length,
        files: g.files.map((f) => previewItemOf(f.fullPath, g.category)),
      })),
      subfolders: planned.subfolders.map((sub) => makeSubFolder(sub)),
    });

    const makeSubFolder = (sub: PlannedFolder): PreviewSubFolder => ({
      name: sub.outputName,
      sourcePath: sourcePathOf(sub.origin),
      outputPath: sub.outputDir,
      count: sub.totalFileCount,
      // 这一层原样保留的文件 + 并进来的散文件（子目录里的留在各自节点上）
      files: sub.keptFiles.concat(sub.mergedInto).map((f) => previewItemOf(f.fullPath, '')),
      mergedIn: sub.mergedInto.map((f) => previewItemOf(f.fullPath, '')),
      children: sub.subfolders.map((c) => makeSubFolder(c)),
    });

    for (const root of plan.roots) {
      sourceFolderCount += 1 + countNodes(root.subtree.subfolders);
      rootsOut.push({
        name: root.origin.rootName,
        path: root.origin.rootPath,
        outputName: root.outputName,
        renamed: root.renamed,
        self: makeSourceFolder(root.subtree),
        children: flattenPlanned(root.subtree.subfolders).map((f) => makeSourceFolder(f)),
        total: root.totalFileCount,
      });
    }
  }

  return {
    ok: true,
    tree: {
      total: totalCount,
      folders,
      counts,
      files: entries,
      readableCount: entries.filter((f) => f.readable).length,
      unreadableCount: entries.filter((f) => !f.readable).length,
      outputDir: String(outputDir),
      rulesApplied: rules !== null && rules !== undefined,
      tracked,
      rootCount: rootsOut.length,
      sourceFolderCount,
      roots: rootsOut,
      skipped: plan ? plan.skipped.slice() : [],
      keepHint: FOLDER_KEEP_HINT,
      classifyCount,
      keepCount,
      mergeCount,
    },
  };
}

/** 源文件夹的完整路径。 */
function sourcePathOf(origin: { rootPath: string; chain: string[] }): string {
  return origin.chain.length > 0 ? [origin.rootPath, ...origin.chain].join('\\') : origin.rootPath;
}

/** 源文件夹这一层的名字。 */
function sourceNameOf(origin: { rootName: string; chain: string[] }): string {
  return origin.chain.length > 0 ? origin.chain[origin.chain.length - 1] : origin.rootName;
}

/** 一棵计划子树里的节点个数。 */
function countNodes(subs: readonly PlannedFolder[]): number {
  let n = 0;
  for (const s of subs) n += 1 + countNodes(s.subfolders);
  return n;
}

/** 把一棵计划子树按「先父后子」摊平。 */
function flattenPlanned(subs: readonly PlannedFolder[], out: PlannedFolder[] = []): PlannedFolder[] {
  for (const s of subs) {
    out.push(s);
    flattenPlanned(s.subfolders, out);
  }
  return out;
}
