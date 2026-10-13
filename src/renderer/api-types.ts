/**
 * 界面（renderer）看到的接口类型。
 *
 * 为什么单独一份、不直接 import ../shared：
 *   界面产物必须是浏览器能直接执行的 ES module，编译时不能牵扯 node 类型
 *   —— src/shared.ts 会一路拉到 src/core/*.ts（里面有 `import * as fs from 'fs'`、
 *   `NodeJS.ErrnoException`），那种类型在浏览器侧不该出现。
 *   这里的类型是 preload（src/preload.ts）通过 contextBridge 真正暴露的那一份的
 *   类型描述；两边是否对得上，由主编译（tsconfig.json 编译 main/preload/shared）看着。
 *
 * 改这里时要同步：src/shared.ts（同一个 API 的 node 侧描述）、src/preload.ts（实现）。
 */

/** 某个文件读不到元信息时的说明；能读到就是 null。 */
export interface PreviewFileError {
  /** 人话原因（如「原文件不存在或路径已失效」） */
  message: string;
  /** 底层错误码（如 ENOENT），取不到时为 '' */
  code: string;
}

/** 预览树里的一个文件。 */
export interface PreviewFile {
  /** 原文件路径 */
  path: string;
  /** 文件名（含后缀） */
  name: string;
  /** 小写后缀，不含点；无后缀为 '' */
  ext: string;
  /** 目标分类文件夹名 */
  folder: string;
  /** 能否读到文件元信息 */
  readable: boolean;
  /** 读不到时的人话原因；读得到时为 null */
  error: PreviewFileError | null;
}

/** 预览树里的一个分类文件夹。 */
export interface PreviewFolder {
  /** 分类文件夹名 */
  folder: string;
  /** 该文件夹下的文件个数 */
  count: number;
  /** 该文件夹下的文件明细 */
  files: PreviewFile[];
}

/**
 * 预览里「某个源文件夹自己那一份」。
 * 最终语义（散落的文件以子文件夹优先）：份内两块 —— 原样保留的子树（含并入的散文件）、
 * 以及「这一层没有同名子文件夹时才按规则新建」的分类夹。
 */
export interface PreviewSourceFolder {
  name: string;
  sourcePath: string;
  chain: string[];
  rootPath: string;
  rootName: string;
  /** 输出里的名字（同段路径里同名时会被改成「照片 (2)」） */
  outputName: string;
  outputDir: string;
  /** 这一份（含子树）的文件总数 */
  count: number;
  /** 直接躺在这一层根下、要按规则处理的散文件个数 */
  looseCount: number;
  /** 这一份下面原样保留的文件个数（子文件夹里的 + 沉进子文件夹的散文件） */
  keptCount: number;
  /** 有多少散文件是「沉进了同名子文件夹」的 */
  mergedCount: number;
  /** 有多少散文件是「按规则新建分类夹」的 */
  classifiedCount: number;
  renamed: boolean;
  /** 这一层根下散文件按规则**新建**的分类夹 */
  categories: PreviewFolder[];
  /** 沉进这一份的散文件（顶层为空） */
  mergedIn: PreviewFile[];
  /** 它们各自沉了几层（与 `mergedIn` 一一对应） */
  sunkDepth: number[];
  /** 它们各自的人话原因（与 `mergedIn` 一一对应） */
  sunkReasons: string[];
  /** 原样保留的子树（含沉进来的散文件） */
  subfolders: PreviewSubFolder[];
}

/** 预览里「原样保留的那棵子树」的一个目录。 */
export interface PreviewSubFolder {
  name: string;
  sourcePath: string;
  /** 输出里的路径（相对输出根） */
  outputPath: string;
  count: number;
  /** 直接躺在这个目录里的文件（含沉进来的散文件） */
  files: PreviewFile[];
  /** 其中是「散文件沉进来」的那几个 */
  mergedIn: PreviewFile[];
  /** 它们各自沉了几层（与 `mergedIn` 一一对应） */
  sunkDepth: number[];
  /** 它们各自的人话原因（与 `mergedIn` 一一对应） */
  sunkReasons: string[];
  children: PreviewSubFolder[];
}

/** 预览树里的一个顶层源文件夹。 */
export interface PreviewRoot {
  name: string;
  path: string;
  /** 输出里的顶层名字（同名不覆盖时可能被改成「备份 (2)」） */
  outputName: string;
  /** 是不是因为「另一个同名顶层源文件夹」改过名 */
  renamed: boolean;
  self: PreviewSourceFolder;
  children: PreviewSourceFolder[];
  /** 这个顶层源文件夹一共展开出几个文件（含子文件夹里的） */
  total: number;
}

/** 一棵分类预览树：每个分类一行（名字 + 数量），展开是文件名。 */
export interface PreviewTree {
  total: number;
  folders: PreviewFolder[];
  counts: Record<string, number>;
  files: PreviewFile[];
  readableCount: number;
  unreadableCount: number;
  outputDir: string | null;
  /** 本次预览用的是不是界面上的规则表（不是就是默认规则） */
  rulesApplied: boolean;
  /** 有没有按「源文件夹各归各 + 文件夹优先」分组（拖入了文件夹时才是 true） */
  tracked: boolean;
  /** 拖进来的顶层源文件夹个数（界面上的「来自 M 个文件夹」） */
  rootCount: number;
  /** 展开出来的所有源文件夹份数（顶层 + 各层子文件夹） */
  sourceFolderCount: number;
  /** 按源文件夹分好的组 */
  roots: PreviewRoot[];
  /** 被跳过的路径与原因（读不了的子文件夹、符号链接、太深的目录…） */
  skipped: { fullPath: string; reason: string; name?: string }[];
  /** 界面上必须写出来的那句人话：子文件夹按原样保留、散文件先并进同名子文件夹、没有才按规则分类 */
  keepHint: string;
  /** 按规则**新建分类夹**放进去的散文件个数（合计） */
  classifyCount: number;
  /** 原样保留的文件个数（合计） */
  keepCount: number;
  /** 并进同名子文件夹的散文件个数（合计） */
  mergeCount: number;
  /** 这一次的输出方向校验：危险时界面上要说清为什么不让开工，「开始整理」也就不可点 */
  outputDirection: OutputDirectionCheck;
}

/** 被跳过的路径与原因（展开文件夹时）。 */
export interface SkippedPath {
  fullPath: string;
  originKey: string;
  name?: string;
  reason: string;
}

/** 递归展开文件夹的结果（只读，不落盘）。 */
export interface ScanResult {
  /** 展开出来的文件（含源文件夹归属）；字段名叫 fullPath，避开 `.path` 的旧写法 */
  files: {
    fullPath: string;
    name: string;
    origin: { rootPath: string; rootName: string; chain: string[]; key: string };
  }[];
  /** 产生过文件的源文件夹（含各层子文件夹） */
  folders: { rootPath: string; rootName: string; chain: string[]; key: string }[];
  /** 被跳过的路径与原因 */
  skipped: SkippedPath[];
}

/** 没选输出文件夹 / 没拖入任何文件时的提示（人话，不抛错）。 */
export interface PreviewValidationError {
  ok: false;
  message: string;
  reason: 'no-files' | 'no-output-dir' | 'internal-error';
}

/** 预览成功 / 失败两种结果。 */
export type PreviewOutcome = { ok: true; tree: PreviewTree } | PreviewValidationError;

/** 复制结果汇总（界面只用来显示「成功几个 / 失败几个」）。 */
export interface CopySummary {
  total: number;
  successCount: number;
  failureCount: number;
  results: {
    source: string;
    folder: string;
    finalName: string;
    target: string | null;
    ok: boolean;
    renamed: boolean;
    error: string | null;
  }[];
  /** 输出根目录（绝对路径） */
  outputDir: string;
  /** 「源文件夹各归各」时：每个源文件夹在输出里的落点（普通文件模式为空数组） */
  plannedFolders: {
    /** 源文件夹完整路径（说清这一份是哪来的） */
    sourcePath: string;
    /** 相对顶层的各层子文件夹名 */
    sourceChain: string[];
    /** 输出里的这一份相对输出根的各层名字 */
    outputChain: string[];
    /** 这一份的输出目录 */
    outputDir: string;
    /** 这一份的文件个数 */
    fileCount: number;
    /** 是不是因为「另一个同名源文件夹」改过名 */
    renamed: boolean;
  }[];
  /** 被跳过的路径与原因（空文件夹不算，它只是不产生输出） */
  skipped: { fullPath: string; reason: string; name?: string }[];
  /** 本次复制出来的文件的目标路径（只有成功的那些）—— 撤销时只删这些 */
  writtenFiles: string[];
  /** 本次由程序（新）创建出来的目录 */
  createdDirs: string[];
  /** 输出方向被拦下时为 true：这次一个字节都没写 */
  blocked: boolean;
  blockedReason: string | null;
  direction: OutputDirectionCheck | null;
}

/** 整理过程中一次次回报的进度。 */
export interface OrganizeProgress {
  done: number;
  total: number;
  result: {
    source: string;
    folder: string;
    finalName: string;
    ok: boolean;
    renamed: boolean;
    error: string | null;
  };
}

/* ---------------- 输出方向校验 + 撤销上一次整理（本片新增） ---------------- */

/** 输出方向被拒绝的原因码（机器可判；界面只用人话那一段）。 */
export type OutputDirectionReason =
  | 'output-is-source'
  | 'output-inside-source'
  | 'output-is-source-parent'
  | 'output-is-file-folder'
  | 'no-output-dir'
  | 'no-files';

/**
 * 开工前的输出方向校验结论。
 * `ok=false` 时 `message` 是一句能直接给用户看的人话（说清为什么危险、所以一个字节都没写）。
 */
export interface OutputDirectionCheck {
  ok: boolean;
  reason: OutputDirectionReason | null;
  message: string;
  sourceRoots: string[];
  fileDirs: string[];
  outputDir: string;
}

/** 界面上那份「上一次整理」的摘要（决定撤销按钮可不可点）。 */
export interface UndoSummary {
  /** 有可撤销的整理时才是 true；否则按钮不可点，`reason` 说清为什么 */
  available: boolean;
  reason: string;
  outputDir: string;
  fileCount: number;
  dirCount: number;
  successCount: number;
  failureCount: number;
  failureNote: string;
  finishedAt: string;
  undoneAt: string | null;
  /** 界面上那一句（如「上一次整理：输出到 …，成功 N 个，可撤销」） */
  message: string;
}

/** 撤销时一个文件 / 一个目录的处置结果。 */
export interface UndoFileOutcome {
  target: string;
  source: string;
  action: 'deleted' | 'skipped';
  reason: string;
}

export interface UndoDirOutcome {
  dir: string;
  action: 'removed' | 'skipped';
  reason: string;
}

/** 撤销报告（人话 + 机器可判的数字）。 */
export interface UndoResult {
  ok: boolean;
  clean: boolean;
  changed: boolean;
  message: string;
  outputDir: string;
  plannedFiles: number;
  plannedDirs: number;
  deletedFiles: number;
  skippedFiles: number;
  removedDirs: number;
  skippedDirs: number;
  files: UndoFileOutcome[];
  dirs: UndoDirOutcome[];
}

/** 点一次「撤销上一次整理」的结果。 */
export interface UndoRunOutcome {
  result: UndoResult;
  summary: UndoSummary;
}

/** 修改时间的三种分档。 */
export type ModTimeBucket = 'any' | 'this-year' | 'last-year' | 'earlier';

/** 规则条件：四种可组合；没写的项不参与判断。 */
export interface RuleCondition {
  /** 后缀列表（小写、不含点；匹配大小写不敏感） */
  extensions?: readonly string[];
  /** 文件名关键词列表（含任意一个就命中，大小写不敏感） */
  keywords?: readonly string[];
  /** 大小下界（字节，含）；null = 不限 */
  minSize?: number | null;
  /** 大小上界（字节，不含）；null = 不限 */
  maxSize?: number | null;
  /** 修改时间分档 */
  modTime?: ModTimeBucket;
}

/** 一条分类规则（规则名 = 输出的分类文件夹名）。 */
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  condition: RuleCondition;
}

/** 规则读取结果（`ok=false` 时 rules 一定是可用的默认规则）。 */
export interface RulesLoadResult {
  ok: boolean;
  rules: Rule[];
  source: 'file' | 'default';
  message: string;
  filePath: string;
}

/** 规则保存结果。 */
export interface RulesSaveResult {
  ok: boolean;
  message: string;
  filePath: string;
}

/** 预加载脚本暴露到 window.organizer 上的那一套方法。 */
export interface OrganizerApi {
  /** 把拖进来的 File 换成磁盘路径（preload 里用 webUtils.getPathForFile）；取不到给 null */
  pathForFile(file: File): string | null;
  pickFiles(): Promise<string[]>;
  /** 「选择文件夹」（可多选） */
  pickFolders(): Promise<string[]>;
  pickOutputDir(): Promise<string | null>;
  exists(filePaths: string[]): Promise<Record<string, boolean>>;
  /** 递归展开文件夹（只读）：文件 + 每个文件的源文件夹归属 + 跳过原因 */
  expand(roots: string[]): Promise<ScanResult>;
  /** 放下「这一次预览要按源文件夹各归各处理」的那批源文件夹（只读地用一次就清掉） */
  setSourceRoots(roots: string[] | null): Promise<boolean>;
  /** 预览：只读计算，绝不写盘；规则表由界面传进去，跟当前界面上的规则保持一致 */
  preview(files: string[], outputDir: string | null, rules?: Rule[] | null): Promise<PreviewOutcome>;
  /** 整理：传了 roots 就走「源文件夹各归各」（每个源文件夹一份，绝不互相混） */
  organize(files: string[], outputDir: string, rules?: Rule[] | null, roots?: string[] | null): Promise<CopySummary>;
  openPath(dir: string): Promise<string>;
  /** 读取上次保存的规则；读不到就是默认规则 */
  loadRules(): Promise<RulesLoadResult>;
  /** 保存规则到 userData 目录下的 JSON 文件 */
  saveRules(rules: Rule[]): Promise<RulesSaveResult>;
  /** 规则文件路径（只用于显示） */
  rulesPath(): Promise<string>;
  /**
   * 上一次整理的记录（界面上那句「上一次整理：输出到 …，成功 N 个，可撤销」）。
   * 没有可撤销的整理时 available=false 并给一句人话原因，按钮据此变灰。
   */
  lastRun(): Promise<UndoSummary>;
  /** 撤销上一次整理：只删记录里列出的目标路径，原文件一律不动；幂等（撤过一次再点不删任何东西） */
  undoLastRun(): Promise<UndoRunOutcome>;
  /** 开工前的输出方向校验（危险就不开工，一个字节都不写） */
  checkOutputDirection(input: {
    roots?: string[] | null;
    files?: string[] | null;
    outputDir?: string | null;
  }): Promise<OutputDirectionCheck>;
  onProgress(handler: (p: OrganizeProgress) => void): void;
}
