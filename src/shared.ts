/**
 * 界面与主进程之间的接口类型（只用于类型检查，运行时不加载）。
 */
import type { CopySummary, PreviewOutcome } from './core';

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

export interface OrganizerApi {
  /** 把拖进来的 File 换成磁盘路径（预加载脚本里用 webUtils.getPathForFile）；取不到给 null */
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
