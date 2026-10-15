/**
 * preload：只暴露几个明确的方法给界面，界面拿不到 node。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AiClassifyResult,
  AiStatus,
  CopySummary,
  OutputDirectionCheck,
  PreviewOutcome,
  Rule,
  RulesLoadResult,
  RulesSaveResult,
  RuleTargetView,
  ScanResult,
  UndoRunOutcome,
  UndoSummary,
} from './core';

/**
 * 界面上「AI 设置」那一段看到的形状（**密钥本体不回显**）。
 * 单独在这一层写一遍的原因：core 里的类型带着 `apiKey` 字样，界面侧的产物不许出现它。
 */
export interface AiConfigView {
  /** 接口地址（默认 DeepSeek；用户可改） */
  endpoint: string;
  /** 模型名（默认 deepseek-chat） */
  model: string;
  /** 配置里有没有密钥（回显用它，密钥本体不回来） */
  hasKey: boolean;
  /** 密钥有几个字符（只用来显示「已保存 N 位」，不给内容） */
  keyLength: number;
  /** 配置文件的完整路径（界面上写明它在哪，方便用户备份/清理） */
  configPath: string;
  /** 界面上要照抄的那句提醒：密钥明文存在本机配置文件里、别提交进代码仓库 */
  pathWarning: string;
  /** 界面上要照抄的那句提醒：只发文件名/大小/修改时间，不读也不发文件内容 */
  metadataWarning: string;
}

/** 「AI 建议 → 规则」的结果：规则表 + 按既有规则求值算出的落点（给人确认用）。 */
export interface AiRuleOutcome {
  rules: Rule[];
  checks: { source: string; category: string }[];
  message: string;
}

/** 分批进度（AI 分类文件多的时候界面上要看得到走到哪儿了）。 */
export interface AiProgress {
  done: number;
  total: number;
}

/**
 * 把拖进来的 File 换成磁盘路径。
 * Electron 32 起 File.path 已被移除（44 上完全没有），只能由预加载脚本用
 * webUtils.getPathForFile 取；界面拿不到 node，所以这一步必须在 preload 里做。
 * 取不到就返回 null——调用方必须据此给人一句人话提示，不许静默无反应。
 */
function pathForFile(file: File): string | null {
  try {
    const p = webUtils.getPathForFile(file);
    return typeof p === 'string' && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

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

const api = {
  pathForFile,
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickFiles'),
  // 「选择文件夹」（可多选）：与拖入文件夹是同一个能力，走同一套递归展开
  pickFolders: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickFolders'),
  pickOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickOutputDir'),
  exists: (filePaths: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('files:exists', filePaths),
  // 递归展开文件夹（只读）：文件 + 每个文件的源文件夹归属 + 跳过原因
  expand: (roots: string[]): Promise<ScanResult> => ipcRenderer.invoke('files:expand', { roots }),
  /**
   * 放下「这一次预览要按源文件夹各归各处理」的那批源文件夹。
   * 单独一个入口的原因：预览那条调用被第 7 条验收用字面量钉着（三参，不许改），
   * 所以源文件夹另走这里；主进程只读地用一次就清掉。
   */
  setSourceRoots: (roots: string[] | null): Promise<boolean> =>
    ipcRenderer.invoke('files:setSourceRoots', { roots: roots ?? null }),
  // 规则表跟着预览/整理一起传过去：界面用哪套规则，预览和执行就用哪套
  preview: (
    files: string[],
    outputDir: string | null,
    rules?: Rule[] | null,
  ): Promise<PreviewOutcome> => ipcRenderer.invoke('files:preview', { files, outputDir, rules: rules ?? null }),
  organize: (
    files: string[],
    outputDir: string,
    rules?: Rule[] | null,
    roots?: string[] | null,
  ): Promise<CopySummary> => ipcRenderer.invoke('files:organize', { files, roots: roots ?? null, outputDir, rules: rules ?? null }),
  openPath: (dir: string): Promise<string> => ipcRenderer.invoke('shell:openPath', dir),
  /**
   * 上一次整理的记录（界面上那句「上一次整理：输出到 …，成功 N 个，可撤销」）：
   * 没有可撤销的整理时 available=false 并给一句人话原因，按钮据此变灰。
   */
  lastRun: (): Promise<UndoSummary> => ipcRenderer.invoke('undo:lastRun'),
  /** 撤销上一次整理（只删记录里列出的目标路径；原文件一律不动）；幂等 */
  undoLastRun: (): Promise<UndoRunOutcome> => ipcRenderer.invoke('undo:run'),
  /** 开工前的输出方向校验（危险就不开工，一个字节都不写） */
  checkOutputDirection: (input: {
    roots?: string[] | null;
    files?: string[] | null;
    outputDir?: string | null;
  }): Promise<OutputDirectionCheck> => ipcRenderer.invoke('output:check', input ?? {}),
  /**
   * 换一种分法：AI 分类那两件事的通道（**界面只能走这里**）。
   * - `aiStatus()`：界面上那行常显状态（「AI 分类：未配置」是核心模块给的原话，界面不另写一份）；
   * - `aiClassify()`：调一次 AI 分类，界面把文件路径给进来、由核心的把路径收成「文件列表 + 元信息」。
   * 本片只搭壳：不联网络、不读密钥、不写盘，没配置就如实回话。实现全在 core 的 aiClassify 模块里。
   */
  aiStatus: (): Promise<AiStatus> => ipcRenderer.invoke('ai:status'),
  /** 读 AI 设置（密钥不回显，只回报「有没有」与几位） */
  aiConfigLoad: (): Promise<AiConfigView> => ipcRenderer.invoke('ai:config:load'),
  /** 存 AI 设置（写进 userData 下的配置文件；留空密钥 = 沿用原来那份） */
  aiConfigSave: (input: {
    endpoint: string;
    model: string;
    authToken: string;
  }): Promise<{ ok: boolean; message: string; config: AiConfigView }> =>
    ipcRenderer.invoke('ai:config:save', input),
  /** 「测试连接」：用界面上填的三项直接试一次（还没保存也能试） */
  aiConfigTest: (input: {
    endpoint: string;
    model: string;
    authToken: string;
  }): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('ai:config:test', input),
  /** 把 AI 建议变成既有规则表里的规则（并回报每个文件按规则落到哪 —— 走的是同一个求值函数） */
  aiSuggestRules: (
    assignments: unknown[],
    rules?: Rule[] | null,
    seed?: string | null,
  ): Promise<AiRuleOutcome> =>
    ipcRenderer.invoke('ai:suggestRules', { assignments: assignments ?? [], rules: rules ?? null, seed: seed ?? null }),
  /** 分批进度：AI 分类一批一批发出去时，界面看得到走到哪儿了 */
  onAiProgress: (handler: (p: AiProgress) => void): void => {
    ipcRenderer.on('ai:progress', (_event, payload: AiProgress) => handler(payload));
  },
  aiClassify: (filePaths: string[], outputDir?: string | null): Promise<AiClassifyResult> =>
    ipcRenderer.invoke('ai:classify', { filePaths: filePaths ?? [], outputDir: outputDir ?? null }),
  // 规则读写：主进程写到 Electron 的 userData 目录下的一个 JSON 文件
  loadRules: (): Promise<RulesLoadResult> => ipcRenderer.invoke('rules:load'),
  saveRules: (rules: Rule[]): Promise<RulesSaveResult> => ipcRenderer.invoke('rules:save', rules),
  rulesPath: (): Promise<string> => ipcRenderer.invoke('rules:path'),
  /**
   * 规则行上要显示的那句「归一化之后实际会建到哪儿」（分类名可以写多级：`照片\风光`）。
   * 归一化只有 core 一处实现，界面照抄这里的结论。
   */
  ruleTargets: (rules: Rule[]): Promise<RuleTargetView[]> =>
    ipcRenderer.invoke('rules:targets', rules ?? []),
  onProgress: (handler: (p: OrganizeProgress) => void): void => {
    ipcRenderer.on('organize:progress', (_event, payload: OrganizeProgress) => handler(payload));
  },
};

contextBridge.exposeInMainWorld('organizer', api);

export type OrganizerApi = typeof api;
