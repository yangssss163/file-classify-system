/**
 * 界面与主进程之间的接口类型（只用于类型检查，运行时不加载）。
 */
import type { CopySummary } from './core';

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
  pickFiles(): Promise<string[]>;
  pickOutputDir(): Promise<string | null>;
  exists(filePaths: string[]): Promise<Record<string, boolean>>;
  organize(files: string[], outputDir: string): Promise<CopySummary>;
  openPath(dir: string): Promise<string>;
  onProgress(handler: (p: OrganizeProgress) => void): void;
}
