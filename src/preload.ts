/**
 * preload：只暴露几个明确的方法给界面，界面拿不到 node。
 */
import { contextBridge, ipcRenderer } from 'electron';
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

const api = {
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickFiles'),
  pickOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickOutputDir'),
  exists: (filePaths: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('files:exists', filePaths),
  organize: (files: string[], outputDir: string): Promise<CopySummary> =>
    ipcRenderer.invoke('files:organize', { files, outputDir }),
  openPath: (dir: string): Promise<string> => ipcRenderer.invoke('shell:openPath', dir),
  onProgress: (handler: (p: OrganizeProgress) => void): void => {
    ipcRenderer.on('organize:progress', (_event, payload: OrganizeProgress) => handler(payload));
  },
};

contextBridge.exposeInMainWorld('organizer', api);

export type OrganizerApi = typeof api;
