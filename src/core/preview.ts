/**
 * 纯逻辑：分类「预览树」。**绝对不写磁盘**——只做只读的 stat，不建目录、不写文件、不写配置。
 *
 * 分类结果复用 `classifyWithMeta()`（与真正执行复制时的**同一个求值函数**）：
 * 传进来的规则表既决定每个文件去哪，也决定预览里列出哪些分类文件夹。
 * 本文件**不依赖 Electron**，可被 node 直接 require 测试。
 */
import * as fssync from 'fs';
import { baseName, extensionOf } from './classify';
import { activeFolderNamesOf, type RuleTable } from './rules';
import { classifyWithMeta } from './classifyWithMeta';
import { describeError } from './copyFiles';

/** 某个文件读不到元信息时的说明；能读到就是 null。 */
export interface PreviewFileError {
  /** 人话原因（如「原文件不存在或路径已失效」） */
  message: string;
  /** 底层错误码（如 ENOENT），取不到时为 '' */
  code: string;
}

/** 预览树里的一个文件。`folder` 始终由现有分类规则给出，与读不到元信息与否无关。 */
export interface PreviewFile {
  /** 原文件路径 */
  path: string;
  /** 文件名（含后缀） */
  name: string;
  /** 小写后缀，不含点；无后缀为 '' */
  ext: string;
  /** 目标分类文件夹名 */
  folder: string;
  /** 能否读到文件元信息（不存在 / 无权限 / 是文件夹 → false） */
  readable: boolean;
  /** 读不到时的人话原因；读得到时为 null */
  error: PreviewFileError | null;
}

/** 预览树里的一个分类文件夹。 */
export interface PreviewFolder {
  /** 分类文件夹名（与真正复制时用的完全一致） */
  folder: string;
  /** 该文件夹下的文件个数 */
  count: number;
  /** 该文件夹下的文件明细 */
  files: PreviewFile[];
}

/** 一棵分类预览树：每个分类一行（名字 + 数量），展开是文件名。 */
export interface PreviewTree {
  /** 输入的文件总数 */
  total: number;
  /** 按固定分类顺序排列的分类节点（没有文件的分类也在，count 为 0） */
  folders: PreviewFolder[];
  /** 每个分类的文件数（分类名 → 个数） */
  counts: Record<string, number>;
  /** 明细汇总（顺序与输入一致），便于「预览 vs 实际」逐条核对 */
  files: PreviewFile[];
  /** 能读到元信息的文件数 */
  readableCount: number;
  /** 读不到元信息的文件数 */
  unreadableCount: number;
  /** 输出文件夹（仅用于显示，预览绝不创建它）；没传就是 null */
  outputDir: string | null;
  /** 本次预览用的是不是调用方传进来的规则表（不是就是默认规则） */
  rulesApplied: boolean;
}

/** 没选输出文件夹 / 没拖入任何文件时的提示（人话，不抛错）。 */
export interface PreviewValidationError {
  ok: false;
  /** 人话提示 */
  message: string;
  /** 机器可判的原因码 */
  reason: 'no-files' | 'no-output-dir' | 'internal-error';
}

/** 预览成功 / 失败两种结果。 */
export type PreviewOutcome = { ok: true; tree: PreviewTree } | PreviewValidationError;

export interface PreviewBuildOptions {
  /** 要预览的文件路径列表 */
  files: readonly string[];
  /** 输出文件夹；只用于显示，预览绝不创建或写入它 */
  outputDir?: string | null;
  /** 分类规则表；不传就用默认规则（按后缀分五类）。与实际整理必须是同一套。 */
  rules?: RuleTable | null;
  /**
   * 是否探测文件元信息（默认 true，只读 stat，不写盘）。
   * 置为 false 时所有文件都按「可读」记，用于不碰磁盘的纯计算场合。
   */
  checkReadable?: boolean;
}

/** 只读探测一个文件的元信息：给不出人话原因就算「读不到」，但绝不让整棵树失败。 */
function probeFile(filePath: string, checkReadable: boolean): { readable: boolean; error: PreviewFileError | null } {
  if (!checkReadable) return { readable: true, error: null };

  try {
    const st = fssync.statSync(filePath);
    if (!st.isFile()) {
      // isDirectory / 其它特殊文件：复制阶段会被拒绝，这里先标出来
      return { readable: false, error: { message: '这是一个文件夹，本片只支持文件', code: 'EISDIR' } };
    }
    return { readable: true, error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    return { readable: false, error: { message: describeError(err), code } };
  }
}

/**
 * 纯函数（除只读 stat 外无副作用）：输入文件路径列表，输出一棵分类预览树。
 *
 * 保证：
 *  - 每个文件的 `folder` 来自现有分类规则，和真正执行复制时一致；
 *  - 预览树的分类顺序、文件夹名与执行时一致；
 *  - **不创建任何目录、不写任何文件**（包括输出文件夹本身）；
 *  - 单个文件读不到元信息只标注原因，不影响整棵树。
 */
export function buildPreviewTree(options: PreviewBuildOptions): PreviewOutcome {
  const files = Array.from(options?.files ?? []);
  if (files.length === 0) {
    return { ok: false, reason: 'no-files', message: '还没有可预览的文件，先拖进来或点「选择文件」' };
  }
  const outputDir = options?.outputDir ?? null;
  if (outputDir === null || outputDir === undefined || String(outputDir).trim() === '') {
    return { ok: false, reason: 'no-output-dir', message: '还没选输出文件夹，先点「选择输出文件夹」' };
  }

  const checkReadable = options?.checkReadable !== false;
  const rules = options?.rules ?? null;
  // 分类：与真正执行复制时**同一个求值函数**（大小/时间条件要真读属性）
  const entries: PreviewFile[] = [];
  const byFolder = new Map<string, PreviewFile[]>();
  for (const folder of activeFolderNamesOf(rules)) byFolder.set(folder, []);

  for (const raw of files) {
    const p = String(raw);
    const matched = classifyWithMeta(rules, p);
    const probe = probeFile(p, checkReadable);
    const item: PreviewFile = {
      path: p,
      name: baseName(p),
      ext: extensionOf(p),
      folder: matched.folder,
      readable: probe.readable,
      error: probe.error,
    };
    entries.push(item);
    let bucket = byFolder.get(item.folder);
    if (!bucket) {
      bucket = [];
      byFolder.set(item.folder, bucket);
    }
    bucket.push(item);
  }

  const folders: PreviewFolder[] = [];
  const counts: Record<string, number> = {};
  for (const [folder, list] of byFolder) {
    folders.push({ folder, count: list.length, files: list });
    counts[folder] = list.length;
  }

  return {
    ok: true,
    tree: {
      total: entries.length,
      folders,
      counts,
      files: entries,
      readableCount: entries.filter((f) => f.readable).length,
      unreadableCount: entries.filter((f) => !f.readable).length,
      outputDir: String(outputDir),
      rulesApplied: rules !== null && rules !== undefined,
    },
  };
}
