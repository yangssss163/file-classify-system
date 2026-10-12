/**
 * 界面逻辑：只管拖拽 / 按钮 / 显示，分类与复制都在 core 里、由主进程调用。
 * 全程不阻塞：复制是异步的，进程里逐个回报进度。
 */
import type { OrganizeProgress } from '../shared';

const api = window.organizer;

const el = {
  drop: document.getElementById('drop') as HTMLDivElement,
  pickFiles: document.getElementById('pick-files') as HTMLButtonElement,
  clearFiles: document.getElementById('clear-files') as HTMLButtonElement,
  fileCount: document.getElementById('file-count') as HTMLSpanElement,
  pickOut: document.getElementById('pick-out') as HTMLButtonElement,
  outDir: document.getElementById('out-dir') as HTMLSpanElement,
  start: document.getElementById('start') as HTMLButtonElement,
  progress: document.getElementById('progress') as HTMLSpanElement,
  openOut: document.getElementById('open-out') as HTMLButtonElement,
  notice: document.getElementById('notice') as HTMLParagraphElement,
  list: document.getElementById('file-list') as HTMLDivElement,
  summary: document.getElementById('summary') as HTMLParagraphElement,
};

let selectedFiles: string[] = [];
let outputDir: string | null = null;
let running = false;

function notice(msg: string): void {
  el.notice.textContent = msg;
}

function refreshCounts(): void {
  el.fileCount.textContent = `已选 ${selectedFiles.length} 个文件`;
}

function renderOutDir(): void {
  el.outDir.textContent = outputDir ?? '未选择输出文件夹';
}

function addToList(text: string, cls: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = `item ${cls}`;
  div.textContent = text;
  el.list.appendChild(div);
  el.list.scrollTop = el.list.scrollHeight;
  return div;
}

/** 同一路径大小写不同（Windows）视作同一个文件。 */
function mergeFiles(incoming: string[]): { added: string[]; duplicates: number } {
  const seen = new Set(selectedFiles.map((f) => f.toLowerCase()));
  const added: string[] = [];
  let duplicates = 0;
  for (const p of incoming) {
    const key = p.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    added.push(p);
  }
  selectedFiles = selectedFiles.concat(added);
  return { added, duplicates };
}

async function acceptPaths(paths: string[], sourceLabel: string): Promise<void> {
  if (paths.length === 0) return;
  let isFileMap: Record<string, boolean> = {};
  try {
    isFileMap = await api.exists(paths);
  } catch {
    isFileMap = {};
  }

  const files: string[] = [];
  let folders = 0;
  const missing: string[] = [];
  for (const p of paths) {
    if (isFileMap[p] === true) files.push(p);
    else if (isFileMap[p] === false) folders++;
    else missing.push(p);
  }

  const { added, duplicates } = mergeFiles(files);
  refreshCounts();

  const msgs: string[] = [];
  if (added.length > 0) msgs.push(`${sourceLabel}加入 ${added.length} 个文件`);
  if (folders > 0) msgs.push(`暂不支持文件夹，已忽略 ${folders} 个文件夹`);
  if (missing.length > 0) msgs.push(`${missing.length} 个路径已失效，已忽略`);
  if (duplicates > 0) msgs.push(`${duplicates} 个重复文件已跳过`);
  notice(msgs.length > 0 ? msgs.join('；') : '没有可用的文件');
}

/* ---------------- 拖拽 ---------------- */

['dragenter', 'dragover'].forEach((type) => {
  el.drop.addEventListener(type, (ev) => {
    ev.preventDefault();
    el.drop.classList.add('over');
  });
});

['dragleave', 'drop'].forEach((type) => {
  el.drop.addEventListener(type, (ev) => {
    ev.preventDefault();
    el.drop.classList.remove('over');
  });
});

// 拖到窗口别处时不要让 Electron 直接打开这个文件
window.addEventListener('dragover', (ev) => ev.preventDefault());
window.addEventListener('drop', (ev) => ev.preventDefault());

el.drop.addEventListener('drop', (ev) => {
  const dt = ev.dataTransfer;
  if (!dt) return;
  const paths: string[] = [];
  for (const file of Array.from(dt.files)) {
    const anyFile = file as File & { path?: string };
    if (typeof anyFile.path === 'string' && anyFile.path.length > 0) paths.push(anyFile.path);
  }
  if (paths.length === 0) {
    notice('没拿到文件路径，请改用「选择文件」按钮');
    return;
  }
  void acceptPaths(paths, '拖入');
});

/* ---------------- 按钮 ---------------- */

el.pickFiles.addEventListener('click', () => {
  void (async () => {
    const picked = await api.pickFiles();
    await acceptPaths(picked, '选择');
  })();
});

el.clearFiles.addEventListener('click', () => {
  selectedFiles = [];
  refreshCounts();
  el.list.textContent = '';
  el.summary.textContent = '整理完成：成功 0 个，失败 0 个';
  notice('已清空文件名单');
});

el.pickOut.addEventListener('click', () => {
  void (async () => {
    const dir = await api.pickOutputDir();
    if (dir) {
      outputDir = dir;
      renderOutDir();
      notice('输出文件夹已选定');
    }
  })();
});

el.openOut.addEventListener('click', () => {
  if (!outputDir) {
    notice('还没选输出文件夹');
    return;
  }
  void api.openPath(outputDir);
});

api.onProgress((p: OrganizeProgress) => {
  el.progress.textContent = `已处理 ${p.done} / 共 ${p.total}`;
  const name = p.result.source.split(/[\\/]/).pop() ?? p.result.source;
  if (p.result.ok) {
    const extra = p.result.renamed ? `（改名 ${p.result.finalName}）` : '';
    addToList(`[成功] ${name} → ${p.result.folder}${extra}`, 'ok');
  } else {
    addToList(`[失败] ${name} → ${p.result.error ?? '未知原因'}`, 'fail');
  }
});

el.start.addEventListener('click', () => {
  void (async () => {
    if (running) return;
    if (selectedFiles.length === 0) {
      notice('还没有可整理的文件，先拖进来或点「选择文件」');
      return;
    }
    if (!outputDir) {
      notice('还没选输出文件夹');
      return;
    }

    const files = selectedFiles.slice();
    const out = outputDir;
    running = true;
    el.start.disabled = true;
    el.list.textContent = '';
    el.progress.textContent = `已处理 0 / 共 ${files.length}`;
    notice('正在整理（只复制，不动原文件）…');

    try {
      const summary = await api.organize(files, out);
      el.progress.textContent = `已处理 ${summary.total} / 共 ${summary.total}`;
      el.summary.textContent = `整理完成：成功 ${summary.successCount} 个，失败 ${summary.failureCount} 个`;
      notice(`输出目录：${summary.outputDir}`);
    } catch (err) {
      notice(`整理中断：${(err as Error)?.message ?? '未知错误'}`);
      el.summary.textContent = '整理完成：成功 0 个，失败 0 个（本次未跑完）';
    } finally {
      running = false;
      el.start.disabled = false;
    }
  })();
});

refreshCounts();
renderOutDir();
