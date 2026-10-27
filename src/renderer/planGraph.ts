/**
 * 「分拣方案」的关系图模型。**纯数据**：不碰磁盘、不依赖 Electron、不碰 DOM。
 *
 * 为什么单独一层：界面上的「关系链球」要能拖、能连线、能改名、能嵌套，
 * 这些操作必须只有一处实现（否则拖动改的是界面、落盘的却是另一套，迟早对不上）。
 * 所以这里只做「一份方案（每个文件挂到哪个分类）+ 改它的几个动作」，
 * 界面负责画球、主进程负责按 `assignmentsOf()` 的结果落盘。
 *
 * 三个概念，别混：
 *  - **scope**：这份文件属于哪个源文件夹（等于它在输出里的前缀，如 `报销材料/2024`）；
 *    散文件模式是空串。**不同 scope 之间不许互相搬**（源文件夹各归各是红线）。
 *  - **category**：相对 scope 的分类路径（`票据`、`票据/打车`），落盘时就是它。
 *  - **full**：给用户看的完整路径（scope + category），只用于显示与去重，不参与落盘。
 */

/** 没有分类时的兜底分类名（与 core 的 classify 一致：不猜、明说没分）。 */
export const PLAN_UNCATEGORIZED = '未分类';

/** 方案里的一个文件：它从哪来、归到哪个 scope 的哪个分类。 */
export interface PlanFileNode {
  /** 原文件完整路径（只读；落盘时按它复制） */
  source: string;
  /** 文件名（含后缀，显示用；为空时从 source 里取） */
  name?: string;
  /** 归属前缀（源文件夹在输出里的路径）；散文件模式为空串 */
  scope?: string;
  /** 分类（相对 scope，可以是多级：`票据\打车`） */
  category?: string;
}

/** 一个「还没有文件、但用户主动建了」的分类（空的分类也要能在图上看见）。 */
export interface PlanEmptyCategory {
  scope: string;
  catPath: string;
}

/** 一份方案。 */
export interface PlanGraph {
  files: PlanFileNode[];
  /** 用户手动新建、但里面暂时没有文件的分类 */
  extra: PlanEmptyCategory[];
}

/** 图上要画的一个分类球（由 files + extra 推出来，不单独存）。 */
export interface PlanCategoryView {
  scope: string;
  /** 相对 scope 的分类路径 */
  catPath: string;
  /** 给用户看的完整路径（scope 为空时就是 catPath） */
  full: string;
  /** 这一层自己的名字（catPath 的最后一段） */
  name: string;
  /** 第几层（从 1 开始） */
  depth: number;
  /** 直接挂在这一层上的文件数 */
  count: number;
  /** 含下面各层一共几个文件 */
  total: number;
}

/** 落盘要用的「文件 → 分类」（只含分类名，不含 scope：core 的复制逻辑按归属自己拼前缀）。 */
export interface PlanAssignment {
  source: string;
  category: string;
}

/** 文件名（含后缀）：只用字符串运算，不碰磁盘。 */
export function planBaseName(fullPath: string): string {
  const parts = String(fullPath ?? '').split(/[\\/]/);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * 归一化一个分类路径：
 *  - 分隔符统一成 `\`（`/` 与 `\` 等价，与规则里的写法一致）；
 *  - 去掉空段、`.`、`..`、盘符与绝对路径前缀（**分类名绝不能变成绝对路径**）；
 *  - 首尾空白去掉；归一化后为空就是空串（调用方决定怎么办）。
 */
export function normalizePlanPath(input: string): string {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) return '';
  const parts: string[] = [];
  for (const piece of raw.split(/[\\/]+/)) {
    const seg = piece.trim();
    if (seg.length === 0 || seg === '.' || seg === '..') continue;
    // `C:` 这种盘符、以及任何以冒号结尾的段落都不该出现在分类名里
    if (/^[a-zA-Z]:$/.test(seg)) continue;
    parts.push(seg);
  }
  return parts.join('\\');
}

/** 完整显示路径：scope 为空时就是分类本身。 */
export function planFullPath(scope: string, category: string): string {
  const s = normalizePlanPath(scope);
  const c = normalizePlanPath(category);
  if (s.length === 0) return c;
  if (c.length === 0) return s;
  return `${s}\\${c}`;
}

function scopeKey(scope: string): string {
  return String(scope ?? '').trim().toLowerCase();
}

function categoryKey(scope: string, category: string): string {
  return `${scopeKey(scope)}\u0000${normalizePlanPath(category).toLowerCase()}`;
}

/**
 * 造一份方案：把「文件 → 分类」的清单整成图。
 * 分类为空、或分类名非法到归一化后是空串的文件，落到「未分类」（明说没分，不猜）。
 */
export function buildPlanGraph(
  files: readonly PlanFileNode[],
  extra?: readonly PlanEmptyCategory[] | null,
): PlanGraph {
  const out: PlanGraph = { files: [], extra: [] };
  for (const input of files ?? []) {
    const source = String(input?.source ?? '');
    if (source.length === 0) continue;
    const category = normalizePlanPath(String(input?.category ?? ''));
    out.files.push({
      source,
      name: String(input?.name ?? '') || planBaseName(source),
      scope: normalizePlanPath(String(input?.scope ?? '')),
      category: category.length > 0 ? category : PLAN_UNCATEGORIZED,
    });
  }
  for (const e of extra ?? []) {
    const catPath = normalizePlanPath(String(e?.catPath ?? ''));
    if (catPath.length === 0) continue;
    const scope = normalizePlanPath(String(e?.scope ?? ''));
    const key = categoryKey(scope, catPath);
    if (out.extra.some((x) => categoryKey(x.scope, x.catPath) === key)) continue;
    out.extra.push({ scope, catPath });
  }
  return out;
}

/**
 * 图上所有的分类球（含每一层祖先），按 scope、再按路径排好。
 * 有文件的分类与手动新建的空分类都算；同一个分类只出现一次。
 */
export function categoriesOf(graph: PlanGraph): PlanCategoryView[] {
  const direct = new Map<string, number>();
  const meta = new Map<string, { scope: string; catPath: string }>();

  const remember = (scope: string, catPath: string): void => {
    const key = categoryKey(scope, catPath);
    if (!meta.has(key)) meta.set(key, { scope, catPath });
    if (!direct.has(key)) direct.set(key, 0);
  };

  const addWithAncestors = (scope: string, catPath: string): void => {
    const parts = normalizePlanPath(catPath).split('\\').filter((p) => p.length > 0);
    let acc = '';
    for (const part of parts) {
      acc = acc.length === 0 ? part : `${acc}\\${part}`;
      remember(scope, acc);
    }
  };

  for (const f of graph?.files ?? []) {
    const scope = normalizePlanPath(String(f?.scope ?? ''));
    const category = normalizePlanPath(String(f?.category ?? ''));
    if (category.length === 0) continue;
    addWithAncestors(scope, category);
    const key = categoryKey(scope, category);
    direct.set(key, (direct.get(key) ?? 0) + 1);
  }
  for (const e of graph?.extra ?? []) {
    addWithAncestors(normalizePlanPath(String(e?.scope ?? '')), String(e?.catPath ?? ''));
  }

  const list: PlanCategoryView[] = [];
  for (const [key, value] of meta.entries()) {
    const depth = value.catPath.split('\\').filter((p) => p.length > 0).length;
    list.push({
      scope: value.scope,
      catPath: value.catPath,
      full: planFullPath(value.scope, value.catPath),
      name: value.catPath.split('\\').pop() ?? value.catPath,
      depth,
      count: direct.get(key) ?? 0,
      total: 0,
    });
  }

  // total：自己 + 所有子孙
  for (const c of list) {
    let total = c.count;
    for (const other of list) {
      if (other === c) continue;
      if (scopeKey(other.scope) !== scopeKey(c.scope)) continue;
      if (other.catPath.toLowerCase().startsWith(`${c.catPath.toLowerCase()}\\`)) total += other.count;
    }
    c.total = total;
  }

  list.sort((a, b) => {
    const sa = scopeKey(a.scope);
    const sb = scopeKey(b.scope);
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.catPath.toLowerCase() < b.catPath.toLowerCase() ? -1 : a.catPath.toLowerCase() > b.catPath.toLowerCase() ? 1 : 0;
  });
  return list;
}

/** 这份方案会往磁盘上建哪些分类目录（给「确认分拣」前后对照用）。 */
export function categoryPathsOf(graph: PlanGraph): string[] {
  return categoriesOf(graph).map((c) => c.full);
}

/** 落盘用的清单：每个文件一条，分类是**相对 scope** 的那一段。 */
export function assignmentsOf(graph: PlanGraph): PlanAssignment[] {
  const out: PlanAssignment[] = [];
  for (const f of graph?.files ?? []) {
    const category = normalizePlanPath(String(f?.category ?? ''));
    if (String(f?.source ?? '').length === 0 || category.length === 0) continue;
    out.push({ source: f.source, category });
  }
  return out;
}

/** 把一个文件挪到（同 scope 的）某个分类里。找不到这个文件就原样返回。 */
export function moveFileTo(
  graph: PlanGraph,
  source: string,
  scope: string,
  category: string,
): PlanGraph {
  const key = String(source ?? '').toLowerCase();
  const nextScope = normalizePlanPath(scope);
  const nextCategory = normalizePlanPath(category);
  if (key.length === 0 || nextCategory.length === 0) return graph;
  let hit = false;
  const files = (graph?.files ?? []).map((f) => {
    if (String(f?.source ?? '').toLowerCase() !== key) return f;
    hit = true;
    return { ...f, scope: nextScope, category: nextCategory };
  });
  if (!hit) return graph;
  return { files, extra: (graph?.extra ?? []).slice() };
}

/** 新建一个空分类（已经存在就原样返回）。 */
export function addCategory(graph: PlanGraph, scope: string, catPath: string): PlanGraph {
  const s = normalizePlanPath(scope);
  const p = normalizePlanPath(catPath);
  if (p.length === 0) return graph;
  const key = categoryKey(s, p);
  const exists =
    (graph?.extra ?? []).some((e) => categoryKey(e.scope, e.catPath) === key) ||
    categoriesOf(graph).some((c) => categoryKey(c.scope, c.catPath) === key);
  if (exists) return graph;
  return { files: (graph?.files ?? []).slice(), extra: [...(graph?.extra ?? []), { scope: s, catPath: p }] };
}

/** 改一个分类的名字（它下面的子分类与文件一起改）。 */
export function renameCategory(
  graph: PlanGraph,
  scope: string,
  from: string,
  to: string,
): PlanGraph {
  const s = normalizePlanPath(scope);
  const fromPath = normalizePlanPath(from);
  const toPath = normalizePlanPath(to);
  if (fromPath.length === 0 || toPath.length === 0 || fromPath === toPath) return graph;
  const fromKey = fromPath.toLowerCase();
  const rename = (catPath: string): string => {
    const p = normalizePlanPath(catPath);
    const lower = p.toLowerCase();
    if (lower === fromKey) return toPath;
    if (lower.startsWith(`${fromKey}\\`)) return `${toPath}${p.slice(fromPath.length)}`;
    return p;
  };
  const files = (graph?.files ?? []).map((f) =>
    scopeKey(f?.scope ?? '') === scopeKey(s) ? { ...f, category: rename(String(f?.category ?? '')) } : f,
  );
  const extra = (graph?.extra ?? []).map((e) =>
    scopeKey(e.scope) === scopeKey(s) ? { ...e, catPath: rename(e.catPath) } : e,
  );
  return { files, extra };
}

/**
 * 删掉一个分类：**只删分类、不删文件** —— 它下面的文件（含子分类里的）一律回到「未分类」，
 * 用户再把它们拖到别处。这是界面上唯一一步「看起来像删除」的动作，绝不能碰磁盘。
 */
export function removeCategory(graph: PlanGraph, scope: string, catPath: string): PlanGraph {
  const s = normalizePlanPath(scope);
  const target = normalizePlanPath(catPath);
  if (target.length === 0) return graph;
  const key = target.toLowerCase();
  const under = (category: string): boolean => {
    const p = normalizePlanPath(category).toLowerCase();
    return p === key || p.startsWith(`${key}\\`);
  };
  const files = (graph?.files ?? []).map((f) =>
    scopeKey(f?.scope ?? '') === scopeKey(s) && under(String(f?.category ?? ''))
      ? { ...f, category: PLAN_UNCATEGORIZED }
      : f,
  );
  const extra = (graph?.extra ?? []).filter(
    (e) => !(scopeKey(e.scope) === scopeKey(s) && under(e.catPath)),
  );
  return { files, extra };
}

/**
 * 把 `child` 挂到 `parent` 下面（关系链球里「分类拖到分类上」这个动作）。
 * parent 传空串 = 拽回顶层；自己挂自己、或把父挂到自己的子孙下面 → 原样返回（不让方案成环）。
 */
export function nestCategory(
  graph: PlanGraph,
  scope: string,
  child: string,
  parent: string,
): PlanGraph {
  const s = normalizePlanPath(scope);
  const childPath = normalizePlanPath(child);
  const parentPath = normalizePlanPath(parent);
  if (childPath.length === 0) return graph;
  const childKey = childPath.toLowerCase();
  const parentKey = parentPath.toLowerCase();
  if (childKey === parentKey) return graph;
  if (parentKey.startsWith(`${childKey}\\`)) return graph; // 不能把父挂到自己的子孙下
  const name = childPath.split('\\').pop() ?? childPath;
  const nextPath = parentPath.length === 0 ? name : `${parentPath}\\${name}`;
  if (nextPath.toLowerCase() === childKey) return graph;

  const rebase = (category: string): string => {
    const p = normalizePlanPath(category);
    const lower = p.toLowerCase();
    if (lower === childKey) return nextPath;
    if (lower.startsWith(`${childKey}\\`)) return `${nextPath}${p.slice(childPath.length)}`;
    return p;
  };
  const files = (graph?.files ?? []).map((f) =>
    scopeKey(f?.scope ?? '') === scopeKey(s) ? { ...f, category: rebase(String(f?.category ?? '')) } : f,
  );
  const extra = (graph?.extra ?? []).map((e) =>
    scopeKey(e.scope) === scopeKey(s) ? { ...e, catPath: rebase(e.catPath) } : e,
  );
  return { files, extra };
}

/** 一个 scope 下所有的分类（给「移到…」那种列表用）。 */
export function categoriesInScope(graph: PlanGraph, scope: string): PlanCategoryView[] {
  return categoriesOf(graph).filter((c) => scopeKey(c.scope) === scopeKey(scope));
}

/** 这一份方案的一句话摘要（界面上照抄，不另写一份）。 */
export function planSummaryText(graph: PlanGraph): string {
  const files = (graph?.files ?? []).length;
  if (files === 0) return '方案里还没有文件';
  const top = categoriesOf(graph)
    .filter((c) => c.depth === 1 && c.total > 0)
    .map((c) => c.full);
  const head = `${files} 个文件分 ${top.length} 组`;
  const tail = top.length > 0 ? `：${top.slice(0, 5).join('、')}${top.length > 5 ? ' 等' : ''}` : '';
  return `${head}${tail}`;
}
