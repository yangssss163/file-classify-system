/**
 * 纯逻辑：**上一次整理的记录** + **撤销上一次整理**。**不依赖 Electron**（文件路径由调用方给）。
 *
 * 本片的红线（一条都不能松）：
 *  1. **只复制不移动、绝不删原文件**。撤销**只删**「记录里列出、且确实是本次复制出来的」那些目标文件；
 *  2. 记录里混进指向源文件夹的路径（坏记录）→ **跳过并说明**，绝不硬删；
 *  3. 撤销后**不许**删源文件夹里的任何东西（连「由程序创建的空目录」也不行，只要它在源文件夹里/之下）；
 *  4. 记录里那个文件的大小跟当前磁盘上的对不上（用户改过 / 换过一个同名文件）→ **跳过并说明**，绝不删；
 *  5. 单个文件删不掉（被占用 / 没权限）→ 跳过、记原因、**继续处理后面的**，绝不整体崩；
 *  6. 撤销是**幂等**的：撤过一次就标记「已撤销」，再撤一次不删任何东西、不报错，给一句人话；
 *  7. 记录是**持久化**的（一个 JSON 文件）：关掉程序再打开，仍然能撤销上一次整理；
 *  8. **输出根目录本身永不删除**：那是用户自己选的目录，撤销只清它下面「由程序新建、且变空」的分类夹。
 *     （用户报过「目的文件夹消失了」—— 旧实现会把整批撤空的输出根一起 rmdir 掉，看起来就像文件夹自己没了。）
 *     每删一个文件 / 清一个目录都写一行**删除审计**（`organizer-delete-audit.log`），方便以后追。
 *
 * 「什么都不删」也是成功：本文件的函数**一律不抛异常**，任何异常都变成人话原因。
 */
import * as fs from 'fs';
import * as path from 'path';
import { describeError } from './copyFiles';
import { isInsideDir, sameDir } from './outputDirection';

/** 记录文件的固定文件名（放在 userData 目录下）。 */
export const RUN_RECORD_FILE_NAME = 'organizer-last-run.json';

/**
 * **删除审计**的固定文件名（放在 userData 目录下，和记录同一个目录）。
 *
 * 为什么要有它：用户报过一个偶发问题 ——「目的文件夹消失了，可能是软件关闭后自动清除了？」。
 * 程序里唯一会删东西的地方就是这里（撤销），所以撤销每删一个文件 / 一个目录都往这份日志里记一行。
 * 以后真再遇到「文件夹不见了」，打开这份日志就能判断到底是不是程序干的（里面没有记录 = 不是程序干的）。
 */
export const RUN_AUDIT_FILE_NAME = 'organizer-delete-audit.log';

/** 记录格式版本，便于以后改动时不误读（"1/2" 那种字符串，写成数字 "2" 也能认）。 */
export const RUN_RECORD_SCHEMA_VERSION = '1';

/** 记录里一个「本次由程序复制出来的文件」。 */
export interface RunRecordFile {
  /** 原文件路径（给人看；撤销绝不碰它） */
  source: string;
  /** 本次复制出来的目标路径（撤销只删这一个） */
  target: string;
  /** 复制成功时这个文件有多少字节（撤销时拿它对；对不上就跳过） */
  size: number;
  /** 是不是因为同名冲突换过名 */
  renamed: boolean;
}

/** 没成功、因此**不在**可撤销范围内的文件。 */
export interface RunRecordFailure {
  source: string;
  reason: string;
}

/** 一次「开始整理」的完整记录。 */
export interface RunRecord {
  schema: string;
  /** 这一次整理是什么时候开始 / 结束的（ISO 字符串） */
  startedAt: string;
  finishedAt: string;
  /** 本次的输出根目录（撤销只看它下面） */
  outputDir: string;
  /** 本次拖入/选中的源文件夹（安全底线：撤销绝不碰这些路径及它们下面的东西） */
  sourceRoots: string[];
  /** 本次要整理的文件（散文件模式的「源」；也用于安全校验） */
  sourceFiles: string[];
  /** 本次由程序复制出来的每个文件的目标路径（**只有复制成功的**） */
  files: RunRecordFile[];
  /** 本次由程序（新）创建出来的目录（深的在前，撤销时由深到浅清） */
  directories: string[];
  /** 成功数 = files.length（明写一遍，方便给人看/给测试核） */
  successCount: number;
  /** 失败数 */
  failureCount: number;
  /** 失败的那些为什么没撤：一句话说清口径 */
  failureNote: string;
  /** 失败明细（原因给人看） */
  failures: RunRecordFailure[];
  /** 已经撤销过的时间（ISO 字符串）；null = 还没撤过，可以撤 */
  undoneAt: string | null;
  /** 已经删过源文件的时间（ISO 字符串）；null/缺省 = 还没删过。删源文件是用户另外点的一次动作 */
  sourcesDeletedAt?: string | null;
}

/** 撤销时一个文件的处置结果。 */
export interface UndoFileOutcome {
  target: string;
  source: string;
  /** 删掉了 / 跳过了 */
  action: 'deleted' | 'skipped';
  /** 人话原因（删掉时也有：说清为什么删它） */
  reason: string;
}

/** 撤销时一个目录的处置结果。 */
export interface UndoDirOutcome {
  dir: string;
  action: 'removed' | 'skipped';
  reason: string;
}

/** 撤销结果（人话报告 + 机器可判的数字）。 */
export interface UndoResult {
  ok: boolean;
  /** 干净地撤完了（没有跳过的东西）*/
  clean: boolean;
  /** 这次调用有没有动手删东西（幂等时是 false） */
  changed: boolean;
  message: string;
  outputDir: string;
  /** 记录里的目标文件总数（可撤销范围的大小） */
  plannedFiles: number;
  /** 记录里由程序创建的目录总数 */
  plannedDirs: number;
  /** 真删掉的文件数 */
  deletedFiles: number;
  /** 跳过的文件数 */
  skippedFiles: number;
  /** 真清掉的空目录数 */
  removedDirs: number;
  /** 没清掉的目录数 */
  skippedDirs: number;
  files: UndoFileOutcome[];
  dirs: UndoDirOutcome[];
}

/** 撤销开始时的一句人话（界面上的警告；措辞与撤销报告分开，便于核对）。 */
export function undoWarningOf(record: RunRecord | null): string {
  if (!record) return '没有可撤销的整理：还没有整理过。';
  const n = Array.isArray(record.files) ? record.files.length : 0;
  return (
    `只会删掉这次复制到输出目录的那 ${n} 个文件（输出目录：${record.outputDir}），` +
    `以及由程序创建、撤销后变空的目录；原文件一个都不会动。`
  );
}

/** 空记录（读不到记录文件时用）。 */
function emptyRecord(filePath: string): RunRecord {
  return {
    schema: RUN_RECORD_SCHEMA_VERSION,
    startedAt: '',
    finishedAt: '',
    outputDir: '',
    sourceRoots: [],
    sourceFiles: [],
    files: [],
    directories: [],
    successCount: 0,
    failureCount: 0,
    failureNote: '',
    failures: [],
    undoneAt: null,
  };
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? '')).filter((x) => x.length > 0);
}

/** 把外部来的内容收拾成规矩的记录形状（缺项补空；坏项丢掉）。 */
export function normalizeRunRecord(input: unknown): RunRecord {
  const raw = (input ?? {}) as Partial<RunRecord>;
  const files: RunRecordFile[] = [];
  for (const f of Array.isArray(raw.files) ? raw.files : []) {
    const item = (f ?? {}) as Partial<RunRecordFile>;
    const target = String(item.target ?? '');
    if (target.length === 0) continue;
    files.push({
      source: String(item.source ?? ''),
      target,
      size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : -1,
      renamed: item.renamed === true,
    });
  }
  const failures: RunRecordFailure[] = [];
  for (const f of Array.isArray(raw.failures) ? raw.failures : []) {
    const item = (f ?? {}) as Partial<RunRecordFailure>;
    failures.push({ source: String(item.source ?? ''), reason: String(item.reason ?? '') });
  }
  return {
    schema: String(raw.schema ?? RUN_RECORD_SCHEMA_VERSION),
    startedAt: String(raw.startedAt ?? ''),
    finishedAt: String(raw.finishedAt ?? ''),
    outputDir: String(raw.outputDir ?? ''),
    sourceRoots: strList(raw.sourceRoots),
    sourceFiles: strList(raw.sourceFiles),
    files,
    directories: strList(raw.directories),
    successCount: typeof raw.successCount === 'number' ? raw.successCount : files.length,
    failureCount: typeof raw.failureCount === 'number' ? raw.failureCount : failures.length,
    failureNote: String(raw.failureNote ?? ''),
    failures,
    undoneAt: raw.undoneAt ? String(raw.undoneAt) : null,
    sourcesDeletedAt: raw.sourcesDeletedAt ? String(raw.sourcesDeletedAt) : null,
  };
}

/** 记录序列化成落盘的 JSON 文本。 */
export function serializeRunRecord(record: RunRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * 读记录文件。读不到 / 内容坏了 → 返回 null（调用方给一句人话），**绝不抛异常**。
 * 允许外面传内容进来（`parseRunRecord`）：跨重启可用性靠「关掉程序再打开，文件还在」证明。
 */
export function parseRunRecord(text: string): RunRecord | null {
  try {
    const data = JSON.parse(text) as unknown;
    if (data === null || typeof data !== 'object') return null;
    const record = normalizeRunRecord(data);
    if (record.outputDir.length === 0) return null;
    return record;
  } catch {
    return null;
  }
}

/** 从文件读记录；读不到/坏了返回 null。 */
export function loadRunRecord(filePath: string): RunRecord | null {
  const target = String(filePath ?? '');
  if (target.length === 0) return null;
  try {
    if (!fs.existsSync(target)) return null;
    return parseRunRecord(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

/** 把记录写到文件（目录不存在就建）。失败给人话，不抛出去。 */
export function saveRunRecord(filePath: string, record: RunRecord): { ok: boolean; message: string; filePath: string } {
  const target = String(filePath ?? '');
  try {
    if (target.length === 0) return { ok: false, message: '记录文件路径为空，没能保存', filePath: target };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serializeRunRecord(normalizeRunRecord(record)), 'utf8');
    return { ok: true, message: `已记下这次整理的 ${record?.files?.length ?? 0} 个文件，之后可以撤销`, filePath: target };
  } catch (err) {
    return { ok: false, message: `记这次整理失败（${describeError(err)}），这次没法撤销`, filePath: target };
  }
}

/**
 * 界面上要显示的那一份「上一次整理」摘要。没有可撤销的整理时 `available=false` 并给出原因。
 */
export interface LastRunSummary {
  available: boolean;
  /** 没有可撤销的整理时的人话原因；有就是空串 */
  reason: string;
  outputDir: string;
  fileCount: number;
  dirCount: number;
  successCount: number;
  failureCount: number;
  failureNote: string;
  finishedAt: string;
  undoneAt: string | null;
  /** 界面上那一句（有可撤销的整理时：输出到哪、成功几个、可撤销） */
  message: string;
}

/** 把记录收成界面上要显示的一行。 */
export function summarizeLastRun(record: RunRecord | null): LastRunSummary {
  if (!record) {
    return {
      available: false,
      reason: '没有可撤销的整理',
      outputDir: '',
      fileCount: 0,
      dirCount: 0,
      successCount: 0,
      failureCount: 0,
      failureNote: '',
      finishedAt: '',
      undoneAt: null,
      message: '没有可撤销的整理',
    };
  }
  const fileCount = record.files.length;
  if (record.undoneAt) {
    return {
      available: false,
      reason: '上一次整理已经撤销过了',
      outputDir: record.outputDir,
      fileCount,
      dirCount: record.directories.length,
      successCount: record.successCount,
      failureCount: record.failureCount,
      failureNote: record.failureNote,
      finishedAt: record.finishedAt,
      undoneAt: record.undoneAt,
      message: `上一次整理已经撤销过了（${record.outputDir}）`,
    };
  }
  if (fileCount === 0) {
    return {
      available: false,
      reason: '上一次整理没有复制出任何文件，没有可撤销的东西',
      outputDir: record.outputDir,
      fileCount,
      dirCount: record.directories.length,
      successCount: record.successCount,
      failureCount: record.failureCount,
      failureNote: record.failureNote,
      finishedAt: record.finishedAt,
      undoneAt: null,
      message: `上一次整理没有复制出任何文件（输出：${record.outputDir}）`,
    };
  }
  return {
    available: true,
    reason: '',
    outputDir: record.outputDir,
    fileCount,
    dirCount: record.directories.length,
    successCount: record.successCount,
    failureCount: record.failureCount,
    failureNote: record.failureNote,
    finishedAt: record.finishedAt,
    undoneAt: null,
    message: `上一次整理：输出到 ${record.outputDir}，成功 ${record.successCount} 个，可撤销`,
  };
}

function fileSizeOf(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** `dir` 是不是在源范围内（= 某个源文件夹 / 某个源文件所在目录，或它们下面的任何东西）。 */
function insideSourceScope(p: string, record: RunRecord): boolean {
  const scopes: string[] = [];
  for (const r of record.sourceRoots ?? []) if (String(r).length > 0) scopes.push(String(r));
  for (const f of record.sourceFiles ?? []) {
    const s = String(f);
    if (s.length === 0) continue;
    const dir = s.slice(0, Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')));
    if (dir.length > 0) scopes.push(dir);
  }
  return scopes.some((s) => sameDir(p, s) || isInsideDir(p, s));
}

/** 目录深度（路径段数），用来把记录里的目录按「深的先删」排序。 */
function depthOf(p: string): number {
  return String(p).replace(/\//g, '\\').split('\\').filter((s) => s.length > 0).length;
}

/** 撤销时可以带的选项。 */
export interface UndoOptions {
  /**
   * 删除审计日志的位置（`organizer-delete-audit.log`）。
   * 给了就把这次删掉的每个文件 / 每个目录记一行；不给就不记（验收里多数用例不关心它）。
   */
  auditPath?: string | null;
}

/** 往审计日志里追加几行（写不进去也绝不影响撤销本身）。 */
export function appendDeleteAudit(auditPath: string, lines: readonly string[]): void {
  const target = String(auditPath ?? '').trim();
  if (target.length === 0 || lines.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    /* 记不下来不算失败：撤销本身该做的都做了 */
  }
}

/** 把一个目标路径翻译成「为什么不能删」的人话；能删就返回 null。 */
function whyNotDeletable(entry: RunRecordFile, record: RunRecord, outDir: string): string | null {
  const target = String(entry.target ?? '');
  if (target.length === 0) return '记录里这一条没有目标路径，不敢删';
  if (outDir.length === 0) return '记录里没有输出根目录，不敢删';
  // 安全底线（先判这条）：绝不删源文件夹里的任何东西——哪怕记录里混进了这样一条、
  // 而且它碰巧落在输出目录里（例如输出目录就选在源文件夹里）也不许删。
  if (insideSourceScope(target, record)) {
    return '这个路径在源文件夹里（记录里混进了指向源文件夹的路径），属于原文件的地盘，绝不删，跳过';
  }
  // 只删「记录里列出的目标路径」——其余一律不碰（这是本片的准则）
  if (!isInsideDir(target, outDir)) {
    return `这个路径不在本次的输出目录里（输出目录 ${outDir}），不在撤销范围内，跳过`;
  }
  return null;
}

/**
 * 撤销上一次整理。
 *
 * @param filePath 记录文件路径（主进程给的是 userData 下那个；验收给的是临时路径）
 * @param options.auditPath 删除审计日志的位置（给了就把「删了什么」记下来；不给就不记）
 */
export function undoLastRun(filePath: string, options?: UndoOptions | null): UndoResult {
  const target = String(filePath ?? '');
  const auditPath = typeof options?.auditPath === 'string' ? options.auditPath : '';
  const record = loadRunRecord(target);

  if (!record) {
    return {
      ok: true,
      clean: true,
      changed: false,
      message: '没有可撤销的整理：还没读到上一次整理的记录。',
      outputDir: '',
      plannedFiles: 0,
      plannedDirs: 0,
      deletedFiles: 0,
      skippedFiles: 0,
      removedDirs: 0,
      skippedDirs: 0,
      files: [],
      dirs: [],
    };
  }

  const outDir = String(record.outputDir ?? '');
  const plannedFiles = record.files.length;
  const plannedDirs = record.directories.length;
  const files: UndoFileOutcome[] = [];
  const dirs: UndoDirOutcome[] = [];

  // 幂等：撤过一次就再也不动手（不报错，给一句人话）
  if (record.undoneAt) {
    return {
      ok: true,
      clean: true,
      changed: false,
      message: `上一次整理已经撤销过了（${record.undoneAt}），这次没有再删任何东西。`,
      outputDir: outDir,
      plannedFiles,
      plannedDirs,
      deletedFiles: 0,
      skippedFiles: 0,
      removedDirs: 0,
      skippedDirs: 0,
      files: [],
      dirs: [],
    };
  }

  /* ---------- ① 逐个删「记录里列出的那些文件」 ---------- */
  for (const entry of record.files) {
    const t = String(entry.target ?? '');
    const bad = whyNotDeletable(entry, record, outDir);
    if (bad) {
      files.push({ target: t, source: String(entry.source ?? ''), action: 'skipped', reason: bad });
      continue;
    }

    const size = fileSizeOf(t);
    if (size === null) {
      files.push({
        target: t,
        source: String(entry.source ?? ''),
        action: 'skipped',
        reason: '这个文件已经不在了（可能你自己删过或挪走了），没有可删的',
      });
      continue;
    }
    if (entry.size >= 0 && size !== entry.size) {
      files.push({
        target: t,
        source: String(entry.source ?? ''),
        action: 'skipped',
        reason: `内容/大小与记录不符（记录是 ${entry.size} 字节，现在是 ${size} 字节）：这个文件跟本次整理复制出来的那份不是一回事，跳过不删`,
      });
      continue;
    }

    try {
      fs.unlinkSync(t);
      files.push({
        target: t,
        source: String(entry.source ?? ''),
        action: 'deleted',
        reason: '这是本次整理复制出来的文件（大小与记录一致），已删掉；原文件没动',
      });
    } catch (err) {
      files.push({
        target: t,
        source: String(entry.source ?? ''),
        action: 'skipped',
        reason: `删不掉：${describeError(err)}（跳过它，继续处理后面的）`,
      });
    }
  }

  /* ---------- ② 清掉「由程序创建、撤销后变空」的目录（深的先清） ---------- */
  const sortedDirs = record.directories
    .map((d) => String(d ?? ''))
    .filter((d) => d.length > 0)
    .sort((a, b) => depthOf(b) - depthOf(a) || b.length - a.length);

  for (const dir of sortedDirs) {
    // 安全底线：源范围里的目录一个都不清（宁可少删、多报告）
    if (insideSourceScope(dir, record)) {
      dirs.push({ dir, action: 'skipped', reason: '这个目录在源文件夹的地盘里，绝不删，跳过' });
      continue;
    }
    if (outDir.length === 0 || (!sameDir(dir, outDir) && !isInsideDir(dir, outDir))) {
      dirs.push({ dir, action: 'skipped', reason: `这个目录不在本次的输出目录里（${outDir}），不在撤销范围内，跳过` });
      continue;
    }
    // 用户报过「目的文件夹（输出根）消失了」：输出根是**用户自己选的目录**，撤销只清它下面
    // 由程序新建的分类夹，根目录本身一概留着 —— 哪怕它也是这次整理新建出来的。
    // （以前的实现会把它一起 rmdir 掉：整批撤完后输出根就没了，看起来就像「文件夹自己消失了」。）
    if (sameDir(dir, outDir)) {
      dirs.push({
        dir,
        action: 'skipped',
        reason: '这是你自己选的输出根目录：撤销只清它下面由程序建的分类夹，根目录留着不动',
      });
      continue;
    }
    try {
      fs.rmdirSync(dir); // 只在**空**的时候才成功；里面还有东西就报错，正是我们要的
      dirs.push({ dir, action: 'removed', reason: '这是本次整理新建的目录，现在空了，已清掉' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      const why =
        code === 'ENOENT'
          ? '这个目录已经不在了，跳过'
          : code === 'ENOTEMPTY' || code === 'EEXIST'
            ? '这个目录里还有东西（你自己加进去的，不是本次整理产生的），留着不动'
            : code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
              ? `清不掉：${describeError(err)}（可能被别的程序占用，跳过）`
              : `清不掉：${describeError(err)}`;
      dirs.push({ dir, action: 'skipped', reason: why });
    }
  }

  const deletedFiles = files.filter((f) => f.action === 'deleted').length;
  const skippedFiles = files.filter((f) => f.action === 'skipped').length;
  const removedDirs = dirs.filter((d) => d.action === 'removed').length;
  const skippedDirs = dirs.filter((d) => d.action === 'skipped').length;

  // 标记「已撤销」：再点一次不许再删任何东西
  const stamp = new Date().toISOString();
  const updated: RunRecord = { ...record, undoneAt: stamp };
  const saved = saveRunRecord(target, updated);

  // 删除审计：删掉/清掉的每一个都记一行（跳过的也记，省得以后查不清「为什么它还在」）
  const auditLines: string[] = [
    `[${stamp}] 撤销（记录 ${target}，输出根 ${outDir}）：删掉 ${deletedFiles} 个文件、清掉 ${removedDirs} 个目录、跳过 ${skippedFiles}/${skippedDirs}`,
  ];
  for (const f of files) auditLines.push(`  文件 ${f.action} ${f.target} —— ${f.reason}`);
  for (const d of dirs) auditLines.push(`  目录 ${d.action} ${d.dir} —— ${d.reason}`);
  appendDeleteAudit(auditPath, auditLines);

  const parts = [`撤销完成：删掉 ${deletedFiles} 个文件、${removedDirs} 个目录`];
  if (skippedFiles > 0 || skippedDirs > 0) {
    parts.push(`跳过 ${skippedFiles} 个文件、${skippedDirs} 个目录（原因见下）`);
  }
  parts.push('输出根目录本身留着不动（那是你自己选的目录）');
  parts.push(`原文件一个都没动（本次整理共复制成功 ${record.successCount} 个）`);
  if (!saved.ok) parts.push(`（注意：记录没能标记成「已撤销」：${saved.message}）`);

  const clean = skippedFiles === 0 && skippedDirs === 0;
  return {
    ok: true,
    clean,
    changed: deletedFiles > 0 || removedDirs > 0 || skippedFiles > 0 || skippedDirs > 0,
    message: parts.join('；'),
    outputDir: outDir,
    plannedFiles,
    plannedDirs,
    deletedFiles,
    skippedFiles,
    removedDirs,
    skippedDirs,
    files,
    dirs,
  };
}

/** 撤销报告的人话明细（界面上一条一行；顶部是 `UndoResult.message`）。 */
export function undoReportLines(result: UndoResult): string[] {
  const out: string[] = [];
  for (const f of result?.files ?? []) {
    out.push(`[${f.action === 'deleted' ? '删除' : '跳过'}] ${f.target} —— ${f.reason}`);
  }
  for (const d of result?.dirs ?? []) {
    out.push(`[${d.action === 'removed' ? '清掉目录' : '跳过目录'}] ${d.dir} —— ${d.reason}`);
  }
  return out;
}

/** 界面上那份「上一次整理」的摘要（`LastRunSummary` 的别名，界面上叫这个名字更顺）。 */
export type UndoSummary = LastRunSummary;

/** 点一次「撤销上一次整理」的结果：撤销报告 + 撤销之后的最新摘要（按钮据此变回不可点）。 */
export interface UndoRunOutcome {
  result: UndoResult;
  summary: LastRunSummary;
}
