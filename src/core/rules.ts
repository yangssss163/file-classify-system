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
  /**
   * 目标分类文件夹（相对**这一层**的路径；兜底时为 FALLBACK_FOLDER）。
   * 规则名里写 `照片\风光` 就是 `照片\风光`（多级：逐层建目录），只写 `01_图片` 就是一层。
   */
  folder: string;
  /** 命中的规则在规则表里的下标；没命中 = -1 */
  index: number;
  /** 是否走的是兜底分类 */
  fallback: boolean;
  /** 归一化之后的各层文件夹名（单层规则就是一项；兜底时是 [FALLBACK_FOLDER]） */
  segments: string[];
  /**
   * 规则名因为危险而**被拒绝**时的那句人话原因（安全时是空串）。
   * 被拒绝的文件一律落到兜底分类，绝不许写到源文件夹树外面去。
   */
  invalidReason: string;
}

/* ------------------------------------------------------------------ *
 * 分类名的归一化（本片新增：分类名允许是「相对这一层的多级路径」）
 * ------------------------------------------------------------------ *
 * 用户写 `照片\风光` 就是「这一层下面先建 照片、再建 风光」；只写 `01_图片` 与现在**完全一致**（一层）。
 * `\` 与 `/` 都算分隔符（Windows 语义，两者等价）。
 *
 * 安全底线：分类名**只许是相对这一层的多级目录**，绝不许把文件写到源文件夹树外面去。
 * 所以下面这些一律**拒绝**（不是偷偷改一改），并且给人一句人话原因：
 *   · 绝对路径（`C:\x`、`\\server\share`）、驱动器相对写法（`C:x`）、UNC 前缀（`\\?\`）；
 *   · `..` 向上跳出（任何一层都不许）；
 *   · 空层名（`照片\\风光`、`照片\` 结尾的写法由下面的归一化当一层处理，不算空层）；
 *   · Windows 非法字符 `< > : " | ? *`；
 *   · 结尾空格 / 结尾点（Windows 建不出这种目录，建出来的名字也会跟写的不是一回事）；
 *   · 保留设备名（`CON`、`NUL`、`COM1`、`LPT9`…，含 `CON.txt` 这种带后缀的写法）。
 * 拒绝之后由调用方**回落兜底分类**，所以「写了个危险名字」不会静默变样，而是明确落到「05_其他」并能看到原因。
 */

/** 解析结果：`segments` 为空 = 拒绝，`reason` 给一句人话。 */
export interface RulePathParse {
  /** 归一化之后的各层文件夹名（不含分隔符） */
  segments: string[];
  /** 用 `\` 拼回去的那种写法（界面显示用，一眼看出实际会建几层） */
  cleanName: string;
  /** 被拒绝时的人话原因；通过时是空串 */
  reason: string;
}

/** 危险/不可用的分类名 → 一句人话（只有这一处写原因，不许在别处再写一份）。 */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function parseRulePath(text: string): RulePathParse {
  // 注意：这里**不 trim**。理由：分类名开头/结尾的空格与结尾的点会让「写出来的名字」与
  // 「Windows 真正建出来的目录名」不是一回事（尾部空格/点会被系统吃掉），属于必须拦住的情形。
  // 想让中间的空格留着就留着（`我的 照片` 是合法目录名），只把「头尾」这些不安全的挡下来。
  const raw = String(text ?? '');
  if (raw.trim().length === 0) {
    return { segments: [], cleanName: '', reason: '这条规则的分类名是空的（写个名字，或用「照片\\风光」这种多级写法）' };
  }
  if (/^\s/.test(raw) || /\s$/.test(raw)) {
    return {
      segments: [],
      cleanName: '',
      reason: `分类名「${raw}」的开头或结尾有空格：Windows 会把这种文件夹名的头尾空格吃掉，写出来的名字与实际建出来的不是一回事，所以拒绝这条规则（这个文件按兜底分类「${FOLDER_OTHERS}」走）`,
    };
  }

  // `\` 与 `/` 都算分隔符：统一按两者切，逐层判。
  // 开头的分隔符（`\照片`）与结尾的分隔符（`照片\`）不算「空的一层」——`照片\` 与 `照片` 等价；
  // 中间的空层（`照片\\风光`）才是问题：那一层没有名字，说明写法有误，一律拒绝。
  const parts = raw.split(/[\\/]+/);
  while (parts.length > 0 && parts[0].length === 0) parts.shift();
  while (parts.length > 0 && parts[parts.length - 1].length === 0) parts.pop();
  const segments: string[] = [];
  for (const part of parts) {
    const seg = String(part ?? '').trim();
    if (seg.length === 0) {
      return { segments: [], cleanName: '', reason: `分类名「${raw}」里有空的一层（多层写法是「照片\\风光」，别写「照片\\\\风光」）` };
    }
    if (seg === '.' || /^\.+$/.test(seg)) {
      return { segments: [], cleanName: '', reason: `分类名「${raw}」里有「${seg}」这一层，它指的不是一个真的文件夹名` };
    }
    if (seg === '..') {
      return {
        segments: [],
        cleanName: '',
        reason: `分类名「${raw}」里有「..」想往上跳出这一层：这样可能把文件写到源文件夹树外面去，所以拒绝这条规则（这个文件按兜底分类「${FOLDER_OTHERS}」走）`,
      };
    }
    if (seg.endsWith(' ') || seg.endsWith('.')) {
      return {
        segments: [],
        cleanName: '',
        reason: `分类名「${raw}」里的「${seg}」以空格或点结尾：Windows 建不出这种文件夹名，所以拒绝这条规则（这个文件按兜底分类「${FOLDER_OTHERS}」走）`,
      };
    }
    const bad = seg.match(/[<>:"|?*]/);
    if (bad) {
      return {
        segments: [],
        cleanName: '',
        reason: `分类名「${raw}」里的「${seg}」含 Windows 不允许的字符「${bad[0]}」，所以拒绝这条规则（这个文件按兜底分类「${FOLDER_OTHERS}」走）`,
      };
    }
    if (RESERVED_DEVICE_NAME.test(seg)) {
      return {
        segments: [],
        cleanName: '',
        reason: `分类名「${raw}」里的「${seg}」是 Windows 保留的设备名，不能当文件夹名，所以拒绝这条规则（这个文件按兜底分类「${FOLDER_OTHERS}」走）`,
      };
    }
    segments.push(seg);
  }

  // 绝对路径 / 驱动器号 / UNC：即使逐层都安全，只要开头是这些写法也一律拒绝
  // （`C:\x` 的第一层是 `C:`，已被非法字符拦下；这里再兜一道，把 `C:x`、`\\server\share` 这类也拦掉）。
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return {
      segments: [],
      cleanName: '',
      reason: `分类名「${raw}」看起来是绝对路径或 UNC 路径：分类名只能是「相对这一层的多级目录」，所以拒绝这条规则（这个文件按兜底分类「${FOLDER_OTHERS}」走）`,
    };
  }
  const first = segments[0] ?? '';
  if (/^[A-Za-z]:/.test(first) || /^[A-Za-z]:/.test(raw)) {
    return {
      segments: [],
      cleanName: '',
      reason: `分类名「${raw}」以驱动器号开头（看起来是绝对路径）：分类名只能是「相对这一层的多级目录」，所以拒绝这条规则（这个文件按兜底分类「${FOLDER_OTHERS}」走）`,
    };
  }

  return { segments, cleanName: segments.join('\\'), reason: '' };
}

/**
 * 归一化一个分类名（纯函数，不碰磁盘）。
 * @returns `ok:true` 时 `segments` 是各层文件夹名、`path` 是用 `\` 拼好的相对路径；
 *          `ok:false` 时 `path` 与 `segments` 都是空的，`reason` 说清为什么拒绝。
 */
export function normalizeCategoryPath(text: string): { ok: boolean; path: string; segments: string[]; reason: string } {
  const parsed = parseRulePath(text);
  if (parsed.segments.length === 0) return { ok: false, path: '', segments: [], reason: parsed.reason };
  return { ok: true, path: parsed.cleanName, segments: parsed.segments.slice(), reason: '' };
}

/** 归一化之后的分类名（用 `\` 拼；不含分隔符时原样返回）。危险的规则名返回空串。 */
export function categoryFolderNameOf(text: string): string {
  const parsed = parseRulePath(text);
  return parsed.segments.length === 0 ? '' : parsed.cleanName;
}

/** 分类名被拒绝时的人话原因（安全时是空串）。 */
export function categoryInvalidReasonOf(text: string): string {
  return parseRulePath(text).reason;
}

/** 求值实际用的那一份：规则名 → 归一化后的分类路径 + 拒绝原因。 */
function resolveRuleFolder(rule: Rule | null | undefined): { folder: string; segments: string[]; invalidReason: string } {
  const parsed = parseRulePath(String(rule?.name ?? ''));
  if (parsed.segments.length === 0) {
    return { folder: FALLBACK_FOLDER, segments: [FALLBACK_FOLDER], invalidReason: parsed.reason };
  }
  return { folder: parsed.cleanName, segments: parsed.segments.slice(), invalidReason: '' };
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
      const resolved = resolveRuleFolder(rule);
      return {
        rule,
        folder: resolved.folder,
        index: i,
        fallback: false,
        segments: resolved.segments,
        invalidReason: resolved.invalidReason,
      };
    }
  }
  return {
    rule: null,
    folder: FALLBACK_FOLDER,
    index: -1,
    fallback: true,
    segments: [FALLBACK_FOLDER],
    invalidReason: '',
  };
}

/**
 * 便利入口：按规则表算一个文件该进哪个分类文件夹。
 * （真正的元信息读取在调用方做完后把 FileInfo 传进来，本模块只做纯计算。）
 */
export function evaluateFile(table: RuleTable | null | undefined, info: FileInfo): string {
  return matchRule(table, info).folder;
}

/**
 * 规则表里会出现哪些分类文件夹（按规则顺序 + 兜底分类；停用的规则名也留着，便于界面显示）。
 * 名字一律**归一化之后**再列：`照片/风光` 与 `照片\风光` 是同一个目标，只列一次；
 * 危险的规则名（绝对路径、`..`、非法字符…）列不出来 —— 它的文件会落到兜底分类，`matchRule` 会给人话原因。
 */
export function folderNamesOf(table: RuleTable | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rule of table ?? []) {
    const name = categoryFolderNameOf(String(rule?.name ?? ''));
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (!seen.has(FALLBACK_FOLDER)) out.push(FALLBACK_FOLDER);
  return out;
}

/** 预览/执行真正用得到的文件夹（停用的规则不算）。名字同样归一化之后再列。 */
export function activeFolderNamesOf(table: RuleTable | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rule of table ?? []) {
    if (!rule || rule.enabled === false) continue;
    const name = categoryFolderNameOf(String(rule.name ?? ''));
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (!seen.has(FALLBACK_FOLDER)) out.push(FALLBACK_FOLDER);
  return out;
}

/** 一条规则归一化之后的实际目标（界面显示用：一眼看出 `照片\风光` 会建两层）。 */
export function ruleTargetOf(rule: Rule | null | undefined): { path: string; segments: string[]; reason: string } {
  const resolved = resolveRuleFolder(rule);
  return { path: resolved.folder, segments: resolved.segments.slice(), reason: resolved.invalidReason };
}
