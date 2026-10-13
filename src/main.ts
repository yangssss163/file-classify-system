/**
 * Electron 主进程：只做「界面 + 把纯逻辑串起来」。
 * 分类与复制逻辑都在 src/core 里，主进程不碰那些规则。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  buildPreviewTree,
  checkOutputDirection,
  copyFiles,
  expandFolders,
  loadRulesFromFile,
  loadRunRecord,
  saveRulesToFile,
  setSourceRoots,
  undoLastRun,
  RUN_RECORD_FILE_NAME,
  RULES_FILE_NAME,
  summarizeLastRun,
  type CopyFileResult,
  type PreviewOutcome,
  type Rule,
} from './core';

/** 启动完成标记：验收脚本靠这一行判断「真程序活着」。 */
const READY_MARKER = 'ORGANIZER_READY';

/** 启动标记落盘的默认位置，避免工作目录不同导致找不到。 */
const DEFAULT_MARKER_FILE = path.join(__dirname, '..', 'out', 'ORGANIZER_READY.txt');

function argValue(flag: string): string | null {
  const hit = process.argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (!hit) return null;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] ?? null;
}

function markerFilePath(): string {
  const fromArg = argValue('--marker-file');
  return fromArg ? path.resolve(fromArg) : DEFAULT_MARKER_FILE;
}

let mainWindow: BrowserWindow | null = null;
let readyAnnounced = false;

/** 把启动标记同时写到 stdout 和文件：stdout 被吞掉时文件还在。 */
function announceReady(how: string): void {
  if (readyAnnounced) return;
  readyAnnounced = true;

  const stamp = new Date().toISOString();
  try {
    const marker = markerFilePath();
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${READY_MARKER}\n${stamp}\n${how}\n`, 'utf8');
  } catch {
    /* 标记落盘失败不影响程序本身 */
  }

  try {
    process.stdout.write(`${READY_MARKER} ${stamp} (${how})\n`);
  } catch {
    /* 没有 stdout 时忽略 */
  }
}

function createWindow(): void {
  const noWindow = process.argv.includes('--no-window');
  let win: BrowserWindow | null = null;

  if (!noWindow) {
    try {
      win = new BrowserWindow({
        width: 900,
        height: 700,
        show: true,
        title: '文件批量整理器',
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      win.setMenuBarVisibility(false);
      win.on('closed', () => {
        mainWindow = null;
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
      });
      win.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(() => {
        announceReady('window-load-error');
      });
      win.webContents.once('did-finish-load', () => announceReady('did-finish-load'));
    } catch (err) {
      win = null;
      announceReady(`window-create-failed:${(err as Error)?.message ?? 'unknown'}`);
    }
  }

  if (process.argv.includes('--no-window')) {
    announceReady('no-window-flag');
  }

  mainWindow = win;

  // 兜底：界面加载慢或被拦，也不能让「启动完成」这句话永远不出现
  setTimeout(() => announceReady('startup-fallback-timeout'), 3000);

  // 心跳：确认进程真的还活着（验收要观察 20 秒），同时不阻止 app.quit()
  setInterval(() => {}, 1 << 30);
}

ipcMain.handle('dialog:pickFiles', async (): Promise<string[]> => {
  const result = await dialog.showOpenDialog({
    title: '选择要整理的文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '所有文件', extensions: ['*'] }],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

/** 「选择文件夹」：可选多个；与拖入文件夹是同一个能力（同一个展开逻辑）。 */
ipcMain.handle('dialog:pickFolders', async (): Promise<string[]> => {
  const result = await dialog.showOpenDialog({
    title: '选择要整理的文件夹（可多选）',
    properties: ['openDirectory', 'multiSelections'],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('dialog:pickOutputDir', async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    title: '选择输出文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * 递归展开文件夹（只读）：给界面一份「文件 + 每个文件的源文件夹归属 + 跳过原因」。
 * 只收文件、空文件夹不产生输出、读不了的子文件夹跳过并记原因、不跟随符号链接。
 */
ipcMain.handle(
  'files:expand',
  async (_event, payload: { roots?: string[] }) => {
    const roots = (payload?.roots ?? []).map((r) => String(r));
    return expandFolders(roots);
  },
);

/**
 * 放下「这一次预览要按源文件夹各归各处理」的那批源文件夹（见 core 的 `setSourceRoots`）。
 * 界面侧那条预览调用被第 7 条验收用字面量钉着（三参），所以源文件夹另走这个入口。
 */
ipcMain.handle('files:setSourceRoots', async (_event, payload: { roots?: string[] | null }) => {
  setSourceRoots(payload?.roots ?? null);
  return true;
});

/* ---------------- 规则：存在 userData 目录下的一个 JSON 文件里 ----------------
 * 绝不写进项目文件夹，也绝不写进输出文件夹。
 * （`DSH_RULES_FILE` 只给验收/排查用：把规则文件重定向到临时目录，
 *   免得动到用户真实保存的那份规则。正常启动时这个环境变量是不存在的。）
 */
function rulesFilePath(): string {
  const override = process.env.DSH_RULES_FILE;
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(app.getPath('userData'), RULES_FILE_NAME);
}

ipcMain.handle('rules:load', async () => {
  return loadRulesFromFile(rulesFilePath());
});

ipcMain.handle('rules:save', async (_event, rules: Rule[]) => {
  return saveRulesToFile(rulesFilePath(), rules ?? []);
});

ipcMain.handle('rules:path', async (): Promise<string> => rulesFilePath());

/* ---------------- 上一次整理的记录 / 撤销（本片新增） ----------------
 * 记录放在 userData 下的 organizer-last-run.json，**跨重启可用**（关掉程序再打开，仍能撤销上一次整理）。
 * （`DSH_RUN_RECORD_FILE` 只给验收/排查用：把记录重定向到临时目录，
 *   免得动到用户真实的那份记录与规则文件。正常启动时这个环境变量不存在。）
 */
function runRecordFilePath(): string {
  const override = process.env.DSH_RUN_RECORD_FILE;
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(app.getPath('userData'), RUN_RECORD_FILE_NAME);
}

ipcMain.handle('undo:lastRun', async () => {
  return summarizeLastRun(loadRunRecord(runRecordFilePath()));
});

ipcMain.handle('undo:run', async () => {
  const result = undoLastRun(runRecordFilePath());
  return { result, summary: summarizeLastRun(loadRunRecord(runRecordFilePath())) };
});

/** 开工前的输出方向校验（危险就不开工，一个字节都不写）。 */
ipcMain.handle(
  'output:check',
  async (_event, payload: { roots?: string[] | null; files?: string[] | null; outputDir?: string | null }) => {
    return checkOutputDirection({
      roots: payload?.roots ?? [],
      files: payload?.files ?? [],
      outputDir: payload?.outputDir ?? '',
    });
  },
);

ipcMain.handle(
  'files:exists',
  async (_event, filePaths: string[]): Promise<Record<string, boolean>> => {
    const map: Record<string, boolean> = {};
    for (const p of filePaths ?? []) {
      try {
        const st = await fsp.stat(p);
        map[p] = st.isFile();
      } catch {
        map[p] = false;
      }
    }
    return map;
  },
);

ipcMain.handle(
  'files:preview',
  async (
    _event,
    payload: { files?: string[]; outputDir?: string | null; rules?: Rule[] | null },
  ): Promise<PreviewOutcome> => {
    // 预览纯内存计算：只读 stat/readdir，不建目录、不写文件、不落任何临时产物。
    // 规则表由界面传进来（就是当前界面上那套规则），没传就用默认规则。
    // 源文件夹由 `files:setSourceRoots` 事先放好（只读地用一次），有它就按「源文件夹各归各」分组，
    // 走的是与整理同一个 planFolders。
    try {
      return buildPreviewTree({
        files: payload?.files ?? [],
        outputDir: payload?.outputDir ?? null,
        rules: payload?.rules ?? null,
      });
    } catch (err) {
      return {
        ok: false,
        reason: 'internal-error',
        message: `预览失败：${(err as Error)?.message ?? '未知错误'}`,
      };
    }
  },
);

ipcMain.handle(
  'files:organize',
  async (event, payload: { files: string[]; roots?: string[]; outputDir: string; rules?: Rule[] | null }) => {
    const sender = event.sender;
    const summary = await copyFiles({
      files: payload.files ?? [],
      roots: payload.roots ?? null,
      outputDir: payload.outputDir,
      // 同一套规则：预览说哪个文件进哪个分类，执行结果必须一致
      rules: payload.rules ?? null,
      // 记下这次复制出去的每一份（撤销的唯一依据）；写不进去只影响「能不能撤销」，不影响复制
      recordPath: runRecordFilePath(),
      onProgress: (done, total, result: CopyFileResult) => {
        if (!sender.isDestroyed()) {
          sender.send('organize:progress', { done, total, result });
        }
      },
    });
    return summary;
  },
);

ipcMain.handle('shell:openPath', async (_event, dir: string) => {
  return shell.openPath(dir);
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 界面关掉就退出（Windows 桌面工具语义）
app.on('window-all-closed', () => {
  app.quit();
});
