/**
 * 界面逻辑：只管拖拽 / 按钮 / 规则编辑 / 显示，分类与复制都在 core 里、由主进程调用。
 * 全程不阻塞：复制是异步的，进程里逐个回报进度。
 */
import type {
  ModTimeBucket,
  OrganizeProgress,
  OrganizerApi,
  PreviewOutcome,
  PreviewTree,
  Rule,
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
 * 这里只负责「造」，不负责「放到哪」——放置位置由 `addRule()` 决定（必须是末尾）。
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
 * 新增规则：**追加到规则表末尾**，排在所有已有规则之后。
 *
 * 为什么必须是末尾：规则表从上往下求值、第一条命中的生效，而列表里的行顺序**就是**这个数组的顺序
 * （只有这一套顺序，不拆成「显示顺序」和「求值顺序」两套）。新规则要是插到最前，它会永远抢先命中，
 * 用户已经配好的那套规则等于被架空 —— 用起来就是「加了一条规则，结果全乱套」。
 * 想让新规则优先，用行上的「上移」自己挪。
 *
 * @returns 新规则在表里的下标（= 最后一个位置），便于核对
 */
function addRule(rules: Rule[]): number {
  rules.push(makeNewRule());
  return rules.length - 1;
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
  clearFiles: getEl<HTMLButtonElement>('clear-files'),
  fileCount: getEl<HTMLSpanElement>('file-count'),
  pickOut: getEl<HTMLButtonElement>('pick-out'),
  outDir: getEl<HTMLSpanElement>('out-dir'),
  preview: getEl<HTMLButtonElement>('preview'),
  previewWarning: getEl<HTMLParagraphElement>('preview-warning'),
  previewSummary: getEl<HTMLParagraphElement>('preview-summary'),
  previewTree: getEl<HTMLDivElement>('preview-tree'),
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
      // 规则表就传当前界面上这一套：预览说哪个文件进哪个分类，执行时用的是同一套。
      outcome = await api.preview(selectedFiles.slice(), outputDir, rulesForUse());
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
    if (tree.rulesApplied === true) notes.push(rulesSummaryText());
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
  addRule(next); // 追加到末尾：新规则不许抢在已有规则前面
  setRules(next);
  setRuleStatus(`已新增 1 条规则（排在最后一行，第 ${next.length} 行），当前共 ${next.length} 条（记得点「保存规则」）`);
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

listen(el.clearFiles, 'click', () => {
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
    const rules = rulesForUse();
    running = true;
    el.start.disabled = true;
    el.list.textContent = '';
    el.progress.textContent = `已处理 0 / 共 ${files.length}`;
    notice('正在整理（只复制，不动原文件）…');

    try {
      // 与预览同一套规则：预览说哪个文件进哪个分类，这里就必须一致。
      const summary = await api.organize(files, out, rules);
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
// 启动时自动读上次保存的规则（读不到就默认规则 + 人话提示，这里绝不崩）
void initRules();
