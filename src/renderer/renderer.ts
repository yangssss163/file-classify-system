/**
 * 界面逻辑：只管拖拽 / 按钮 / 显示，分类与复制都在 core 里、由主进程调用。
 * 全程不阻塞：复制是异步的，进程里逐个回报进度。
 */
import type { OrganizeProgress, OrganizerApi, PreviewOutcome, PreviewTree } from './api-types';

declare global {
  interface Window {
    /** 由预加载脚本通过 contextBridge 注入（preload.ts） */
    organizer: OrganizerApi;
  }
}

const api = window.organizer;

const el = {
  drop: document.getElementById('drop') as HTMLDivElement,
  pickFiles: document.getElementById('pick-files') as HTMLButtonElement,
  clearFiles: document.getElementById('clear-files') as HTMLButtonElement,
  fileCount: document.getElementById('file-count') as HTMLSpanElement,
  pickOut: document.getElementById('pick-out') as HTMLButtonElement,
  outDir: document.getElementById('out-dir') as HTMLSpanElement,
  preview: document.getElementById('preview') as HTMLButtonElement,
  previewWarning: document.getElementById('preview-warning') as HTMLParagraphElement,
  previewSummary: document.getElementById('preview-summary') as HTMLParagraphElement,
  previewTree: document.getElementById('preview-tree') as HTMLDivElement,
  start: document.getElementById('start') as HTMLButtonElement,
  progress: document.getElementById('progress') as HTMLSpanElement,
  openOut: document.getElementById('open-out') as HTMLButtonElement,
  notice: document.getElementById('notice') as HTMLParagraphElement,
  list: document.getElementById('file-list') as HTMLDivElement,
  summary: document.getElementById('summary') as HTMLParagraphElement,
};

/**
 * 预览区上方那句话：一眼看出「这是预览，还没动你的文件」。
 * 只有真的看到了预览树才显示。
 */
const PREVIEW_WARNING = '以下是预览，还没有复制任何文件：原文件、输出文件夹都保持原样。';

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

async function acceptPaths(
  paths: string[],
  sourceLabel: string,
  extraHint = '',
): Promise<void> {
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
  if (added.length > 0) invalidatePreview();

  const msgs: string[] = [];
  if (added.length > 0) msgs.push(`${sourceLabel}加入 ${added.length} 个文件`);
  if (folders > 0) msgs.push(`暂不支持文件夹，已忽略 ${folders} 个文件夹`);
  if (missing.length > 0) msgs.push(`${missing.length} 个路径已失效，已忽略`);
  if (duplicates > 0) msgs.push(`${duplicates} 个重复文件已跳过`);
  if (extraHint) msgs.push(extraHint);
  notice(msgs.length > 0 ? msgs.join('；') : '没有可用的文件');
}

/* ---------------- 预览（纯内存，绝不写盘） ---------------- */

/** 文件名在预览里的显示：名字 + 后缀读不到时的原因。 */
function fileLine(f: PreviewTree['files'][number]): HTMLDivElement {
  const line = document.createElement('div');
  line.className = f.error ? 'file file-error' : 'file';
  line.textContent =
    f.name + (f.error ? `  —— ${f.error.message}（仍会归到 ${f.folder}）` : '');
  return line;
}

/**
 * 画预览树：每个分类一行（分类名 + 文件数），点一下展开看具体文件名。
 * 只往内存里的 DOM 写，不碰磁盘。
 */
function renderPreviewTree(tree: PreviewTree): void {
  el.previewTree.textContent = '';
  for (const group of tree.folders) {
    const box = document.createElement('div');
    box.className = group.files.length > 0 ? 'folder' : 'folder hidden';

    const head = document.createElement('div');
    head.className = 'folder-head';
    head.textContent = `${group.files.length > 0 ? '▸' : '·'} ${group.folder}　`;
    const count = document.createElement('span');
    count.className = 'folder-count';
    count.textContent = `${group.count} 个文件`;
    head.appendChild(count);

    const files = document.createElement('div');
    files.className = 'files';
    files.style.display = 'none';

    if (group.files.length === 0) {
      const none = document.createElement('div');
      none.className = 'empty';
      none.textContent = '（这一类没有文件）';
      files.appendChild(none);
    } else {
      for (const f of group.files) files.appendChild(fileLine(f));
    }

    head.addEventListener('click', () => {
      const open = files.style.display !== 'none';
      files.style.display = open ? 'none' : 'block';
      head.textContent = `${open ? '▸' : '▾'} ${group.folder}　`;
      head.appendChild(count);
      box.classList.toggle('hidden', open && group.files.length === 0);
    });

    box.appendChild(head);
    box.appendChild(files);
    el.previewTree.appendChild(box);
  }

  // 有文件的分类默认展开，方便一眼看清
  for (const box of Array.from(el.previewTree.querySelectorAll('.folder'))) {
    const head = box.querySelector('.folder-head');
    const files = box.querySelector('.files') as HTMLDivElement | null;
    if (!head || !files) continue;
    const label = head.textContent ?? '';
    if (label.startsWith('▸')) files.style.display = 'block';
  }
}

/** 清掉上一次预览，避免「旧预览」被误当成当前名单的结果。 */
function clearPreview(): void {
  el.previewWarning.textContent = '';
  el.previewSummary.textContent = '';
  el.previewTree.textContent = '';
}

el.preview.addEventListener('click', () => {
  void (async () => {
    clearPreview();
    if (selectedFiles.length === 0) {
      notice('还没有可预览的文件，先拖进来或点「选择文件」');
      return;
    }
    if (!outputDir) {
      notice('还没选输出文件夹，先点「选择输出文件夹」');
      return;
    }

    let outcome: PreviewOutcome;
    try {
      outcome = await api.preview(selectedFiles.slice(), outputDir);
    } catch (err) {
      notice(`预览没做出来：${(err as Error)?.message ?? '未知错误'}`);
      return;
    }

    if (!outcome || outcome.ok !== true) {
      notice(outcome && outcome.message ? outcome.message : '预览没做出来');
      return;
    }

    const tree = outcome.tree;
    el.previewWarning.textContent = PREVIEW_WARNING;
    const notes: string[] = [];
    if (tree.unreadableCount > 0) notes.push(`其中 ${tree.unreadableCount} 个读不到文件信息，已标注原因`);
    if (tree.outputDir) notes.push(`计划输出到：${tree.outputDir}`);
    el.previewSummary.textContent =
      `共 ${tree.total} 个文件，会分到 ${tree.folders.filter((g) => g.count > 0).length} 个分类文件夹` +
      (notes.length > 0 ? `（${notes.join('；')}）` : '');
    renderPreviewTree(tree);
    notice('预览完成：这一步没有写任何文件');
  })();
});

/** 名单或输出文件夹变了，上一次的预览就作废。 */
function invalidatePreview(): void {
  clearPreview();
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

/**
 * 把拖进来的文件交给名单。
 * 路径只能由预加载脚本里的 webUtils.getPathForFile 取（File.path 在 Electron 32 起已被移除，44 上完全没有），
 * 所以这里一律调 api.pathForFile，且不许留「先试 File.path」的后路。
 * 取不到路径不许静默：必须给人一句人话提示。
 */
function createDropHandler(): (ev: DragEvent) => void {
  return (ev: DragEvent): void => {
    const dt = ev.dataTransfer;
    if (!dt || dt.files.length === 0) {
      notice('这次拖入没有拿到文件，请改用「选择文件」按钮');
      return;
    }

    const paths: string[] = [];
    let unreadable = 0;
    for (const file of Array.from(dt.files)) {
      const p = api.pathForFile(file);
      if (typeof p === 'string' && p.length > 0) paths.push(p);
      else unreadable++;
    }

    if (paths.length === 0) {
      notice('读不到这个文件的路径，请改用「选择文件」按钮');
      return;
    }

    // 文件夹在当前 Electron 版本下拿不到可用路径：忽略它，但不能让整次拖入失败。
    // 数量对不上就说明有拿不到路径的（拖的是文件夹，或系统暂时给不出路径）。
    const unreadableHint = unreadable > 0 ? `暂不支持文件夹，已忽略 ${unreadable} 个` : '';
    void acceptPaths(paths, '拖入', unreadableHint);
  };
}

el.drop.addEventListener('drop', createDropHandler());

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
  invalidatePreview();
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
      invalidatePreview();
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
