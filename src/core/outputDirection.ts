/**
 * 纯逻辑：**开工前的输出方向校验**（本片新增的安全护栏）。**不依赖 Electron**。
 *
 * 为什么要有这个文件（用户提出的隐患）：
 *   整理是「把源文件夹整个重建到输出根下」。如果输出目录就是源文件夹本身、或落在源文件夹里面、
 *   或者**是源文件夹的上一级**，那么「原文件夹本身」就会被卷进这次整理的目标范围里，
 *   结果是越整理越乱（甚至在极端情况下把原文件的所在目录当成输出内容重新造一份）。
 *   所以这三种方向一律**不许开工**，并且**一个字节都不写**。
 *
 * 三条判据（都按绝对路径比较，大小写不敏感 —— Windows 语义）：
 *   1. 输出目录 == 某个源文件夹                → 拒绝（会把源文件夹自己当成输出内容）；
 *   2. 输出目录 在 某个源文件夹 之下            → 拒绝（会把整理结果写回源文件夹里）；
 *   3. 输出目录 是 某个源文件夹 的上级          → 拒绝（会把原文件夹卷进去）。
 *      注意：判据 1、2 都漏掉这一种（输出在上面、源在下面，谁都不在谁「之下」），
 *      所以这一条**必须单独判**，不能省。
 *
 * 只有散文件（没有拖入任何源文件夹）时口径不同：只校验「输出目录 != 文件所在目录」。
 *
 * 输出方向允许时给的是**正常方向**（源与输出互不相干，或输出在源的另一侧），
 * 正好对应「同级不同名的两个目录」这种正常用法。
 */

/** 拒绝的原因码（机器可判；界面上不受这个影响）。 */
export type OutputDirectionReason =
  | 'output-is-source'
  | 'output-inside-source'
  | 'output-is-source-parent'
  | 'output-is-file-folder'
  | 'no-output-dir'
  | 'no-files';

/** 校验结论：`ok=false` 时 `message` 必须是一句能直接给用户看的人话。 */
export interface OutputDirectionCheck {
  /** 能不能开工 */
  ok: boolean;
  /** 拒绝原因码；允许时为 null */
  reason: OutputDirectionReason | null;
  /** 人话说明：拒绝时是完整的一句（说清为什么危险、所以什么都没做）；允许时为空串 */
  message: string;
  /** 参与判定的源文件夹（绝对路径；给人看用） */
  sourceRoots: string[];
  /** 参与判定的散文件所在目录（绝对路径；只有散文件模式才有） */
  fileDirs: string[];
  /** 输出目录绝对路径（没给就是空串） */
  outputDir: string;
}

export interface OutputDirectionInput {
  /** 拖入/选中的顶层源文件夹（没有就传空数组/不传） */
  roots?: readonly string[] | null;
  /** 要整理的散文件完整路径（只有散文件模式用；有源文件夹时忽略） */
  files?: readonly string[] | null;
  /** 输出目录（没选就别调用这里；空串会给出拒绝结论） */
  outputDir?: string | null;
}

/** 路径规范化：绝对化 + 反斜杠统一 + 去掉结尾分隔符 + 小写（Windows 大小写不敏感）。 */
function normalizeDir(p: string): string {
  const s = String(p ?? '').trim();
  if (s.length === 0) return '';
  let out = s.replace(/\//g, '\\');
  while (out.length > 3 && out.endsWith('\\')) out = out.slice(0, -1);
  return out.toLowerCase();
}

/** 两个路径是不是同一个（大小写不敏感）。 */
export function sameDir(a: string, b: string): boolean {
  const na = normalizeDir(a);
  const nb = normalizeDir(b);
  return na.length > 0 && na === nb;
}

/** `dir` 是不是正好在 `ancestor` 里面（不含相等）。 */
export function isInsideDir(dir: string, ancestor: string): boolean {
  const d = normalizeDir(dir);
  const a = normalizeDir(ancestor);
  if (d.length === 0 || a.length === 0) return false;
  return d.startsWith(a + '\\');
}

/** 两个方向任一个包含另一个（用于算「互不相干」）。 */
export function isRelatedDir(a: string, b: string): boolean {
  return sameDir(a, b) || isInsideDir(a, b) || isInsideDir(b, a);
}

/** 去重后保留顺序。 */
function uniquePaths(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const p = String(raw ?? '').trim();
    if (p.length === 0) continue;
    const key = normalizeDir(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function dirOfFile(filePath: string): string {
  const s = String(filePath ?? '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : '';
}

function allow(outputDir: string, sourceRoots: string[], fileDirs: string[]): OutputDirectionCheck {
  return { ok: true, reason: null, message: '', sourceRoots, fileDirs, outputDir };
}

function block(
  reason: OutputDirectionReason,
  message: string,
  outputDir: string,
  sourceRoots: string[],
  fileDirs: string[],
): OutputDirectionCheck {
  return { ok: false, reason, message, sourceRoots, fileDirs, outputDir };
}

/**
 * 校验输出方向。**纯计算 + 路径比较**，绝不建目录、绝不写文件、绝不删东西。
 *
 * 判定顺序（有源文件夹时）：
 *   ① 没选输出目录 → 拒绝（一句人话）；
 *   ② 输出 == 某个源文件夹 → 拒绝；
 *   ③ 输出 在某个源文件夹之下 → 拒绝；
 *   ④ 输出 是某个源文件夹的上级 → 拒绝；
 *   ⑤ 其余 → 允许。
 * 只有散文件时：输出 == 某个散文件所在目录 → 拒绝；否则允许（多个散文件来自不同目录时，
 * 只要碰到其中任何一个就等于「在源文件旁边开工」，一律拒绝）。
 */
export function checkOutputDirection(input: OutputDirectionInput): OutputDirectionCheck {
  const outputDir = String(input?.outputDir ?? '');
  const roots = uniquePaths(input?.roots ?? []);
  const files = uniquePaths(input?.files ?? []);

  if (outputDir.trim().length === 0) {
    return block('no-output-dir', '还没选输出文件夹，先点「选择输出文件夹」。这次一个字节都没写。', '', roots, []);
  }

  if (roots.length > 0) {
    // ① 输出就是某个源文件夹本身
    const same = roots.find((r) => sameDir(r, outputDir));
    if (same) {
      return block(
        'output-is-source',
        `输出文件夹就是源文件夹本身（${same}）：整理会把源文件夹自己当成输出内容，原文件夹会被卷进去，所以没有开工，一个字节都没写。请换一个跟源文件夹无关的输出文件夹。`,
        outputDir,
        roots,
        [],
      );
    }
    // ② 输出落在某个源文件夹之下
    const insideAt = roots.find((r) => isInsideDir(outputDir, r));
    if (insideAt) {
      return block(
        'output-inside-source',
        `输出文件夹在源文件夹里面（${insideAt}）：整理会把结果写回源文件夹里，源文件夹会被卷进去，所以没有开工，一个字节都没写。请换一个跟源文件夹无关的输出文件夹。`,
        outputDir,
        roots,
        [],
      );
    }
    // ③ 输出是某个源文件夹的上一级（用户提的那个隐患）
    const parentOf = roots.find((r) => isInsideDir(r, outputDir));
    if (parentOf) {
      return block(
        'output-is-source-parent',
        `输出文件夹是源文件夹的上一级（输出 ${outputDir}，源 ${parentOf}）：整理会把原文件所在文件夹也卷进去，所以没有开工，一个字节都没写。请换一个跟源文件夹无关的输出文件夹。`,
        outputDir,
        roots,
        [],
      );
    }
    return allow(outputDir, roots, []);
  }

  // 只有散文件：没有「源文件夹」这个概念，只校验「输出 != 文件所在目录」
  const fileDirs = uniquePaths(files.map(dirOfFile));
  if (files.length === 0) {
    return block('no-files', '还没有可整理的文件，先拖进来或点「选择文件」「选择文件夹」。这次一个字节都没写。', outputDir, [], []);
  }
  const hitDir = fileDirs.find((d) => sameDir(d, outputDir));
  if (hitDir) {
    return block(
      'output-is-file-folder',
      `输出文件夹就是这些文件所在的文件夹（${hitDir}）：整理会把结果写回原文件旁边，所以没有开工，一个字节都没写。请换一个跟原文件无关的输出文件夹。`,
      outputDir,
      [],
      fileDirs,
    );
  }
  return allow(outputDir, [], fileDirs);
}

/** 给人看的一句话状态（界面上显示用；允许时说明输出方向没问题）。 */
export function describeOutputDirection(check: OutputDirectionCheck): string {
  if (!check) return '';
  if (check.ok) {
    return check.sourceRoots.length > 0 || check.fileDirs.length > 0
      ? '输出方向没问题：输出文件夹跟源互不相干，可以开工。'
      : '';
  }
  return check.message;
}
