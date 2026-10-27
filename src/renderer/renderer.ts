/**
 * 界面逻辑：只管拖拽 / 按钮 / 方案编辑 / 显示，分类与复制都在 core 里、由主进程调用。
 *
 * 这一版的界面只有**一页到底**（用户要求：「页面需要切来切去，麻烦」）：
 *   投递站（拖进来、选输出）→ 分拣台（一键选 AI 或规则）→ 预览（关系链球，手动调整）
 *   → 确认分拣 / 取消本次分拣 → 结果（再决定要不要删源文件）
 * 侧栏只剩四个入口：投递 / 规则 / 历史单号 / 设置。
 *
 * 「关系链球」的模型在 `planGraph.ts`（纯数据：拖球、连线、改名、嵌套都只改那份方案），
 * 这里只负责画球与接线 —— 界面绝不自己算分类、也绝不自己复制文件。
 */
import type {
  AiSeedClassifyOutcome,
  AiSeedConfigView,
  AiSeedProgress,
  AiSeedStatus,
  HistoryEntryView,
  ModTimeBucket,
  OrganizeProgress,
  OrganizerApi,
  OutputDirectionCheck,
  PreviewFile,
  PreviewFolder,
  PreviewSourceFolder,
  PreviewSubFolder,
  PreviewTree,
  Rule,
  RulesLoadResult,
  RuleTargetView,
  ScanResult,
  SkippedPath,
  SourceDeleteResultView,
  UndoSummary,
} from './api-types';
import {
  PLAN_UNCATEGORIZED,
  addCategory,
  assignmentsOf,
  buildPlanGraph,
  categoriesOf,
  moveFileTo,
  nestCategory,
  planBaseName,
  planFullPath,
  planSummaryText,
  removeCategory,
  renameCategory,
  type PlanCategoryView,
  type PlanFileNode,
  type PlanGraph,
} from './planGraph.js';

declare global {
  interface Window {
    /** 由预加载脚本通过 contextBridge 注入（preload.ts） */
    organizer: OrganizerApi;
  }
}

const api = window.organizer;

/** 兜底分类文件夹名：与 core 里那一份保持一致（core 的 rules.ts 里指向 classify.ts 的 FOLDER_OTHERS）。 */
const FALLBACK_FOLDER = '05_其他';
void FALLBACK_FOLDER;

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
 * 新规则放在最前，用户刚配的这条会立刻生效；不想让它优先，用行上的「下移」把它挪下去。
 */
function addRule(rules: Rule[]): number {
  rules.unshift(makeNewRule());
  return 0;
}

/**
 * 取元素：拿不到就给一个空壳（挂在它上面的监听器无效，但不会让整个界面脚本崩溃）。
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
  // 投递站
  drop: getEl<HTMLDivElement>('drop'),
  pickFiles: getEl<HTMLButtonElement>('pick-files'),
  pickFolders: getEl<HTMLButtonElement>('pick-folders'),
  clearFiles: getEl<HTMLButtonElement>('clear-files'),
  fileCount: getEl<HTMLSpanElement>('file-count'),
  tray: getEl<HTMLDivElement>('tray'),
  skipped: getEl<HTMLDivElement>('skipped'),
  pickOut: getEl<HTMLButtonElement>('pick-out'),
  outDir: getEl<HTMLSpanElement>('out-dir'),
  notice: getEl<HTMLParagraphElement>('notice'),
  navCount: getEl<HTMLSpanElement>('nav-count'),
  inboxCard: getEl<HTMLElement>('inbox-card'),
  toggleStation: getEl<HTMLButtonElement>('toggle-station'),
  // 分拣台
  sortAi: getEl<HTMLButtonElement>('sort-ai'),
  sortRules: getEl<HTMLButtonElement>('sort-rules'),
  preview: getEl<HTMLButtonElement>('preview'),
  planModeText: getEl<HTMLSpanElement>('plan-mode'),
  planNotice: getEl<HTMLParagraphElement>('plan-notice'),
  progress: getEl<HTMLSpanElement>('progress'),
  progressBar: getEl<HTMLElement>('progress-bar'),
  // 预览（关系链球）
  planCard: getEl<HTMLElement>('plan-card'),
  planWarning: getEl<HTMLDivElement>('plan-warning'),
  planCanvas: getEl<HTMLDivElement>('plan-canvas'),
  planSvg: getEl<SVGSVGElement>('plan-svg'),
  planSummary: getEl<HTMLSpanElement>('plan-summary'),
  planCats: getEl<HTMLDivElement>('plan-cats'),
  planInspector: getEl<HTMLDivElement>('plan-inspector'),
  planAdd: getEl<HTMLButtonElement>('plan-add'),
  planRelayout: getEl<HTMLButtonElement>('plan-relayout'),
  planCancel: getEl<HTMLButtonElement>('plan-cancel'),
  planConfirm: getEl<HTMLButtonElement>('plan-confirm'),
  planJson: getEl<HTMLElement>('plan-json'),
  planHint: getEl<HTMLDivElement>('plan-hint'),
  // 结果
  resultCard: getEl<HTMLElement>('result-card'),
  list: getEl<HTMLDivElement>('file-list'),
  summary: getEl<HTMLParagraphElement>('summary'),
  openOut: getEl<HTMLButtonElement>('open-out'),
  openOut2: getEl<HTMLButtonElement>('open-out-2'),
  delSrcZone: getEl<HTMLElement>('del-src-zone'),
  delSrcCount: getEl<HTMLSpanElement>('del-src-count'),
  delSrcWarning: getEl<HTMLDivElement>('del-src-warning'),
  delSrcConfirm: getEl<HTMLInputElement>('del-src-confirm'),
  delSrc: getEl<HTMLButtonElement>('del-src'),
  delSrcReport: getEl<HTMLDivElement>('del-src-report'),
  undo: getEl<HTMLButtonElement>('undo'),
  undoHint: getEl<HTMLSpanElement>('undo-hint'),
  undoWarning: getEl<HTMLParagraphElement>('undo-warning'),
  undoReport: getEl<HTMLDivElement>('undo-report'),
  // 历史单号
  historyList: getEl<HTMLDivElement>('history-list'),
  historyCount: getEl<HTMLSpanElement>('history-count'),
  historyRefresh: getEl<HTMLButtonElement>('history-refresh'),
  historyNotice: getEl<HTMLParagraphElement>('history-notice'),
  // 规则编辑器
  ruleCount: getEl<HTMLSpanElement>('rule-count'),
  ruleAdd: getEl<HTMLButtonElement>('rule-add'),
  ruleDefault: getEl<HTMLButtonElement>('rule-default'),
  ruleSave: getEl<HTMLButtonElement>('rule-save'),
  ruleLoad: getEl<HTMLButtonElement>('rule-load'),
  ruleList: getEl<HTMLDivElement>('rule-list'),
  ruleStatus: getEl<HTMLParagraphElement>('rule-status'),
  // AI 状态与设置
  aiStatus: getEl<HTMLSpanElement>('ai-status'),
  aiEndpoint: getEl<HTMLInputElement>('ai-endpoint'),
  aiKey: getEl<HTMLInputElement>('ai-key'),
  aiModel: getEl<HTMLInputElement>('ai-model'),
  aiSave: getEl<HTMLButtonElement>('ai-save'),
  aiTest: getEl<HTMLButtonElement>('ai-test'),
  aiConfigStatus: getEl<HTMLSpanElement>('ai-config-status'),
  aiConfigPath: getEl<HTMLParagraphElement>('ai-config-path'),
};

/* ---------------- 路由：一页到底，侧栏只剩四个入口 ----------------
 * 只用 hash 路由（不动主进程、不动 preload）：切页就是改 location.hash + 把对应 section 显示出来。
 * 验收脚本的窗口桩里没有 location，所以拿不到就退回内存里记的那个 hash，逻辑照跑。
 */
type RouteName = 'inbox' | 'rules' | 'history' | 'settings';

const ROUTES: RouteName[] = ['inbox', 'rules', 'history', 'settings'];

const ROUTE_TITLES: Record<RouteName, string> = {
  inbox: '文件分拣站',
  rules: '分拣规则',
  history: '历史单号',
  settings: '设置',
};

/** 没有 location 时（验收桩）就记在这里，行为一致。 */
let inMemoryHash = '';

function readHash(): string {
  try {
    const loc = (window as unknown as { location?: { hash?: unknown } }).location;
    if (loc && typeof loc.hash === 'string') return loc.hash;
  } catch {
    /* 桩里没有 location，走下面的内存那份 */
  }
  return inMemoryHash;
}

function writeHash(hash: string): void {
  inMemoryHash = hash;
  try {
    const loc = (window as unknown as { location?: { hash?: string } }).location;
    if (loc && typeof loc.hash === 'string') loc.hash = hash;
  } catch {
    /* 写不进去就只记在内存里 */
  }
}

function currentRoute(): RouteName {
  const raw = readHash().replace(/^#\/?/, '').split('?')[0];
  return (ROUTES as string[]).indexOf(raw) >= 0 ? (raw as RouteName) : 'inbox';
}

/** 切到某一页（不触发任何业务动作，纯显示）。 */
function go(route: RouteName): void {
  const hash = `#/${route}`;
  if (readHash() !== hash) writeHash(hash);
  renderRoute(route);
}

function renderRoute(route?: RouteName): void {
  const active = route ?? currentRoute();
  for (const name of ROUTES) {
    const view = document.getElementById(`view-${name}`);
    if (view) view.hidden = name !== active;
  }
  const doc = document as unknown as { querySelectorAll?: (sel: string) => ArrayLike<Element> };
  if (typeof doc.querySelectorAll === 'function') {
    const items = doc.querySelectorAll('.nav-item');
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as HTMLElement;
      if (item.getAttribute('data-route') === active) item.classList.add('active');
      else item.classList.remove('active');
    }
  }
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
  if (active === 'history') void refreshHistory();
  try {
    document.title = `${ROUTE_TITLES[active]} · 拣分站`;
  } catch {
    /* 桩里的 document 是个普通对象，写不进去就算了 */
  }
}

listen(window, 'hashchange', () => renderRoute());

/**
 * 输出方向校验（安全护栏）当前结论。
 * 危险时：预览区写出那句人话理由，「确认分拣」按钮**不可点**（按钮和后台各拦一道）。
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
/** 方案是不是已经被确认执行过（执行过之后就不再允许重复点「确认分拣」）。 */
let planDone = false;
/** 投递站在出方案后自动收起（一页里能把投递、分拣、预览都看全）；用户可手动展开。 */
let stationCollapsed = false;

/** 当前这份方案（关系链球的数据源）；null = 还没生成。 */
let planGraph: PlanGraph | null = null;
/** 这份方案是用哪种分法算出来的（显示 + 历史单号用）。 */
let planMode: 'ai' | 'rules' = 'rules';
/** 方案生成时 AI 说的那句人话（规则分法时为空）。 */
let planAiMessage = '';
/** 当前选中的球（`file:<source>` / `cat:<scope>|<path>` / `scope:<scope>`）。 */
let planSelected: string | null = null;
/** 画出来的那些球（含坐标；拖动时改的就是它）。 */
let planBalls: BallNode[] = [];

function notice(msg: string): void {
  el.notice.textContent = msg;
}

function setPlanNotice(msg: string): void {
  el.planNotice.textContent = msg;
}

/**
 * 当前要分拣的文件清单 = 单选的文件 + 从源文件夹递归展开出来的文件。
 * 只合成一份**扁平清单**（顺序稳定：先单选的，后展开的），
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

/** 把展开出来的文件并进主名单（预览/整理用的都是同一份扁平名单）。 */
function mergeScannedIntoSelected(): void {
  selectedFiles = collectFiles();
}

/** 等分拣的那一堆文件：铺成小块，一眼看出拖进来了什么（只显示前 80 个）。 */
function renderTray(): void {
  const files = collectFiles();
  el.tray.textContent = '';
  const max = 80;
  for (const file of files.slice(0, max)) {
    const chip = document.createElement('span');
    chip.className = 'file-chip';
    chip.textContent = planBaseName(file);
    chip.setAttribute('title', file);
    el.tray.appendChild(chip);
  }
  if (files.length > max) {
    const more = document.createElement('span');
    more.className = 'file-chip more';
    more.textContent = `还有 ${files.length - max} 个`;
    el.tray.appendChild(more);
  }
}

function refreshCounts(): void {
  const total = collectFiles().length;
  el.fileCount.textContent =
    selectedRoots.length > 0
      ? `已选 ${total} 个文件（来自 ${selectedRoots.length} 个文件夹）`
      : `已选 ${total} 个文件`;
  el.navCount.textContent = String(total);
  renderSkipped();
  renderTray();
  el.drop.classList.toggle('compact', total > 0);
  const dzTitle = (el.drop as unknown as { querySelector?: (s: string) => Element | null }).querySelector
    ? (el.drop as unknown as { querySelector: (s: string) => Element | null }).querySelector('.dz-title')
    : null;
  if (dzTitle) dzTitle.textContent = total > 0 ? '继续拖入' : '把文件或文件夹拖进来';
}

/** 被跳过的文件夹/路径：一条一行（源文件夹里读不了的子文件夹必须能看见原因）。 */
function renderSkipped(): void {
  el.skipped.textContent = '';
  if (skippedPaths.length === 0) return;
  const head = document.createElement('div');
  head.className = 'skipped-head';
  head.textContent = `已跳过 ${skippedPaths.length} 处（不影响其它文件继续分拣）：`;
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
  el.outDir.textContent = outputDir ?? '还没有选择输出位置';
  el.outDir.className = outputDir ? 'path-box' : 'path-box empty';
  el.outDir.setAttribute('title', outputDir ?? '');
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
 *  - 文件 → 进单文件名单；
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
    mergeScannedIntoSelected();
  }
  refreshCounts();
  if (added.length > 0 || folders.length > 0) {
    clearPlan('名单变了，上一份方案作废');
  }

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
 * @returns 给人看的一句说明（如「加入 5 个文件（来自 2 个文件夹）」）
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

/* ---------------- 输出方向校验 ---------------- */

/**
 * 拿「这一批源文件夹 / 散文件 + 输出目录」去后台算一遍（只读，一个字节都不写）。
 * 危险时把理由写进预览区，并让「确认分拣」不可点 —— 这道关卡与主进程真正写盘前的那一道是**同一个函数**。
 */
async function runDirectionCheck(
  files: readonly string[],
  roots: readonly string[],
  label = '',
): Promise<OutputDirectionCheck | null> {
  let check: OutputDirectionCheck | null = null;
  try {
    check = await api.checkOutputDirection({ roots: roots.slice(), files: files.slice(), outputDir });
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

/**
 * 把方向结论画出来：危险就写出那句话（一字不改地照抄后台给的说明）。
 * 不依赖「方案已经画出来」——方向危险时预览根本不会出现，但这句话必须看得见。
 */
function renderDirectionWarning(): void {
  const blocked = gateCheck.ok !== true;
  const hasWork = collectFiles().length > 0 && !!outputDir;
  el.planWarning.textContent =
    blocked && hasWork
      ? `不能开工：${gateCheck.message && gateCheck.message.trim().length > 0 ? gateCheck.message : '输出方向不对，这次不许开工（一个字节都不会写）。'}`
      : '';
  updateConfirmButton();
}

/** 「确认分拣」按钮的可点状态：正在跑、方向危险、方案已执行过 → 不可点。 */
function updateConfirmButton(): void {
  const blocked = gateCheck.ok !== true;
  el.planConfirm.disabled = running || blocked || planDone || planGraph === null;
  el.planConfirm.textContent = planDone ? '已分拣' : '确认分拣';
  el.planCancel.disabled = running;
  el.planAdd.disabled = running || planGraph === null;
  el.sortAi.disabled = running;
  el.sortRules.disabled = running;
}

/** 名单 / 源文件夹 / 输出目录一变，就把方向校验重算一遍。 */
function refreshDirectionNow(label = ''): void {
  void runDirectionCheck(collectFiles(), selectedRoots.slice(), label);
}

/* ---------------- 方案：从预览树 + AI 结论造出关系链球 ---------------- */

/**
 * 从预览树里读出每个文件「不手动改的话会落在哪」：
 *  - `scope`：它在输出里的源文件夹前缀（散文件模式为空）；
 *  - `category`：相对 scope 的分类路径。
 * 树是 core 算的（与真正落盘同一套规则），界面只做搬运，不重算分类。
 */
/** 预览树里那个文件的**原文件路径**（后台算好的数据；拖进来的 File 对象另走 api.pathForFile）。 */
function sourcePathOf(file: PreviewFile): string {
  return String(file.fullPath ?? '');
}

function readPlanBase(tree: PreviewTree): PlanFileNode[] {
  const files: PlanFileNode[] = [];
  const seen = new Set<string>();
  const push = (source: string, scope: string, category: string, name?: string): void => {
    const key = String(source ?? '').toLowerCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    files.push({ source, name: name || planBaseName(source), scope, category });
  };

  const walkFolder = (folder: PreviewFolder, scope: string, prefix: string): void => {
    const catPath = prefix ? `${prefix}\\${folder.folder}` : folder.folder;
    for (const f of folder.files ?? []) push(sourcePathOf(f), scope, catPath, f.name);
    for (const child of folder.children ?? []) walkFolder(child, scope, catPath);
  };
  const walkSub = (sub: PreviewSubFolder, scope: string, prefix: string): void => {
    const catPath = prefix ? `${prefix}\\${sub.name}` : sub.name;
    for (const f of sub.files ?? []) push(sourcePathOf(f), scope, catPath, f.name);
    for (const child of sub.children ?? []) walkSub(child, scope, catPath);
  };

  if (tree.tracked === true && Array.isArray(tree.roots) && tree.roots.length > 0) {
    for (const root of tree.roots) {
      const sfs: PreviewSourceFolder[] = [root.self, ...root.children];
      for (const sf of sfs) {
        const scope = [root.outputName, ...(sf.chain ?? [])].filter((s) => String(s).length > 0).join('\\');
        for (const c of sf.categories ?? []) walkFolder(c, scope, '');
        for (const s of sf.subfolders ?? []) walkSub(s, scope, '');
      }
    }
  } else {
    for (const f of tree.folders ?? []) walkFolder(f, '', '');
  }

  // 兜底：树没覆盖到的（读不到元信息的）按它自己的 folder 放
  for (const f of tree.files ?? []) push(sourcePathOf(f), '', f.folder, f.name);
  return files;
}

/** 投递站：出方案后收起来，点按钮能再展开（只改显示）。 */
function syncStation(): void {
  const compact = stationCollapsed && planGraph !== null;
  if (el.inboxCard) el.inboxCard.classList.toggle('is-compact', compact);
  el.toggleStation.hidden = planGraph === null;
  el.toggleStation.textContent = compact ? '展开投递站' : '收起投递站';
}

/** 清掉当前这份方案（名单/输出/分法一变就作废；**不删任何文件**）。 */
function clearPlan(reason = ''): void {
  const had = planGraph !== null;
  planGraph = null;
  stationCollapsed = false;
  syncStation();
  planSelected = null;
  planBalls = [];
  planDone = false;
  planAiMessage = '';
  if (el.planCard) el.planCard.hidden = true;
  if (el.planJson) el.planJson.textContent = '';
  if (el.planSummary) el.planSummary.textContent = '';
  if (el.planCats) el.planCats.textContent = '';
  if (el.planInspector) el.planInspector.textContent = '';
  if (el.planWarning) el.planWarning.textContent = '';
  if (el.planSvg && el.planSvg.textContent !== undefined) el.planSvg.textContent = '';
  // 降级清单要摘掉，但 <svg> 本身必须留在页面上（摘掉之后球就画在野节点上了）
  const fallback = el.planCanvas && el.planCanvas.querySelector ? el.planCanvas.querySelector('.plan-list') : null;
  if (fallback && fallback.parentNode) fallback.parentNode.removeChild(fallback);
  updateConfirmButton();
  if (reason && had) setPlanNotice(reason);
  else if (!reason && had) setPlanNotice('');
}

/** 上一份方案作废（改名单/改输出时调用）。 */
function invalidatePreview(): void {
  clearPlan();
}

/**
 * 生成方案：先按规则预览一遍（拿到不手动改的落点），AI 模式下再让 AI 覆盖一遍分类。
 * 两条路都是**只读**：不创建目录、不复制文件。
 */
async function buildPlan(mode: 'ai' | 'rules'): Promise<void> {
  if (running) return;
  const files = collectFiles();
  if (files.length === 0) {
    setPlanNotice('先把文件或文件夹投进来（左边投递站）');
    notice('还没有可分拣的文件');
    return;
  }
  if (!outputDir) {
    setPlanNotice('还没选输出位置：点「输出位置」选一个文件夹');
    notice('还没选输出位置');
    return;
  }

  clearPlan();
  planDone = false;
  planMode = mode;
  setPlanNotice(mode === 'ai' ? '正在让 AI 看这些文件…（只发文件名、大小、修改时间）' : '正在按规则算落点…');
  el.progress.textContent = `已处理 0 / 共 ${files.length}`;
  if (el.progressBar) el.progressBar.style.width = '0%';

  // 方向上危险 → 先说清，不生成方案（一个字节都没写）
  const gate = await runDirectionCheck(files, selectedRoots.slice(), '');
  if (gate && gate.ok !== true) {
    const why = gate.message && gate.message.trim().length > 0 ? gate.message : '输出方向不对';
    setPlanNotice(`不能开工：${why}。换一个跟源文件夹无关的输出目录。`);
    renderDirectionWarning();
    return;
  }

  let outcome: { ok: boolean; tree?: PreviewTree; message?: string } | null = null;
  try {
    // 源文件夹走「放下来、用一次」的那个入口：预览与真正落盘用的是同一批归属。
    if (typeof api.setSourceRoots === 'function') await api.setSourceRoots(selectedRoots.slice());
    outcome = (await api.preview(files, outputDir, rulesForUse())) as unknown as {
      ok: boolean;
      tree?: PreviewTree;
      message?: string;
    };
  } catch (err) {
    setPlanNotice(`预览没做出来：${(err as Error)?.message ?? '未知错误'}`);
    return;
  } finally {
    try {
      if (typeof api.setSourceRoots === 'function') await api.setSourceRoots([]);
    } catch {
      /* 清不掉也不影响本次结果 */
    }
  }

  if (!outcome || outcome.ok !== true || !outcome.tree) {
    setPlanNotice(outcome && outcome.message ? outcome.message : '预览没做出来');
    return;
  }

  const tree = outcome.tree;
  if (tree.outputDirection) gateCheck = tree.outputDirection;
  const base = readPlanBase(tree);

  if (mode === 'ai') {
    let ai: AiSeedClassifyOutcome | null = null;
    try {
      // 第三个参数是源文件夹：核心据它读出「原文件夹已有的分类」当候选，AI 在**已有结构**上分。
      ai = await api.aiClassify(files, outputDir, selectedRoots.slice());
    } catch (err) {
      setPlanNotice(`AI 分拣没能调起来：${(err as Error)?.message ?? '未知错误'}（可以先用「规则分拣」）`);
      return;
    }
    if (!ai || ai.ok !== true) {
      const msg = ai && typeof ai.message === 'string' && ai.message.length > 0 ? ai.message : 'AI 分拣没有结果';
      setPlanNotice(`${msg}——这次没有用 AI，也没有复制或删除任何文件；可以点「规则分拣」。`);
      await refreshAiStatus();
      return;
    }
    const table = new Map<string, string>();
    for (const a of ai.assignments ?? []) table.set(String(a.source).toLowerCase(), a.category);
    let overridden = 0;
    for (const f of base) {
      const hit = table.get(f.source.toLowerCase());
      if (hit && hit.length > 0) {
        f.category = hit;
        overridden++;
      }
    }
    planAiMessage = ai.message;
    setPlanNotice(`${ai.message}（可以直接改；确认之前不会动任何文件）`);
    if (overridden === 0) setPlanNotice(`${ai.message}——这一批文件都没有拿到新分类，按规则兜底`);
  } else {
    planAiMessage = '';
    // 这句话（「预览用的是当前规则（共 N 条…）」）由核心那句原话给，界面不另写一份
    setPlanNotice(
      `${rulesSummaryText()}。${base.length} 个文件；下面可以按需手动调整，确认之前不会动任何文件。`,
    );
  }

  planGraph = buildPlanGraph(base);
  planSelected = null;
  planDone = false;
  renderPlan();
  renderDirectionWarning();
  el.progress.textContent = `已出方案：共 ${files.length} 个文件（还没开始复制）`;
  if (el.progressBar) el.progressBar.style.width = '0%';
  if (el.planCard) el.planCard.hidden = false;
  scrollTo(el.planCard);
}

/** 把某块内容滚到视野里（元素不存在就算了）。 */
function scrollTo(target: unknown): void {
  const node = target as { scrollIntoView?: (opts: unknown) => void } | null;
  if (node && typeof node.scrollIntoView === 'function') {
    try {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      /* 某些环境不支持，无所谓 */
    }
  }
}

/* ---------------- 关系链球：画 + 拖 + 连线 ---------------- */

type BallKind = 'root' | 'scope' | 'category' | 'file';

interface BallNode {
  /** `root` / `scope:<scope>` / `cat:<scope>|<path>` / `file:<source>` */
  id: string;
  kind: BallKind;
  label: string;
  scope: string;
  /** 分类路径（category 才有） */
  catPath: string;
  /** 文件完整路径（file 才有） */
  source: string;
  x: number;
  y: number;
  r: number;
  /** 挂在哪颗球上 */
  parent: string | null;
  /** 布局给的连线通道：非首行子球的连线从竖直通道下来，不穿过上面的球（重排时算，其余时候没有） */
  _entryX?: number;
  _busY?: number;
}

function catId(scope: string, path: string): string {
  return `cat:${scope}|${path}`;
}

function fileId(source: string): string {
  return `file:${source}`;
}

function scopeId(scope: string): string {
  return `scope:${scope}`;
}

/** 由方案造出所有球（root → 源文件夹 → 分类 → 文件）。 */
function buildBalls(graph: PlanGraph): BallNode[] {
  const cats = categoriesOf(graph);
  const balls: BallNode[] = [];
  const rootLabel = outputDir ? planBaseName(outputDir) || '输出' : '输出';
  balls.push({
    id: 'root',
    kind: 'root',
    label: rootLabel,
    scope: '',
    catPath: '',
    source: '',
    x: 0,
    y: 0,
    r: 26,
    parent: null,
  });

  const scopes = Array.from(new Set(cats.map((c) => c.scope))).sort();
  for (const scope of scopes) {
    if (scope.length === 0) continue;
    balls.push({
      id: scopeId(scope),
      kind: 'scope',
      label: planBaseName(scope) || scope,
      scope,
      catPath: '',
      source: '',
      x: 0,
      y: 0,
      r: 20,
      parent: 'root',
    });
  }

  for (const c of cats) {
    const parts = c.catPath.split('\\');
    const parentPath = parts.slice(0, -1).join('\\');
    const parent = parentPath
      ? catId(c.scope, parentPath)
      : c.scope
        ? scopeId(c.scope)
        : 'root';
    balls.push({
      id: catId(c.scope, c.catPath),
      kind: 'category',
      label: c.name,
      scope: c.scope,
      catPath: c.catPath,
      source: '',
      x: 0,
      y: 0,
      r: 14 + Math.min(9, Math.sqrt(Math.max(1, c.total)) * 2.2),
      parent,
    });
  }

  for (const f of graph.files ?? []) {
    balls.push({
      id: fileId(f.source),
      kind: 'file',
      label: String(f.name ?? planBaseName(f.source)),
      scope: String(f.scope ?? ''),
      catPath: String(f.category ?? ''),
      source: f.source,
      x: 0,
      y: 0,
      r: 7,
      parent: catId(String(f.scope ?? ''), String(f.category ?? '')),
    });
  }
  return balls;
}

/**
 * 摆位置：竖向 tidy tree —— 父球在上、子球按行排在正下方（一行放不下就换行），
 * 每棵子树独占一条横向区间、父球对齐到子树正中。
 * 这样初始预览整棵树左右居中，连线只在父子之间的空档里走，不会压到别的球、也不会互相交叉。
 */
const LAYOUT = {
  colGap: 26, // 同一行两颗球之间
  rowGap: 22, // 行与行之间
  childGap: 52, // 父球与它第一行子球之间
  maxRowW: 660, // 一行最宽多少，超了就换行（换行后的连线走专用通道，不穿球）
  top: 56, // 顶上留白
  pad: 48, // 左右留白
};

/** 球（含它下面那行文字）占的横向宽度。估算就够，只用于摆位。 */
function ballBoxW(b: BallNode): number {
  return Math.max(b.r * 2 + 6, Math.min(b.label.length, 16) * 12 + 10);
}

/** 球自身占的高度：根球文字在球里，其余在球下面（分类/源文件夹还带一行计数）。 */
function ballOwnH(b: BallNode): number {
  if (b.kind === 'root') return b.r * 2;
  return b.r + 18 + (b.kind === 'file' ? 0 : 16);
}

interface LayoutRow {
  items: { k: BallNode; w: number }[];
  w: number;
  h: number;
}

/** 量出每颗球子树的宽高，顺手把子球按行分好组（记在 `_rows` 上，摆位时用）。 */
function measureBall(node: BallNode, children: Map<string, BallNode[]>): { w: number; h: number } {
  const kids = children.get(node.id) ?? [];
  const ownW = ballBoxW(node);
  const ownH = ballOwnH(node);
  if (kids.length === 0) return { w: ownW, h: ownH };

  const sized = kids.map((k) => ({ k, box: measureBall(k, children) }));
  const rows: LayoutRow[] = [];
  let cur: { k: BallNode; w: number; h: number }[] = [];
  let curW = 0;
  const flush = () => {
    if (cur.length === 0) return;
    rows.push({
      items: cur.map((c) => ({ k: c.k, w: c.w })),
      w: curW,
      h: Math.max(...cur.map((c) => c.h)),
    });
    cur = [];
    curW = 0;
  };
  for (const s of sized) {
    const add = (cur.length > 0 ? LAYOUT.colGap : 0) + s.box.w;
    if (cur.length === 0 || curW + add <= LAYOUT.maxRowW) {
      cur.push({ k: s.k, w: s.box.w, h: s.box.h });
      curW += add;
    } else {
      flush();
      cur.push({ k: s.k, w: s.box.w, h: s.box.h });
      curW = s.box.w;
    }
  }
  flush();

  const rowsH = rows.reduce((acc, r) => acc + r.h, 0) + LAYOUT.rowGap * Math.max(0, rows.length - 1);
  (node as BallNode & { _rows?: LayoutRow[] })._rows = rows;
  return { w: Math.max(ownW, ...rows.map((r) => r.w)), h: ownH + LAYOUT.childGap + rowsH };
}

/** 把量好的子树摆到（left, top）起、宽 spanW 的区间里：球对齐区间正中。 */
function placeBall(node: BallNode, top: number, left: number, spanW: number): void {
  const ownH = ballOwnH(node);
  node.x = left + spanW / 2;
  node.y = top + ownH / 2;
  const rows = (node as BallNode & { _rows?: LayoutRow[] })._rows;
  if (!rows || rows.length === 0) return;
  let rowY = top + ownH + LAYOUT.childGap;
  // 已经摆好的上面几行占的横向区间：给下面行的连线挑「不穿过任何球」的竖直通道用
  let spansAbove: { l: number; r: number }[] = [];
  for (const row of rows) {
    let rowLeft = left + (spanW - row.w) / 2;
    const spans: { k: BallNode; l: number; r: number }[] = [];
    for (const item of row.items) {
      spans.push({ k: item.k, l: rowLeft, r: rowLeft + item.w });
      rowLeft += item.w + LAYOUT.colGap;
    }
    if (spansAbove.length > 0) {
      // 非首行：每颗子球的连线走一条竖直通道（落在上面所有球都占不到的空档里）
      const busY = rowY - LAYOUT.rowGap / 2;
      const gaps = freeGapCenters(spansAbove);
      for (const s of spans) {
        const target = (s.l + s.r) / 2;
        let best = gaps[0] ?? target;
        for (const g of gaps) {
          if (Math.abs(g - target) < Math.abs(best - target)) best = g;
        }
        s.k._entryX = best;
        s.k._busY = busY;
      }
    }
    for (const s of spans) {
      placeBall(s.k, rowY, s.l, s.r - s.l);
    }
    spansAbove = spansAbove.concat(spans.map((s) => ({ l: s.l, r: s.r })));
    rowY += row.h + LAYOUT.rowGap;
  }
}

/** 一堆横向区间合并且排序后，中间的空档中心 + 两端外侧的备选点。 */
function freeGapCenters(spans: { l: number; r: number }[]): number[] {
  const sorted = spans.slice().sort((a, b) => a.l - b.l);
  const merged: { l: number; r: number }[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.l <= last.r + 1) last.r = Math.max(last.r, s.r);
    else merged.push({ l: s.l, r: s.r });
  }
  const out: number[] = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const gapL = merged[i].r;
    const gapR = merged[i + 1].l;
    if (gapR - gapL >= 10) out.push((gapL + gapR) / 2);
  }
  const minL = merged.length > 0 ? merged[0].l : 0;
  const maxR = merged.length > 0 ? merged[merged.length - 1].r : 0;
  out.push(minL - 34, maxR + 34);
  return out;
}

function layoutBalls(balls: BallNode[]): void {
  const children = new Map<string, BallNode[]>();
  for (const b of balls) {
    const key = b.parent ?? '';
    if (!children.has(key)) children.set(key, []);
    children.get(key)?.push(b);
  }
  const root = balls.find((b) => b.kind === 'root');
  if (!root) return;
  const box = measureBall(root, children);
  placeBall(root, LAYOUT.top, 0, box.w);
  // 整树往右挪一挪：左边留出 pad，别让球贴到画布边上
  let minX = Infinity;
  for (const b of balls) minX = Math.min(minX, b.x - ballBoxW(b) / 2);
  if (Number.isFinite(minX)) {
    const dx = LAYOUT.pad - minX;
    for (const b of balls) b.x += dx;
  }
}

/** 桩环境（没有 SVG）时的降级：按关系一行一条列出来，功能照旧。 */
function renderPlanFallback(cats: readonly PlanCategoryView[]): void {
  const box = el.planCanvas;
  box.textContent = '';
  const list = document.createElement('div');
  list.className = 'plan-list';
  for (const c of cats) {
    const row = document.createElement('div');
    row.className = `ball-row is-category${planSelected === catId(c.scope, c.catPath) ? ' is-selected' : ''}`;
    row.textContent = `${'  '.repeat(Math.max(0, c.depth - 1))}${c.full}（${c.total}）`;
    list.appendChild(row);
    for (const f of planGraph?.files ?? []) {
      const scope = String(f.scope ?? '');
      const path = String(f.category ?? '');
      if (scope !== c.scope || path !== c.catPath) continue;
      const line = document.createElement('div');
      line.className = `ball-row${planSelected === fileId(f.source) ? ' is-selected' : ''}`;
      line.textContent = `${'  '.repeat(Math.max(0, c.depth))}· ${String(f.name ?? planBaseName(f.source))}`;
      list.appendChild(line);
    }
  }
  box.appendChild(list);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 折线转圆角路径：每个拐点用二次贝塞尔倒角（点距太近的点直接丢弃）。 */
function roundedPath(pts: { x: number; y: number }[], r: number): string {
  const p: { x: number; y: number }[] = [];
  for (const pt of pts) {
    const last = p[p.length - 1];
    if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) > 0.5) p.push(pt);
  }
  if (p.length < 2) return '';
  let d = `M ${p[0].x} ${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const prev = p[i - 1];
    const cur = p[i];
    const next = p[i + 1];
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: cur.x + ((prev.x - cur.x) / d1) * rr, y: cur.y + ((prev.y - cur.y) / d1) * rr };
    const c = { x: cur.x + ((next.x - cur.x) / d2) * rr, y: cur.y + ((next.y - cur.y) / d2) * rr };
    d += ` L ${a.x} ${a.y} Q ${cur.x} ${cur.y} ${c.x} ${c.y}`;
  }
  const last = p[p.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

function svgNode<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name) as SVGElementTagNameMap[K];
}

/** 拖动中的那颗球（pointerdown 之后才非空）。 */
let dragState: {
  node: BallNode;
  el: unknown;
  downX: number;
  downY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
} | null = null;

/**
 * 拖一下 / 点一下之后，浏览器还会补一个 `click`。点选已经在这里处理过了，
 * 那个迟到的 click 会再触发一次「选中 + 重排」，把刚拖到的位置弹回去 ——
 * 用这个旗子把它吞掉（下一拍就复位，不影响下一次真正的点选）。
 */
let suppressNextClick = false;

/** SVG 上的事件只挂一次。 */
let svgWired = false;

function wireSvg(): void {
  if (svgWired) return;
  const svg = el.planSvg as unknown as SVGSVGElement | null;
  if (!svg || typeof svg.addEventListener !== 'function') return;
  svgWired = true;

  svg.addEventListener('pointermove', (ev: Event) => {
    const st = dragState;
    if (!st) return;
    const p = pointerPoint(ev as PointerEvent);
    if (!p) return;
    // 累加式位移：每拍把「这一拍动了多少」加到球上（比绝对偏移更顺、不飘）
    const dx = p.x - st.lastX;
    const dy = p.y - st.lastY;
    st.lastX = p.x;
    st.lastY = p.y;
    if (!st.moved && Math.abs(p.x - st.downX) + Math.abs(p.y - st.downY) > 3) st.moved = true;
    st.node.x += dx;
    st.node.y += dy;
    // 拖动中只挪那颗球自己的 transform，**不整屏重画**：
    // 整屏重画会把球整颗换掉，拖起来一顿一顿，还会让这次拖动看起来像被「取消」了。
    const elNode = st.el as { setAttribute?: (name: string, value: string) => void } | null;
    if (elNode && typeof elNode.setAttribute === 'function') {
      elNode.setAttribute('transform', `translate(${Math.round(st.node.x)} ${Math.round(st.node.y)})`);
    }
  });

  svg.addEventListener('pointerup', (ev: Event) => {
    const st = dragState;
    dragState = null;
    if (!st) return;
    // 这次指针交互已经在这里收尾了，别再让迟到的 click 弹一次位置
    suppressNextClick = true;
    setTimeout(() => {
      suppressNextClick = false;
    }, 0);
    const p = pointerPoint(ev as PointerEvent);
    const target = p ? ballAt(p.x, p.y, st.node.id) : null;
    // 落在别的球上（哪怕只挪了一点点）就是「连过去」——别因为没到 3px 就把一次拖拽当成点选
    if (target && target.id !== st.node.id) {
      linkBalls(st.node, target);
      return;
    }
    if (!st.moved) {
      planSelected = st.node.id;
      renderPlan(false);
      return;
    }
    // 自由摆位：没连到别的球，就保留这次拖到的位置（不弹回）
    drawBalls();
  });
}

/** 指针位置换算成画布坐标（拿不到就返回 null，绝不抛）。 */
function pointerPoint(ev: PointerEvent): { x: number; y: number } | null {
  const svg = el.planSvg as unknown as SVGSVGElement | null;
  const canvas = el.planCanvas;
  if (!svg || typeof (svg as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect !== 'function') {
    return null;
  }
  // 优先按 SVG 自己的变换矩阵换算：画布被 CSS 拉伸过，直接减矩形会差一个比例
  try {
    const holder = svg as unknown as {
      createSVGPoint?: () => { x: number; y: number; matrixTransform: (m: unknown) => { x: number; y: number } };
      getScreenCTM?: () => { inverse: () => unknown } | null;
    };
    if (typeof holder.createSVGPoint === 'function' && typeof holder.getScreenCTM === 'function') {
      const ctm = holder.getScreenCTM();
      if (ctm) {
        const pt = holder.createSVGPoint();
        pt.x = Number(ev.clientX ?? 0);
        pt.y = Number(ev.clientY ?? 0);
        const out = pt.matrixTransform(ctm.inverse());
        if (Number.isFinite(out.x) && Number.isFinite(out.y)) return { x: out.x, y: out.y };
      }
    }
  } catch {
    /* 没有矩阵 API 就退回下面的算法 */
  }
  try {
    const rect = (svg as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect();
    return {
      x: Number(ev.clientX ?? 0) - rect.left + Number(canvas.scrollLeft ?? 0),
      y: Number(ev.clientY ?? 0) - rect.top + Number(canvas.scrollTop ?? 0),
    };
  } catch {
    return null;
  }
}

/** 这个位置上有哪颗球（排除自己）。 */
function ballAt(x: number, y: number, exceptId: string): BallNode | null {
  let best: BallNode | null = null;
  let bestDist = Infinity;
  for (const b of planBalls) {
    if (b.id === exceptId) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d <= b.r + 16 && d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

/**
 * 把一颗球连到另一颗上（关系链球的核心手势）：
 *  - 文件 → 分类：换组（必须同一个源文件夹）；
 *  - 分类 → 分类：变成子分类；分类 → 根球：拽回顶层。
 * 不合法就**只给一句人话**，方案一个字都不改。
 */
function linkBalls(from: BallNode, to: BallNode): void {
  if (!planGraph) return;

  if (from.kind === 'file') {
    if (to.kind !== 'category') {
      setPlanNotice('文件要放到某个分类球上（不能直接挂在输出根上）');
      drawBalls();
      return;
    }
    if (from.scope !== to.scope) {
      setPlanNotice('不同源文件夹之间不能互相搬（各自的目录各归各）；可以先给这个文件建一个分类');
      drawBalls();
      return;
    }
    planGraph = moveFileTo(planGraph, from.source, to.scope, to.catPath);
    planSelected = catId(to.scope, to.catPath);
    setPlanNotice(`已把「${from.label}」放进「${planFullPath(to.scope, to.catPath)}」`);
    renderPlan(false);
    return;
  }

  if (from.kind === 'category') {
    if (to.kind === 'category' && to.scope !== from.scope) {
      setPlanNotice('不同源文件夹的分类不能互相嵌套（各自的目录各归各）');
      drawBalls();
      return;
    }
    if (to.kind === 'file') {
      setPlanNotice('分类要拖到分类球上（文件不能当父级）');
      drawBalls();
      return;
    }
    const parentPath = to.kind === 'category' ? to.catPath : '';
    const scope = from.scope;
    planGraph = nestCategory(planGraph, scope, from.catPath, parentPath);
    planSelected = catId(scope, parentPath ? `${parentPath}\\${from.label}` : from.label);
    setPlanNotice(
      parentPath
        ? `已把「${from.label}」变成「${planFullPath(scope, parentPath)}」的子分类`
        : `已把「${from.label}」挪回顶层`,
    );
    renderPlan(false);
    return;
  }

  setPlanNotice('这颗球不能连');
  drawBalls();
}

/** 画球与连线（每次都按 planBalls 重画：球不多，简单可靠）。 */
function drawBalls(): void {
  const svg = el.planSvg as unknown as SVGSVGElement | null;
  if (!svg || typeof (document as unknown as { createElementNS?: unknown }).createElementNS !== 'function') {
    return;
  }
  svg.textContent = '';

  const byId = new Map(planBalls.map((b) => [b.id, b] as const));
  let minX = Infinity;
  let maxX = 0;
  let maxY = 0;
  for (const b of planBalls) {
    minX = Math.min(minX, b.x - Math.max(b.r, ballBoxW(b) / 2) - 8, b._entryX ?? b.x);
    maxX = Math.max(maxX, b.x + Math.max(b.r, ballBoxW(b) / 2) + 8, b._entryX ?? b.x);
    maxY = Math.max(maxY, b.y + b.r + 46);
  }
  if (!Number.isFinite(minX)) minX = 0;
  const vbX = Math.floor(Math.min(minX, 0));
  const vbW = Math.ceil(Math.max(maxX - vbX, 320));
  const vbH = Math.ceil(Math.max(maxY, 320));
  svg.setAttribute('viewBox', `${vbX} 0 ${vbW} ${vbH}`);
  svg.setAttribute('width', String(vbW));
  svg.setAttribute('height', String(vbH));

  const links = svgNode('g');
  links.setAttribute('class', 'links');
  svg.appendChild(links);
  for (const b of planBalls) {
    if (!b.parent) continue;
    const p = byId.get(b.parent);
    if (!p) continue;
    const path = svgNode('path');
    path.setAttribute('class', `link${b.kind === 'category' ? ' is-child' : ''}`);
    const y1 = p.y + p.r;
    const y2 = b.y - b.r;
    if (typeof b._entryX === 'number' && typeof b._busY === 'number') {
      // 布局给的绕行通道：父球底贴着出来（在首行连线展开之前）→ 横移到通道
      // → 竖直下来（穿过上面几行的空档）→ 进子球顶
      const yA = y1 + 6;
      const pts = [
        { x: p.x, y: y1 },
        { x: p.x, y: yA },
        { x: b._entryX, y: yA },
        { x: b._entryX, y: b._busY },
        { x: b.x, y: b._busY },
        { x: b.x, y: y2 },
      ];
      path.setAttribute('d', roundedPath(pts, 10));
    } else {
      // 首行子球（或拖动后的自由位置）：竖向贝塞尔，只走在父子之间的空档里
      const my = (y1 + y2) / 2;
      path.setAttribute('d', `M ${p.x} ${y1} C ${p.x} ${my}, ${b.x} ${my}, ${b.x} ${y2}`);
    }
    links.appendChild(path);
  }

  const balls = svgNode('g');
  balls.setAttribute('class', 'balls');
  svg.appendChild(balls);
  for (const b of planBalls) {
    const g = svgNode('g');
    g.setAttribute('class', `ball ball-${b.kind}${planSelected === b.id ? ' is-selected' : ''}`);
    g.setAttribute('transform', `translate(${Math.round(b.x)} ${Math.round(b.y)})`);
    g.setAttribute('data-kind', b.kind);
    g.setAttribute('data-ball', b.id);
    g.setAttribute('data-label', b.label);
    // 父球就是「这颗球挂在谁下面」：连线画得出来，验收也据它核对层级
    if (b.parent) g.setAttribute('data-parent', b.parent);

    const circle = svgNode('circle');
    circle.setAttribute('r', String(b.r));
    g.appendChild(circle);

    const text = svgNode('text');
    if (b.kind === 'root') {
      // 根球：文字写在球里
      text.setAttribute('x', '0');
      text.setAttribute('y', '1');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '10');
      text.textContent = b.label.slice(0, 4);
    } else {
      // 其余球：文字写在球下面、居中（分类/源文件夹的计数再往下一行）
      text.setAttribute('x', '0');
      text.setAttribute('y', String(b.r + 15));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', b.kind === 'file' ? '10' : '12');
      text.textContent = b.kind === 'file' ? b.label.slice(0, 12) : b.label;
    }
    g.appendChild(text);

    if (b.kind === 'category' || b.kind === 'scope') {
      const count = svgNode('text');
      count.setAttribute('class', 'count');
      count.setAttribute('x', '0');
      count.setAttribute('y', String(b.r + 30));
      count.setAttribute('text-anchor', 'middle');
      const n =
        b.kind === 'category'
          ? (planGraph?.files ?? []).filter(
              (f) => String(f.scope ?? '') === b.scope && String(f.category ?? '') === b.catPath,
            ).length
          : (planGraph?.files ?? []).filter((f) => String(f.scope ?? '') === b.scope).length;
      count.textContent = `${n} 个`;
      g.appendChild(count);
    }

    const title = svgNode('title');
    title.textContent =
      b.kind === 'file' ? b.source : b.kind === 'root' ? `输出：${outputDir ?? ''}` : planFullPath(b.scope, b.catPath);
    g.appendChild(title);

    g.addEventListener('pointerdown', (ev: Event) => {
      ev.preventDefault();
      const p = pointerPoint(ev as PointerEvent);
      if (!p) return;
      dragState = { node: b, el: g, downX: p.x, downY: p.y, lastX: p.x, lastY: p.y, moved: false };
    });
    // 点一下也能选中（拖动要靠 pointerdown，点选两条路都通）
    g.addEventListener('click', () => {
      if (suppressNextClick) return;
      planSelected = b.id;
      renderPlan(false);
    });
    balls.appendChild(g);
  }
}

/** 画侧栏那排分类小块。 */
function renderCatChips(cats: readonly PlanCategoryView[]): void {
  el.planCats.textContent = '';
  for (const c of cats) {
    const chip = document.createElement('button');
    chip.className = `cat-chip${planSelected === catId(c.scope, c.catPath) ? ' is-selected' : ''}`;
    chip.textContent = `${c.name}（${c.total}）`;
    chip.setAttribute('title', c.full);
    chip.setAttribute('data-cat', catId(c.scope, c.catPath));
    listen(chip, 'click', () => {
      planSelected = catId(c.scope, c.catPath);
      renderPlan(false);
    });
    el.planCats.appendChild(chip);
  }
}

function smallButton(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  listen(b, 'click', onClick);
  return b;
}

/** 「选中的球」那块：文件能换组、分类能改名/删除/挂到别处。 */
function renderInspector(): void {
  const box = el.planInspector;
  box.textContent = '';
  if (!planGraph) return;

  const ball = planBalls.find((b) => b.id === planSelected) ?? null;
  if (!ball) {
    const hint = document.createElement('div');
    hint.className = 'empty';
    hint.textContent = '点一颗球，看它能怎么调';
    box.appendChild(hint);
    return;
  }

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent =
    ball.kind === 'file'
      ? planBaseName(ball.source)
      : ball.kind === 'category'
        ? planFullPath(ball.scope, ball.catPath)
        : ball.kind === 'scope'
          ? `源文件夹：${ball.scope}`
          : `输出：${outputDir ?? ''}`;
  box.appendChild(who);

  if (ball.kind === 'file') {
    const where = document.createElement('div');
    where.textContent = `现在在：${planFullPath(ball.scope, ball.catPath)}`;
    box.appendChild(where);

    const label = document.createElement('div');
    label.className = 'hint';
    label.textContent = '移到：';
    box.appendChild(label);

    const row = document.createElement('div');
    row.className = 'row';
    const candidates = categoriesOf(planGraph).filter(
      (c) => c.scope === ball.scope && c.catPath !== ball.catPath,
    );
    for (const c of candidates.slice(0, 14)) {
      row.appendChild(
        smallButton(c.catPath, 'btn btn-sm', () => {
          if (!planGraph) return;
          planGraph = moveFileTo(planGraph, ball.source, c.scope, c.catPath);
          planSelected = catId(c.scope, c.catPath);
          setPlanNotice(`已把「${ball.label}」放进「${c.full}」`);
          renderPlan(false);
        }),
      );
    }
    if (candidates.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'hint';
      empty.textContent = '这一组只有一个分类：先「新建分类」再挪';
      row.appendChild(empty);
    }
    box.appendChild(row);
    return;
  }

  if (ball.kind === 'category') {
    const where = document.createElement('div');
    where.textContent = `路径：${ball.catPath}　里面 ${categoriesOf(planGraph)
      .filter((c) => c.scope === ball.scope && c.catPath === ball.catPath)
      .reduce((n, c) => n + c.total, 0)} 个文件`;
    box.appendChild(where);

    const input = document.createElement('input');
    input.className = 'name-field';
    input.type = 'text';
    input.value = ball.label;
    input.setAttribute('data-role', 'rename');
    box.appendChild(input);

    const row = document.createElement('div');
    row.className = 'row';
    row.appendChild(
      smallButton('改名', 'btn btn-sm', () => {
        if (!planGraph) return;
        const next = String(input.value ?? '').trim();
        if (next.length === 0) {
          setPlanNotice('分类名不能为空');
          return;
        }
        const parentPath = ball.catPath.split('\\').slice(0, -1).join('\\');
        const target = parentPath ? `${parentPath}\\${next}` : next;
        planGraph = renameCategory(planGraph, ball.scope, ball.catPath, target);
        planSelected = catId(ball.scope, target);
        setPlanNotice(`分类已改名为「${planFullPath(ball.scope, target)}」`);
        renderPlan(false);
      }),
    );
    row.appendChild(
      smallButton('删除分类', 'btn btn-sm btn-danger-ghost', () => {
        if (!planGraph) return;
        planGraph = removeCategory(planGraph, ball.scope, ball.catPath);
        planSelected = null;
        setPlanNotice(`已删掉分类「${ball.label}」：里面的文件回到「${PLAN_UNCATEGORIZED}」，一个文件都没删`);
        renderPlan(false);
      }),
    );
    // 在这颗分类下面新建一个分支（子分类）
    row.appendChild(
      smallButton('新建子分类', 'btn btn-sm', () => {
        planSelected = catId(ball.scope, ball.catPath);
        addPlanCategory();
      }),
    );
    box.appendChild(row);

    const toLabel = document.createElement('div');
    toLabel.className = 'hint';
    toLabel.textContent = '挂到：';
    box.appendChild(toLabel);

    const toRow = document.createElement('div');
    toRow.className = 'row';
    toRow.appendChild(
      smallButton('顶层', 'btn btn-sm', () => {
        if (!planGraph) return;
        planGraph = nestCategory(planGraph, ball.scope, ball.catPath, '');
        planSelected = catId(ball.scope, ball.label);
        setPlanNotice(`「${ball.label}」已挪回顶层`);
        renderPlan(false);
      }),
    );
    const parents = categoriesOf(planGraph).filter(
      (c) =>
        c.scope === ball.scope &&
        c.catPath !== ball.catPath &&
        !c.catPath.toLowerCase().startsWith(`${ball.catPath.toLowerCase()}\\`),
    );
    for (const c of parents.slice(0, 8)) {
      toRow.appendChild(
        smallButton(planFullPath(c.scope, c.catPath), 'btn btn-sm', () => {
          if (!planGraph) return;
          planGraph = nestCategory(planGraph, ball.scope, ball.catPath, c.catPath);
          planSelected = catId(c.scope, `${c.catPath}\\${ball.label}`);
          setPlanNotice(`「${ball.label}」已挂到「${c.full}」下面`);
          renderPlan(false);
        }),
      );
    }
    box.appendChild(toRow);
    return;
  }

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent =
    ball.kind === 'root'
      ? '输出根：分类球都挂在它下面。把分类拖到它上面就是挪回顶层。'
      : '源文件夹：它下面的分类与文件都在这个文件夹自己那份里。';
  box.appendChild(hint);
}

/**
 * 把整份方案画一遍（摘要、分类条、球、选中面板、给测试看的 JSON 快照）。
 * `relayout=false` 时**保留每颗球现在的位置**（只是重画/刷新选中态）——
 * 点选、拖动、改结构（连线/换组/改名/新建/嵌套）都走这一路，位置不会被弹回去；
 * 只有两条路会整树重排：初始出方案，和用户手动点「重排」。
 */
function renderPlan(relayout = true): void {
  if (!planGraph) {
    if (el.planCard) el.planCard.hidden = true;
    updateConfirmButton();
    return;
  }
  if (el.planCard) el.planCard.hidden = false;
  if (!stationCollapsed) {
    stationCollapsed = true;
    syncStation();
  }

  const cats = categoriesOf(planGraph);
  const modeText = planMode === 'ai' ? 'AI 分法' : '规则分法';
  el.planSummary.textContent = `${modeText} · ${planSummaryText(planGraph)}`;
  el.planModeText.textContent = `${modeText} · ${cats.length} 个分类`;
  renderCatChips(cats);

  const prev = new Map(planBalls.map((b) => [b.id, b] as const));
  planBalls = buildBalls(planGraph);
  const hasSvg = el.planSvg && typeof (document as unknown as { createElementNS?: unknown }).createElementNS === 'function';
  if (hasSvg) {
    if (el.planCanvas && el.planSvg && el.planCanvas.firstElementChild !== el.planSvg) {
      el.planCanvas.textContent = '';
      el.planCanvas.appendChild(el.planSvg as unknown as Node);
    }
    wireSvg();
    if (relayout || prev.size === 0) {
      layoutBalls(planBalls);
    } else {
      // 保留每一颗球现在的位置（点选、拖动、改结构都不整树重排，重排只走「重排」按钮）。
      // 结构改动冒出来的新球（改名/新建/换组后的新 id）在它父球旁边落位，别堆在原点。
      let seed = 0;
      for (const b of planBalls) {
        const old = prev.get(b.id);
        if (old) {
          b.x = old.x;
          b.y = old.y;
          continue;
        }
        const p = b.parent ? planBalls.find((o) => o.id === b.parent) : null;
        if (p) {
          b.x = p.x + 34 + (seed % 4) * 26;
          b.y = p.y + 66 + Math.floor(seed / 4) * 32;
        } else {
          b.x = 90;
          b.y = 90 + seed * 34;
        }
        seed++;
      }
    }
    drawBalls();
  } else {
    layoutBalls(planBalls);
    renderPlanFallback(cats);
  }
  renderInspector();

  el.planJson.textContent = JSON.stringify({
    mode: planMode,
    categories: cats.map((c) => ({ scope: c.scope, catPath: c.catPath, full: c.full, count: c.count, total: c.total })),
    files: (planGraph.files ?? []).map((f) => ({
      source: f.source,
      name: f.name,
      scope: f.scope,
      category: f.category,
      full: planFullPath(String(f.scope ?? ''), String(f.category ?? '')),
    })),
  });
  updateConfirmButton();
  renderDirectionWarning();
}

/** 「新建分类」：挂在当前选中的分类下面（没选就是顶层）。 */
function addPlanCategory(): void {
  if (!planGraph) return;
  const ball = planBalls.find((b) => b.id === planSelected) ?? null;
  const scope = ball && ball.kind !== 'root' ? ball.scope : '';
  const basePath = ball && ball.kind === 'category' ? ball.catPath : '';
  const existing = new Set(categoriesOf(planGraph).map((c) => `${c.scope}\u0000${c.catPath.toLowerCase()}`));
  let name = '新分类';
  let i = 1;
  let path = basePath ? `${basePath}\\${name}` : name;
  while (existing.has(`${scope}\u0000${path.toLowerCase()}`)) {
    i++;
    name = `新分类${i}`;
    path = basePath ? `${basePath}\\${name}` : name;
  }
  planGraph = addCategory(planGraph, scope, path);
  planSelected = catId(scope, path);
  setPlanNotice(`新建了分类「${planFullPath(scope, path)}」：把文件拖到它上面就归到这儿`);
  renderPlan(false);
}

/* ---------------- 确认分拣 / 取消本次分拣 ---------------- */

/** 取消：把方案丢掉，**一个文件、一个目录都不动**。 */
function cancelPlan(): void {
  if (running) return;
  const had = planGraph !== null;
  clearPlan(had ? '已取消本次分拣：没有复制、没有删除、也没有动源文件' : '');
  setPlanNotice(had ? '已取消本次分拣：没有动任何文件' : '现在没有进行中的方案');
  notice(had ? '已取消本次分拣（没有动任何文件）' : '');
}

/** 确认分拣：按方案落盘（只复制；源文件一个都不动）。 */
function confirmPlan(): void {
  void (async () => {
    if (running || !planGraph) return;
    const files = collectFiles();
    if (files.length === 0) {
      setPlanNotice('名单是空的，先投递文件');
      return;
    }
    if (!outputDir) {
      setPlanNotice('还没选输出位置');
      return;
    }

    // 最后一道出口校验：方向危险 → 直接拒绝，不调 organize（一个字节都不会写）
    const before = await runDirectionCheck(files, selectedRoots.slice(), '');
    if (before && before.ok !== true) {
      const why = before.message && before.message.trim().length > 0 ? before.message : '输出方向不对';
      setPlanNotice(`不能开工：${why}`);
      return;
    }

    const assignments = assignmentsOf(planGraph);
    if (assignments.length !== files.length) {
      setPlanNotice(
        `方案只覆盖了 ${assignments.length} / ${files.length} 个文件，先「重排」或重新生成方案再分拣`,
      );
      return;
    }

    const out = outputDir;
    const roots = selectedRoots.slice();
    const rules = rulesForUse();
    const byAi = planMode === 'ai';

    running = true;
    updateConfirmButton();
    el.list.textContent = '';
    el.progress.textContent = `已处理 0 / 共 ${files.length}`;
    if (el.progressBar) el.progressBar.style.width = '0%';
    if (el.resultCard) el.resultCard.hidden = false;
    setPlanNotice(byAi ? '正在按 AI 的分法落盘（只复制，不动源文件）…' : '正在按规则落盘（只复制，不动源文件）…');
    scrollTo(el.resultCard);

    try {
      const summary = await api.organize(files, out, rules, roots.length > 0 ? roots : null, assignments);
      el.progress.textContent = `已处理 ${summary.total} / 共 ${summary.total}`;
      const parts = [`整理完成：成功 ${summary.successCount} 个，失败 ${summary.failureCount} 个`];
      if (summary.plannedFolders && summary.plannedFolders.length > 0) {
        const renamed = summary.plannedFolders.filter((f) => f.renamed).length;
        parts.push(
          `${roots.length} 个源文件夹各归各（共 ${summary.plannedFolders.length} 份${renamed > 0 ? `，其中 ${renamed} 份因同名改过输出名` : ''}）`,
        );
      }
      if (summary.skipped && summary.skipped.length > 0) parts.push(`跳过 ${summary.skipped.length} 处`);
      el.summary.textContent = parts.join('；');

      for (const p of summary.plannedFolders ?? []) {
        if (!p.renamed) continue;
        addToList(`[改名] ${p.sourcePath} → 输出里的 ${p.outputChain.join('\\')}`, 'ok');
      }
      for (const s of summary.skipped ?? []) addToList(`[跳过] ${s.fullPath} —— ${s.reason}`, 'fail');
      mergeSkipped((summary.skipped ?? []).map((s) => ({ fullPath: s.fullPath, reason: s.reason, name: s.name, originKey: '' })));

      if (summary.blocked === true) {
        setPlanNotice(`不能开工：${summary.blockedReason ?? '输出方向不对'}`);
        gateCheck = summary.direction ?? gateCheck;
        renderDirectionWarning();
        planDone = false;
      } else {
        notice(`输出目录：${summary.outputDir}`);
        planDone = true;
        if (el.planCard) el.planCard.hidden = true;
        scrollTo(el.resultCard);
        setPlanNotice(`分拣完了：${summary.successCount} 个进输出。要不要删源文件，由你在下面决定。`);
        renderDeleteSources(summary.successCount);
        await refreshUndo();
        await refreshHistory();
      }
    } catch (err) {
      setPlanNotice(`分拣中断：${(err as Error)?.message ?? '未知错误'}`);
      el.summary.textContent = '整理完成：成功 0 个，失败 0 个（本次未跑完）';
    } finally {
      running = false;
      updateConfirmButton();
    }
  })();
}

/* ---------------- 删源文件（用户明确确认才动） ---------------- */

/** 这一轮复制成功几个（= 最多能删几个源文件）。 */
let deletableSources = 0;

function renderDeleteSources(successCount: number): void {
  deletableSources = Math.max(0, Number(successCount) || 0);
  el.delSrcCount.textContent =
    deletableSources > 0 ? `这次复制成功 ${deletableSources} 个` : '这次没有复制成功的文件';
  el.delSrcWarning.textContent =
    deletableSources > 0
      ? `删掉源文件 = 把这 ${deletableSources} 个原文件移到回收站；输出里那 ${deletableSources} 份不受影响，以后要恢复就从回收站还原。`
      : '';
  el.delSrcConfirm.checked = false;
  el.delSrc.disabled = true;
  el.delSrcReport.textContent = '';
}

listen(el.delSrcConfirm, 'change', () => {
  el.delSrc.disabled = deletableSources === 0 || el.delSrcConfirm.checked !== true;
});

listen(el.delSrc, 'click', () => {
  void (async () => {
    if (el.delSrc.disabled) return;
    if (el.delSrcConfirm.checked !== true) {
      notice('先勾选「我确认」再删（这一步不可轻率）');
      return;
    }
    const warn =
      `要点「确定」才会动手：把这次复制成功的 ${deletableSources} 个源文件移到回收站，` +
      `删空的源文件夹也一并删掉。输出里那 ${deletableSources} 份不受影响，源文件可以从回收站还原。`;
    el.delSrcWarning.textContent = warn;
    let yes = false;
    try {
      yes = window.confirm(warn) === true;
    } catch {
      yes = false;
    }
    if (!yes) return;

    el.delSrc.disabled = true;
    let outcome: SourceDeleteResultView | null = null;
    try {
      outcome = await api.deleteSources();
    } catch (err) {
      el.delSrcWarning.textContent = `删源文件失败：${(err as Error)?.message ?? '未知错误'}（没有删掉东西）`;
      el.delSrc.disabled = false;
      return;
    }
    if (!outcome) {
      el.delSrcWarning.textContent = '删源文件没有结果';
      return;
    }
    el.delSrcWarning.textContent = outcome.message;
    el.delSrcReport.textContent = '';
    for (const f of outcome.files ?? []) {
      const line = document.createElement('div');
      line.className = f.action === 'deleted' ? 'item ok' : 'item fail';
      line.textContent = `[${f.action === 'deleted' ? '已删' : '跳过'}] ${f.source} —— ${f.reason}`;
      el.delSrcReport.appendChild(line);
    }
    for (const d of outcome.dirs ?? []) {
      const line = document.createElement('div');
      line.className = d.action === 'removed' ? 'item ok' : 'item fail';
      line.textContent = `[${d.action === 'removed' ? '目录已删' : '目录跳过'}] ${d.dir} —— ${d.reason}`;
      el.delSrcReport.appendChild(line);
    }
    deletableSources = 0;
    el.delSrcConfirm.checked = false;
    notice(outcome.message);
    await refreshHistory();
  })();
});

/* ---------------- 撤销上一次整理 ----------------
 * 界面只负责「问一句 → 调一次 → 把人话报告摆出来」；真正删什么、不删什么全在 core/runRecord.ts。
 */

/** 撤销按钮当前指向的这一次记录（界面上要写「输出目录」）。 */
let currentUndo: { count: number; outputDir: string } = { count: 0, outputDir: '' };

/** 窗口内的二次确认：**问不出来就不删**。 */
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

/** 拉一次「上一次整理」的摘要，并把警告要用的数字记下来。 */
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
    const n = currentUndo.count;
    const warn =
      `要点「确定」才会动手：只会删掉这次复制到输出目录的那 ${n} 个文件` +
      `（输出目录：${currentUndo.outputDir}），以及由程序创建、撤销后变空的分类夹；` +
      `源文件一个都不会动。整理之后你自己加过或改过的文件会被跳过。`;
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

/* ---------------- 历史单号 ---------------- */

function renderHistory(entries: readonly HistoryEntryView[]): void {
  el.historyList.textContent = '';
  el.historyCount.textContent = entries.length > 0 ? `共 ${entries.length} 张` : '';
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'history-row';

    const ticket = document.createElement('span');
    ticket.className = 'ticket';
    ticket.textContent = entry.id;
    row.appendChild(ticket);

    const mode = document.createElement('span');
    mode.className = entry.mode === 'ai' ? 'mode' : 'mode is-rules';
    mode.textContent = entry.mode === 'ai' ? 'AI 分法' : '规则分法';
    row.appendChild(mode);

    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = `${entry.fileCount} 个文件 · 成功 ${entry.successCount}${
      entry.failureCount > 0 ? ` · 失败 ${entry.failureCount}` : ''
    } · ${entry.outputDir || '（未记录输出目录）'}`;
    where.setAttribute('title', where.textContent);
    row.appendChild(where);

    const open = smallButton('打开', 'btn btn-sm btn-ghost', () => {
      if (entry.outputDir) void api.openPath(entry.outputDir);
    });
    row.appendChild(open);

    el.historyList.appendChild(row);
  }
}

async function refreshHistory(): Promise<void> {
  let entries: HistoryEntryView[] = [];
  try {
    entries = await api.historyList();
  } catch {
    entries = [];
    el.historyNotice.textContent = '历史读不出来（不影响分拣）';
  }
  renderHistory(Array.isArray(entries) ? entries : []);
}

listen(el.historyRefresh, 'click', () => {
  void (async () => {
    el.historyNotice.textContent = '';
    await refreshHistory();
  })();
});

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
// 标签文字现在写进输入框的占位提示里（见 ruleRow），这个函数留着给别处复用
void rowLabel;

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

  const upBtn = makeButton('↑', 'rule-up', () => {
    if (index <= 0) return;
    const next = currentRules.slice();
    const [moved] = next.splice(index, 1);
    next.splice(index - 1, 0, moved);
    setRules(next);
  });
  upBtn.setAttribute('aria-label', '上移这条规则');
  upBtn.setAttribute('title', '上移（更先命中）');
  const downBtn = makeButton('↓', 'rule-down', () => {
    if (index >= currentRules.length - 1) return;
    const next = currentRules.slice();
    const [moved] = next.splice(index, 1);
    next.splice(index + 1, 0, moved);
    setRules(next);
  });
  downBtn.setAttribute('aria-label', '下移这条规则');
  downBtn.setAttribute('title', '下移');
  const delBtn = makeButton('×', 'rule-delete', () => {
    setRules(currentRules.filter((_, i) => i !== index));
  });
  delBtn.setAttribute('aria-label', '删除这条规则');
  delBtn.setAttribute('title', '删除');

  // 标签不再单独占一列：直接写进输入框的占位提示，行更短、也更容易扫
  extInput.setAttribute('placeholder', '后缀，如 jpg / png');
  keyInput.setAttribute('placeholder', '文件名含…');
  minInput.setAttribute('placeholder', '最小');
  minInput.setAttribute('title', '最小大小（MB）');
  maxInput.setAttribute('placeholder', '最大');
  maxInput.setAttribute('title', '最大大小（MB）');
  timeSelect.setAttribute('title', '按修改时间筛');

  for (const child of [
    checkbox,
    order,
    nameInput,
    targetLabel,
    extInput,
    keyInput,
    minInput,
    maxInput,
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
 * 路径只能由预加载脚本里的 webUtils.getPathForFile 取（File.path 在 Electron 32 起已被移除），
 * 所以这里一律调 api.pathForFile，且不许留「先试 File.path」的后路。
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

    const unreadableHint = unreadable > 0 ? `${unreadable} 个拖入项没拿到路径，已忽略` : '';
    void acceptPaths(paths, '拖入', unreadableHint);
  };
}

el.drop.addEventListener('drop', createDropHandler());

/* ---------------- 投递站按钮 ---------------- */

listen(el.pickFiles, 'click', () => {
  void (async () => {
    const picked = await api.pickFiles();
    await acceptPaths(picked, '选择');
  })();
});

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

listen(el.toggleStation, 'click', () => {
  stationCollapsed = !stationCollapsed;
  syncStation();
});

listen(el.clearFiles, 'click', () => {
  selectedFiles = [];
  selectedRoots = [];
  scanResult = null;
  skippedPaths = [];
  refreshCounts();
  clearPlan();
  el.list.textContent = '';
  el.summary.textContent = '整理完成：成功 0 个，失败 0 个';
  if (el.resultCard) el.resultCard.hidden = true;
  el.progress.textContent = '已处理 0 / 共 0';
  if (el.progressBar) el.progressBar.style.width = '0%';
  setPlanNotice('');
  notice('已清空（没有动任何文件）');
});

function pickOutputDirNow(): void {
  void (async () => {
    const dir = await api.pickOutputDir();
    if (dir) {
      outputDir = dir;
      renderOutDir();
      clearPlan();
      await runDirectionCheck(collectFiles(), selectedRoots.slice(), '输出位置已选定（已顺手校验输出方向）');
    }
  })();
}

listen(el.pickOut, 'click', pickOutputDirNow);

function openOutputDirNow(): void {
  if (!outputDir) {
    notice('还没选输出位置');
    return;
  }
  void api.openPath(outputDir);
}

listen(el.openOut, 'click', openOutputDirNow);
listen(el.openOut2, 'click', openOutputDirNow);

/* ---------------- 分拣台按钮 ---------------- */

listen(el.sortAi, 'click', () => {
  void buildPlan('ai');
});

listen(el.sortRules, 'click', () => {
  void buildPlan('rules');
});

// 「预览」：已经有方案就把它亮出来；还没有就按规则先算一份（之后随时可以换 AI）
listen(el.preview, 'click', () => {
  if (planGraph) {
    renderPlan(false);
    if (el.planCard) el.planCard.hidden = false;
    scrollTo(el.planCard);
    return;
  }
  if (collectFiles().length === 0) {
    setPlanNotice('先把文件或文件夹投进来');
    return;
  }
  void buildPlan('rules');
});

listen(el.planAdd, 'click', addPlanCategory);

listen(el.planRelayout, 'click', () => {
  // 重排 = 重新按树形布局排一遍（把自由拖动过的球都摆回整齐的位置）
  renderPlan(true);
  setPlanNotice('已重排（只改显示，方案不变）');
});

listen(el.planCancel, 'click', cancelPlan);
listen(el.planConfirm, 'click', confirmPlan);

/**
 * 结果里那句话的「落到哪儿」：
 *  - 进了分类夹 → 分类名（分类可以有层级，直接显示）；
 *  - 原样保留（子文件夹里的文件）→ 输出里那一段相对目录（比「原路径」有用得多）；
 *  - 实在算不出来才写「原路径」。
 */
function copyTargetLabel(result: { folder?: string; target?: string | null; finalName?: string }): string {
  const folder = String(result.folder ?? '');
  if (folder.length > 0) return folder;
  const target = String(result.target ?? '');
  if (target.length === 0) return '原路径';
  const base = String(outputDir ?? '');
  let rel = target;
  if (base.length > 0 && target.toLowerCase().startsWith(base.toLowerCase())) rel = target.slice(base.length);
  rel = rel.replace(/^[\\/]+/, '');
  const name = String(result.finalName ?? '') || planBaseName(target);
  if (name.length > 0 && rel.toLowerCase().endsWith(name.toLowerCase())) {
    rel = rel.slice(0, rel.length - name.length);
  }
  const dir = rel.replace(/[\\/]+$/, '');
  return dir.length > 0 ? dir : '输出根目录';
}

/** 复制进度：一条一条往结果里写（成功/失败都写，不隐藏）。 */
if (typeof api.onProgress === 'function') api.onProgress((p: OrganizeProgress) => {
  el.progress.textContent = `已处理 ${p.done} / 共 ${p.total}`;
  if (p.total > 0 && el.progressBar) {
    el.progressBar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
  }
  const name = planBaseName(p.result.source);
  if (p.result.ok) {
    const extra = p.result.renamed ? `（改名 ${p.result.finalName}）` : '';
    addToList(`[成功] ${name} → ${copyTargetLabel(p.result)}${extra}`, 'ok');
  } else {
    addToList(`[失败] ${name} → ${p.result.error ?? '未知原因'}`, 'fail');
  }
});

/** AI 分批进度（文件多的时候看得到走到哪儿）。 */
if (typeof api.onAiProgress === 'function') api.onAiProgress((p: AiSeedProgress) => {
  el.progress.textContent = `AI 已看 ${p.done} / 共 ${p.total}`;
  if (p.total > 0 && el.progressBar) {
    el.progressBar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
  }
});

/* ---------------- AI 状态（那行常显的「已配置 / 未配置」） ---------------- */

async function refreshAiStatus(): Promise<void> {
  try {
    const status = (await api.aiStatus()) as AiSeedStatus | null;
    if (status && typeof status.label === 'string' && status.label.length > 0) {
      el.aiStatus.textContent = status.label;
      el.aiStatus.className = status.configured === true ? 'pill-status ai-ready' : 'pill-status';
      return;
    }
  } catch {
    /* 读不到就退回下面那句兜底，绝不把界面搞崩 */
  }
  el.aiStatus.textContent = 'AI 分类：未配置';
  el.aiStatus.className = 'pill-status';
}

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


/* ---------------- 启动 ---------------- */

refreshCounts();
renderOutDir();
renderDeleteSources(0);
updateConfirmButton();
// 启动时自动读上次保存的规则（读不到就默认规则 + 人话提示，这里绝不崩）
void initRules();
// 上一次整理的记录（持久化）：有可撤销的 → 按钮可点；没有 / 已撤过 → 按钮不可点 + 说清原因
void refreshUndo();
// 「AI 分类：已配置 / 未配置」那行状态：不用点按钮就知道现在能不能用 AI 分法
void refreshAiStatus();
// 上次保存的 AI 设置读回来摆上（密钥不回显，只显示「已保存 N 位」）
void loadAiConfigToForm();
// 方向校验：界面刚起来时名单是空的，先算一遍
refreshDirectionNow();
// 历史单号（读不到就是空表，不影响分拣）
void refreshHistory();
// 落到默认那一页（#/inbox）；hash 里已经有页面时按 hash 来
renderRoute();
