/**
 * 界面与主进程之间的接口类型（只用于类型检查，运行时不加载）。
 */
import type { CopySummary, PreviewOutcome, Rule, RulesLoadResult, RulesSaveResult, ScanResult } from './core';

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
  /** 「选择文件夹」（可多选） */
  pickFolders(): Promise<string[]>;
  pickOutputDir(): Promise<string | null>;
  exists(filePaths: string[]): Promise<Record<string, boolean>>;
  /** 递归展开文件夹（只读）：文件 + 每个文件的源文件夹归属 + 跳过原因 */
  expand(roots: string[]): Promise<ScanResult>;
  /** 放下「这一次预览要按源文件夹各归各处理」的那批源文件夹（只读地用一次就清掉） */
  setSourceRoots(roots: string[] | null): Promise<boolean>;
  /** 预览：只读计算，绝不写盘；规则表由界面传进去，与实际整理保持同一套 */
  preview(files: string[], outputDir: string | null, rules?: Rule[] | null): Promise<PreviewOutcome>;
  /** 整理：传了 roots 就走「源文件夹各归各」（每个源文件夹一份，绝不互相混） */
  organize(files: string[], outputDir: string, rules?: Rule[] | null, roots?: string[] | null): Promise<CopySummary>;
  openPath(dir: string): Promise<string>;
  /** 读取上次保存的规则（读不到/坏掉 → 默认规则 + 人话提示） */
  loadRules(): Promise<RulesLoadResult>;
  /** 保存规则（写到 userData 目录下的 JSON 文件） */
  saveRules(rules: Rule[]): Promise<RulesSaveResult>;
  /** 规则文件路径（只用于显示） */
  rulesPath(): Promise<string>;
  onProgress(handler: (p: OrganizeProgress) => void): void;
}
