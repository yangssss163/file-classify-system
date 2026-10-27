/**
 * 纯逻辑：**历史单号**（每次分拣一张单，按时间倒序列出来）。不依赖 Electron。
 *
 * 为什么单独存一份、而不是从「上一次整理的记录」推：
 *  - 那份记录只有**最后一次**（撤销用），而用户要的是「历史上都做过哪些单」；
 *  - 这份只管流水：单号、时间、分法、几个文件、成功几个、输出到哪儿。
 *    撤销 / 删源这些「会改状态」的事仍然以 `organizer-last-run.json` 为准，这里只读不写文件。
 *
 * 红线：只追加、不删旧单（最多留 `HISTORY_LIMIT` 条，超了丢最老的）；读坏了就当空表，
 * 绝不让「历史读不出来」把整个界面拖死。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 历史文件的固定文件名（放在 userData 下，和整理记录同一个目录）。 */
export const HISTORY_FILE_NAME = 'organizer-history.json';

/** 最多留多少张单（再多就把最老的丢掉：这是流水，不是档案库）。 */
export const HISTORY_LIMIT = 200;

/** 一次分拣是什么分法。 */
export type HistoryMode = 'ai' | 'rules';

/** 历史里的一张单。 */
export interface HistoryEntry {
  /** 单号（`261027-1712-4F2A` 这种：日期-时分-序号） */
  id: string;
  /** 开始时间（ISO 字符串） */
  at: string;
  /** 这次用的分法 */
  mode: HistoryMode;
  /** 交进去几个文件 */
  fileCount: number;
  /** 成功几个 */
  successCount: number;
  /** 失败几个 */
  failureCount: number;
  /** 输出到哪儿 */
  outputDir: string;
}

/** 造一个单号：日期 + 时分 + 4 位序号（同一分钟里连做两单也不会撞）。 */
export function makeTicketId(at: Date, seq = 0): string {
  const d = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${two(d.getFullYear() % 100)}${two(d.getMonth() + 1)}${two(d.getDate())}`;
  const clock = `${two(d.getHours())}${two(d.getMinutes())}`;
  const tail = (Math.abs(Math.floor(d.getSeconds() * 100 + d.getMilliseconds() / 10)) % 10000)
    .toString(16)
    .toUpperCase()
    .padStart(4, '0')
    .slice(-4);
  return `${stamp}-${clock}-${seq > 0 ? String(seq).padStart(2, '0').slice(-2) : tail}`;
}

/** 把读到的任意东西归一成一张单；不像就返回 null。 */
export function normalizeHistoryEntry(input: unknown): HistoryEntry | null {
  const raw = (input ?? {}) as Partial<HistoryEntry>;
  const id = String(raw.id ?? '').trim();
  if (id.length === 0) return null;
  const mode: HistoryMode = raw.mode === 'ai' ? 'ai' : 'rules';
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    id,
    at: String(raw.at ?? ''),
    mode,
    fileCount: num(raw.fileCount),
    successCount: num(raw.successCount),
    failureCount: num(raw.failureCount),
    outputDir: String(raw.outputDir ?? ''),
  };
}

/** 读历史（读不到 / 读坏了都是空表，绝不抛）。 */
export function readHistory(filePath: string): HistoryEntry[] {
  const target = String(filePath ?? '').trim();
  if (target.length === 0) return [];
  try {
    const text = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown })?.entries;
    if (!Array.isArray(list)) return [];
    const out: HistoryEntry[] = [];
    for (const item of list) {
      const entry = normalizeHistoryEntry(item);
      if (entry) out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

/** 历史文件里存的形状（带一个版本号，方便以后迁移）。 */
interface HistoryFile {
  schema: 1;
  entries: HistoryEntry[];
}

function serialize(entries: readonly HistoryEntry[]): string {
  const file: HistoryFile = { schema: 1, entries: entries.slice() };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** 追加一张单（新的在前），超过上限丢最老的。写不进去也不抛。 */
export function appendHistory(
  filePath: string,
  entry: HistoryEntry,
): { ok: boolean; message: string; entries: HistoryEntry[] } {
  const target = String(filePath ?? '').trim();
  const normalized = normalizeHistoryEntry(entry);
  if (!normalized) return { ok: false, message: '这张单不完整，没有记进历史', entries: [] };
  const existing = target.length > 0 ? readHistory(target) : [];
  const next = [normalized, ...existing].slice(0, HISTORY_LIMIT);
  if (target.length === 0) return { ok: false, message: '没有历史文件的位置，没有记进历史', entries: next };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serialize(next), 'utf8');
    return { ok: true, message: `已记进历史：${normalized.id}`, entries: next };
  } catch (err) {
    return {
      ok: false,
      message: `历史没写进去：${(err as Error)?.message ?? '未知错误'}`,
      entries: next,
    };
  }
}

/** 给界面用的一句话（「AI 分法 · 8 个文件 · 成功 8」这种）。 */
export function historyLine(entry: HistoryEntry): string {
  const mode = entry.mode === 'ai' ? 'AI 分法' : '规则分法';
  const tail = entry.failureCount > 0 ? ` · 失败 ${entry.failureCount}` : '';
  return `${mode} · ${entry.fileCount} 个文件 · 成功 ${entry.successCount}${tail}`;
}
