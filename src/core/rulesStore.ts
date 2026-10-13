/**
 * 纯逻辑：用户规则的读写（JSON 文件）。**不依赖 Electron**——文件路径由调用方给，
 * 主进程用的就是 Electron 的 `app.getPath('userData')` 下的一个文件。
 *
 * 铁律：
 *  - 只写这一个规则文件，不往项目文件夹、输出文件夹里写任何东西；
 *  - 读不到 / 文件坏了 / 内容不合法 → 回落默认规则并给一句人话，**绝不抛出去、绝不崩**。
 */
import * as fs from 'fs';
import * as path from 'path';
import { defaultRules, type Rule, type RuleTable } from './rules';

/** 规则文件的固定文件名（放在 userData 目录下）。 */
export const RULES_FILE_NAME = 'organizer-rules.json';

/** 规则文件里记录的格式版本，便于以后改动时不误读。 */
export const RULES_SCHEMA_VERSION = 1;

/** 保存/加载的结果：`ok=false` 时 `rules` 一定是可用的默认规则。 */
export interface RulesLoadResult {
  ok: boolean;
  /** 可用的规则表（读不到就是默认规则） */
  rules: Rule[];
  /** 数据来源：'file' 读到了文件；'default' 回落到默认规则 */
  source: 'file' | 'default';
  /** 给人看的一句话（成功也是人话，如「已读取 N 条规则」） */
  message: string;
  /** 规则文件路径 */
  filePath: string;
}

export interface RulesSaveResult {
  ok: boolean;
  message: string;
  filePath: string;
}

/** 规则列表去掉不可读字符，避免写出坏 JSON / 坏文件名。 */
function cleanText(v: unknown): string {
  return String(v ?? '').replace(/[\r\n\t]/g, ' ').trim();
}

/** 一条规则是不是可用（有 id、有名字）。 */
function isValidRule(r: unknown): r is Rule {
  const rule = r as Rule | null;
  return !!rule && typeof rule === 'object' && typeof rule.id === 'string' && typeof rule.name === 'string';
}

/**
 * 把外部来的规则收拾成规矩的形状（补齐 id / enabled / condition，丢掉不认识的字段）。
 * 返回空数组表示「这份内容不可用」。
 */
export function normalizeRules(input: unknown): Rule[] {
  if (!Array.isArray(input)) return [];
  const out: Rule[] = [];
  let seq = 0;
  for (const raw of input) {
    if (!isValidRule(raw)) continue;
    const name = cleanText(raw.name);
    const id = cleanText(raw.id);
    if (name.length === 0 || id.length === 0) continue;
    const condition = (raw.condition ?? {}) as Rule['condition'];
    out.push({
      id: id || `rule-${++seq}`,
      name,
      enabled: raw.enabled !== false,
      condition: {
        extensions: Array.isArray(condition.extensions) ? condition.extensions.map(cleanText).filter((e) => e.length > 0) : [],
        keywords: Array.isArray(condition.keywords) ? condition.keywords.map(cleanText).filter((k) => k.length > 0) : [],
        minSize: typeof condition.minSize === 'number' && Number.isFinite(condition.minSize) ? condition.minSize : null,
        maxSize: typeof condition.maxSize === 'number' && Number.isFinite(condition.maxSize) ? condition.maxSize : null,
        modTime: condition.modTime ?? 'any',
      },
    });
  }
  return out;
}

/** 规则表序列化成要落盘的 JSON 文本（含格式版本）。 */
export function serializeRules(rules: RuleTable): string {
  const payload = {
    schema: RULES_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    rules: Array.from(rules ?? []),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** 解析规则文件的内容。`ok=false` 表示这份内容根本读不出规则表（坏 JSON / 结构不对）。 */
export function parseRules(text: string): { ok: boolean; rules: Rule[] } {
  try {
    const data = JSON.parse(text) as { rules?: unknown };
    if (data === null || typeof data !== 'object' || !Array.isArray((data as { rules?: unknown }).rules)) {
      return { ok: false, rules: [] };
    }
    return { ok: true, rules: normalizeRules((data as { rules?: unknown }).rules) };
  } catch {
    return { ok: false, rules: [] };
  }
}

/**
 * 从文件读规则。**任何异常都变成「回落到默认规则 + 一句人话」**，绝不抛出去。
 * 注意：一份「合法但一条规则都没有」的规则文件不算坏——那时所有文件都进兜底分类，
 * 不许拿默认规则把用户的意图盖掉。只有读不出（不存在 / 坏 JSON / 结构不对）才回落默认规则。
 */
export function loadRulesFromFile(filePath: string): RulesLoadResult {
  const target = String(filePath ?? '');
  try {
    if (!target || !fs.existsSync(target)) {
      const rules = defaultRules();
      return {
        ok: true,
        rules,
        source: 'default',
        message: `还没有保存过规则，先用默认规则（按后缀分 ${rules.length} 类）`,
        filePath: target,
      };
    }
    const text = fs.readFileSync(target, 'utf8');
    const parsed = parseRules(text);
    if (!parsed.ok) {
      const rules = defaultRules();
      return {
        ok: false,
        rules,
        source: 'default',
        message: '规则文件读不出来（内容坏了），已改用默认规则',
        filePath: target,
      };
    }
    return {
      ok: true,
      rules: parsed.rules,
      source: 'file',
      message:
        parsed.rules.length > 0
          ? `已读取上次保存的 ${parsed.rules.length} 条规则`
          : '上次保存的规则是空的（文件里一条也没有），所有文件都会进兜底分类',
      filePath: target,
    };
  } catch (err) {
    const rules = defaultRules();
    return {
      ok: false,
      rules,
      source: 'default',
      message: `读规则失败（${(err as Error)?.message ?? '未知错误'}），已改用默认规则`,
      filePath: target,
    };
  }
}

/** 把规则写到文件（目录不存在就建）。失败给人话，不抛出去。 */
export function saveRulesToFile(filePath: string, rules: RuleTable): RulesSaveResult {
  const target = String(filePath ?? '');
  try {
    if (!target) {
      return { ok: false, message: '规则文件路径为空，没能保存', filePath: target };
    }
    const list = normalizeRules(rules);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serializeRules(list), 'utf8');
    return { ok: true, message: `已保存 ${list.length} 条规则到 ${target}`, filePath: target };
  } catch (err) {
    return { ok: false, message: `保存规则失败（${(err as Error)?.message ?? '未知错误'}）`, filePath: target };
  }
}
