/**
 * 实际复制（异步，fs/promises）。**不依赖 Electron**，可被 node 直接 require 测试。
 *
 * 铁律：只复制，不移动，绝不删除原文件。
 *  - 复制用 COPYFILE_EXCL，目标已存在一律不覆盖，改为换名。
 *  - 单个文件出错只记这一条失败，继续处理后面的文件，不抛出去、不中断整批。
 */
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import { defaultRules, type RuleTable } from './rules';
import { classifyWithMeta } from './classifyWithMeta';
import { pickUniqueName, MAX_RENAME_ATTEMPTS } from './classify';

export interface CopyFileResult {
  /** 原文件路径 */
  source: string;
  /** 目标分类文件夹名 */
  folder: string;
  /** 最终文件名（可能被换名） */
  finalName: string;
  /** 最终完整目标路径；失败时为 null */
  target: string | null;
  ok: boolean;
  /** 是否因同名冲突换过名 */
  renamed: boolean;
  /** 失败原因（人话），成功时为 null */
  error: string | null;
}

export interface CopySummary {
  total: number;
  successCount: number;
  failureCount: number;
  results: CopyFileResult[];
  /** 输出根目录（绝对路径） */
  outputDir: string;
}

export interface CopyOptions {
  /** 输出根目录 */
  outputDir: string;
  /** 要复制的原文件路径列表 */
  files: readonly string[];
  /**
   * 分类规则表；不传就用默认规则（按后缀分五类）。
   * **预览与执行必须传同一套规则**，否则会出现「预览说去 A、执行却去了 B」。
   */
  rules?: RuleTable | null;
  /** 每处理完一个文件回调一次，用于界面进度 */
  onProgress?: (done: number, total: number, result: CopyFileResult) => void;
}

/** 把底层错误翻译成一句人话。 */
export function describeError(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  const code = e?.code ?? '';
  switch (code) {
    case 'ENOENT':
      return '原文件不存在或路径已失效';
    case 'EACCES':
      return '没有权限读写该文件或目标文件夹';
    case 'EPERM':
      return '系统权限拒绝（文件可能被占用或只读）';
    case 'EBUSY':
      return '文件正被其他程序占用';
    case 'EISDIR':
      return '这是一个文件夹，本片只支持文件';
    case 'ENOSPC':
      return '目标磁盘空间不足';
    case 'EINVAL':
      return '路径不合法（文件名含非法字符）';
    case 'EMFILE':
    case 'ENFILE':
      return '打开的文件太多，请稍后重试';
    default:
      return code ? `复制失败（${code}）` : `复制失败：${e?.message ?? String(err)}`;
  }
}

async function listTakenNames(dir: string): Promise<Set<string>> {
  const taken = new Set<string>();
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return taken; // 目录还不存在 / 读不了，视作空
  }
  for (const n of names) taken.add(n.toLowerCase());
  return taken;
}

/** 让 stdout/文件系统留一点余量，避免同一批里两名撞车：用一个 promise 串行化整个批次。 */
export async function copyFiles(options: CopyOptions): Promise<CopySummary> {
  const outputDir = path.resolve(options.outputDir);
  const files = Array.from(options.files ?? []);
  const rules = options.rules ?? defaultRules();
  const results: CopyFileResult[] = [];

  // 预建五个分类文件夹 + 读一次已存在的名字（同名冲突判定用）
  const takenByFolder = new Map<string, Set<string>>();
  const ensureTaken = async (folder: string): Promise<Set<string>> => {
    let set = takenByFolder.get(folder);
    if (!set) {
      set = await listTakenNames(path.join(outputDir, folder));
      takenByFolder.set(folder, set);
    }
    return set;
  };

  await fs.mkdir(outputDir, { recursive: true });

  let done = 0;
  for (const rawSource of files) {
    const source = String(rawSource);
    const originalName = path.basename(source);
    done++;

    // 分类：与预览用同一个求值函数（大小/时间条件要真读属性，读不到就当作该项不命中）
    const matched = classifyWithMeta(rules, source, originalName);
    const folder = matched.folder;

    const base: CopyFileResult = {
      source,
      folder,
      finalName: originalName,
      target: null,
      ok: false,
      renamed: false,
      error: null,
    };

    try {
      const targetDir = path.join(outputDir, folder);
      await fs.mkdir(targetDir, { recursive: true });
      const taken = await ensureTaken(folder);

      let finalName: string | null = null;
      let renamed = false;
      let lastError: unknown = null;

      for (let round = 0; round <= MAX_RENAME_ATTEMPTS; round++) {
        const picked = pickUniqueName(originalName, taken);
        if (picked.name === null) {
          lastError = new Error('同名文件太多，已试到 999 个，找不到空位');
          break;
        }
        const candidate = picked.name;
        try {
          await fs.copyFile(source, path.join(targetDir, candidate), fssync.constants.COPYFILE_EXCL);
          finalName = candidate;
          renamed = picked.renamed;
          taken.add(candidate.toLowerCase());
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'EEXIST') {
            // 上次读目录之后有人插了一个同名文件：把这个名字记下来，再换一个
            taken.add(candidate.toLowerCase());
            lastError = err;
            continue;
          }
          lastError = err;
          break;
        }
      }

      if (finalName === null) {
        base.error =
          lastError instanceof Error && lastError.message.startsWith('同名文件太多')
            ? lastError.message
            : describeError(lastError);
      } else {
        base.ok = true;
        base.finalName = finalName;
        base.renamed = renamed;
        base.target = path.join(targetDir, finalName);
      }
    } catch (err) {
      base.error = describeError(err);
    }

    results.push(base);
    if (options.onProgress) {
      try {
        options.onProgress(done, files.length, base);
      } catch {
        /* 进度回调自己出错不许影响复制 */
      }
    }
  }

  return {
    total: files.length,
    successCount: results.filter((r) => r.ok).length,
    failureCount: results.filter((r) => !r.ok).length,
    results,
    outputDir,
  };
}
