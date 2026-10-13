/**
 * preload：只暴露几个明确的方法给界面，界面拿不到 node。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  CopySummary,
  PreviewOutcome,
  Rule,
  RulesLoadResult,
  RulesSaveResult,
  ScanResult,
} from './core';

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
  // 规则读写：主进程写到 Electron 的 userData 目录下的一个 JSON 文件
  loadRules: (): Promise<RulesLoadResult> => ipcRenderer.invoke('rules:load'),
  saveRules: (rules: Rule[]): Promise<RulesSaveResult> => ipcRenderer.invoke('rules:save', rules),
  rulesPath: (): Promise<string> => ipcRenderer.invoke('rules:path'),
  onProgress: (handler: (p: OrganizeProgress) => void): void => {
    ipcRenderer.on('organize:progress', (_event, payload: OrganizeProgress) => handler(payload));
  },
};

contextBridge.exposeInMainWorld('organizer', api);

export type OrganizerApi = typeof api;
