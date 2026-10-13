/**
 * 纯逻辑：用户自定义分类规则（规则表 + 求值）。**不依赖 Electron**，可被 node 直接 require。
 *
 * 一条规则 = 是否启用 + 规则名（= 输出的分类文件夹名）+ 条件 + 位置（优先级）。
 * 求值顺序：从上往下，**第一条命中的生效**；一条都不命中 → 兜底分类（`FALLBACK_FOLDER`）。
 *
 * 条件有四种，可组合；同一条规则里：
 *   - 不同种类的条件之间是「并且」（后缀 且 关键词 且 大小 且 时间）；
 *   - 同一种条件里写了多个值时是「或者」（后缀是 txt 或 md → 命中）。
 *   - 某一种条件没写（空数组 / 不限）＝ 这一项不参与判断，视为命中。
 *
 * 后缀与关键词匹配都大小写不敏感；大小看字节数；时间看「修改时间」。
 * 文件夹名只有一个来源：本模块的兜底用 `classify.ts` 里的 `FOLDER_OTHERS`，
 * 后缀分组的默认规则表也由 `classify.ts` 的 `EXT_GROUPS` 生成，不存在第二份写死的名字。
 */
import { baseName, extensionOf, EXT_GROUPS, FOLDER_OTHERS } from './classify';

/** 兜底分类文件夹名（所有规则都不命中时进这里）。只有这一个来源，不许在别处再写一份。 */
export const FALLBACK_FOLDER: string = FOLDER_OTHERS;

/** 兜底分类在规则表里的占位规则名（不是真规则，只是为了让「预览」也列出来）。 */
export const FALLBACK_RULE_NAME = FALLBACK_FOLDER;

/** 大小分档的上下界单位换算：1 MB = 1024 * 1024 字节。 */
export const BYTES_PER_MB = 1024 * 1024;

/** 修改时间的三种分档。 */
export type ModTimeBucket = 'any' | 'this-year' | 'last-year' | 'earlier';

export const MOD_TIME_BUCKETS: readonly ModTimeBucket[] = ['any', 'this-year', 'last-year', 'earlier'];

/** 分档的中文说明（界面上显示用）。 */
export const MOD_TIME_LABELS: Readonly<Record<ModTimeBucket, string>> = {
  any: '不限',
  'this-year': '今年',
  'last-year': '去年',
  earlier: '更早',
};

/** 规则条件：四种可组合；没写的项不参与判断。 */
export interface RuleCondition {
  /** 后缀列表（小写、不含点；匹配大小写不敏感）。空数组 = 不限后缀。 */
  extensions?: readonly string[];
  /** 文件名关键词列表；文件名里含其中任意一个就命中（大小写不敏感）。空数组 = 不限。 */
  keywords?: readonly string[];
  /** 大小下界（字节，含）；不填 = 不限下界。 */
  minSize?: number | null;
  /** 大小上界（字节，不含）；不填 = 不限上界。 */
  maxSize?: number | null;
  /** 修改时间分档；不填或 'any' = 不限时间。 */
  modTime?: ModTimeBucket;
}

/** 一条分类规则。 */
export interface Rule {
  /** 稳定 id（界面上用来对上行） */
  id: string;
  /** 规则名 = 输出的分类文件夹名 */
  name: string;
  /** 是否启用；停用的规则直接跳过 */
  enabled: boolean;
  /** 条件（四种可组合） */
  condition: RuleCondition;
}

/** 规则表：有序，顺序就是优先级（第一条命中的生效）。 */
export type RuleTable = readonly Rule[];

/** 求值时用到的文件信息（大小与时间要真读文件属性；读不到就是 null）。 */
export interface FileInfo {
  /** 文件路径（只用于兜底命名） */
  path?: string;
  /** 文件名（含后缀）；不填就从 path 取 */
  name?: string;
  /** 小写后缀，不含点；不填就从名字取 */
  ext?: string;
  /** 字节数；取不到 = null（大小条件视为不命中） */
  size: number | null;
  /** 修改时间（毫秒）；取不到 = null（时间条件视为不命中） */
  mtimeMs: number | null;
}

/** 规则求值的结果。 */
export interface RuleMatch {
  /** 命中的规则；一条都没命中时为 null（此时 folder = 兜底分类） */
  rule: Rule | null;
  /** 目标分类文件夹名（兜底时为 FALLBACK_FOLDER） */
  folder: string;
  /** 命中的规则在规则表里的下标；没命中 = -1 */
  index: number;
  /** 是否走的是兜底分类 */
  fallback: boolean;
}

/* ------------------------------------------------------------------ *
 * 默认规则表（由现有后缀分组生成，行为与第 01/03 片完全一致）
 * ------------------------------------------------------------------ */

let defaultRuleSeq = 0;

/**
 * 把现有后缀分组（`EXT_GROUPS`）生成默认规则表：一组后缀一条规则，规则名 = 分类文件夹名。
 * 因为名字与后缀都取自 `classify.ts` 的同一份常量，默认规则表跑出来的结果与原来的后缀分类**必然**一致。
 */
export function createDefaultRules(): Rule[] {
  const rules: Rule[] = [];
  const used = new Set<string>();
  for (const group of EXT_GROUPS) {
    if (used.has(group.folder)) continue;
    used.add(group.folder);
    rules.push({
      id: `default-${++defaultRuleSeq}`,
      name: group.folder,
      enabled: true,
      condition: { extensions: group.extensions.map((e) => e.toLowerCase()) },
    });
  }
  if (!used.has(FALLBACK_FOLDER)) {
    rules.push({
      id: `default-${++defaultRuleSeq}`,
      name: FALLBACK_RULE_NAME,
      enabled: true,
      condition: { extensions: [] },
    });
  }
  return rules;
}

/** 每次调用给一份新的默认规则副本（用户改了规则不许污染默认表）。 */
export function defaultRules(): Rule[] {
  return createDefaultRules();
}

/** 规则库里可用的后缀全集（界面上给人参考用）。 */
export function knownExtensions(): string[] {
  const out = new Set<string>();
  for (const group of EXT_GROUPS) for (const e of group.extensions) out.add(e.toLowerCase());
  return Array.from(out);
}

/* ------------------------------------------------------------------ *
 * 求值
 * ------------------------------------------------------------------ */

function toExtensionList(list: readonly string[] | undefined | null): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const e = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\.+/, '');
    if (e.length > 0) out.push(e);
  }
  return out;
}

/** 文件名（含后缀）。没给名字就从路径取最后一段。 */
function nameOf(info: FileInfo): string {
  if (typeof info.name === 'string' && info.name.length > 0) return info.name;
  return info.path ? baseName(info.path) : '';
}

function extOf(info: FileInfo): string {
  if (typeof info.ext === 'string') return info.ext.toLowerCase();
  const name = nameOf(info);
  return name ? extensionOf(name) : '';
}

function matchesExtensions(info: FileInfo, rule: Rule): boolean {
  const list = toExtensionList(rule.condition?.extensions);
  if (list.length === 0) return true;
  return list.includes(extOf(info));
}

function matchesKeywords(info: FileInfo, rule: Rule): boolean {
  const list = (rule.condition?.keywords ?? [])
    .map((k) => String(k ?? '').trim().toLowerCase())
    .filter((k) => k.length > 0);
  if (list.length === 0) return true;
  const name = nameOf(info).toLowerCase();
  return list.some((k) => name.includes(k));
}

function matchesSize(info: FileInfo, rule: Rule): boolean {
  const min = normalizeBound(rule.condition?.minSize);
  const max = normalizeBound(rule.condition?.maxSize);
  if (min === null && max === null) return true;
  const size = typeof info.size === 'number' && Number.isFinite(info.size) ? info.size : null;
  if (size === null) return false; // 读不到大小 → 这一项不算命中
  if (min !== null && size < min) return false;
  if (max !== null && size >= max) return false; // 上界不含
  return true;
}

function normalizeBound(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 修改时间分档：今年 / 去年 / 更早（按本机时区的日历年算）。 */
function matchesModTime(info: FileInfo, rule: Rule): boolean {
  const bucket: ModTimeBucket = rule.condition?.modTime ?? 'any';
  if (bucket === 'any') return true;
  const ms = typeof info.mtimeMs === 'number' && Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
  if (ms === null) return false; // 读不到时间 → 这一项不算命中
  return bucketOf(ms, Date.now()) === bucket;
}

/** 给定时间戳落在哪个档（暴露出来便于测试与界面提示）。 */
export function bucketOf(mtimeMs: number, nowMs: number): ModTimeBucket {
  const year = new Date(mtimeMs).getFullYear();
  const nowYear = new Date(nowMs).getFullYear();
  if (year === nowYear) return 'this-year';
  if (year === nowYear - 1) return 'last-year';
  return 'earlier';
}

/** 单条规则是否命中（四种条件之间是「并且」）。 */
export function matchesRule(rule: Rule, info: FileInfo): boolean {
  if (!rule || rule.enabled === false) return false;
  return (
    matchesExtensions(info, rule) &&
    matchesKeywords(info, rule) &&
    matchesSize(info, rule) &&
    matchesModTime(info, rule)
  );
}

/** 按规则表求值：第一条命中的生效；都不命中 → 兜底分类。 */
export function matchRule(table: RuleTable | null | undefined, info: FileInfo): RuleMatch {
  const rules = table ?? [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (matchesRule(rule, info)) {
      return { rule, folder: rule.name, index: i, fallback: false };
    }
  }
  return { rule: null, folder: FALLBACK_FOLDER, index: -1, fallback: true };
}

/**
 * 便利入口：按规则表算一个文件该进哪个分类文件夹。
 * （真正的元信息读取在调用方做完后把 FileInfo 传进来，本模块只做纯计算。）
 */
export function evaluateFile(table: RuleTable | null | undefined, info: FileInfo): string {
  return matchRule(table, info).folder;
}

/** 规则表里会出现哪些分类文件夹（按规则顺序 + 兜底分类；停用的规则名也留着，便于界面显示）。 */
export function folderNamesOf(table: RuleTable | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rule of table ?? []) {
    const name = String(rule?.name ?? '').trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (!seen.has(FALLBACK_FOLDER)) out.push(FALLBACK_FOLDER);
  return out;
}

/** 预览/执行真正用得到的文件夹（停用的规则不算）。 */
export function activeFolderNamesOf(table: RuleTable | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rule of table ?? []) {
    if (!rule || rule.enabled === false) continue;
    const name = String(rule.name ?? '').trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (!seen.has(FALLBACK_FOLDER)) out.push(FALLBACK_FOLDER);
  return out;
}
