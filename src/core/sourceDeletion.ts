/**
 * 纯逻辑：**用户明确要求时，删掉这一批的源文件**。
 *
 * 这和「撤销」是两件相反的事，别混：
 *  - 撤销 = 删**输出**里由程序复制出来的那份，源文件永远不动；
 *  - 删源 = 删**源文件**（用户已经确认输出里那份是好的，不再需要原件）。
 *
 * 这个动作是全产品唯一一次「动用户的原始文件」，所以红线写得比别处更死：
 *  1. **只删这一次整理里「复制成功」的那几个源文件**（记录里的 `files` 就是成功清单）；
 *     失败的那些一个都不碰（输出里没有对应的那份，删了就真丢了）；
 *  2. 删之前**逐个核对输出里那份还在**：输出里那份被撤销/被手动删了 → 跳过并说明，不删源文件；
 *  3. **默认走回收站**（`options.trash` 由主进程传 `shell.trashItem`），不是彻底抹掉；
 *     没给回收站能力时**一个都不删**（宁可不动，也不许不可恢复地删）；
 *  4. 目录只 `rmdir`（**只在空的时候才成功**）：绝不递归删目录，里面还有东西就留着；
 *     而且只清「本次源文件夹里、被删空的那些目录」，散文件模式一个目录都不清；
 *  5. 幂等：删过一次就在记录里盖上 `sourcesDeletedAt`，再点只回一句人话，不重复动手；
 *  6. 每个删掉的文件 / 清掉的目录都写一行**删除审计**（与撤销同一份日志）。
 *
 * 一律不抛异常：任何失败都变成人话原因（界面直接显示）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { describeError } from './copyFiles';
import { isInsideDir } from './outputDirection';
import { appendDeleteAudit, loadRunRecord, normalizeRunRecord, saveRunRecord } from './runRecord';
import type { RunRecord } from './runRecord';

/** 删源时一个文件的处置结果。 */
export interface SourceDeleteFileOutcome {
  source: string;
  target: string;
  action: 'deleted' | 'skipped';
  reason: string;
}

/** 删源时一个目录的处置结果。 */
export interface SourceDeleteDirOutcome {
  dir: string;
  action: 'removed' | 'skipped';
  reason: string;
}

/** 删源的结果（人话 + 机器可判的数字）。 */
export interface SourceDeleteResult {
  ok: boolean;
  /** 这次调用有没有真动手 */
  changed: boolean;
  message: string;
  /** 记录里这轮复制成功的源文件数（= 最多能删几个） */
  plannedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  removedDirs: number;
  files: SourceDeleteFileOutcome[];
  dirs: SourceDeleteDirOutcome[];
}

export interface SourceDeleteOptions {
  /**
   * 把文件移到回收站的函数（主进程传 `shell.trashItem`）。
   * **不给就一个文件都不删** —— 这个动作不可逆，没有回收站能力时宁可不动。
   */
  trash?: ((filePath: string) => Promise<void> | void) | null;
  /** 删除审计日志的位置（给了就记一行一条） */
  auditPath?: string | null;
  /** 现在的时间（测试注入用；不给就是当前时间） */
  now?: Date;
}

/** 这一批能删几个源文件（界面在按钮上要写数字，不点也能看出来）。 */
export function sourceDeletePlan(record: RunRecord | null): {
  count: number;
  sample: string[];
  available: boolean;
  reason: string;
} {
  if (!record) return { count: 0, sample: [], available: false, reason: '还没有整理过' };
  if (record.sourcesDeletedAt) {
    return { count: 0, sample: [], available: false, reason: '这批源文件已经删过了' };
  }
  const sources = record.files.map((f) => String(f.source ?? '')).filter((s) => s.length > 0);
  if (sources.length === 0) return { count: 0, sample: [], available: false, reason: '这次没有复制成功的文件' };
  return {
    count: sources.length,
    sample: sources.slice(0, 8),
    available: true,
    reason: '',
  };
}

function depthOf(p: string): number {
  return String(p).replace(/\//g, '\\').split('\\').filter((s) => s.length > 0).length;
}

function sameDirText(a: string, b: string): boolean {
  const norm = (p: string): string => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}

/**
 * 删掉这一批的源文件。
 *
 * @param recordPath 上一次整理的记录文件（主进程给的是 userData 下那个）
 */
export async function deleteSourceFiles(
  recordPath: string,
  options?: SourceDeleteOptions | null,
): Promise<SourceDeleteResult> {
  const empty: SourceDeleteResult = {
    ok: false,
    changed: false,
    message: '',
    plannedFiles: 0,
    deletedFiles: 0,
    skippedFiles: 0,
    removedDirs: 0,
    files: [],
    dirs: [],
  };

  const loaded = loadRunRecord(String(recordPath ?? ''));
  const record = loaded ? normalizeRunRecord(loaded) : null;
  if (!record) {
    return { ...empty, message: '没有可用的整理记录：先分拣一次，再来决定要不要删源文件。' };
  }

  const plan = sourceDeletePlan(record);
  if (!plan.available) {
    return {
      ...empty,
      ok: true,
      plannedFiles: record.files.length,
      message: `${plan.reason}：这次没有删任何东西。`,
    };
  }

  const trash = typeof options?.trash === 'function' ? options?.trash : null;
  if (!trash) {
    return {
      ...empty,
      plannedFiles: record.files.length,
      message: '这个环境不能把文件移到回收站，所以一个都没删（此操作不可逆，宁可不动）。',
    };
  }

  const files: SourceDeleteFileOutcome[] = [];
  const deletedSources: string[] = [];

  for (const entry of record.files) {
    const source = String(entry?.source ?? '');
    const target = String(entry?.target ?? '');
    if (source.length === 0) continue;
    if (!fs.existsSync(target)) {
      files.push({
        source,
        target,
        action: 'skipped',
        reason: '输出里那份已经不在了（被撤销或手动删了），不敢删源文件',
      });
      continue;
    }
    if (!fs.existsSync(source)) {
      files.push({ source, target, action: 'skipped', reason: '原文件已经不在了，跳过' });
      continue;
    }
    try {
      await trash(source);
      files.push({
        source,
        target,
        action: 'deleted',
        reason: '输出里那份还在，按你的确认把源文件移到回收站',
      });
      deletedSources.push(source);
    } catch (err) {
      files.push({ source, target, action: 'skipped', reason: `删不掉：${describeError(err)}` });
    }
  }

  // ---- 目录：只清「本次源文件夹里、因为删源而变空」的那些，绝不递归 ----
  const dirs: SourceDeleteDirOutcome[] = [];
  if (record.sourceRoots.length > 0 && deletedSources.length > 0) {
    const candidates = new Set<string>();
    for (const source of deletedSources) {
      let dir = path.dirname(source);
      // 往上收集到源文件夹根为止（根自己也收）
      for (;;) {
        const rootHit = record.sourceRoots.find((r) => sameDirText(r, dir));
        if (rootHit) {
          candidates.add(rootHit);
          break;
        }
        const insideRoot = record.sourceRoots.some((r) => isInsideDir(dir, r));
        if (!insideRoot) break;
        candidates.add(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    const sorted = Array.from(candidates).sort((a, b) => depthOf(b) - depthOf(a));
    for (const dir of sorted) {
      if (!fs.existsSync(dir)) {
        dirs.push({ dir, action: 'skipped', reason: '这个目录已经不在了，跳过' });
        continue;
      }
      try {
        fs.rmdirSync(dir); // 只在空的时候成功
        dirs.push({ dir, action: 'removed', reason: '这个源文件夹里的文件都删完了、目录空了，一并删掉' });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code ?? '';
        dirs.push({
          dir,
          action: 'skipped',
          reason:
            code === 'ENOTEMPTY' || code === 'EEXIST'
              ? '里面还有东西（不是这次删的那些），留着不动'
              : `清不掉：${describeError(err)}（可能被别的程序占用）`,
        });
      }
    }
  }

  const deletedFiles = files.filter((f) => f.action === 'deleted').length;
  const skippedFiles = files.filter((f) => f.action === 'skipped').length;
  const removedDirs = dirs.filter((d) => d.action === 'removed').length;

  const stamp = (options?.now ?? new Date()).toISOString();
  const updated: RunRecord = { ...record, sourcesDeletedAt: stamp };
  const saved = saveRunRecord(String(recordPath ?? ''), updated);

  const parts = [
    `源文件已移到回收站：${deletedFiles} 个${removedDirs > 0 ? `、空了 ${removedDirs} 个源文件夹` : ''}`,
  ];
  if (skippedFiles > 0) parts.push(`跳过 ${skippedFiles} 个（原因见下）`);
  parts.push('回收站里的东西可以还原');
  if (!saved.ok) parts.push(`（注意：记录没能标记成「已删源」，下次可能重复问：${saved.message}）`);

  const auditLines = [`[${stamp}] 删源文件 ${deletedFiles} 个（记录：${record.outputDir}）`];
  for (const f of files) auditLines.push(`  文件 ${f.action} ${f.source} —— ${f.reason}`);
  for (const d of dirs) auditLines.push(`  目录 ${d.action} ${d.dir} —— ${d.reason}`);
  if (typeof options?.auditPath === 'string') appendDeleteAudit(options.auditPath, auditLines);

  return {
    ok: true,
    changed: deletedFiles > 0,
    message: parts.join('；'),
    plannedFiles: record.files.length,
    deletedFiles,
    skippedFiles,
    removedDirs,
    files,
    dirs,
  };
}
