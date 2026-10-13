/**
 * 纯逻辑：**「换一种分法」的 AI 分类器 —— 本片只搭壳**。**不依赖 Electron**。
 *
 * 本片只做三件事：接口形状、状态查询、未配置时的如实回话。
 * **真实模型调用是下一片的事**（用户自己配接口与密钥）。所以现在这个文件里：
 *   - 没有任何联网动作（不建连接、不请求）；
 *   - 不读任何密钥（不读 shell 环境变量、不读配置文件、不读命令行）；
 *   - 不碰磁盘（不建目录、不写文件、不删东西）——`classifyByAi` 一定什么都不改就回话。
 *
 * 为什么这样切：整轮整理完之后，用户可能觉得分得不好。那时先**撤销本次复制**
 * （见 `runRecord.ts` 的 `undoLastRun`），再换一种分法重来。另一种分法就是 AI 分类；
 * 现在还没配，所以只把「壳」搭出来，界面能进得来、能如实说明「还没配置」。
 *
 * ----------------------------------------------------------------------------
 * 【给下一片：将来接大模型时，这个接口长什么样】
 *
 * 输入（`AiClassifyInput`）：要分类的**文件列表与元信息**
 *   - `files`：每个文件给 `path`（完整路径）、`name`（文件名）、`ext`（后缀，可空）；
 *     需要更多线索（大小 / 修改时间）时由实现自己去 stat，本片不在输入里强加。
 *   - `rules`：当前那套规则（把「规则名」当成候选分类名，便于让模型在同名集合里挑）；
 *     以后要改成完全自由分类，就把它当提示而不是约束。
 *   - `outputDir`：本次的输出根（只用于提示上下文，实现**不许**往那儿写东西）。
 *
 * 输出（`AiClassifyResult`）：**文件 → 分类名**的对应关系
 *   - `ok: true` 时给 `assignments: { source, category, confidence?, reason? }[]`
 *     （`category` 就是输出里的分类夹名，将来直接喂给既有的复制逻辑）；
 *     模型自己说不清的文件放在 `unclassified` 里，由调用方回落规则分类。
 *   - `ok: false` 时给机器可判的 `reason` 码 + 一句人话 `message`。
 *
 * 配置（`AiConfig` + `loadAiConfig`）：
 *   - `AiConfig` 是预留的位置（接口地址、模型名、凭据字段名等，本片不填真值）；
 *   - `loadAiConfig()` 现在**恒**返回 `null`（= 没配置）——因为产品里**还没有任何配置来源**
 *     （没做设置页、不读环境变量）。下一片把它换成「读用户在设置里填的那份配置」，
 *     本文件其它函数的签名与语义都不用动，界面那一层也认这套码与人话。
 * ----------------------------------------------------------------------------
 */

/** 机器可判的「为什么没给出 AI 分类」的原因码。 */
export type AiReason =
  /** 还没配置（本片恒是这个） */
  | 'not-configured'
  /** 下一片：配置在、但调用失败（超时 / 报错 / 模型返回看不懂的东西） */
  | 'request-failed'
  /** 下一片：配置在、但模型没给出可用结果 */
  | 'empty-result';

/**
 * 将来放「AI 接口配置」的位置（**本片不填任何真值**，也不读任何地方）。
 *
 * 与 `loadAiConfig()` 的关系：读取函数现在恒返回 `null`，也就是「没配置」。
 * 下一片在这里落用户填的接口地址 / 模型名 / 凭据存放位置（凭据本身不进这个类型，
 * 只放「去哪儿拿」的引用，避免把凭据散到各处）。
 */
export interface AiConfig {
  /** 接口地址（下一片由用户在设置里填） */
  endpoint: string;
  /** 模型名（下一片由用户在设置里填） */
  model: string;
  /** 凭据的存放位置说明（本片是空串；凭据本身不进这里） */
  credentialRef: string;
}

/** 送进 AI 分类的一个文件（列表 + 元信息）。 */
export interface AiClassifyInputFile {
  /** 完整路径 */
  path: string;
  /** 文件名（含后缀） */
  name: string;
  /** 后缀（小写、不含点；没有后缀就是空串） */
  ext: string;
}

/** AI 分类的输入（形状见文件头的「给下一片」一段）。 */
export interface AiClassifyInput {
  /** 要分类的文件（**只读**：分类不许改动、移动、删除它们） */
  files: readonly AiClassifyInputFile[];
  /** 当前那套规则（分类名的候选；以后可以只用它作提示） */
  rules?: readonly { name: string }[] | null;
  /** 本次的输出根（只作上下文；实现不许往那儿写东西） */
  outputDir?: string | null;
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
  /** 配没配（现在恒为 false） */
  configured: boolean;
  /** 给用户看的短标签（如「AI 分类：未配置」） */
  label: string;
  /** 一句人话（说清现在只有规则分类可用） */
  message: string;
}

/**
 * 读 AI 配置。
 *
 * **本片恒返回 null（= 没配置）**：产品里还没有任何配置来源 —— 没做设置页、
 * 不读 shell 环境变量、不读配置文件、不读命令行参数。下一片换成「读用户在设置里填的那份」。
 *
 * @param _configPath 预留：将来配置存放的位置由调用方给（本片忽略它）
 */
export function loadAiConfig(_configPath?: string): AiConfig | null {
  return null;
}

/** AI 分类配好了没有。**本片恒为 false**（没有配置来源，见 `loadAiConfig`）。 */
export function isAiConfigured(): boolean {
  return loadAiConfig() !== null;
}

/** 未配置时那句人话（模块与界面共用同一句，别处不许再写一份）。 */
export const AI_NOT_CONFIGURED_MESSAGE =
  'AI 分类还没配置，先按规则分类；到设置里填接口与密钥后可用（下一版做）';

/** 界面上那行常显状态的短标签。 */
export const AI_STATUS_LABEL = 'AI 分类：未配置';

/** 界面上那行常显状态（按钮旁边那行小字就是它给的，界面里不许再写死一份）。 */
export function formatAiStatus(): AiStatus {
  if (isAiConfigured()) {
    return { configured: true, label: 'AI 分类：已配置', message: 'AI 分类已经配置好，可以用它来换一种分法。' };
  }
  return { configured: false, label: AI_STATUS_LABEL, message: AI_NOT_CONFIGURED_MESSAGE };
}

/**
 * 「换一种分法」要用的 AI 分类调用入口。
 *
 * **本片只搭壳**：不建连接、不读密钥、不写盘、不删东西。没配置就如实回话
 * （`ok:false` + `reason:'not-configured'` + 一句人话），让界面能原样转告用户。
 * 下一片在这里接上真模型：读 `loadAiConfig()` 那份配置，把 `input` 送出去，
 * 把「文件 → 分类名」按 `AiClassifyResult` 收回来。
 */
export async function classifyByAi(input: AiClassifyInput): Promise<AiClassifyResult> {
  void input; // 本片不读这份输入（不碰文件、不碰磁盘），只用于把形状钉在明面上
  if (!isAiConfigured()) {
    return { ok: false, reason: 'not-configured', message: AI_NOT_CONFIGURED_MESSAGE };
  }
  // 配置存在时才往下走（本片到不了这里：`loadAiConfig` 恒返回 null）
  return { ok: false, reason: 'request-failed', message: 'AI 分类没跑起来（下一版接上模型后才有这一步）' };
}

/**
 * 把要分类的文件名单收成 `AiClassifyInput.files`（**只在模块内部用**）。
 * **只读路径字符串，不 stat、不读文件内容**（本片不碰磁盘）。
 */
function toAiInputFiles(paths: readonly string[]): AiClassifyInputFile[] {
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
 * @param outputDir 本次的输出根（只作上下文；本片用不到）
 */
export async function aiClassifyByPaths(
  filePaths: readonly string[],
  outputDir?: string | null,
): Promise<AiClassifyResult> {
  return classifyByAi({ files: toAiInputFiles(filePaths), outputDir: outputDir ?? null });
}
