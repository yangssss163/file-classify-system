/**
 * 界面逻辑：只管拖拽 / 按钮 / 规则编辑 / 显示，分类与复制都在 core 里、由主进程调用。
 * 全程不阻塞：复制是异步的，进程里逐个回报进度。
 */
import type {
  AiSeedAssignment,
  AiSeedClassifyOutcome,
  AiSeedConfigView,
  AiSeedProgress,
  AiSeedRuleOutcome,
  AiSeedStatus,
  ModTimeBucket,
  OrganizeProgress,
  OrganizerApi,
  OutputDirectionCheck,
  PreviewCategoryNode,
  PreviewOutcome,
  PreviewSourceFolder,
  PreviewSubFolder,
  PreviewTree,
  Rule,
  RulesLoadResult,
  RuleTargetView,
  ScanResult,
  SkippedPath,
  UndoSummary,
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
  // 撤销上一次整理（本片新增）
  undo: getEl<HTMLButtonElement>('undo'),
  undoHint: getEl<HTMLSpanElement>('undo-hint'),
  undoWarning: getEl<HTMLParagraphElement>('undo-warning'),
  undoReport: getEl<HTMLDivElement>('undo-report'),
  // 换一种分法：AI 分类（本片接上真实现）
  aiReclassify: getEl<HTMLButtonElement>('ai-reclassify'),
  aiStatus: getEl<HTMLSpanElement>('ai-status'),
  aiNotice: getEl<HTMLParagraphElement>('ai-notice'),
  aiSuggest: getEl<HTMLDivElement>('ai-suggest'),
  // AI 设置（本片新增：接口地址 / 密钥 / 模型名 / 测试连接）
  aiEndpoint: getEl<HTMLInputElement>('ai-endpoint'),
  aiKey: getEl<HTMLInputElement>('ai-key'),
  aiModel: getEl<HTMLInputElement>('ai-model'),
  aiSave: getEl<HTMLButtonElement>('ai-save'),
  aiTest: getEl<HTMLButtonElement>('ai-test'),
  aiConfigStatus: getEl<HTMLSpanElement>('ai-config-status'),
  aiConfigPath: getEl<HTMLParagraphElement>('ai-config-path'),
};

/**
 * 预览区上方那句话：一眼看出「这是预览，还没动你的文件」。
 * 只有真的看到了预览树才显示。
 */
const PREVIEW_WARNING = '以下是预览，还没有复制任何文件：原文件、输出文件夹都保持原样。';

/**
 * 输出方向校验（本片新增的安全护栏）当前结论。
 * 危险时：预览区写出那句人话理由，「开始整理」按钮**不可点**（按钮和后台各拦一道）。
 * 下面是内存里的兜底结论（没有任何名单/输出目录时就是它），真结论由主进程算（与写盘用的是同一个函数）。
 */
let gateCheck: OutputDirectionCheck = {
  ok: false,
  reason: 'no-files',
  message: '还没有可整理的文件，先拖进来或点「选择文件」「选择文件夹」。',
  sourceRoots: [],
  fileDirs: [],
  outputDir: '',
};

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
/** 「开始整理」是不是被输出方向校验挡住了（挡住就不可点）。 */
let startBlocked = false;

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

/** 一份源文件夹下面的一个分类夹（如 01_图片）—— 预览里只有树，不写任何统计旁白。 */
function categoryBlock(group: { folder: string; count: number; files: PreviewTree['files'] }): HTMLDivElement {
  const { box, body } = collapsible(`${group.folder}`, '', 'files', true, 'cat');
  for (const f of group.files) body.appendChild(fileLine(f));
  return box;
}

/**
 * 多层分类名逐层画出来：`照片\风光` 必须画成「`照片` 这一层下面还有一层 `风光`」，
 * 而不是把带分隔符的整个名字当成一个目录名（这是本片的硬要求）。
 * 只有一层时就是普通的那一行（既有行为不变）。
 */
function categoryTreeNode(node: PreviewCategoryNode): HTMLDivElement {
  const { box, body } = collapsible(`${node.folder}`, '', 'files', true, 'cat');
  for (const f of node.files) body.appendChild(fileLine(f));
  for (const child of node.children ?? []) {
    const childBox = categoryTreeNode(child);
    // 下一层挂在这一层的正文里：`照片` 的框里能看到 `风光` 的框
    childBox.className = 'cat cat-nest';
    body.appendChild(childBox);
  }
  return box;
}

/**
 * 「原样保留」的那棵子树里的一个目录。
 * 预览里**只给树**：目录名 + 里面的文件名，不再写「几个文件」「沉了几层」「为什么沉进来」那些过程说明。
 */
function subFolderBlock(sub: PreviewSubFolder, depth: number): HTMLDivElement {
  const { box, body } = collapsible(`${sub.name}`, '', 'keep-files', depth < 2, 'keep');
  for (const f of sub.files) body.appendChild(fileLine(f));
  for (const child of sub.children) body.appendChild(subFolderBlock(child, depth + 1));
  return box;
}

/**
 * 画「某个源文件夹自己那一份」下的内容（每一组 = 输出里的一个目录）：
 * 原样保留的子树 + 这一层根下散文件的分类夹。
 * 预览区**只给树**，不写「做了什么 / 怎么判定的」那类说明。
 */
function sourceFolderBlock(sf: PreviewSourceFolder, depth: number): HTMLDivElement {
  const label = `${sf.name}${sf.renamed ? '（同名，已改成别的输出名）' : ''}（源：${sf.sourcePath}）`;
  const { box, body } = collapsible(label, '', 'source-files', depth === 0, 'source');
  for (const sub of sf.subfolders) body.appendChild(subFolderBlock(sub, 0));
  // 多级分类名逐层画（`categoryTree`）；没有它时退回按规则逐条画（一层一条，形状与现在一样）
  const tree = sf.categoryTree;
  if (Array.isArray(tree) && tree.length > 0) {
    for (const node of tree) body.appendChild(categoryTreeNode(node));
  } else {
    for (const g of sf.categories) body.appendChild(categoryBlock(g));
  }
  return box;
}

/**
 * 画预览树。**预览区只给树** —— 不写「做了什么 / 怎么判定的」那类说明（用户要求）。
 *  - 拖入了文件夹（tree.tracked）：**按源文件夹分组**，每一份下面就是它在输出里的目录与文件；
 *  - 只是一堆散文件：照旧按分类列出。
 * 全程只往内存里的 DOM 写，不碰磁盘。
 */
function renderPreviewTree(tree: PreviewTree): void {
  el.previewTree.textContent = '';

  if (tree.tracked && Array.isArray(tree.roots) && tree.roots.length > 0) {
    for (const root of tree.roots) {
      const { box, body } = collapsible(
        `${root.name}${root.renamed ? '（同名，输出里已改名）' : ''}（源：${root.sourcePath}）→ 输出根下的 ${root.outputName}\\`,
        '',
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

    const files = document.createElement('div');
    files.className = 'files';
    files.style.display = 'none';

    for (const f of group.files) files.appendChild(fileLine(f));

    head.addEventListener('click', () => {
      const open = files.style.display !== 'none';
      files.style.display = open ? 'none' : 'block';
      head.textContent = `${open ? '▸' : '▾'} ${group.folder}　`;
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

/**
 * 输出方向校验：拿「这一批源文件夹 / 散文件 + 输出目录」去后台算一遍（只读，一个字节都不写）。
 * 危险时把理由写进预览区，并让「开始整理」不可点 —— 这道关卡与主进程真正写盘前的那一道是**同一个函数**，
 * 所以「界面说能开工、后台却拒绝」不可能发生。
 * `files` / `roots` 由调用方显式给（免得校验用到的清单和真正要整理的那一份不是同一份）。
 * @param label 校验完成后要说的一句人话（不传就不多说）
 */
async function runDirectionCheck(
  files: readonly string[],
  roots: readonly string[],
  label = '',
): Promise<OutputDirectionCheck | null> {
  let check: OutputDirectionCheck | null = null;
  try {
    check = await api.checkOutputDirection({
      roots: roots.slice(),
      files: files.slice(),
      outputDir,
    });
  } catch {
    check = null; // 校验本身出错（拿不到结论）不阻塞：主进程写盘前还会再拦一道
  }
  gateCheck = check ?? {
    ok: true,
    reason: null,
    message: '',
    sourceRoots: [],
    fileDirs: [],
    outputDir: outputDir ?? '',
  };
  renderDirectionWarning();
  if (label) notice(label);
  return check;
}

/** 把方向结论画出来：危险就写出那句话（一字不改地照抄后台给的说明）。 */
function renderDirectionWarning(): void {
  const blocked = gateCheck.ok !== true;
  if (blocked) {
    const why =
      gateCheck.message && gateCheck.message.trim().length > 0
        ? gateCheck.message
        : '输出方向不对，这次不许开工（一个字节都不会写）。';
    el.previewWarning.textContent = `不能开工：${why}`;
  } else if (el.previewTree.children && el.previewTree.children.length > 0) {
    el.previewWarning.textContent = PREVIEW_WARNING;
  }
  // 危险时「开始整理」不可点（真点了也会被后台拦下）
  startBlocked = blocked;
  updateStartButton();
}

/** 「开始整理」按钮的可点状态：正在跑、或方向危险 → 不可点。 */
function updateStartButton(): void {
  el.start.disabled = running || startBlocked;
}

/** 名单 / 源文件夹 / 输出目录一变，就把方向校验重算一遍（免得留下过时的结论）。 */
function refreshDirectionNow(label = ''): void {
  void runDirectionCheck(collectFiles(), selectedRoots.slice(), label);
}

/**
 * 清掉上一次预览，避免「旧预览」被误当成当前名单的结果。
 * 预览区**只放树**：这里只清树与「跳过」那两块，方向警告交给 `renderDirectionWarning()` 重画。
 */
function clearPreview(): void {
  el.previewSummary.textContent = '';
  el.previewTree.textContent = '';
  el.previewSkipped.textContent = '';
  renderDirectionWarning();
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
    // 方向危险时：把理由覆盖上去，并让「开始整理」不可点（在下面细说）
    if (tree.outputDirection && tree.outputDirection.ok !== true) gateCheck = tree.outputDirection;
    // 预览区**只给树**：这里不再写「做了什么 / 几个文件 / 沉了几层 / 计划输出到哪」那类说明旁白。
    // 拦事故的那几样仍然照旧显示：方向危险那句警告（下面）、读不到文件与被跳过的原因（树里 + 下面那块）。
    // 例外的只有散文件这一趟：那句话说清「预览用的是当前规则（共 N 条）」（规则编辑器那条验收钉着它）。
    el.previewSummary.textContent =
      tree.rulesApplied === true && tree.tracked !== true ? rulesSummaryText() : '';
    renderPreviewTree(tree);
    renderPreviewSkipped(tree);
    // 最后一步再画方向警告：这时预览树已经画好，危险的那句话不会被后续赋值盖掉
    renderDirectionWarning();
    if (tree.outputDirection && tree.outputDirection.ok !== true) {
      notice('输出方向危险：这次不许开工，一个字节都没写。请换一个跟源文件夹无关的输出文件夹。');
      return;
    }
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

/**
 * 每条规则「归一化之后实际会建到哪儿」，按 id 存一份。
 * 结论由 core 给（`api.ruleTargets()`，与真正落盘用的是同一个函数），界面只缓存 + 照抄，
 * 免得「界面显示的目标」与「实际落盘的目标」变成两套。
 * `sourceName` 是「这份结论是按哪个规则名算的」：规则名一改，这份结论立刻作废（不显示旧结论）。
 */
const ruleTargets = new Map<string, { sourceName: string; targetPath: string; segments: string[]; reason: string }>();

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

/**
 * 规则行上那句「实际会建到哪儿」：分类名允许写多级（`照片\风光`），
 * 让人一眼看出这一条会建几层 —— 这是用户要的「让用户一眼看到 `照片\风光`」。
 *
 * 归一化的**权威结论由 core 给**（`api.ruleTargets()`，与真正落盘用的是同一个函数），
 * 这里只做两件事：缓存一份（按 id 对上行）＋ 照抄进那一行。界面绝不自己另写一套归一化。
 * 还没拿到的瞬间（刚点「新增规则」）先按名字直显：没有分隔符时与权威结论一字不差，
 * 有分隔符时下面会写出「共 N 层」；规则行重画后一律以 core 的结论为准。
 */
function ruleTargetText(rule: Rule): string {
  const cached = ruleTargets.get(rule.id);
  // 缓存是按**当时的规则名**算的：名字改过之后这份结论就不成立了，退回按名字直显（不显示旧结论）。
  if (cached && cached.sourceName === String(rule.name ?? '')) {
    if (cached.targetPath.length === 0) {
      return `→ 不能用（${cached.reason || '这个分类名不能用'}）`;
    }
    return `→ ${cached.targetPath}\\${cached.segments.length > 1 ? `，共 ${cached.segments.length} 层` : ''}`;
  }
  const name = String(rule.name ?? '').trim();
  if (name.length === 0) return '→ （还没写分类名）';
  const layers = name.split(/[\\/]+/).filter((s) => s.length > 0).length;
  return `→ ${name}${layers > 1 ? `（共 ${layers} 层）` : ''}`;
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

/**
 * 一眼看出「预览用的是当前规则」。
 * 只在**散文件那一趟**写出来（拖入文件夹那一趟预览区只给树，不写这类说明旁白）——
 * 第 7 条验收（规则编辑器）钉着这句话，所以它不能删。
 */
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

/** 改完规则一律：刷新条数 → 让旧预览作废 → 记「还没保存」→ 把「实际目标」按新名字再问一遍。 */
function touchRule(): void {
  rulesDirty = true;
  refreshRuleCount();
  invalidatePreview();
  // 只改内容、不重画整张表时也要把「这一条实际会建到哪儿」重新问一遍 core：
  // 分类名改了，core 给的那份结论就变了（多级分类名尤其明显）。
  // 这一格按名字直显也会给出同样的路径，但**权威结论只认 core 那一份**，所以这里顺手刷新。
  void refreshRuleTargets();
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

  // 规则行上显示**归一化之后的实际目标**：写 `照片\风光` 就显示「→ 照片\风光\，共 2 层」。
  const targetLabel = document.createElement('span');
  targetLabel.className = 'rule-target';
  targetLabel.textContent = ruleTargetText(rule);

  const nameInput = makeField({
    className: 'rule-name',
    type: 'text',
    value: rule.name,
    onChange: (value) => {
      rule.name = value;
      // 这一行的名字变了：core 给的那份「实际目标」对应的是**改名之前**的结论，立刻作废，
      // 免得规则行上继续显示一个已经不成立的目标（改成新的之后那一格会按名字直显）。
      // 随后 `touchRule()` 会重画整张表 → `refreshRuleTargets()` 去 core 取新的结论回来补上。
      ruleTargets.delete(rule.id);
      targetLabel.textContent = ruleTargetText(rule);
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
    targetLabel,
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
  // 规则行上那句「实际会建到哪儿」要的是 core 的归一化结论（多级分类名尤其如此）：
  // 拿回来之后把这几行更新一遍（不重画整张表，别把用户正在敲的光标顶掉）。
  void refreshRuleTargets();
}

/**
 * 把每条规则「归一化之后实际会建到哪儿」从 core 取回来（同一个归一化函数），
 * 再更新**当前页面上**那几行规则的目标文字（整张表重画的场合由 `renderRuleRows()` 自己带上）。
 *
 * 取回来的是「每条规则一项」，所以**整表替换**：同一个 id 的规则改了名字之后目标会变，
 * 留着上一次的结论会让规则行显示一个已经不成立的目标。
 * 另外用序号挡住乱序回包：只有最后一次请求的结论算数（免得旧的回包把新的盖掉）。
 */
let ruleTargetsSeq = 0;
async function refreshRuleTargets(): Promise<void> {
  if (!api || typeof api.ruleTargets !== 'function') return; // 老接口：按名字直显，不阻塞界面
  const seq = ++ruleTargetsSeq;
  const asked = rulesForUse();
  let list: RuleTargetView[] = [];
  try {
    list = await api.ruleTargets(asked);
  } catch {
    return; // 取不到就沿用上一份（或按名字直显），绝不把界面搞崩
  }
  if (!Array.isArray(list) || seq !== ruleTargetsSeq) return;
  ruleTargets.clear();
  list.forEach((entry, index) => {
    if (!entry || typeof entry.id !== 'string') return;
    ruleTargets.set(entry.id, {
      // 记下「这份结论是按哪个规则名算的」：规则名一改就作废，不显示旧结论。
      sourceName: String(asked[index]?.name ?? ''),
      targetPath: String(entry.targetPath ?? ''),
      segments: Array.isArray(entry.segments) ? entry.segments.map((s) => String(s)) : [],
      reason: String(entry.reason ?? ''),
    });
  });
  refreshRuleTargetLabels();
}

/** 把页面上那几行规则的目标文字重写一遍（不重画整张表，别把用户正在敲的光标顶掉）。 */
function refreshRuleTargetLabels(): void {
  const containers = Array.from(el.ruleList.children ?? []);
  currentRules.slice(0, RULE_ROWS_MAX).forEach((rule, index) => {
    const row = containers[index] as (HTMLDivElement & { children?: unknown[] }) | undefined;
    const spans = row ? Array.from(row.children ?? []) : [];
    for (const child of spans) {
      const node = child as { className?: string; textContent?: string };
      if (node.className === 'rule-target') {
        node.textContent = ruleTargetText(rule);
        break;
      }
    }
  });
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
  let result: RulesLoadResult | null = null;
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
  stashRuleTargets(result?.targets);
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
      stashRuleTargets(result.targets);
      setRuleStatus(describeLoad(result));
    } else {
      setRuleStatus('没有读到规则，先用默认规则');
    }
  } catch (err) {
    setRuleStatus(`读规则失败：${(err as Error)?.message ?? '未知错误'}（先用默认规则）`);
  }
  renderRuleRows();
}

/**
 * 收下 core 给的「每条规则实际会建到哪儿」（按 id 对上那一行）。
 * `sourceName` 就是这一批规则里对应的那个规则名：规则名一改这份结论立刻作废。
 */
function stashRuleTargets(
  list: readonly { id: string; targetPath?: string; segments: string[]; reason: string }[] | undefined,
  rules: readonly Rule[] = currentRules,
): void {
  for (const entry of list ?? []) {
    if (!entry || typeof entry.id !== 'string') continue;
    const source = rules.find((r) => r.id === entry.id);
    ruleTargets.set(entry.id, {
      sourceName: String(source?.name ?? ''),
      targetPath: String(entry.targetPath ?? ''),
      segments: Array.isArray(entry.segments) ? entry.segments.map((s) => String(s)) : [],
      reason: String(entry.reason ?? ''),
    });
  }
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
      // 换了输出目录 = 方向可能变了：立刻重算一遍，危险的话「开始整理」马上变灰
      await runDirectionCheck(collectFiles(), selectedRoots.slice(), '输出文件夹已选定（已顺手校验输出方向）');
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

    // 最后一道出口校验：方向危险 → 直接拒绝，不调 organize（一个字节都不会写）
    const before = await runDirectionCheck(files, roots, '');
    if (before && before.ok !== true) {
      const why = before.message && before.message.trim().length > 0 ? before.message : '输出方向不对';
      notice(`不能开工：${why}`);
      el.summary.textContent = '没有开始整理：输出方向危险，一个字节都没写。';
      return;
    }

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
      // 本次整理已经记下来了（记录在主进程 userData 下）：刷新「撤销上一次整理」那一段
      if (summary.blocked === true) {
        notice(`不能开工：${summary.blockedReason ?? '输出方向不对'}`);
        gateCheck = summary.direction ?? gateCheck;
        renderDirectionWarning();
      } else {
        await refreshUndo();
      }
    } catch (err) {
      notice(`整理中断：${(err as Error)?.message ?? '未知错误'}`);
      el.summary.textContent = '整理完成：成功 0 个，失败 0 个（本次未跑完）';
    } finally {
      running = false;
      updateStartButton();
    }
  })();
});

/* ---------------- 撤销上一次整理（本片新增） ----------------
 * 界面只负责「问一句 → 调一次 → 把人话报告摆出来」；真正删什么、不删什么全在 core/runRecord.ts。
 * 记录是持久化的（主进程 userData 下的 JSON），所以**关掉程序再打开，仍然能撤销上一次整理**。
 */

/** 撤销按钮当前指向的这一次记录（界面上要写「输出目录」；主进程给的最新摘要）。 */
let currentUndo: { count: number; outputDir: string } = { count: 0, outputDir: '' };

/** 窗口内的二次确认：**问不出来就不删**（宁可少删，也不许不明不白地删）。 */
function confirmUndo(warn: string): boolean {
  try {
    return window.confirm(warn) === true;
  } catch {
    return false;
  }
}

/** 撤销区的状态是否与记录一致：没有可撤销的整理 → 按钮不可点 + 说清原因。 */
function renderUndoSummary(summary: UndoSummary | null): void {
  const undoSpan = el.undoHint;
  if (!summary || summary.available !== true) {
    el.undo.disabled = true;
    undoSpan.className = 'undo-hint';
    undoSpan.textContent = summary && summary.reason ? summary.reason : '没有可撤销的整理';
    return;
  }
  el.undo.disabled = false;
  undoSpan.className = 'undo-hint undo-available';
  undoSpan.textContent = summary.message;
}

/** 拉一次「上一次整理」的摘要（启动时、整理完成后、撤销完成后各一次），并把警告要用的数字记下来。 */
async function refreshUndo(): Promise<void> {
  let summary: UndoSummary | null = null;
  try {
    summary = await api.lastRun();
  } catch {
    summary = null;
  }
  currentUndo = {
    count: summary && typeof summary.fileCount === 'number' ? summary.fileCount : 0,
    outputDir: summary && summary.outputDir ? summary.outputDir : '',
  };
  renderUndoSummary(summary);
}

/** 撤销报告：一句总结 + 一条一条明细（删了的、跳过的都在）。 */
function renderUndoReport(result: {
  message: string;
  files: { target: string; action: string; reason: string }[];
  dirs: { dir: string; action: string; reason: string }[];
}): void {
  el.undoReport.textContent = '';
  const head = document.createElement('div');
  head.className = 'item undo-head';
  head.textContent = result.message;
  el.undoReport.appendChild(head);
  for (const f of result.files ?? []) {
    const line = document.createElement('div');
    line.className = f.action === 'deleted' ? 'item undo-deleted' : 'item undo-skipped';
    line.textContent = `[${f.action === 'deleted' ? '删除' : '跳过'}] ${f.target} —— ${f.reason}`;
    el.undoReport.appendChild(line);
  }
  for (const d of result.dirs ?? []) {
    const line = document.createElement('div');
    line.className = d.action === 'removed' ? 'item undo-deleted' : 'item undo-skipped';
    line.textContent = `[${d.action === 'removed' ? '清掉目录' : '跳过目录'}] ${d.dir} —— ${d.reason}`;
    el.undoReport.appendChild(line);
  }
}

listen(el.undo, 'click', () => {
  void (async () => {
    if (el.undo.disabled) return;
    // 点之前给一句明确警告：只会删这次复制到输出目录的那 N 个文件，原文件不动（窗口内二次确认）
    const n = currentUndo.count;
    const warn =
      `要点「确定」才会动手：只会删掉这次复制到输出目录的那 ${n} 个文件` +
      `（输出目录：${currentUndo.outputDir}），以及由程序创建、撤销后变空的目录；` +
      `原文件一个都不会动。整理之后你自己加过或改过的文件会被跳过。`;
    el.undoWarning.textContent = warn;
    if (!confirmUndo(warn)) return;

    el.undo.disabled = true;
    let outcome: { result: unknown; summary: unknown } | null = null;
    try {
      outcome = await api.undoLastRun();
    } catch (err) {
      el.undoWarning.textContent = `撤销失败：${(err as Error)?.message ?? '未知错误'}（没有删掉东西）`;
      await refreshUndo();
      return;
    }
    const result = (outcome?.result ?? null) as {
      message: string;
      files: { target: string; action: string; reason: string }[];
      dirs: { dir: string; action: string; reason: string }[];
    } | null;
    if (!result) {
      el.undoWarning.textContent = '撤销没有结果，请看下面的记录';
      await refreshUndo();
      return;
    }
    renderUndoReport(result);
    el.undoWarning.textContent = '';
    renderUndoSummary((outcome?.summary ?? null) as UndoSummary | null);
    notice(result.message);
  })();
});

/* ---------------- AI 设置（接口地址 / 密钥 / 模型名） ----------------
 * 界面只负责「读出来摆上去、把用户改的存回去、点一下测连接」，真正的读写与请求都在核心那几个模块里。
 * **密钥不回显**：输入框是密码型，读设置时留空（留空 = 不改动已保存的那份）。
 */
function setAiConfigStatus(msg: string): void {
  el.aiConfigStatus.textContent = msg;
}

/** 把设置摆到界面上（密钥只显示「已保存几位」，内容不回显）。 */
function renderAiConfig(view: AiSeedConfigView | null): void {
  if (!view) return;
  el.aiEndpoint.value = view.endpoint;
  el.aiModel.value = view.model;
  el.aiKey.value = ''; // 绝不回显密钥本体
  el.aiKey.placeholder = view.hasKey
    ? `已保存 ${view.keyLength} 位，留空就不改动它`
    : '还没填密钥（必填）';
  el.aiConfigPath.textContent = `配置文件：${view.configPath}`;
  setAiConfigStatus(view.hasKey ? '已配置' : '还没配置');
}

/** 启动时把上次保存的设置读回来摆上。 */
async function loadAiConfigToForm(): Promise<void> {
  try {
    const view = (await api.aiConfigLoad()) as AiSeedConfigView | null;
    if (view) renderAiConfig(view);
    else setAiConfigStatus('没读到 AI 设置');
  } catch (err) {
    setAiConfigStatus(`读 AI 设置失败：${(err as Error)?.message ?? '未知错误'}`);
  }
}

listen(el.aiSave, 'click', () => {
  void (async () => {
    setAiConfigStatus('正在保存…');
    let saved: { ok?: boolean; message?: string; config?: AiSeedConfigView } | null = null;
    try {
      saved = await api.aiConfigSave({
        endpoint: String(el.aiEndpoint.value ?? ''),
        model: String(el.aiModel.value ?? ''),
        authToken: String(el.aiKey.value ?? ''),
      });
    } catch (err) {
      setAiConfigStatus(`保存失败：${(err as Error)?.message ?? '未知错误'}`);
      return;
    }
    if (saved?.config) renderAiConfig(saved.config);
    setAiConfigStatus(saved?.message ?? (saved?.ok === false ? '保存失败' : '已保存'));
    notice(saved?.ok === false ? 'AI 设置没保存成功' : 'AI 设置已保存（下次打开自动读回）');
    await refreshAiStatus();
  })();
});

listen(el.aiTest, 'click', () => {
  void (async () => {
    setAiConfigStatus('正在测试连接…');
    let result: { ok?: boolean; message?: string } | null = null;
    try {
      result = await api.aiConfigTest({
        endpoint: String(el.aiEndpoint.value ?? ''),
        model: String(el.aiModel.value ?? ''),
        authToken: String(el.aiKey.value ?? ''),
      });
    } catch (err) {
      setAiConfigStatus(`测试连接失败：${(err as Error)?.message ?? '未知错误'}`);
      return;
    }
    setAiConfigStatus(result?.message ?? '测试连接没有结果');
  })();
});

/* ---------------- AI 建议：先看、能改（改规则）、确认采用 ----------------
 * 硬要求：**AI 只给建议**；采用之后就把建议变成「既有规则表里的规则」（条件 = 文件名在建议清单里），
 * 再走**既有的**预览 / 开始整理那条管线落盘 —— 界面绝不自己复制、也不自己建分类夹。
 * 「建议 → 规则」的换算与「每个文件落到哪」的求值都在核心那一处（同一个求值函数），界面只摆出来。
 */

/** 这一次的 AI 建议（人确认之前只存在内存里；不确认什么都不改）。 */
let pendingAiSuggestions: AiSeedAssignment[] = [];

function renderAiSuggestions(): void {
  el.aiSuggest.textContent = '';
  if (pendingAiSuggestions.length === 0) return;
  const byCategory = new Map<string, string[]>();
  for (const a of pendingAiSuggestions) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a.source.split(/[\\/]/).pop() ?? a.source);
    byCategory.set(a.category, list);
  }

  const head = document.createElement('div');
  head.className = 'ai-suggest-head';
  head.textContent = `AI 建议（${pendingAiSuggestions.length} 个文件，分 ${byCategory.size} 类）—— 还没采用，采用之前不会动任何文件：`;
  el.aiSuggest.appendChild(head);

  for (const [category, names] of byCategory) {
    const line = document.createElement('div');
    line.className = 'item ai-suggest-item';
    line.textContent = `${category}（${names.length}）：${names.slice(0, 8).join('、')}${names.length > 8 ? ' …' : ''}`;
    el.aiSuggest.appendChild(line);
  }

  const row = document.createElement('div');
  row.className = 'row';
  const accept = makeButton('采用这些建议（变成规则）', 'ai-accept', () => {
    void acceptAiSuggestions();
  });
  const drop = makeButton('不采用（丢掉建议）', 'ai-drop', () => {
    pendingAiSuggestions = [];
    renderAiSuggestions();
    el.aiNotice.textContent = '已丢掉这次 AI 建议：规则没变，也没动任何文件。';
  });
  row.appendChild(accept);
  row.appendChild(drop);
  el.aiSuggest.appendChild(row);
}

/** 采用建议：换算成规则 → 摆进规则表 → 提醒用户点「预览」看一遍再「开始整理」。 */
async function acceptAiSuggestions(): Promise<void> {
  if (pendingAiSuggestions.length === 0) return;
  let outcome: AiSeedRuleOutcome | null = null;
  try {
    outcome = await api.aiSuggestRules(pendingAiSuggestions, rulesForUse(), `ai-${Date.now().toString(36)}`);
  } catch (err) {
    el.aiNotice.textContent = `建议没能变成规则：${(err as Error)?.message ?? '未知错误'}（什么都没改）`;
    return;
  }
  if (!outcome || !Array.isArray(outcome.rules) || outcome.rules.length === 0) {
    el.aiNotice.textContent = '建议没能变成规则（没拿到可用的规则表），什么都没改';
    return;
  }
  // 走既有的规则表：从这一刻起，预览与「开始整理」用的就是这套（含 AI 建议那条）
  setRules(outcome.rules, true);
  pendingAiSuggestions = [];
  renderAiSuggestions();
  const checks = outcome.checks ?? [];
  const mismatched = checks.filter((c) => {
    const want = checks.find((x) => x.source === c.source);
    return !want;
  }).length;
  setRuleStatus(`已采用 AI 建议：${outcome.rules.length} 条规则（放在最前面优先命中）—— 记得点「保存规则」`);
  el.aiNotice.textContent =
    `已把 AI 建议变成规则（共 ${outcome.rules.length} 条，放在规则表最前面）。` +
    `每个文件按这套规则算出来的分类和 AI 建议一致（核对了 ${checks.length} 个）${mismatched > 0 ? '（有对不上的，请看一眼规则表）' : ''}。` +
    `下一步：点「预览」看一遍 → 再点「开始整理」（还是只复制、不动原文件）。`;
  invalidatePreview();
}

/** 进度：AI 分类一批一批发出去时，界面上看得到走到哪儿了（老桩里没这个方法时静默跳过）。 */
api.onAiProgress?.((p: AiSeedProgress) => {
  if (!p || typeof p.done !== 'number') return;
  el.aiNotice.textContent = `AI 正在分批分类：已发 ${p.done} / 共 ${p.total} 个文件…`;
});

/* ---------------- 换一种分法：AI 分类（先撤销、后 AI 的硬顺序照旧） ----------------
 * 用户要的那条路：整轮整理完觉得分得不好 → 先把这次复制出去的撤销掉 → 再换一种分法重来。
 * **顺序是硬要求**：① 撤销接口被调到 → ② 撤销成功之后才去调 AI 分类接口。
 *   - 撤销没成功（有文件删不掉）→ 如实显示撤销报告，**不往下调 AI**（不在没撤干净的状态上再叠一层）；
 *   - 没有可撤销的整理 → 只给一句提示，**不删任何东西**，也不调 AI；
 *   - 撤销成了、AI 没配置 → 说清「已撤销 N 个 + AI 分类还没配置」两层信息。
 * 与 AI 有关的实现只有 core/aiClassify.ts 一处；界面这里只调预加载暴露的那两个方法。
 */

/** 撤销结果里那几个数字（界面只用人话 + 这几个数）。 */
interface UndoOutcomeView {
  result?: {
    ok?: boolean;
    message?: string;
    deletedFiles?: number;
    files?: { target: string; action: string; reason: string }[];
    dirs?: { dir: string; action: string; reason: string }[];
  } | null;
  summary?: UndoSummary | null;
}

/**
 * 界面上那行**常显**的 AI 状态（不用点按钮就能看出「现在只有规则分类可用」）。
 * 文字由核心模块给（`api.aiStatus()`），界面照抄 —— 界面里不许再写死一份。
 */
async function refreshAiStatus(): Promise<void> {
  try {
    const status = (await api.aiStatus()) as AiSeedStatus | null;
    if (status && typeof status.label === 'string' && status.label.length > 0) {
      el.aiStatus.textContent = status.label;
      el.aiStatus.className = status.configured === true ? 'hint ai-ready' : 'hint';
      return;
    }
  } catch {
    /* 读不到就退回下面那句兜底，绝不把界面搞崩 */
  }
  el.aiStatus.textContent = 'AI 分类：未配置';
  el.aiStatus.className = 'hint';
}
/** 把「撤销报告」画一遍（撤销失败时也要如实显示 —— 这正是它存在的意义）。 */
function renderUndoOutcomeReport(view: UndoOutcomeView | null): void {
  const result = view?.result;
  if (!result) return;
  renderUndoReport({
    message: String(result.message ?? '撤销没有结果'),
    files: (result.files ?? []) as { target: string; action: string; reason: string }[],
    dirs: (result.dirs ?? []) as { dir: string; action: string; reason: string }[],
  });
}

el.aiReclassify.addEventListener('click', () => {
  void (async () => {
    el.aiNotice.textContent = '';
    renderUndoOutcomeReport(null);

    // ① 先问清楚：有没有可撤销的整理（没有就只给一句提示，绝不删东西、也不调 AI）
    let summary: UndoSummary | null = null;
    try {
      summary = (await api.lastRun()) as UndoSummary | null;
    } catch {
      summary = null;
    }
    currentUndo = {
      count: summary && typeof summary.fileCount === 'number' ? summary.fileCount : 0,
      outputDir: summary && summary.outputDir ? summary.outputDir : '',
    };
    renderUndoSummary(summary);

    if (!summary || summary.available !== true) {
      el.aiNotice.textContent = `没有可撤销的整理（${summary?.reason ?? '还没有整理过'}）：没有删任何东西，也没有换分法。`;
      return;
    }

    // ② 先撤销：这一步必须在调 AI 之前（顺序是硬要求）
    let outcome: UndoOutcomeView | null = null;
    try {
      outcome = (await api.undoLastRun()) as UndoOutcomeView;
    } catch (err) {
      el.aiNotice.textContent = `撤销失败：${(err as Error)?.message ?? '未知错误'}（没有删掉东西，也没有换分法）`;
      await refreshUndo();
      return;
    }
    const result = outcome?.result ?? null;
    if (!result) {
      el.aiNotice.textContent = '撤销没有结果，请看下面的记录；没有换分法';
      await refreshUndo();
      return;
    }

    renderUndoOutcomeReport(outcome);
    renderUndoSummary((outcome?.summary ?? null) as UndoSummary | null);
    notice(outcome?.result?.message ?? '');

    // 撤销本身失败了（有文件删不掉）→ 如实显示报告，**不往下调 AI**
    if (outcome?.result?.ok !== true) {
      el.aiNotice.textContent = '撤销没有成功，这次不换分法：先按下面的撤销报告把没撤掉的处理掉';
      el.aiReclassify.disabled = true;
      return;
    }

    // ③ 撤销成功之后，才去问 AI 分类（真调用：分批发请求、失败一律明确失败并回落规则分类）
    let ai: AiSeedClassifyOutcome | null = null;
    try {
      ai = (await api.aiClassify(collectFiles(), outputDir)) as AiSeedClassifyOutcome;
    } catch (err) {
      el.aiNotice.textContent = `本次已撤销（删掉 ${result.deletedFiles ?? 0} 个文件）。AI 分类没能调起来：${(err as Error)?.message ?? '未知错误'}（按规则分类照旧可用）`;
      pendingAiSuggestions = [];
      renderAiSuggestions();
      return;
    }
    const aiMessage = ai && typeof ai.message === 'string' && ai.message.length > 0 ? ai.message : 'AI 分类没有结果。';
    // 失败（没配置 / 连不上 / 超时 / 回的看不懂）：说清原因 + 明确回落规则分类，一个文件都不动
    if (ai?.ok !== true) {
      pendingAiSuggestions = [];
      renderAiSuggestions();
      el.aiNotice.textContent = `本次已撤销（删掉 ${result.deletedFiles ?? 0} 个文件）。${aiMessage}——这次没有采用任何 AI 建议，也没有复制或删除任何文件；先按规则分类整理即可。`;
      await refreshAiStatus();
      return;
    }
    // 成功：先把建议摆出来给人看（**还没采用**），确认之后才变成规则、再走既有管线落盘
    pendingAiSuggestions = Array.isArray(ai.assignments) ? ai.assignments.slice() : [];
    renderAiSuggestions();
    el.aiNotice.textContent = `本次已撤销（删掉 ${result.deletedFiles ?? 0} 个文件）。${aiMessage}——下面是 AI 建议（还没采用，采用之前不会动任何文件）。`;
    await refreshAiStatus();
  })();
});

refreshCounts();
renderOutDir();
// 启动时自动读上次保存的规则（读不到就默认规则 + 人话提示，这里绝不崩）
void initRules();
// 启动时顺手报一次「上一次整理」的状态：有可撤销的 → 按钮可点；没有 / 已撤过 → 按钮不可点 + 说清原因。
// 记录在主进程 userData 下（持久化），所以关掉程序再打开，上一次整理仍然可撤。
void refreshUndo();
// 启动时顺手把「AI 分类：未配置 / 已配置」那行状态显出来：不用点按钮就知道现在能不能用 AI 分法。
void refreshAiStatus();
// 启动时把上次保存的 AI 设置读回来摆上（密钥不回显，只显示「已保存 N 位」）
void loadAiConfigToForm();
// 方向校验：界面刚起来时名单是空的，先算一遍（结论就是「还没有可整理的文件」）
refreshDirectionNow();
