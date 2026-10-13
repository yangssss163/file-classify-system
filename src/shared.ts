/**
 * 界面与主进程之间的接口类型（只用于类型检查，运行时不加载）。
 */
import type {
  AiClassifyResult,
  AiStatus,
  CopySummary,
  OutputDirectionCheck,
  PreviewOutcome,
  Rule,
  RulesLoadResult,
  RulesSaveResult,
  ScanResult,
  UndoRunOutcome,
  UndoSummary,
} from './core';

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
  /** 上一次整理的记录（界面上那句「上一次整理：输出到 …，成功 N 个，可撤销」） */
  lastRun(): Promise<UndoSummary>;
  /** 撤销上一次整理：只删记录里列出的目标路径，原文件一律不动；幂等 */
  undoLastRun(): Promise<UndoRunOutcome>;
  /** 开工前的输出方向校验（危险就不开工，一个字节都不写） */
  checkOutputDirection(input: {
    roots?: string[] | null;
    files?: string[] | null;
    outputDir?: string | null;
  }): Promise<OutputDirectionCheck>;
  /**
   * 「换一种分法：AI 分类」那两件事的通道（界面只能走这里）。
   * `aiStatus()` 给界面上那行常显状态；`aiClassify()` 调一次 AI 分类。
   * 本片只搭壳：不联网络、不读密钥、不写盘；实现只有 core/aiClassify.ts 一处。
   */
  aiStatus(): Promise<AiStatus>;
  aiClassify(filePaths: string[], outputDir?: string | null): Promise<AiClassifyResult>;
  onProgress(handler: (p: OrganizeProgress) => void): void;
}
