/**
 * 纯逻辑：**「换一种分法」的 AI 分类器（真实现）**。**不依赖 Electron**。
 *
 * ============================================================================================
 * 两条用户拍板的前提（不许改）
 * ============================================================================================
 * 1. **接口**：默认值按 DeepSeek 填好 —— 接口地址 `https://api.deepseek.com`（走 OpenAI 兼容的
 *    chat completions 形状）、默认模型名 `deepseek-chat`。**只是默认值，不是写死**：
 *    用户在设置里可以改成别的地址（任何 OpenAI 兼容的服务都行）。默认值在 `aiAppFiles.ts` 里。
 * 2. **AI 能看到什么**：只发**文件名（含后缀）、大小（字节）、修改时间（ISO）**这三样。
 *    **绝对不读文件内容、绝不把文件内容发出去**；也**不发文件所在目录路径**（免得泄露目录结构）。
 *    这条在界面上写明（那句提醒的唯一来源是 `aiAppFiles.ts` 的 `AI_METADATA_ONLY_WARNING`），
 *    也在 `buildOpenAiRequestBody()` 里只用这三个字段钉死。
 *
 * ============================================================================================
 * 这一片做了什么
 * ============================================================================================
 *   · 真发请求：`classifyByAi()` 按批（每批 ≤ `AI_MAX_FILES_PER_BATCH` 个文件）调 OpenAI 兼容的
 *     `POST <接口地址>/v1/chat/completions`，要求模型**只输出 JSON**（`{ "分类名": ["文件名1", ...] }`）；
 *   · 分批 + 进度回调（`onProgress`）、超时（`AI_TIMEOUT_MS`）、最多 `AI_MAX_RETRIES` 次重试
 *     （**只对超时 / 429 / 5xx 重试**；401/400 这类别的错一次就停，并说清是人话）；
 *   · 失败一律**明确失败**：解析不了 / 形状不对 / 超时 / 401 / 连不上 → `ok:false` + 原因码 + 人话，
 *     一个文件都不复制、不删任何东西 —— 本模块从头到尾**只读**：不建目录、不写文件、不删东西；
 *   · 「AI 建议 → 规则」只做**数据结构**转换（`aiAssignmentsToRules()`）：把建议变成既有规则表里的
 *     规则（条件是「文件名在建议清单里」），于是后面能直接走**既有的**预览 / 计划 / 复制 / 撤销那条
 *     管线落盘 —— **本文件绝不自建第二套复制或计划逻辑**。
 *
 * ============================================================================================
 * 【将来接大模型（本片已经接上，形状仍是这份契约）】文件 → 分类名 的接口形状
 * ============================================================================================
 * 输入（`AiClassifyInput`）：要分类的文件列表与元信息（`path` / `name` / `ext`）+ 当前规则表
 *   （把「规则名」当成候选分类名给模型参考，**不是约束**，模型可以给新名字）+ 输出根（只作上下文，
 *   实现**不许**往那儿写东西）+ 这次用的接口设置（由调用方（主进程）读好传进来；没有 = 没配置）。
 * 输出（`AiClassifyResult`）：`ok:true` 时给 `assignments: { source, category, confidence?, reason? }[]`
 *   —— `category` 就是输出里的分类文件夹名，后面**喂给既有的复制/预览逻辑**；
 *   模型没提到的文件进 `unclassified`，由调用方回落规则分类。`ok:false` 时给机器可判的 `reason` 码 + 人话。
 *
 * 分工（别破坏）：
 *   · 本文件：地址拼接、请求体、解析、对上原文件、「建议 → 规则」、分批与重试；
 *   · `aiAppFiles.ts`：用户设置（接口地址 / 模型名 / 密钥）放在哪儿、怎么读写；
 *   · `aiTransport.ts`：真正把请求发出去的那一层（**唯一连网的地方**），把网络细节与本文件隔开；
 *   · `aiRuntime.ts`：少数「跑起来才知道」的事（只读 stat 拿大小/修改时间），本文件不直接碰 node 内建；
 *   · 主进程：只开几个门（读设置 / 存设置 / 测试连接 / 查状态 / 调一次分类）。
 *
 * 注意（别破坏）：本文件编译出来的产物**必须能当普通脚本直接跑** —— 里面不许 import 任何
 * node 内建模块（所以连 `require` 都不会出现）；需要 node 能力的地方一概由上面那两层给。
 * 这也是「配置/密钥只出现在这一份文件的注释与类型里」的由来：取文件原文、连网、读元信息
 * 全在别处，这个文件的代码体里既没有网络标识、也没有取密钥的写法。
 */
import type { Rule } from './rules';

/* ------------------------------------------------------------------ *
 * 批量 / 超时 / 重试
 * ------------------------------------------------------------------ */

/** 一次请求最多带多少个文件（文件多就分批发，避免一个请求撑爆）。 */
export const AI_MAX_FILES_PER_BATCH = 50;

/** 单次请求的超时（毫秒）。 */
export const AI_TIMEOUT_MS = 60_000;

/** 最多重试几次（**只对超时 / 429 / 5xx**；总次数 = 首次 + 重试次数）。 */
export const AI_MAX_RETRIES = 2;

/** 重试之间的等待（毫秒）；第 n 次重试等 `AI_RETRY_DELAY_MS * n`。 */
export const AI_RETRY_DELAY_MS = 500;

/** 测试连接那条请求不要等太久（给人感觉快一点）。 */
export const AI_TEST_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------ *
 * 输入 / 输出形状
 * ------------------------------------------------------------------ */

/** 机器可判的「为什么没给出 AI 分类」的原因码。 */
export type AiReason =
  /** 还没配置（缺接口地址 / 模型名 / 密钥） */
  | 'not-configured'
  /** 配置在、但调用失败（连不上 / 超时 / 报错 / 模型返回看不懂的东西） */
  | 'request-failed'
  /** 配置在、但模型没给出可用结果 */
  | 'empty-result';

/** 送进 AI 分类的一个文件（列表 + 元信息）。 */
export interface AiClassifyInputFile {
  /** 完整路径（**只用来对回原文件，绝不发给模型**） */
  path: string;
  /** 文件名（含后缀）—— 会发给模型 */
  name: string;
  /** 后缀（小写、不含点；没有后缀就是空串）—— 会发给模型 */
  ext: string;
}

/** 分批进度（文件多的时候界面要看得到走到哪儿了） */
export type AiProgressHandler = (done: number, total: number) => void;

/** 这次调用要用的接口设置（由调用方读好传进来；不给 = 没配置）。 */
export interface AiConfig {
  /** 接口地址（如 `https://api.deepseek.com`；默认值在 `aiAppFiles.ts` 里，用户可改） */
  endpoint: string;
  /** 模型名（如 `deepseek-chat`） */
  model: string;
  /** 密钥（只用来拼认证头，别处不许写出去；明文存在本机配置文件里，不进代码仓库） */
  authToken: string;
}

/** 一次请求的结果（纯数据，方便直接断言「发出去的到底是什么」）。 */
export interface AiWireOutcome {
  /** 拿到响应了没有（超时 / 连不上都是 false） */
  ok: boolean;
  /** 响应状态码（没响应时为 0） */
  status: number;
  /** 响应体文本（没响应时为 ''） */
  body: string;
  /** 失败时的人话原因（成功时为 null） */
  error: string | null;
  /** 这个错值不值得重试（超时 / 429 / 5xx） */
  retryable: boolean;
  /** 实际发出去的请求（**验收用它断言请求形状**） */
  sentRequest: {
    url: string;
    headers: Record<string, string>;
    body: string;
  } | null;
}

/** 真正把请求发出去的那一层（`aiTransport.ts` 载入时装上；本文件只认这个形状）。 */
export interface AiWireGate {
  /**
   * 发一次请求，把响应原样带回来。
   * @param input.path 相对接口地址的路径（如 `/v1/chat/completions`）
   */
  call(input: {
    endpoint: string;
    authToken: string;
    path: string;
    body: string;
    timeoutMs: number;
  }): Promise<AiWireOutcome>;
}

/** 传输层的门：只在这里放一次，别处不许再挂。 */
let wireGate: AiWireGate | null = null;

/** 装上传送门（**只由 `aiTransport.ts` 调一次**）。 */
export function installAiWire(gate: AiWireGate): void {
  wireGate = gate;
}

/** 「跑起来才知道」的那几件事（由 `aiRuntime.ts` 接上）：只读元信息，**绝不读文件内容**。 */
export interface AiRuntimeHooks {
  /** 读每个文件的大小与修改时间（按同一个下标一一对应）；读不到就留 0 / 空串 */
  readFileMetadata(files: readonly AiClassifyInputFile[]): AiFileMetadata[];
}

let runtimeHooks: AiRuntimeHooks | null = null;

/** 接上运行时那一层（**只由 `aiRuntime.ts` 调**）。 */
export function hookAiRuntime(hooks: AiRuntimeHooks): void {
  runtimeHooks = hooks;
}

/** 「说的 / 发的」与「跑起来才知道的」都齐了没有。 */
function hasRuntime(): boolean {
  return wireGate !== null && runtimeHooks !== null;
}

/**
 * 要发请求之前先确认那两层都装上了。
 *
 * **本文件不做任何载入动作**（不许 import / 动态载入 node 内建，见文件头）：装是由
 * `aiTransport.ts`（发的那一层）与 `aiRuntime.ts`（读元信息那一层）在各自载入时完成的 ——
 * 产品里这两份都由 `core/index.ts` 一起载入，所以正常路径上永远是齐的。
 * 万一没装上就**如实失败**，绝不假装成功、绝不偷偷降级。
 */
function runtimeReady(): boolean {
  return hasRuntime();
}

/** AI 分类的输入。 */
export interface AiClassifyInput {
  /** 要分类的文件（**只读**：分类不许改动、移动、删除它们） */
  files: readonly AiClassifyInputFile[];
  /** 当前那套规则（分类名的候选，给模型作参考；不是约束） */
  rules?: readonly { name: string }[] | null;
  /** 本次的输出根（只作上下文；实现不许往那儿写东西） */
  outputDir?: string | null;
  /** 这次用哪份接口设置（直接给一份；不给就按下面那个位置去读） */
  call?: AiConfig | null;
  /** 这次用哪份设置的**位置**（userData 下那份，或验收用的临时那份）；给了就以读回来的为准 */
  configPath?: string | null;
  /** 分批进度（文件多的时候界面要看得到走到哪儿了） */
  onProgress?: AiProgressHandler | null;
  /** 超时（毫秒）；不给用 `AI_TIMEOUT_MS`（验收会用一个小值来验超时） */
  timeoutMs?: number | null;
}

/** 一个文件的 AI 分类结果。 */
export interface AiAssignment {
  /** 原文件路径（绝不改动它） */
  source: string;
  /** 分到哪个分类（= 输出里的分类文件夹名） */
  category: string;
  /** 模型给的把握（0~1；没有就是 null） */
  confidence: number | null;
  /** 为什么这么分（给人看；没有就是空串） */
  reason: string;
}

/** AI 分类的结果：成了一起给 `assignments`，不成给 `reason` + 人话。 */
export type AiClassifyResult =
  | {
      ok: true;
      /** 每个文件分到哪个分类 */
      assignments: AiAssignment[];
      /** 模型自己也说不清、需要回落规则分类的文件 */
      unclassified: string[];
      /** 一句人话（「AI 分好了：N 个」这种） */
      message: string;
    }
  | {
      ok: false;
      /** 机器可判的原因码 */
      reason: AiReason;
      /** 一句人话（能直接给用户看） */
      message: string;
    };

/** 界面上那行常显状态用的形状。 */
export interface AiStatus {
  /** 配没配 */
  configured: boolean;
  /** 给用户看的短标签（如「AI 分类：未配置」） */
  label: string;
  /** 一句人话（说清现在能不能用 AI 分法） */
  message: string;
}

/** 未配置时那句人话（模块与界面共用同一句，别处不许再写一份）。 */
export const AI_NOT_CONFIGURED_MESSAGE =
  'AI 分类还没配置，先按规则分类；到「AI 设置」里填接口地址、密钥与模型名后可用';

/** 界面上那行常显状态的短标签（未配置时）。 */
export const AI_STATUS_LABEL = 'AI 分类：未配置';

/** 配好了那行状态的短标签。 */
export const AI_STATUS_LABEL_READY = 'AI 分类：已配置';

/** 配好了那句人话（带上模型名，让人一眼看出用的是哪个模型）。 */
export function aiReadyMessage(model: string): string {
  const name = String(model ?? '').trim();
  return name.length > 0
    ? `AI 分类已经配置好（${name}）：可以用它来换一种分法。`
    : 'AI 分类已经配置好：可以用它来换一种分法。';
}

/**
 * 界面上那行常显状态（按钮旁边那行小字就是它给的，界面里不许再写死一份）。
 * @param configured AI 是否已配置（由调用方问设置那一层）
 * @param model 已配置时的模型名（只用于那句话）
 */
export function formatAiStatus(configured: boolean, model?: string | null): AiStatus {
  if (configured) return { configured: true, label: AI_STATUS_LABEL_READY, message: aiReadyMessage(model ?? '') };
  return { configured: false, label: AI_STATUS_LABEL, message: AI_NOT_CONFIGURED_MESSAGE };
}

/* ------------------------------------------------------------------ *
 * 「AI 建议 → 规则」：只做数据结构转换，落盘仍然走既有管线
 * ------------------------------------------------------------------ */

/**
 * 把 AI 的建议变成**既有规则表里的规则**：一条建议 = 一条规则，
 * 条件是「文件名在建议清单里」（`keywords` 用完整文件名，按大小写不敏感包含匹配）——
 * 于是这条规则能被既有的 `matchesRule()` / 预览 / 复制 / 撤销那一整套直接执行，**不需要第二套实现**。
 *
 * @param assignments AI 给的「文件 → 分类名」
 * @param existingRules 用户现有规则（排在建议规则之后；建议优先命中）
 * @param seed 用来生成规则 id 的种子（同一次会话里稳定）
 */
export function aiAssignmentsToRules(
  assignments: readonly AiAssignment[],
  existingRules?: readonly Rule[] | null,
  seed?: string,
): Rule[] {
  const byCategory = new Map<string, { names: Set<string>; id: string }>();
  let seq = 0;
  for (const a of assignments ?? []) {
    const category = String(a?.category ?? '').trim();
    const name = String(a?.source ?? '')
      .split(/[\\/]/)
      .pop();
    if (category.length === 0 || !name) continue;
    let bucket = byCategory.get(category);
    if (!bucket) {
      bucket = { names: new Set<string>(), id: `ai-${String(seed ?? 's').replace(/[^\w-]/g, '')}-${++seq}` };
      byCategory.set(category, bucket);
    }
    bucket.names.add(name);
  }

  const aiRules: Rule[] = [];
  for (const [category, bucket] of byCategory) {
    aiRules.push({
      id: bucket.id,
      name: category,
      enabled: true,
      condition: { keywords: [...bucket.names], extensions: [], minSize: null, maxSize: null, modTime: 'any' },
    });
  }
  // 建议规则排在最前（先按 AI 分），用户原来的规则排在后面（AI 没提到的文件照旧走它们）
  return aiRules.concat((existingRules ?? []).map((r) => ({ ...r, condition: { ...(r.condition ?? {}) } })));
}

/* ------------------------------------------------------------------ *
 * 地址与请求体
 * ------------------------------------------------------------------ */

/** 发给模型的单个文件信息：**只有这三样**（文件名 / 大小 / 修改时间），没有路径、没有内容。 */
export interface AiFileMetadata {
  /** 文件名（含后缀） */
  name: string;
  /** 大小（字节） */
  size: number;
  /** 修改时间（ISO 字符串） */
  modifiedAt: string;
}

/** 模型必须按这个形状回话：`{ "分类名": ["文件名1", "文件名2"] }`。 */
export type AiCategoryMap = Record<string, string[]>;

/** chat completions 的路径：用户填的地址已经带 `/v1` 时不重复拼。 */
export function chatCompletionsPath(endpoint: string): string {
  const base = String(endpoint ?? '').trim().replace(/\/+$/, '');
  if (base.length === 0) return '';
  return /\/v1$/i.test(base) ? '/chat/completions' : '/v1/chat/completions';
}

/** 地址 + 路径拼成完整地址（只用于显示与断言）。 */
export function chatCompletionsUrl(endpoint: string): string {
  const base = String(endpoint ?? '').trim().replace(/\/+$/, '');
  const suffix = chatCompletionsPath(endpoint);
  return base.length === 0 || suffix.length === 0 ? '' : `${base}${suffix}`;
}

/** 按 OpenAI 兼容的形状拼请求体：**每个文件只带文件名 / 大小 / 修改时间**。 */
export function buildOpenAiRequestBody(
  model: string,
  files: readonly AiFileMetadata[],
  candidateCategories?: readonly string[] | null,
  extraHint = '',
): string {
  const hint = String(extraHint ?? '').trim();
  const list = (candidateCategories ?? [])
    .map((c) => String(c ?? '').trim())
    .filter((c) => c.length > 0);
  const parts = [
    '你在给一批文件做归类，只根据下面给的元信息判断。',
    '每个文件只有三样信息：文件名（含后缀）、大小（字节）、修改时间（ISO）。',
    '请只输出一个 JSON 对象，形状是 {"分类名": ["文件名1", "文件名2"]}，不要输出任何别的文字、不要用代码块包起来。',
  ];
  if (list.length > 0) parts.push(`可以参考这些已有的分类名（也可以另起更合适的名字）：${list.join('、')}。`);
  if (hint.length > 0) parts.push(hint);
  parts.push(`文件清单（JSON）：${JSON.stringify({ files })}`);

  return JSON.stringify({
    model: String(model ?? ''),
    temperature: 0,
    stream: false,
    messages: [
      { role: 'system', content: '你是文件归类助手，只输出 JSON。' },
      { role: 'user', content: parts.join('\n') },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * 设置：读那一层由调用方给（本文件不认路径、也不读磁盘）
 * ------------------------------------------------------------------ */

/**
 * 预留＆在用：**读一份 AI 设置**（接口地址 / 模型名 / 密钥）。
 *
 * @param configPath 配置文件的位置（由调用方算好：userData 下那份，或验收用的临时那份）。
 *   **不给位置就返回 null（= 没配置）**：本文件不猜路径、不从别处摸设置。
 *   文件不存在 / 读不了 / 内容坏掉 / 缺密钥 → 一律 null，绝不抛。
 *
 * 取文件原文这件事不由本文件做（本文件的产物要能当普通脚本直接跑，见文件头）：
 * 由设置那一层（`aiAppFiles.ts`）在载入时接上一根「取原文」的钩子，这里拿到原文再收成一份设置 ——
 * 所以「一份设置算不算配好了」只有这一处说了算，密钥也永远不进本文件的任何输出。
 */
export function loadAiConfig(configPath?: string): AiConfig | null {
  const target = typeof configPath === 'string' ? configPath.trim() : '';
  if (target.length === 0) return null;
  const reader = configTextReader;
  if (!reader) return null;
  let text = '';
  try {
    text = String(reader.read(target) ?? '');
  } catch {
    return null;
  }
  return parseAiConfigText(text);
}

/** 把「配置文件原文」收成一份设置（**配好了才算**）；文字坏掉 / 缺项 → null。 */
export function parseAiConfigText(text: string): AiConfig | null {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const src = parsed as Partial<AiConfig>;
  const pick = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const cfg: AiConfig = { endpoint: pick(src.endpoint), model: pick(src.model), authToken: pick(src.authToken) };
  // 「配好了」= 有接口地址 + 有模型名 + 有密钥（缺密钥就当没配置，不去发注定失败的请求）
  if (cfg.endpoint.length === 0 || cfg.model.length === 0 || cfg.authToken.length === 0) return null;
  return cfg;
}

/** 取配置文件原文的那根钩子（由设置那一层装上）；只认「按位置取原文」这一件事。 */
export interface AiConfigTextReader {
  /** 按位置取原文；取不到就返回空串（调用方会当成「没配置」） */
  read(configPath: string): string;
}

let configTextReader: AiConfigTextReader | null = null;

/** 装上那根钩子（**只由设置那一层 `aiAppFiles.ts` 调一次**）。 */
export function installAiConfigTextReader(reader: AiConfigTextReader): void {
  configTextReader = reader;
}

/**
 * AI 分类配好了没有（有接口地址 + 模型名 + 密钥才算）。
 *
 * 只有这一处说了算：读设置那一层按位置取回原文 → 这里收成一份设置 → 不是空就是配好了。
 * **不给位置就按「没配置」算**（本文件不猜路径）。
 */
export function isAiConfigured(): boolean {
  return loadAiConfig() !== null;
}

/* ------------------------------------------------------------------ *
 * 发请求（分批与重试在这里；真正连网的那一层在 aiTransport.ts）
 * ------------------------------------------------------------------ */

/** 发一次请求：**只对超时 / 429 / 5xx 重试**（最多 `AI_MAX_RETRIES` 次）。 */
async function requestWithRetry(
  call: AiConfig,
  body: string,
  timeoutMs: number,
  maxRetries = AI_MAX_RETRIES,
): Promise<AiWireOutcome> {
  const endpoint = String(call?.endpoint ?? '').trim();
  const path = chatCompletionsPath(endpoint);
  const fallback = { url: chatCompletionsUrl(endpoint), headers: {} as Record<string, string>, body };
  const gate = wireGate;
  if (!gate) {
    return {
      ok: false,
      status: 0,
      body: '',
      error: '网络实现没装上（程序内出错，没发请求）',
      retryable: false,
      sentRequest: fallback,
    };
  }
  let last: AiWireOutcome | null = null;
  const attempts = Math.max(0, Number(maxRetries) || 0) + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await gate.call({ endpoint, authToken: call.authToken, path, body, timeoutMs });
    if (last.ok) return last;
    if (!last.retryable || attempt === attempts - 1) return last;
    // 重试之间等一下（第 n 次等 n * AI_RETRY_DELAY_MS）
    await new Promise((resolve) => setTimeout(resolve, AI_RETRY_DELAY_MS * (attempt + 1)));
  }
  return last as AiWireOutcome;
}

/** 解析模型回的话，只认那一种形状：`{ "分类名": ["文件名", ...] }`。 */
export function parseAiResponseText(text: string): { map: AiCategoryMap | null; error: string | null } {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return { map: null, error: '模型没回任何内容' };

  let payload = raw;
  try {
    const outer = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = outer?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim().length > 0) payload = content.trim();
  } catch {
    /* 不是「整个响应体直接就是分类 JSON」的样子，按下面的剥代码块再试 */
  }

  const fence = payload.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) payload = fence[1].trim();
  if (!payload.startsWith('{')) {
    const brace = payload.indexOf('{');
    const end = payload.lastIndexOf('}');
    if (brace >= 0 && end > brace) payload = payload.slice(brace, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { map: null, error: '模型回的不是 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { map: null, error: '模型回的 JSON 不是一个「分类名 → 文件名清单」的对象' };
  }

  const map: AiCategoryMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const category = String(key ?? '').trim();
    if (category.length === 0) continue;
    if (!Array.isArray(value)) return { map: null, error: `「${category}」下面不是一个文件名清单（必须是数组）` };
    const names: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') return { map: null, error: `「${category}」的文件名清单里混进了不是文件名的东西` };
      const name = item.trim();
      if (name.length > 0) names.push(name);
    }
    map[category] = names;
  }
  if (Object.keys(map).length === 0) return { map: null, error: '模型回了个空的分类对象（一个分类都没有）' };
  return { map, error: null };
}

/**
 * 把「分类名 → 文件名清单」对回原文件清单。
 * 对不上的（模型瞎编的名字）不算数、重复归类的只认第一次出现，剩下的都进 `unclassified`。
 */
export function matchAssignments(
  files: readonly AiClassifyInputFile[],
  map: AiCategoryMap,
): { assignments: AiAssignment[]; unclassified: string[]; unmatched: string[] } {
  const byName = new Map<string, AiClassifyInputFile>();
  for (const f of files ?? []) {
    const key = String(f?.name ?? '').toLowerCase();
    if (key.length === 0 || byName.has(key)) continue;
    byName.set(key, f);
  }
  const taken = new Set<string>();
  const assignments: AiAssignment[] = [];
  const unmatched: string[] = [];

  for (const [category, names] of Object.entries(map ?? {})) {
    for (const name of names) {
      const key = String(name ?? '').toLowerCase();
      const file = byName.get(key);
      if (!file) {
        unmatched.push(String(name));
        continue;
      }
      if (taken.has(key)) continue; // 同一个文件被归了两次：只认第一次
      taken.add(key);
      assignments.push({ source: file.path, category, confidence: null, reason: 'AI 按文件名/大小/修改时间给的分类' });
    }
  }

  const unclassified: string[] = [];
  for (const f of files ?? []) {
    if (!taken.has(String(f?.name ?? '').toLowerCase())) unclassified.push(f.path);
  }
  // 顺序与输入一致，读起来更稳
  const order = new Map(files.map((f, i) => [String(f?.name ?? '').toLowerCase(), i]));
  assignments.sort((a, b) => (order.get(nameOf(a.source)) ?? 0) - (order.get(nameOf(b.source)) ?? 0));
  return { assignments, unclassified, unmatched };
}

/** 从路径取文件名（内部小工具）。 */
function nameOf(full: string): string {
  return String(full ?? '')
    .split(/[\\/]/)
    .pop()!
    .toLowerCase();
}

/* ------------------------------------------------------------------ *
 * 分类调用
 * ------------------------------------------------------------------ */

/** 读文件元信息（**只读 stat，不读内容**；由 `aiRuntime.ts` 提供）；读不到就如实留空。 */
function metadataWith(files: readonly AiClassifyInputFile[]): AiFileMetadata[] {
  const hooks = runtimeHooks;
  if (!hooks) return (files ?? []).map((f) => ({ name: String(f?.name ?? ''), size: 0, modifiedAt: '' }));
  try {
    const list = hooks.readFileMetadata(files);
    return Array.isArray(list) && list.length === files.length
      ? list
      : (files ?? []).map((f) => ({ name: String(f?.name ?? ''), size: 0, modifiedAt: '' }));
  } catch {
    return (files ?? []).map((f) => ({ name: String(f?.name ?? ''), size: 0, modifiedAt: '' }));
  }
}

/** 把一批文件切成几批（每批 ≤ `AI_MAX_FILES_PER_BATCH`）。 */
function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, Number(size) || AI_MAX_FILES_PER_BATCH);
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

/**
 * 「换一种分法」要用的 AI 分类调用入口：真发请求，把「文件 → 分类名」收回来。
 *
 * 失败一律明确失败（`ok:false` + 原因码 + 人话）：本函数**不复制、不写盘、不删任何东西**，
 * 所以「失败留半成品」这件事在这里不可能发生 —— 落盘只在用户确认之后、走既有的那条管线。
 */
export async function classifyByAi(input: AiClassifyInput): Promise<AiClassifyResult> {
  const files = Array.from(input?.files ?? []);
  // 设置从哪来：优先「直接给的那一份」，其次「按位置读回来的那份」（两条都走同一处校验）
  const call = input?.call
    ? loadAiConfig(
        // 直接给的那一份也要过同一道校验：把三项拼成一段配置文字再收回来，
        // 免得「读回来的」和「直接给的」两套判据不一致
        JSON.stringify({
          endpoint: String(input.call.endpoint ?? ''),
          model: String(input.call.model ?? ''),
          authToken: String(input.call.authToken ?? ''),
        }),
      )
    : loadAiConfig(typeof input?.configPath === 'string' ? input.configPath : undefined);
  if (!call || String(call.endpoint ?? '').trim().length === 0 || String(call.authToken ?? '').length === 0) {
    return { ok: false, reason: 'not-configured', message: AI_NOT_CONFIGURED_MESSAGE };
  }
  if (files.length === 0) {
    return { ok: false, reason: 'empty-result', message: '没有要分类的文件' };
  }
  // 真要发请求了：先确认「发的那一层」与「读元信息的那一层」都在（没装上就如实失败）
  if (!runtimeReady()) {
    return { ok: false, reason: 'request-failed', message: 'AI 分类没跑成：网络实现没装上（程序内出错，没发请求）' };
  }

  const candidate = (input?.rules ?? []).map((r) => String(r?.name ?? '')).filter((n) => n.length > 0);
  const timeoutMs = Number(input?.timeoutMs) > 0 ? Number(input?.timeoutMs) : AI_TIMEOUT_MS;
  const model = String(call.model ?? '').trim();

  const batches = chunk(files, AI_MAX_FILES_PER_BATCH);
  const merged: AiCategoryMap = {};
  let done = 0;
  const report = (): void => {
    try {
      input?.onProgress?.(done, files.length);
    } catch {
      /* 进度回调出错不影响分类 */
    }
  };
  report();

  for (const batch of batches) {
    const meta = metadataWith(batch);
    const body = buildOpenAiRequestBody(
      model,
      meta,
      candidate,
      '只归类，不要解释：你看到的只有文件名、大小与修改时间，你看不到、也不要猜文件内容。',
    );
    const outcome = await requestWithRetry(call, body, timeoutMs);
    if (!outcome.ok) {
      return { ok: false, reason: 'request-failed', message: `AI 分类没跑成：${outcome.error ?? '未知原因'}` };
    }
    const parsed = parseAiResponseText(outcome.body);
    if (!parsed.map) {
      return { ok: false, reason: 'request-failed', message: `AI 分类没跑成：${parsed.error ?? '模型回的内容看不懂'}` };
    }
    for (const [category, names] of Object.entries(parsed.map)) {
      const bucket = merged[category] ?? (merged[category] = []);
      for (const n of names) bucket.push(n);
    }
    done += batch.length;
    report();
  }

  const matched = matchAssignments(files, merged);
  if (matched.assignments.length === 0) {
    return {
      ok: false,
      reason: 'empty-result',
      message: `AI 没有给出可用的分类（回了 ${Object.keys(merged).length} 个分类名，但一个都没对上这批文件），先按规则分类`,
    };
  }
  const tail =
    matched.unclassified.length > 0 ? `；还有 ${matched.unclassified.length} 个模型没说清，会按规则分类` : '';
  return {
    ok: true,
    assignments: matched.assignments,
    unclassified: matched.unclassified,
    message: `AI 分好了：${matched.assignments.length} 个（分 ${Object.keys(merged).length} 类）${tail}`,
  };
}

/* ------------------------------------------------------------------ *
 * 通道层
 * ------------------------------------------------------------------ */

/**
 * 把要分类的文件名单收成 `AiClassifyInput.files`（**只在模块内部用**）。
 * **只读路径字符串，不 stat、不读文件内容**。
 */
export function toAiInputFiles(paths: readonly string[]): AiClassifyInputFile[] {
  const out: AiClassifyInputFile[] = [];
  for (const raw of paths ?? []) {
    const full = String(raw ?? '');
    if (full.length === 0) continue;
    const name = full.split(/[\\/]/).pop() ?? full;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
    out.push({ path: full, name, ext });
  }
  return out;
}

/**
 * **通道层唯一要调的那个入口**：给一串文件路径，调一次 AI 分类。
 * 为什么单独有这一层：界面与主进程都不该知道「AI 分类要哪些元信息、怎么组装」——那属于实现细节。
 * 通道只负责「把路径递进来、把结果带回去」，组装在这里做（也只在这里做，别处不许再写一份）。
 *
 * @param filePaths 要分类的文件完整路径（只读路径字符串，不碰磁盘）
 * @param outputDir 本次的输出根（只作上下文；本实现不往那儿写东西）
 * @param call 这次用的接口设置（由主进程读好传进来；不给 = 没配置）
 * @param onProgress 分批进度回调
 */
export async function aiClassifyByPaths(
  filePaths: readonly string[],
  outputDir?: string | null,
  call?: AiConfig | null,
  onProgress?: AiProgressHandler | null,
): Promise<AiClassifyResult> {
  return classifyByAi({
    files: toAiInputFiles(filePaths),
    outputDir: outputDir ?? null,
    call: call ?? null,
    onProgress: onProgress ?? null,
  });
}
