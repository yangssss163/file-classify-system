/**
 * 实际复制（异步，fs/promises）。**不依赖 Electron**，可被 node 直接 require 测试。
 *
 * 铁律：只复制，不移动，绝不删除原文件。
 *  - 复制用 COPYFILE_EXCL，目标已存在一律不覆盖，改为换名。
 *  - 单个文件出错只记这一条失败，继续处理后面的文件，不抛出去、不中断整批。
 *  - **开工前先校验输出方向**（见 `outputDirection.ts`）：方向危险就一个字节都不写，
 *    把拒绝原因原样带回去（`blocked`）。
 *  - 传了 `recordPath` 就把这一次整理记下来（`runRecord.ts`）：本次复制成功的每个目标路径、
 *    新建的目录、成功/失败数 —— 之后才能「撤销上一次整理」。
 */
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import { defaultRules, type RuleTable } from './rules';
import { classifyWithMeta } from './classifyWithMeta';
import { pickUniqueName, MAX_RENAME_ATTEMPTS } from './classify';
import { planFolders, type PlanResult } from './expandAndPlan';
import { checkOutputDirection, isInsideDir, sameDir, type OutputDirectionCheck } from './outputDirection';
import { saveRunRecord, type RunRecord, type RunRecordFailure, type RunRecordFile } from './runRecord';

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
  /** 「源文件夹各归各」时：这个文件属于哪个源文件夹（顶层拖入点的绝对路径）；普通文件模式为 null */
  sourceRoot: string | null;
  /** 「源文件夹各归各」时：相对源文件夹的各层子文件夹名；普通文件模式为 null */
  sourceChain: string[] | null;
}

export interface CopySummary {
  total: number;
  successCount: number;
  failureCount: number;
  results: CopyFileResult[];
  /** 输出根目录（绝对路径） */
  outputDir: string;
  /** 「源文件夹各归各」时：每个源文件夹在输出里的落点（普通文件模式为空数组） */
  plannedFolders: Array<{
    sourcePath: string;
    sourceChain: string[];
    outputChain: string[];
    outputDir: string;
    fileCount: number;
    renamed: boolean;
  }>;
  /** 「源文件夹各归各」时：被跳过的路径与原因（空文件夹不算，它只是不产生输出） */
  skipped: Array<{ path: string; reason: string; name?: string }>;
  /** 本次复制出来的文件的目标路径（只有成功的那些）—— 撤销时只删这些 */
  writtenFiles: string[];
  /** 本次由程序（新）创建出来的目录 */
  createdDirs: string[];
  /** 输出方向被拦下时为 true：这次**一个字节都没写**，`blockedReason` 说清为什么 */
  blocked: boolean;
  /** 被拦下的原因（人话）；没被拦下时为 null */
  blockedReason: string | null;
  /** 输出方向校验的完整结论（界面上要说清为什么不让开工） */
  direction: OutputDirectionCheck | null;
  /** 记录文件的路径（没传就不记）；记录写失败时为那句人话 */
  recordPath: string | null;
  /** 记录（本次整理的账本）—— 传了 `recordPath` 才有 */
  record: RunRecord | null;
  /** 记录落盘失败时的人话（成功时为 null） */
  recordError: string | null;
}

export interface CopyOptions {
  /** 输出根目录 */
  outputDir: string;
  /** 要复制的原文件路径列表 */
  files: readonly string[];
  /**
   * 源文件夹列表（拖入/选中的文件夹）。
   * 传了它就走「源文件夹各归各」：每个源文件夹在输出根下有自己的同名夹，
   * 各层的分类夹分别建，**来自不同源文件夹的文件绝不进同一个分类夹**。
   * 不传则保持原行为（所有文件直接落到 输出根\分类夹\）。
   */
  roots?: readonly string[] | null;
  /** 拖入的源文件夹路径本身（只用于「跳过原因」里说清是哪个根）；不传就用 roots */
  rootOrigins?: readonly string[] | null;
  /**
   * 分类规则表；不传就用默认规则（按后缀分五类）。
   * **预览与执行必须传同一套规则**，否则会出现「预览说去 A、执行却去了 B」。
   */
  rules?: RuleTable | null;
  /** 每处理完一个文件回调一次，用于界面进度 */
  onProgress?: (done: number, total: number, result: CopyFileResult) => void;
  /**
   * 记录文件路径（userData 下的 `organizer-last-run.json`，验收用临时路径）。
   * 传了它就把这次整理记下来，之后能「撤销上一次整理」；不传就只复制、不记账。
   */
  recordPath?: string | null;
  /** 开始/结束时间由调用方给（验收要断言时间字段在）；不传就用当前时间 */
  startedAt?: string | null;
}

/** 收集一棵树里**已经存在**的目录（小写绝对路径）。用来算「这次新建了哪些目录」。 */
async function collectExistingDirs(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      found.add(child.toLowerCase());
      await walk(child);
    }
  };
  await walk(root);
  return found;
}

/**
 * 往上收集「这次新建的目录链」（到已经存在的目录为止），并登记到 `created`。
 * 这样撤销时才能只清「由程序创建、且变空」的目录。
 */
function markCreatedChain(startDir: string, existing: Set<string>, created: Set<string>): void {
  let cur = startDir;
  for (let i = 0; i < 64; i++) {
    const key = cur.toLowerCase();
    if (existing.has(key) || created.has(key)) return;
    created.add(key);
    const parent = path.dirname(cur);
    if (parent === cur || parent.length === 0) return;
    cur = parent;
  }
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
  const rootsRaw = Array.from(options.roots ?? []).map((r) => String(r)).filter((r) => r.length > 0);
  const recordPath = options.recordPath ? String(options.recordPath) : null;
  const startedAt = options.startedAt ? String(options.startedAt) : new Date().toISOString();

  /* ---------- 开工前的第一件事：校验输出方向（危险就一个字节都不写） ----------
   * 出口校验放在**写盘之前**，所以拒绝时输出目录连建都不会建（见 outputDirection.ts 的三条判据）。 */
  const direction = checkOutputDirection({ roots: rootsRaw, files, outputDir });
  if (!direction.ok) {
    return {
      total: files.length,
      successCount: 0,
      failureCount: 0,
      results: [],
      outputDir,
      plannedFolders: [],
      skipped: [],
      writtenFiles: [],
      createdDirs: [],
      blocked: true,
      blockedReason: direction.message,
      direction,
      recordPath,
      record: null,
      recordError: null,
    };
  }

  // 目标目录 → 已占用的名字（小写）。有 roots 时目标目录是「源文件夹落点 + 分类夹」，没有就是「输出根 + 分类夹」。
  const takenByDir = new Map<string, Set<string>>();
  const ensureTaken = async (dirKey: string, dir: string): Promise<Set<string>> => {
    let set = takenByDir.get(dirKey);
    if (!set) {
      set = await listTakenNames(dir);
      takenByDir.set(dirKey, set);
    }
    return set;
  };

  const dirKeyOf = (dir: string): string => `${dir.toLowerCase()}\\`;

  /**
   * 先把目标路径全算好（预览与执行共用同一个 `planFolders`），再动手复制。
   * 有 roots 时走「文件夹优先」：子文件夹里的文件原样保留相对路径，只有源文件夹各层根下的散文件按规则进分类夹。
   */
  const planned = new Map<
    string,
    {
      dir: string;
      name: string;
      folder: string;
      root: string | null;
      chain: string[] | null;
      renamed: boolean;
      placement: 'keep' | 'classify' | 'merge';
      mergeReason: string | null;
    }
  >();
  let plan: PlanResult | null = null;
  if (rootsRaw.length > 0) {
    plan = planFolders({ roots: rootsRaw, outputDir, rules }).plan;
    for (const f of plan.files) {
      planned.set(f.fullPath.toLowerCase(), {
        dir: f.targetDir,
        name: f.name,
        // 原样保留的文件不算「进哪个分类夹」：`folder` 留空串，界面上也就不会说它被分类了
        folder: f.placement === 'keep' ? '' : (f.category ?? ''),
        root: f.origin.rootPath,
        chain: f.origin.chain.slice(),
        renamed: f.renamed,
        placement: f.placement,
        mergeReason: f.mergeReason,
      });
    }
  }

  // 输出根：先看它本来在不在（记录里要写清「是不是这次新建的」），再建。
  // 建完立刻把**已经存在**的目录全扫一遍 —— 之后 mkdir 出来的都是「这次新建的」，撤销时才可以清。
  const rootExistedBefore = fssync.existsSync(outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const createdDirs = new Set<string>();
  const existingDirs = await collectExistingDirs(outputDir);
  if (!rootExistedBefore) createdDirs.add(outputDir.toLowerCase());

  let done = 0;
  for (const rawSource of files) {
    const source = String(rawSource);
    const originalName = path.basename(source);
    done++;

    // 分类：与预览用同一个求值函数（大小/时间条件要真读属性，读不到就当作该项不命中）
    const pre = planned.get(source.toLowerCase());
    const matched = classifyWithMeta(rules, source, originalName);
    const folder = pre ? pre.folder : matched.folder;

    const base: CopyFileResult = {
      source,
      folder,
      finalName: originalName,
      target: null,
      ok: false,
      renamed: false,
      error: null,
      sourceRoot: pre ? pre.root : null,
      sourceChain: pre ? pre.chain : null,
    };

    try {
      const targetDir = pre ? pre.dir : path.join(outputDir, folder);
      await fs.mkdir(targetDir, { recursive: true });
      const dirKey = dirKeyOf(targetDir);
      const taken = await ensureTaken(dirKey, targetDir);

      let finalName: string | null = null;
      let renamed = false;
      let lastError: unknown = null;

      for (let round = 0; round <= MAX_RENAME_ATTEMPTS; round++) {
        // 有算好的目标名就用它（预览说叫这个名字，就得叫这个名字）；
        // 名字已经被别人占了（比如算完之后有人插了文件）时，才退回现挑一个空位。
        const picked = round === 0 && pre ? { name: pre.name, renamed: pre.renamed } : pickUniqueName(originalName, taken);
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
        // 这次真的落地了：把「新建的目录链」记下来，撤销时才知道哪些目录可以清
        markCreatedChain(targetDir, existingDirs, createdDirs);
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

  /* ---------- 记账：这次到底复制出哪些文件、建了哪些目录（撤销的唯一依据） ---------- */
  const writtenFiles: RunRecordFile[] = [];
  for (const r of results) {
    if (!r.ok || !r.target) continue;
    let size = -1;
    try {
      size = fssync.statSync(r.target).size;
    } catch {
      size = -1; // 读不到大小：记 -1，撤销时只核「存在性」
    }
    writtenFiles.push({ source: r.source, target: r.target, size, renamed: r.renamed });
  }
  const failures: RunRecordFailure[] = results
    .filter((r) => !r.ok)
    .map((r) => ({ source: r.source, reason: r.error ?? '未知原因（这个文件不在可撤销范围内）' }));
  const dirList = Array.from(createdDirs)
    .map((d) => (d.toLowerCase() === outputDir.toLowerCase() ? outputDir : d))
    .sort((a, b) => b.length - a.length);
  const finishedAt = new Date().toISOString();

  const record: RunRecord = {
    schema: '1',
    startedAt,
    finishedAt,
    outputDir,
    sourceRoots: rootsRaw.slice(),
    sourceFiles: files.map((f) => String(f)),
    files: writtenFiles,
    directories: dirList,
    successCount: writtenFiles.length,
    failureCount: failures.length,
    // 失败的那些不在可撤销范围内：撤销只删「记录里列出、且确实复制成功的」目标路径
    failureNote:
      failures.length > 0
        ? `本次有 ${failures.length} 个文件没复制成功，它们没有在输出里产生文件，所以不在可撤销范围内（撤销只删本次复制成功的那些）。`
        : '本次没有失败的文件。',
    failures,
    undoneAt: null,
  };

  let recordError: string | null = null;
  if (recordPath) {
    const saved = saveRunRecord(recordPath, record);
    if (!saved.ok) recordError = saved.message;
  }

  return {
    total: files.length,
    successCount: results.filter((r) => r.ok).length,
    failureCount: results.filter((r) => !r.ok).length,
    results,
    outputDir,
    // 顶层源文件夹在输出里的落点（哪份源路径 → 输出里叫什么），界面上据此说清「同名被改了名」
    plannedFolders: plan
      ? plan.roots.map((r) => ({
          sourcePath: r.origin.rootPath,
          sourceChain: [] as string[],
          outputChain: [r.outputName],
          outputDir: r.outputDir,
          fileCount: r.totalFileCount,
          renamed: r.renamed,
        }))
      : [],
    skipped: plan ? plan.skipped.map((s) => ({ path: s.fullPath, reason: s.reason, name: s.name })) : [],
    writtenFiles: writtenFiles.map((f) => f.target),
    createdDirs: dirList.slice(),
    blocked: false,
    blockedReason: null,
    direction,
    recordPath,
    record,
    recordError,
  };
}
