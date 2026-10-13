/**
 * 界面逻辑：只管拖拽 / 按钮 / 规则编辑 / 显示，分类与复制都在 core 里、由主进程调用。
 * 全程不阻塞：复制是异步的，进程里逐个回报进度。
 */
import type {
  ModTimeBucket,
  OrganizeProgress,
  OrganizerApi,
  PreviewOutcome,
  PreviewSourceFolder,
  PreviewTree,
  Rule,
  ScanResult,
  SkippedPath,
} from './api-types';

declare global {
  interface Window {
    /** 由预加载脚本通过 contextBridge 注入（preload.ts） */
    organizer: OrganizerApi;
  }
}

const api = window.organizer;

/** 兜底分类文件夹名：与 core 里那一份保持一致（core 的 rules.ts 里指向 classify.ts 的 FOLDER_OTHERS）。 */
const FALLBACK_FOLDER = '05_其他';

/** 后台求值：跟 core 里 evaluateFile / 主进程求值同一套常量，界面上不做第二份判定。 */
const GB = 1024 * 1024 * 1024;

/** 改动规则后要用的新 id：时间戳 + 递增序号，保证同一次会话里不重复。 */
let ruleSeq = 0;
function newRuleId(): string {
  ruleSeq++;
  return `rule-${Date.now().toString(36)}-${ruleSeq}`;
}

/**
 * 造一条全新的空规则。
 * 这里只负责「造」，不负责「放到哪」——放置位置由 `addRule()` 决定（放在第一行）。
 */
function makeNewRule(): Rule {
  return {
    id: newRuleId(),
    name: '新分类',
    enabled: true,
    condition: { extensions: [], keywords: [], minSize: null, maxSize: null, modTime: 'any' },
  };
}

/**
 * 新增规则：**插到规则表第一行**，也就是优先级最高、第一条命中生效的那一条。
 *
 * 为什么是第一行（用户明确选的）：规则表从上往下求值、第一条命中的生效，而列表里的行顺序
 * **就是**这个数组的顺序（只有这一套顺序，不拆成「显示顺序」和「求值顺序」两套）。
 * 新加的规则放在最前，用户刚配的这条会立刻生效、原来那套规则排在它后面；
 * 不想让它优先，用行上的「下移」把它挪下去。
 *
 * @returns 新规则在表里的下标（= 0，第一行），便于核对
 */
function addRule(rules: Rule[]): number {
  rules.unshift(makeNewRule());
  return 0;
}

/**
 * 取元素：拿不到就给一个空壳（挂在它上面的监听器无效，但不会让整个界面脚本崩溃）。
 * 真正缺元素属于接线问题，由验收脚本的第 7 条（规则编辑器）盯着。
 */
function getEl<T>(id: string): T {
  const found = id ? document.getElementById(id) : null;
  return (found ?? {}) as T;
}

/** 给元素挂监听：元素不存在就跳过，不让整个界面脚本崩掉。 */
function listen(target: unknown, type: string, handler: (ev: unknown) => void): void {
  const t = target as { addEventListener?: (type: string, handler: (ev: unknown) => void) => void } | null;
  if (t && typeof t.addEventListener === 'function') t.addEventListener(type, handler);
}

const el = {
  drop: getEl<HTMLDivElement>('drop'),
  pickFiles: getEl<HTMLButtonElement>('pick-files'),
  pickFolders: getEl<HTMLButtonElement>('pick-folders'),
  clearFiles: getEl<HTMLButtonElement>('clear-files'),
  fileCount: getEl<HTMLSpanElement>('file-count'),
  skipped: getEl<HTMLDivElement>('skipped'),
  pickOut: getEl<HTMLButtonElement>('pick-out'),
  outDir: getEl<HTMLSpanElement>('out-dir'),
  preview: getEl<HTMLButtonElement>('preview'),
  previewWarning: getEl<HTMLParagraphElement>('preview-warning'),
  previewSummary: getEl<HTMLParagraphElement>('preview-summary'),
  previewTree: getEl<HTMLDivElement>('preview-tree'),
  previewSkipped: getEl<HTMLDivElement>('preview-skipped'),
  start: getEl<HTMLButtonElement>('start'),
  progress: getEl<HTMLSpanElement>('progress'),
  openOut: getEl<HTMLButtonElement>('open-out'),
  notice: getEl<HTMLParagraphElement>('notice'),
  list: getEl<HTMLDivElement>('file-list'),
  summary: getEl<HTMLParagraphElement>('summary'),
  // 规则编辑器
  ruleCount: getEl<HTMLSpanElement>('rule-count'),
  ruleAdd: getEl<HTMLButtonElement>('rule-add'),
  ruleDefault: getEl<HTMLButtonElement>('rule-default'),
  ruleSave: getEl<HTMLButtonElement>('rule-save'),
  ruleLoad: getEl<HTMLButtonElement>('rule-load'),
  ruleList: getEl<HTMLDivElement>('rule-list'),
  ruleStatus: getEl<HTMLParagraphElement>('rule-status'),
};

/**
 * 预览区上方那句话：一眼看出「这是预览，还没动你的文件」。
 * 只有真的看到了预览树才显示。
 */
const PREVIEW_WARNING = '以下是预览，还没有复制任何文件：原文件、输出文件夹都保持原样。';

/** 界面状态：单选的文件名单 + 拖入/选中的源文件夹名单（两者分开记，各归各）。 */
let selectedFiles: string[] = [];
/** 拖入/选中的源文件夹（顶层）。有它就走「源文件夹各归各」。 */
let selectedRoots: string[] = [];
/** 源文件夹递归展开的结果（只读、不落盘）；没有文件夹时是 null。 */
let scanResult: ScanResult | null = null;
/** 展开/挑选时被跳过的路径与原因（给用户看，不隐藏）。 */
let skippedPaths: SkippedPath[] = [];
let outputDir: string | null = null;
let running = false;

function notice(msg: string): void {
  el.notice.textContent = msg;
}

/**
 * 当前要整理的文件清单 = 单选的文件 + 从源文件夹递归展开出来的文件。
 * 两者都是「文件」，都要能预览、能整理；但源文件夹那批必须带着归属一起走，
 * 所以这里只合成一份**扁平清单**（顺序稳定：先单选的，后展开的），
 * 真正决定落到哪里的仍然是 `selectedRoots`（后端按归属算路径）。
 */
function collectFiles(): string[] {
  const out = selectedFiles.slice();
  const seen = new Set(out.map((f) => f.toLowerCase()));
  for (const f of scanResult?.files ?? []) {
    const key = String(f?.fullPath ?? '').toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(f.fullPath);
  }
  return out;
}

/**
 * 把展开出来的文件并进主名单。
 * 为什么要并进来：预览/整理用的都是同一份扁平名单（`selectedFiles`），
 * 而「源文件夹」是**额外**的第四个参数（后端据此算每一份的归属路径）。
 * 展开完就并一次，后面「已选 N 个文件（来自 M 个文件夹）」与预览/整理都只看这一份。
 */
function mergeScannedIntoSelected(): void {
  selectedFiles = collectFiles();
}

function refreshCounts(): void {
  const total = collectFiles().length;
  el.fileCount.textContent =
    selectedRoots.length > 0
      ? `已选 ${total} 个文件（来自 ${selectedRoots.length} 个文件夹）`
      : `已选 ${total} 个文件`;
  renderSkipped();
}

/** 被跳过的文件夹/路径：一条一行（源文件夹里读不了的子文件夹必须能看见原因）。 */
function renderSkipped(): void {
  el.skipped.textContent = '';
  if (skippedPaths.length === 0) return;
  const head = document.createElement('div');
  head.className = 'skipped-head';
  head.textContent = `已跳过 ${skippedPaths.length} 处（不影响其它文件继续整理）：`;
  el.skipped.appendChild(head);
  for (const s of skippedPaths) {
    const line = document.createElement('div');
    line.className = 'skipped-item';
    line.textContent = `${s.fullPath} —— ${s.reason}`;
    el.skipped.appendChild(line);
  }
}

/** 把展开结果里跳过的原因收进来（同一路径只记一次）。 */
function mergeSkipped(list: readonly SkippedPath[]): void {
  const seen = new Set(skippedPaths.map((s) => `${s.fullPath}|${s.reason}`));
  for (const s of list ?? []) {
    const key = `${s.fullPath}|${s.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    skippedPaths.push(s);
  }
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

/* ---------------- 名单：文件 + 源文件夹（两样分开记） ---------------- */

/**
 * 收下一批路径。先问主进程「哪些是文件、哪些是文件夹」：
 *  - 文件 → 进单文件名单（照旧直接落在 输出根\分类夹\）；
 *  - 文件夹 → 递归展开成文件集合，每个文件带着它的源文件夹归属（「源文件夹各归各」）。
 */
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
  const folders: string[] = [];
  const missing: string[] = [];
  for (const p of paths) {
    if (isFileMap[p] === true) files.push(p);
    else if (isFileMap[p] === false) folders.push(p);
    else missing.push(p);
  }

  const { added, duplicates } = mergeFiles(files);
  let folderNote = '';
  if (folders.length > 0) {
    const scanned = await expandRoots(folders);
    folderNote = scanned;
    // 展开出来的文件并进主名单：预览/整理用的就是这一份（源文件夹另走第 4 个参数）
    mergeScannedIntoSelected();
  }
  refreshCounts();
  if (added.length > 0 || folders.length > 0) invalidatePreview();

  const msgs: string[] = [];
  if (added.length > 0) msgs.push(`${sourceLabel}加入 ${added.length} 个文件`);
  if (folderNote) msgs.push(folderNote);
  if (missing.length > 0) msgs.push(`${missing.length} 个路径已失效，已忽略`);
  if (duplicates > 0) msgs.push(`${duplicates} 个重复文件已跳过`);
  if (extraHint) msgs.push(extraHint);
  notice(msgs.length > 0 ? msgs.join('；') : '没有可用的文件');
}

/**
 * 把拖入/选中的文件夹递归展开（只读）并并进名单。
 * 展开由主进程做（界面拿不到 node）；拿到的每个文件都带着源文件夹归属。
 * @returns 给人看的一句说明（如「来自 2 个文件夹，共 5 个文件」）
 */
async function expandRoots(roots: string[]): Promise<string> {
  let result: ScanResult | null = null;
  try {
    result = await api.expand(roots);
  } catch (err) {
    notice(`展开文件夹失败：${(err as Error)?.message ?? '未知错误'}`);
    return '';
  }
  if (!result || !Array.isArray(result.files)) return '';

  // 源文件夹名单：合并（同一个文件夹反复拖入只算一个）
  const seenRoot = new Set(selectedRoots.map((r) => r.toLowerCase()));
  let newRoots = 0;
  for (const r of roots) {
    const key = String(r).toLowerCase();
    if (seenRoot.has(key)) continue;
    seenRoot.add(key);
    selectedRoots.push(String(r));
    newRoots++;
  }

  if (!scanResult) scanResult = { files: [], folders: [], skipped: [] };
  const seenFile = new Set(scanResult.files.map((f) => f.fullPath.toLowerCase()));
  let newFiles = 0;
  for (const f of result.files ?? []) {
    const key = String(f?.fullPath ?? '').toLowerCase();
    if (key.length === 0 || seenFile.has(key)) continue;
    seenFile.add(key);
    scanResult.files.push(f);
    newFiles++;
  }
  const seenFolder = new Set(scanResult.folders.map((f) => f.key));
  for (const f of result.folders ?? []) {
    if (seenFolder.has(f.key)) continue;
    seenFolder.add(f.key);
    scanResult.folders.push(f);
  }
  mergeSkipped(result.skipped ?? []);

  if (newFiles === 0) {
    return `${roots.length} 个文件夹里没有找到文件${newRoots > 0 ? '（文件夹本身已记下）' : ''}`;
  }
  return `加入 ${newFiles} 个文件（来自 ${newRoots > 0 ? newRoots : roots.length} 个文件夹）`;
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
 * 一个「可展开的块」：一行标题（几行几列的数字）+ 一段内容。
 * 标题前面那个三角点一下就展开/收起，纯 DOM 操作，不碰磁盘。
 */
function collapsible(
  headText: string,
  countText: string,
  bodyClass: string,
  openByDefault: boolean,
  className: string,
): { box: HTMLDivElement; body: HTMLDivElement; head: HTMLDivElement; text: HTMLSpanElement } {
  const box = document.createElement('div');
  box.className = className;

  const head = document.createElement('div');
  head.className = `${className}-head`;
  const text = document.createElement('span');
  text.className = 'fold-label';
  text.textContent = `${openByDefault ? '▾' : '▸'} ${headText}　`;
  head.appendChild(text);
  if (countText.length > 0) {
    const count = document.createElement('span');
    count.className = 'folder-count';
    count.textContent = countText;
    head.appendChild(count);
  }

  const body = document.createElement('div');
  body.className = bodyClass;
  body.style.display = openByDefault ? 'block' : 'none';

  const toggle = (): void => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    text.textContent = `${open ? '▸' : '▾'} ${headText}　`;
  };
  listen(head, 'click', toggle);
  listen(text, 'click', toggle);

  box.appendChild(head);
  box.appendChild(body);
  return { box, body, head, text };
}

/** 一份源文件夹下面的一个分类夹（如 01_图片 —— 2 个文件）。 */
function categoryBlock(group: { folder: string; count: number; files: PreviewTree['files'] }): HTMLDivElement {
  const { box, body } = collapsible(`${group.folder}`, `${group.count} 个文件`, 'files', true, 'cat');
  for (const f of group.files) body.appendChild(fileLine(f));
  return box;
}

/**
 * 画「某个源文件夹自己那一份」的一行：源路径 + 输出落到哪 + 几个文件；
 * 展开是它下面的分类夹（各归各，绝不与别的源文件夹合在一起）。
 */
function sourceFolderBlock(sf: PreviewSourceFolder, depth: number): HTMLDivElement {
  const outPath = sf.outputChain.join('\\');
  const label = `${sf.name}${sf.renamed ? '（同名，已改成别的输出名）' : ''}（源：${sf.sourcePath}）`;
  const { box, body } = collapsible(label, `${sf.count} 个文件`, 'source-files', depth === 0, 'source');
  const outLine = document.createElement('div');
  outLine.className = 'source-out';
  outLine.textContent = `→ 输出到：${outPath}\\<分类夹>\\`;
  body.appendChild(outLine);
  if (sf.count === 0) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = '（这一份没有直接躺在它根下的文件）';
    body.appendChild(none);
  }
  for (const g of sf.folders) body.appendChild(categoryBlock(g));
  return box;
}

/**
 * 画预览树。
 *  - 拖入了文件夹（tree.tracked）：**按源文件夹分组**，每个源文件夹一份，
 *    下面列出它自己的分类夹（一眼看出「谁和谁不混」），并写清输出落到哪；
 *  - 只是一堆散文件：照旧按分类列出。
 * 全程只往内存里的 DOM 写，不碰磁盘。
 */
function renderPreviewTree(tree: PreviewTree): void {
  el.previewTree.textContent = '';

  if (tree.tracked && Array.isArray(tree.roots) && tree.roots.length > 0) {
    for (const root of tree.roots) {
      const { box, body } = collapsible(
        `${root.name}（源：${root.path}）`,
        `共 ${root.total} 个文件`,
        'root-files',
        true,
        'root',
      );
      body.appendChild(sourceFolderBlock(root.self, 0));
      for (const child of root.children) body.appendChild(sourceFolderBlock(child, 1));
      el.previewTree.appendChild(box);
    }
    return;
  }

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

/** 预览里也把「跳过了哪几处、为什么」写出来（不藏在暗处）。 */
function renderPreviewSkipped(tree: PreviewTree): void {
  el.previewSkipped.textContent = '';
  const list = tree.skipped ?? [];
  if (list.length === 0) return;
  const head = document.createElement('div');
  head.className = 'skipped-head';
  head.textContent = `预览时跳过 ${list.length} 处（不影响其它文件）：`;
  el.previewSkipped.appendChild(head);
  for (const s of list) {
    const line = document.createElement('div');
    line.className = 'skipped-item';
    line.textContent = `${s.fullPath} —— ${s.reason}`;
    el.previewSkipped.appendChild(line);
  }
}

/** 清掉上一次预览，避免「旧预览」被误当成当前名单的结果。 */
function clearPreview(): void {
  el.previewWarning.textContent = '';
  el.previewSummary.textContent = '';
  el.previewTree.textContent = '';
  el.previewSkipped.textContent = '';
}

el.preview.addEventListener('click', () => {
  void (async () => {
    clearPreview();
    if (selectedFiles.length === 0) {
      notice('还没有可预览的文件，先拖进来或点「选择文件」「选择文件夹」');
      return;
    }
    if (!outputDir) {
      notice('还没选输出文件夹，先点「选择输出文件夹」');
      return;
    }

    let outcome: PreviewOutcome;
    try {
      // 本次预览要按「源文件夹各归各」分组：先把这批源文件夹放好，再点预览。
      // 规则表就传当前界面上这一套：预览说哪个文件进哪个分类，执行时用的是同一套。
      api.setSourceRoots(selectedRoots.slice());
      outcome = await api.preview(selectedFiles.slice(), outputDir, rulesForUse());
    } catch (err) {
      notice(`预览没做出来：${(err as Error)?.message ?? '未知错误'}`);
      return;
    } finally {
      // 只给这一次用：用完就清掉，免得残留给下一次（界面换名单后不会用上次的源文件夹）
      try {
        api.setSourceRoots([]);
      } catch {
        /* 清不掉也不影响本次结果 */
      }
    }

    if (!outcome || outcome.ok !== true) {
      notice(outcome && outcome.message ? outcome.message : '预览没做出来');
      return;
    }

    const tree = outcome.tree;
    el.previewWarning.textContent = PREVIEW_WARNING;
    const notes: string[] = [];
    if (tree.rulesApplied === true) notes.push(rulesSummaryText());
    if (tree.unreadableCount > 0) notes.push(`其中 ${tree.unreadableCount} 个读不到文件信息，已标注原因`);
    if (tree.tracked === true) notes.push(`来自 ${tree.rootCount} 个文件夹（共 ${tree.sourceFolderCount} 份，各归各，绝不互相混）`);
    if (tree.skipped && tree.skipped.length > 0) notes.push(`跳过 ${tree.skipped.length} 处`);
    if (tree.outputDir) notes.push(`计划输出到：${tree.outputDir}`);
    el.previewSummary.textContent =
      `共 ${tree.total} 个文件，会分到 ${tree.folders.filter((g) => g.count > 0).length} 个分类文件夹` +
      (notes.length > 0 ? `（${notes.join('；')}）` : '');
    renderPreviewTree(tree);
    renderPreviewSkipped(tree);
    notice('预览完成：这一步没有写任何文件');
  })();
});

/** 名单或输出文件夹变了，上一次的预览就作废。 */
function invalidatePreview(): void {
  clearPreview();
}

/* ---------------- 分类规则（用户自定义，可存可读） ----------------
 * 「预览」和「开始整理」都带上当前这一套规则：两边用的是同一个求值函数（core 里那一份），
 * 所以预览说哪个文件进哪个分类，执行结果必须一致。
 */

/** 界面上当前的规则表（顺序就是优先级）。 */
let currentRules: Rule[] = [];

/** 上次保存之后又改过规则没有（用来提示「还没保存」）。 */
let rulesDirty = false;

/** 界面上一次最多显示几行规则（避免规则太多把页面撑爆，不影响实际求值）。 */
const RULE_ROWS_MAX = 50;

/** 一组可以放进规则条件里的「不限」哨兵值。 */
const LIST_SEPARATORS = /[,，、;；\s]+/;

function splitList(text: string): string[] {
  return String(text ?? '')
    .split(LIST_SEPARATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 列表 → 输入框里的文字（原样回显，方便用户改）。 */
function listText(values: readonly string[] | undefined): string {
  return (values ?? []).join(', ');
}

/** 界面上显示的一行说明：这条规则在按什么判断。 */
function conditionText(rule: Rule): string {
  const c = rule.condition ?? {};
  const parts: string[] = [];
  const exts = (c.extensions ?? []).filter((e) => e.length > 0);
  const keys = (c.keywords ?? []).filter((k) => k.length > 0);
  if (exts.length > 0) parts.push(`后缀 ${exts.join('/')}`);
  else if (keys.length === 0 && (c.minSize ?? null) === null && (c.maxSize ?? null) === null && (c.modTime ?? 'any') === 'any') {
    parts.push('任何文件');
  }
  if (keys.length > 0) parts.push(`文件名含 ${keys.join('/')}`);
  const min = c.minSize ?? null;
  const max = c.maxSize ?? null;
  if (min !== null || max !== null) {
    if (min !== null && max !== null) parts.push(`大小 ${min / (1024 * 1024)}~${max / (1024 * 1024)} MB`);
    else if (min !== null) parts.push(`大小 ≥ ${min / (1024 * 1024)} MB`);
    else parts.push(`大小 < ${(max as number) / (1024 * 1024)} MB`);
  }
  if ((c.modTime ?? 'any') !== 'any') {
    parts.push(c.modTime === 'this-year' ? '修改时间=今年' : c.modTime === 'last-year' ? '修改时间=去年' : '修改时间=更早');
  }
  return parts.length > 0 ? parts.join(' 且 ') : '未设条件';
}

/** 输给预览/执行的那一份（只留需要的字段，避免把界面上的额外状态带过去）。 */
function rulesForUse(): Rule[] {
  return currentRules.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled !== false,
    condition: {
      extensions: (r.condition?.extensions ?? []).filter((e) => e.length > 0),
      keywords: (r.condition?.keywords ?? []).filter((k) => k.length > 0),
      minSize: r.condition?.minSize ?? null,
      maxSize: r.condition?.maxSize ?? null,
      modTime: r.condition?.modTime ?? 'any',
    },
  }));
}

/** 一眼看出「预览用的是当前规则」。 */
function rulesSummaryText(): string {
  return `预览用的是当前规则（共 ${currentRules.length} 条，从上往下第一条命中生效）`;
}

function setRuleStatus(msg: string): void {
  el.ruleStatus.textContent = msg;
}

function refreshRuleCount(): void {
  const enabled = currentRules.filter((r) => r.enabled !== false).length;
  el.ruleCount.textContent = `当前共 ${currentRules.length} 条规则（启用 ${enabled} 条）`;
}

/** 题头文字（"后缀" / "文件名含" / …）。 */
function rowLabel(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'rule-label';
  span.textContent = text;
  return span;
}

/** 一行规则里的一格输入（text / number / select 共用）。 */
interface RuleFieldSpec {
  className: string;
  value: string;
  type: string;
  onChange?: (value: string) => void;
  options?: Array<{ value: string; label: string }>;
}

function makeField(spec: RuleFieldSpec): HTMLInputElement | HTMLSelectElement {
  const field = (spec.type === 'select' ? document.createElement('select') : document.createElement('input')) as
    | HTMLInputElement
    | HTMLSelectElement;
  field.className = spec.className;
  if (spec.type === 'select') {
    for (const opt of spec.options ?? []) {
      const option = document.createElement('option') as HTMLOptionElement;
      option.value = opt.value;
      option.textContent = opt.label;
      (field as HTMLSelectElement).appendChild(option);
    }
    (field as HTMLSelectElement).value = spec.value;
  } else {
    (field as HTMLInputElement).type = spec.type;
    (field as HTMLInputElement).value = spec.value;
  }
  if (spec.onChange) {
    const change = (): void => spec.onChange?.((field as HTMLInputElement).value);
    listen(field, 'input', change);
    listen(field, 'change', change);
  }
  return field;
}

function makeButton(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button') as HTMLButtonElement;
  button.className = className;
  button.textContent = text;
  listen(button, 'click', onClick);
  return button;
}

/** 改完规则一律：刷新条数 → 让旧预览作废 → 记「还没保存」。 */
function setRules(next: Rule[], dirty = true): void {
  currentRules = next;
  if (dirty) rulesDirty = true;
  renderRuleRows();
  invalidatePreview();
}

/** 只改内容、不动顺序时用（避免每敲一个字就重画整张表，把光标顶掉）。 */
function touchRule(): void {
  rulesDirty = true;
  refreshRuleCount();
  invalidatePreview();
}

/** 画一行规则：启用勾选、规则名、条件、上移/下移/删除。 */
function ruleRow(rule: Rule, index: number): HTMLDivElement {
  const row = document.createElement('div') as HTMLDivElement;
  row.className = rule.enabled === false ? 'rule-row rule-disabled' : 'rule-row';
  row.setAttribute('data-rule-id', rule.id);

  const checkbox = document.createElement('input') as HTMLInputElement;
  checkbox.type = 'checkbox';
  checkbox.checked = rule.enabled !== false;
  checkbox.className = 'rule-enabled';
  // 启用勾选 = 规则名前缀，给「启用勾选」一个稳定标记
  checkbox.setAttribute('data-rule-enabled', '1');
  listen(checkbox, 'change', () => {
    rule.enabled = checkbox.checked;
    setRules(currentRules.slice());
  });

  const order = document.createElement('span');
  order.className = 'rule-index';
  order.textContent = String(index + 1);

  const nameInput = makeField({
    className: 'rule-name',
    type: 'text',
    value: rule.name,
    onChange: (value) => {
      rule.name = value;
      touchRule();
    },
  });

  const extInput = makeField({
    className: 'rule-exts',
    type: 'text',
    value: listText(rule.condition?.extensions),
    onChange: (value) => {
      rule.condition = { ...(rule.condition ?? {}), extensions: splitList(value) };
      touchRule();
    },
  });

  const keyInput = makeField({
    className: 'rule-keywords',
    type: 'text',
    value: listText(rule.condition?.keywords),
    onChange: (value) => {
      rule.condition = { ...(rule.condition ?? {}), keywords: splitList(value) };
      touchRule();
    },
  });

  const mb = (bytes: number | null | undefined): string =>
    bytes === null || bytes === undefined ? '' : String(Number((bytes / (1024 * 1024)).toFixed(4)));
  const numberOrNull = (value: string): number | null => {
    const n = Number(value);
    return value === '' || !Number.isFinite(n) ? null : n;
  };

  const minInput = makeField({
    className: 'rule-min',
    type: 'text',
    value: mb(rule.condition?.minSize),
    onChange: (value) => {
      const n = numberOrNull(value);
      rule.condition = { ...(rule.condition ?? {}), minSize: n === null ? null : n * 1024 * 1024 };
      touchRule();
    },
  });

  const maxInput = makeField({
    className: 'rule-max',
    type: 'text',
    value: mb(rule.condition?.maxSize),
    onChange: (value) => {
      const n = numberOrNull(value);
      rule.condition = { ...(rule.condition ?? {}), maxSize: n === null ? null : n * 1024 * 1024 };
      touchRule();
    },
  });

  const timeSelect = makeField({
    className: 'rule-time',
    type: 'select',
    value: rule.condition?.modTime ?? 'any',
    options: [
      { value: 'any', label: '不限' },
      { value: 'this-year', label: '今年' },
      { value: 'last-year', label: '去年' },
      { value: 'earlier', label: '更早' },
    ],
    onChange: (value) => {
      rule.condition = { ...(rule.condition ?? {}), modTime: value as ModTimeBucket };
      touchRule();
    },
  });

  const upBtn = makeButton('↑ 上移', 'rule-up', () => {
    if (index <= 0) return;
    const next = currentRules.slice();
    const [moved] = next.splice(index, 1);
    next.splice(index - 1, 0, moved);
    setRules(next);
  });
  const downBtn = makeButton('↓ 下移', 'rule-down', () => {
    if (index >= currentRules.length - 1) return;
    const next = currentRules.slice();
    const [moved] = next.splice(index, 1);
    next.splice(index + 1, 0, moved);
    setRules(next);
  });
  const delBtn = makeButton('删除', 'rule-delete', () => {
    setRules(currentRules.filter((_, i) => i !== index));
  });

  for (const child of [
    checkbox,
    order,
    nameInput,
    rowLabel('后缀'),
    extInput,
    rowLabel('文件名含'),
    keyInput,
    rowLabel('大小MB'),
    minInput,
    rowLabel('至'),
    maxInput,
    rowLabel('时间'),
    timeSelect,
    upBtn,
    downBtn,
    delBtn,
  ]) {
    row.appendChild(child);
  }
  return row;
}

/** 重画整张规则表。 */
function renderRuleRows(): void {
  el.ruleList.textContent = '';
  if (currentRules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'rule-empty';
    empty.textContent = '一条规则也没有：所有文件都会进「' + FALLBACK_FOLDER + '」。可以点「新增规则」或「恢复默认规则」。';
    el.ruleList.appendChild(empty);
  } else {
    currentRules.slice(0, RULE_ROWS_MAX).forEach((rule, index) => {
      el.ruleList.appendChild(ruleRow(rule, index));
    });
    if (currentRules.length > RULE_ROWS_MAX) {
      const more = document.createElement('div');
      more.className = 'rule-empty';
      more.textContent = `（规则太多，只显示前 ${RULE_ROWS_MAX} 行；求值仍然用全部 ${currentRules.length} 条）`;
      el.ruleList.appendChild(more);
    }
  }
  refreshRuleCount();
}

/* ---------------- 规则：保存 / 加载 / 恢复默认 ---------------- */

function describeLoad(result: { message?: string } | null | undefined): string {
  return result && typeof result.message === 'string' && result.message.length > 0 ? result.message : '已读取规则';
}

async function saveRulesToDisk(): Promise<void> {
  let result: { ok?: boolean; message?: string } | null = null;
  try {
    result = await api.saveRules(rulesForUse());
  } catch (err) {
    setRuleStatus(`保存规则失败：${(err as Error)?.message ?? '未知错误'}`);
    return;
  }
  const ok = result?.ok !== false;
  if (ok) rulesDirty = false;
  setRuleStatus(result?.message ?? (ok ? '已保存规则' : '保存规则失败'));
  notice(ok ? '规则已保存，下次打开还在' : '规则保存失败');
}

async function loadRulesFromDisk(): Promise<void> {
  let result: { ok?: boolean; rules?: Rule[] | null; message?: string } | null = null;
  try {
    result = await api.loadRules();
  } catch (err) {
    setRuleStatus(`读规则失败：${(err as Error)?.message ?? '未知错误'}（先用默认规则）`);
    return;
  }
  const rules = Array.isArray(result?.rules) ? (result?.rules as Rule[]) : [];
  if (rules.length === 0) {
    setRuleStatus('没有读到规则，先用默认规则');
    return;
  }
  setRules(rules, false);
  setRuleStatus(describeLoad(result));
  notice('规则已就绪');
}

listen(el.ruleAdd, 'click', () => {
  const next = currentRules.slice();
  addRule(next); // 插到第一行：新规则最优先，第一条命中就生效
  setRules(next);
  setRuleStatus(
    `已新增 1 条规则（已插到第一行，最优先命中；不想让它优先就点「下移」），当前共 ${next.length} 条（记得点「保存规则」）`,
  );
});

listen(el.ruleDefault, 'click', () => {
  void (async () => {
    let rules: Rule[] = [];
    try {
      // 规则表、后缀表都由 core 给（单一来源），界面不另写一份默认规则。
      rules = (await api.loadRules()).rules;
    } catch {
      rules = [];
    }
    if (!Array.isArray(rules) || rules.length === 0) {
      setRuleStatus('没能取到默认规则');
      return;
    }
    setRules(rules, true);
    setRuleStatus('已恢复默认规则（按后缀分五类）：点「保存规则」才会写盘');
  })();
});

listen(el.ruleSave, 'click', () => void saveRulesToDisk());
listen(el.ruleLoad, 'click', () => void loadRulesFromDisk());

/** 启动时自动读取上次保存的规则；读不到就回落默认规则并给人话提示（不崩）。 */
async function initRules(): Promise<void> {
  try {
    const result = await api.loadRules();
    if (result && Array.isArray(result.rules) && result.rules.length > 0) {
      currentRules = result.rules;
      setRuleStatus(describeLoad(result));
    } else {
      setRuleStatus('没有读到规则，先用默认规则');
    }
  } catch (err) {
    setRuleStatus(`读规则失败：${(err as Error)?.message ?? '未知错误'}（先用默认规则）`);
  }
  renderRuleRows();
}

/* ---------------- 拖拽 ---------------- */

['dragenter', 'dragover'].forEach((type) => {
  listen(el.drop, type, (ev) => {
    (ev as DragEvent).preventDefault();
    el.drop.classList.add('over');
  });
});

['dragleave', 'drop'].forEach((type) => {
  listen(el.drop, type, (ev) => {
    (ev as DragEvent).preventDefault();
    el.drop.classList.remove('over');
  });
});

// 拖到窗口别处时不要让 Electron 直接打开这个文件
window.addEventListener('dragover', (ev) => ev.preventDefault());
window.addEventListener('drop', (ev) => ev.preventDefault());

/**
 * 把拖进来的文件/文件夹交给名单。
 * 路径只能由预加载脚本里的 webUtils.getPathForFile 取（File.path 在 Electron 32 起已被移除，44 上完全没有），
 * 所以这里一律调 api.pathForFile，且不许留「先试 File.path」的后路。
 * 取不到路径不许静默：必须给人一句人话提示。
 * 拖进来的可能是文件夹（DataTransfer 里同样是 File 对象）：交给 acceptPaths 分派，
 * 是文件夹就递归展开成文件集合，并把「每个文件属于哪个源文件夹」一路带下去。
 */
function createDropHandler(): (ev: DragEvent) => void {
  return (ev: DragEvent): void => {
    const dt = ev.dataTransfer;
    if (!dt || dt.files.length === 0) {
      notice('这次拖入没有拿到文件/文件夹，请改用「选择文件」「选择文件夹」按钮');
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
      notice('读不到这个文件/文件夹的路径，请改用「选择文件」「选择文件夹」按钮');
      return;
    }

    // 数量对不上就说明有拿不到路径的（系统暂时给不出路径），如实说一句，不让整次拖入失败。
    const unreadableHint = unreadable > 0 ? `${unreadable} 个拖入项没拿到路径，已忽略` : '';
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

// 「选择文件夹」：与拖入文件夹是同一个能力（拖拽不灵时必须能走通），可多选。
listen(el.pickFolders, 'click', () => {
  void (async () => {
    let picked: string[] = [];
    try {
      picked = await api.pickFolders();
    } catch (err) {
      notice(`打开「选择文件夹」失败：${(err as Error)?.message ?? '未知错误'}`);
      return;
    }
    await acceptPaths(picked, '选择文件夹：');
  })();
});

listen(el.clearFiles, 'click', () => {
  selectedFiles = [];
  selectedRoots = [];
  scanResult = null;
  skippedPaths = [];
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

listen(el.openOut, 'click', () => {
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
    const files = collectFiles();
    if (files.length === 0) {
      notice('还没有可整理的文件，先拖进来或点「选择文件」「选择文件夹」');
      return;
    }
    if (!outputDir) {
      notice('还没选输出文件夹');
      return;
    }

    const roots = selectedRoots.slice();
    const out = outputDir;
    const rules = rulesForUse();
    running = true;
    el.start.disabled = true;
    el.list.textContent = '';
    el.progress.textContent = `已处理 0 / 共 ${files.length}`;
    notice(
      roots.length > 0
        ? `正在整理（只复制，不动原文件）：${roots.length} 个源文件夹各归各，绝不互相混…`
        : '正在整理（只复制，不动原文件）…',
    );

    try {
      // 与预览同一套规则、同一套源文件夹：预览说哪个文件进哪个分类夹，这里就必须一致。
      // 源文件夹走的是那条老路（第 4 个参数），与 `setSourceRoots` 放下的那批同义。
      const summary = await api.organize(files, out, rules, roots.length > 0 ? roots : null);
      el.progress.textContent = `已处理 ${summary.total} / 共 ${summary.total}`;
      const parts = [`整理完成：成功 ${summary.successCount} 个，失败 ${summary.failureCount} 个`];
      if (summary.plannedFolders && summary.plannedFolders.length > 0) {
        const renamed = summary.plannedFolders.filter((f) => f.renamed).length;
        parts.push(`${roots.length} 个源文件夹各归各（共 ${summary.plannedFolders.length} 份${renamed > 0 ? `，其中 ${renamed} 份因同名改过输出名` : ''}）`);
      }
      if (summary.skipped && summary.skipped.length > 0) parts.push(`跳过 ${summary.skipped.length} 处`);
      el.summary.textContent = parts.join('；');
      // 同名源文件夹被改名时，一条条写清「哪个源路径 → 输出里叫什么」
      for (const p of summary.plannedFolders ?? []) {
        if (!p.renamed) continue;
        addToList(`[改名] ${p.sourcePath} → 输出里的 ${p.outputChain.join('\\')}`, 'ok');
      }
      for (const s of summary.skipped ?? []) {
        addToList(`[跳过] ${s.fullPath} —— ${s.reason}`, 'fail');
      }
      mergeSkipped((summary.skipped ?? []).map((s) => ({ fullPath: s.fullPath, reason: s.reason, name: s.name, originKey: '' })));
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
// 启动时自动读上次保存的规则（读不到就默认规则 + 人话提示，这里绝不崩）
void initRules();
