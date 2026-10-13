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
   * 「换一种分法：AI 分类」那几件事的通道（界面只能走这里）。
   * 真实现只有 core/aiClassify.ts 一处：配置读写、真请求、分批/超时/重试、解析、测试连接、
   * 「AI 建议 → 规则」。**密钥只存在 userData 下的配置文件里，界面只回报「有没有」，不回显内容。**
   */
  aiStatus(): Promise<AiStatus>;
  /** 读 AI 设置（密钥不回显） */
  aiConfigLoad(): Promise<AiConfigView>;
  /** 存 AI 设置（写进 userData 下的配置文件；留空密钥 = 沿用原来那份） */
  aiConfigSave(input: { endpoint: string; model: string; authToken: string }): Promise<{
    ok: boolean;
    message: string;
    config: AiConfigView;
  }>;
  /** 「测试连接」：用界面上填的三项直接试一次（只发一次请求，不重试） */
  aiConfigTest(input: { endpoint: string; model: string; authToken: string }): Promise<{
    ok: boolean;
    message: string;
  }>;
  /** 把 AI 建议变成既有规则表里的规则（界面据此让人确认，再走既有管线落盘） */
  aiSuggestRules(
    assignments: unknown[],
    rules?: Rule[] | null,
    seed?: string | null,
  ): Promise<AiRuleOutcome>;
  aiClassify(filePaths: string[], outputDir?: string | null): Promise<AiClassifyResult>;
  /** AI 分类的分批进度 */
  onAiProgress(handler: (p: AiProgress) => void): void;
  onProgress(handler: (p: OrganizeProgress) => void): void;
}

/** 界面上「AI 设置」那一段看到的形状（**密钥本体不回显**）。 */
export interface AiConfigView {
  endpoint: string;
  model: string;
  hasKey: boolean;
  keyLength: number;
  configPath: string;
  /** 界面上要照抄的那句提醒：密钥明文存在本机配置文件里、别提交进代码仓库 */
  pathWarning: string;
  /** 界面上要照抄的那句提醒：只发文件名/大小/修改时间，不读也不发文件内容 */
  metadataWarning: string;
}

/** 「AI 建议 → 规则」的结果：规则表 + 按既有规则求值算出的落点。 */
export interface AiRuleOutcome {
  rules: Rule[];
  checks: { source: string; category: string }[];
  message: string;
}

/** AI 分类的分批进度。 */
export interface AiProgress {
  done: number;
  total: number;
}
