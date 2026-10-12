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

/** 一棵分类预览树：每个分类一行（名字 + 数量），展开是文件名。 */
export interface PreviewTree {
  total: number;
  folders: PreviewFolder[];
  counts: Record<string, number>;
  files: PreviewFile[];
  readableCount: number;
  unreadableCount: number;
  outputDir: string | null;
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

/** 预加载脚本暴露到 window.organizer 上的那一套方法。 */
export interface OrganizerApi {
  /** 把拖进来的 File 换成磁盘路径（preload 里用 webUtils.getPathForFile）；取不到给 null */
  pathForFile(file: File): string | null;
  pickFiles(): Promise<string[]>;
  pickOutputDir(): Promise<string | null>;
  exists(filePaths: string[]): Promise<Record<string, boolean>>;
  /** 预览：只读计算，绝不写盘 */
  preview(files: string[], outputDir: string | null): Promise<PreviewOutcome>;
  organize(files: string[], outputDir: string): Promise<CopySummary>;
  openPath(dir: string): Promise<string>;
  onProgress(handler: (p: OrganizeProgress) => void): void;
}
