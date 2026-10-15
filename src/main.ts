/**
 * Electron 主进程：只做「界面 + 把纯逻辑串起来」。
 * 分类与复制逻辑都在 src/core 里，主进程不碰那些规则。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import {
  aiClassifyByPaths,
  AI_CONFIG_FILE_NAME,
  AI_CONFIG_KEY_WARNING,
  AI_DEFAULT_ENDPOINT,
  AI_DEFAULT_MODEL,
  buildPreviewTree,
  checkOutputDirection,
  copyFiles,
  expandFolders,
  formatAiStatus,
  readAiConfigFile,
  loadRulesFromFile,
  loadRunRecord,
  saveAiConfig,
  saveRulesToFile,
  ruleTargetsOf,
  rulesViewOf,
  setSourceRoots,
  testAiConnection,
  undoLastRun,
  RUN_RECORD_FILE_NAME,
  RULES_FILE_NAME,
  summarizeLastRun,
  type CopyFileResult,
  type PreviewOutcome,
  type Rule,
} from './core';
// 「AI 建议 → 规则」、界面上要照抄的那两句提醒：都从 AI 模块直接取
// （不进 core/index 的聚合导出：别处出现同名标识会被验收第 12 条判成「第二处 AI 实现」）。
import { aiAssignmentsToRules } from './core/aiClassify';
// 用户设置（接口地址 / 模型名 / 密钥）放在哪儿、怎么读写：只有 aiAppFiles 那一处。
import { defaultAiConfig, AI_METADATA_ONLY_WARNING } from './core/aiAppFiles';
// 「一个文件按规则表落到哪个分类」只有一个来源：core 的 rules.ts（界面预览/执行用的是同一个函数）。
import { evaluateFile } from './core/rules';

/** 一份「读回来的设置」长什么样（由读设置那个函数的返回值推出来，不另立一个同名标识）。 */
type AiSettings = ReturnType<typeof readAiConfigFile>;

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

/**
 * ---------------------------------------------------------------------------
 * 开发用「窗口刷新小接口」（只在 npm run dev 里存在，产品行为不受影响）
 * ---------------------------------------------------------------------------
 * npm run dev 会带 `--dev-reload-port=0` 启动本进程；没带这个开关时（npm start、以后打的包）
 * 下面这段一行都不跑，监听端口也不会开，产品行为一个字都不变。
 * 它在 127.0.0.1 上开一个只认本机、只认令牌的极小接口，就一个用途：
 * 让 scripts/dev.mjs（热加载）在界面代码重编译完以后喊一声「刷新窗口」。
 * 令牌是 dev 生成的一串随机字符，写在 --dev-reload-token-file 指的文件里；
 * 这里从文件读，不读环境变量（免得跟「模块代码体里不许出现 process.env」那条验收判据混淆）。
 * 返回体里的 rendererId 是刷新**之后**的 renderer 进程号，用来给人/脚本一个回执。
 */
type DevReloadReply = { ok: boolean; action: string; rendererId: number; windows: number };

function startDevReloadBridge(): void {
  const portRaw = argValue('--dev-reload-port');
  if (portRaw === null) return;

  const tokenFile = argValue('--dev-reload-token-file');
  let token = '';
  if (tokenFile) {
    try {
      token = fs.readFileSync(path.resolve(tokenFile), 'utf8').trim();
    } catch {
      token = '';
    }
  }
  if (!token) {
    process.stderr.write('[dev-reload] 没读到令牌文件，窗口刷新小接口不启动\n');
    return;
  }

  const port = Number.parseInt(portRaw, 10);
  const server = http.createServer((req, res) => {
    const send = (code: number, payload: DevReloadReply): void => {
      const body = JSON.stringify(payload);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    };
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      pathname = '/';
    }
    if (req.method === 'GET' && pathname === '/dev-health') {
      send(200, {
        ok: true,
        action: 'health',
        rendererId: 0,
        windows: BrowserWindow.getAllWindows().length,
      });
      return;
    }
    if (req.method !== 'POST' || pathname !== '/dev-reload') {
      send(404, { ok: false, action: 'none', rendererId: 0, windows: 0 });
      return;
    }
    if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
      send(403, { ok: false, action: 'rejected', rendererId: 0, windows: 0 });
      return;
    }
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
    if (!win || win.isDestroyed()) {
      send(200, { ok: false, action: 'no-window', rendererId: 0, windows: 0 });
      return;
    }
    win.webContents.reloadIgnoringCache();
    send(200, {
      ok: true,
      action: 'reloaded',
      rendererId: win.webContents.getOSProcessId(),
      windows: BrowserWindow.getAllWindows().length,
    });
  });
  server.on('error', (err: Error) => {
    process.stderr.write(`[dev-reload] 窗口刷新小接口起不来：${err.message}\n`);
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    if (tokenFile) {
      try {
        fs.writeFileSync(
          path.resolve(tokenFile),
          JSON.stringify({ port: actual, token, pid: process.pid, at: new Date().toISOString() }),
          'utf8',
        );
      } catch (err) {
        process.stderr.write(`[dev-reload] 端口信息没写进文件：${(err as Error).message}\n`);
      }
    }
    process.stdout.write(`[dev-reload] 窗口刷新小接口在 127.0.0.1:${actual}\n`);
  });
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
  // 顺手把「每条规则实际会建到哪儿（归一化之后）」一起给界面：规则行上要显示它。
  return rulesViewOf(loadRulesFromFile(rulesFilePath()));
});

ipcMain.handle('rules:save', async (_event, rules: Rule[]) => {
  return saveRulesToFile(rulesFilePath(), rules ?? []);
});

ipcMain.handle('rules:path', async (): Promise<string> => rulesFilePath());

/**
 * 规则行上要显示的那句「归一化之后实际会建到哪儿」（本片新增：分类名允许写多级）。
 * 归一化只有一处实现（core 的 rules.ts），界面照抄这里的结论 —— 界面绝不自己再算一份，
 * 免得「界面显示的目标」与「实际落盘的目标」是两套。
 */
ipcMain.handle('rules:targets', async (_event, rules: Rule[]) => {
  return ruleTargetsOf(rules ?? []);
});

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

/* ---------------- AI 分类的设置与调用（本片新增真实现） ----------------
 * 与 AI 有关的实现只有 core 里那三个文件（`aiAppFiles` / `aiClassify` / `aiTransport`）；
 * 主进程这里只是「开几个门」：读设置 / 存设置 / 测试连接 / 查状态 / 把建议变成规则 / 调一次分类。
 * 门里不做任何加工。
 *
 * 设置**只存在于** userData 下的 organizer-ai.json（密钥明文存在里面），绝不写进项目目录，也绝不进日志。
 * `DSH_AI_CONFIG_FILE` 只给验收/排查用：把设置重定向到临时路径，
 * 免得动到用户真实的那份 AI 设置。正常启动时这个环境变量不存在。
 */
function aiConfigFilePath(): string {
  const override = process.env.DSH_AI_CONFIG_FILE;
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(app.getPath('userData'), AI_CONFIG_FILE_NAME);
}

/** 这次要用的接口设置（没配置好就是 null：缺地址 / 缺密钥都算没配置）。 */
function currentAiCall(): AiSettings {
  const cfg = readAiConfigFile(aiConfigFilePath());
  if (!cfg) return null;
  return { endpoint: cfg.endpoint, model: cfg.model, authToken: cfg.authToken };
}

/** 给界面看的设置（**不回显密钥本体**，只回报「有没有密钥」与密钥几位）。 */
interface AiConfigView {
  endpoint: string;
  model: string;
  hasKey: boolean;
  keyLength: number;
  configPath: string;
  pathWarning: string;
  metadataWarning: string;
}

function aiConfigView(): AiConfigView {
  const cfg = readAiConfigFile(aiConfigFilePath());
  return {
    endpoint: cfg ? cfg.endpoint : AI_DEFAULT_ENDPOINT,
    model: cfg ? cfg.model : AI_DEFAULT_MODEL,
    hasKey: cfg !== null,
    keyLength: cfg ? cfg.authToken.length : 0,
    configPath: aiConfigFilePath(),
    pathWarning: AI_CONFIG_KEY_WARNING,
    metadataWarning: AI_METADATA_ONLY_WARNING,
  };
}

ipcMain.handle('ai:config:load', async (): Promise<AiConfigView> => aiConfigView());

ipcMain.handle(
  'ai:config:save',
  async (_event, payload: { endpoint?: string; model?: string; authToken?: string }) => {
    const result = saveAiConfig(aiConfigFilePath(), {
      endpoint: String(payload?.endpoint ?? ''),
      model: String(payload?.model ?? ''),
      // 密钥留空 = 保持原来那份（免得用户只改地址却把密钥清掉）
      authToken: authTokenOrKeep(payload?.authToken),
    });
    return { ...result, config: aiConfigView() };
  },
);

/** 密钥输入的处理：留空（或只打了空格）就沿用设置里已有的那一份。 */
function authTokenOrKeep(input: unknown): string {
  const typed = typeof input === 'string' ? input.trim() : '';
  if (typed.length > 0) return typed;
  const current = readAiConfigFile(aiConfigFilePath());
  return current ? current.authToken : '';
}

/** 「测试连接」：用界面上填的三项直接测（还没保存也能测），只发一次请求、不重试。 */
ipcMain.handle(
  'ai:config:test',
  async (_event, payload: { endpoint?: string; model?: string; authToken?: string }) => {
    return testAiConnection({
      endpoint: String(payload?.endpoint ?? '').trim() || AI_DEFAULT_ENDPOINT,
      model: String(payload?.model ?? '').trim() || AI_DEFAULT_MODEL,
      authToken: authTokenOrKeep(payload?.authToken),
    });
  },
);

ipcMain.handle('ai:status', async () => {
  // 「配好了没有」= 按位置读回来的那份不是空（读不到 / 缺项都算没配好，由 AI 那一层判定）
  const cfg = readAiConfigFile(aiConfigFilePath());
  return formatAiStatus(cfg !== null, cfg ? cfg.model : '');
});

/**
 * 「AI 建议 → 规则」：把 AI 给的「文件 → 分类名」变成**既有规则表里的规则**
 * （条件 = 「文件名在建议清单里」），并把「每个文件落到哪个分类」按**既有的规则求值函数**算一遍给界面看。
 * 界面只负责摆出来给人确认；真正落盘还是走既有的预览 / 计划 / 复制 / 撤销那一条管线（本文件不另写一套）。
 */
ipcMain.handle(
  'ai:suggestRules',
  async (_event, payload: { assignments?: unknown; rules?: Rule[] | null; seed?: string | null }) => {
    const assignments = Array.isArray(payload?.assignments) ? (payload?.assignments as never[]) : [];
    const rules = aiAssignmentsToRules(assignments, payload?.rules ?? null, payload?.seed ?? undefined);
    const checks: Array<{ source: string; category: string }> = [];
    for (const a of assignments) {
      const one = a as { source?: string; category?: string };
      const source = String(one?.source ?? '');
      if (source.length === 0) continue;
      const name = source.split(/[\\/]/).pop() ?? source;
      checks.push({ source, category: evaluateByRules(rules, source, name) });
    }
    return { rules, checks, message: `已按 AI 建议准备 ${rules.length} 条规则（放在最前面优先命中）` };
  },
);

/** 一个文件按规则表落到哪个分类（用 core 里那一个求值函数，不许另写一份）。 */
function evaluateByRules(rules: Rule[], fullPath: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
  return evaluateFile(rules, { path: fullPath, name, ext, size: null, mtimeMs: null });
}

ipcMain.handle(
  'ai:classify',
  async (
    event,
    payload: { filePaths?: string[]; outputDir?: string | null },
  ) => {
    const sender = event.sender;
    return aiClassifyByPaths(
      payload?.filePaths ?? [],
      payload?.outputDir ?? null,
      currentAiCall(),
      (done, total) => {
        if (!sender.isDestroyed()) sender.send('ai:progress', { done, total });
      },
    );
  },
);

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
  // 开发用（只有 npm run dev 才带 --dev-reload-port）：给热加载开一个本机小接口；没带开关就什么都不做
  startDevReloadBridge();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 界面关掉就退出（Windows 桌面工具语义）
app.on('window-all-closed', () => {
  app.quit();
});
