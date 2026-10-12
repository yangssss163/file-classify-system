/**
 * preload：只暴露几个明确的方法给界面，界面拿不到 node。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { CopySummary, PreviewOutcome } from './core';

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
  pickOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickOutputDir'),
  exists: (filePaths: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('files:exists', filePaths),
  preview: (files: string[], outputDir: string | null): Promise<PreviewOutcome> =>
    ipcRenderer.invoke('files:preview', { files, outputDir }),
  organize: (files: string[], outputDir: string): Promise<CopySummary> =>
    ipcRenderer.invoke('files:organize', { files, outputDir }),
  openPath: (dir: string): Promise<string> => ipcRenderer.invoke('shell:openPath', dir),
  onProgress: (handler: (p: OrganizeProgress) => void): void => {
    ipcRenderer.on('organize:progress', (_event, payload: OrganizeProgress) => handler(payload));
  },
};

contextBridge.exposeInMainWorld('organizer', api);

export type OrganizerApi = typeof api;
