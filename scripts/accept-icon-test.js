/**
 * 验收第 21 条：软件图标（accept-icon-test.js -> 图标OK）
 * ------------------------------------------------------------------
 * 纯逻辑，不碰界面、不碰网络：图标是「资源 + 接线」，判据钉在四件事上：
 *   1. 源文件 assets/icon.svg 是合法 SVG（resvg 真能解析，viewBox 是 512）；
 *   2. assets/icon.png 是 256×256 的 PNG（界面 / 文档用）；
 *   3. assets/icon.ico 结构合法：ICONDIR + 每条目录项自洽、七个尺寸一个不少、
 *      且 256 那条的字节与 icon.png 完全一致（同一份矢量稿出来，不许两张皮）；
 *   4. 接线没断：src/main.ts 与编译产物 out/main.js 真的把 out/assets/icon.ico 传给了
 *      BrowserWindow，copy-assets 也真的把三件图标拷进了 out/assets。
 * 探针（坏样本必须被判失败，防「只查文件存在」的朴素实现）：
 *   - ICO 头改成 type=0（光标）-> 必须报错；
 *   - 把某条目录项的数据截短（offset+size 越界）-> 必须报错；
 *   - 把 256 条目的字节换掉（与 icon.png 不一致）-> 必须报错。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const failures = [];
function check(name, ok, why) {
  if (ok) {
    console.log(`  ok ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${why ? `：${why}` : ''}`);
  }
}

/** 校验一段 ICO：返回 { sizes: number[] }，任何不合法都抛错（探针也用这一个函数判） */
function checkIco(buf) {
  if (buf.length < 6) throw new Error('ICO 太短，连 ICONDIR 都装不下');
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0) throw new Error(`ICONDIR reserved 必须是 0，实际 ${reserved}`);
  if (type !== 1) throw new Error(`ICONDIR type 必须是 1（图标），实际 ${type}`);
  if (count < 1) throw new Error('ICONDIR 一条目录项都没有');

  const sizes = [];
  let png256 = null;
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    if (at + 16 > buf.length) throw new Error(`第 ${i + 1} 条目录项越界`);
    const w = buf.readUInt8(at);
    const h = buf.readUInt8(at + 1);
    const size = (w === 0 ? 256 : w) === (h === 0 ? 256 : h) ? (w === 0 ? 256 : w) : -1;
    if (size < 0) throw new Error(`第 ${i + 1} 条目录项宽高不一致（${w}×${h}）`);
    const bytesInRes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (offset + bytesInRes > buf.length) {
      throw new Error(`第 ${i + 1} 条目录项（${size}px）数据越界：${offset}+${bytesInRes} > ${buf.length}`);
    }
    if (bytesInRes < 1) throw new Error(`第 ${i + 1} 条目录项（${size}px）没有数据`);
    if (size === 256) {
      const data = buf.subarray(offset, offset + bytesInRes);
      if (data.readUInt32LE(0) !== 0x474e5089) throw new Error('256px 条目不是 PNG（大尺寸应当用 PNG 条目）');
      png256 = data;
    }
    sizes.push(size);
  }
  return { sizes, png256 };
}

console.log('第 21 条验收：软件图标');

// ---- 1. 矢量源文件 ----
const svgPath = join(projectRoot, 'assets', 'icon.svg');
check('assets/icon.svg 存在', existsSync(svgPath));
const svgText = readFileSync(svgPath, 'utf8');
const viewBox = /viewBox="0 0 512 512"/.test(svgText);
check('icon.svg viewBox 是 512', viewBox);
let renderedOk = false;
try {
  const img = new Resvg(svgText, { fitTo: { mode: 'width', value: 64 } }).render();
  renderedOk = img.width === 64 && img.height === 64;
} catch (err) {
  console.error(`  resvg 解析失败：${err.message}`);
}
check('icon.svg 能被 resvg 真解析', renderedOk);

// ---- 2. PNG ----
const pngPath = join(projectRoot, 'assets', 'icon.png');
check('assets/icon.png 存在', existsSync(pngPath));
const png = readFileSync(pngPath);
check('icon.png 是 PNG', png.readUInt32LE(0) === 0x474e5089);
check('icon.png 是 256×256', png.readUInt32BE(16) === 256 && png.readUInt32BE(20) === 256,
  `实际 ${png.readUInt32BE(16)}×${png.readUInt32BE(20)}`);

// ---- 3. ICO 结构 ----
const icoPath = join(projectRoot, 'assets', 'icon.ico');
check('assets/icon.ico 存在', existsSync(icoPath));
const ico = readFileSync(icoPath);
let icoInfo = null;
let icoError = null;
try {
  icoInfo = checkIco(ico);
} catch (err) {
  icoError = err;
}
check('icon.ico 结构合法', icoError === null, icoError?.message);
const wantSizes = [16, 24, 32, 48, 64, 128, 256].join(',');
check('icon.ico 七个尺寸一个不少', icoInfo?.sizes.join(',') === wantSizes,
  `实际 ${icoInfo?.sizes.join(',')}`);
check('icon.ico 的 256 条目与 icon.png 字节一致',
  Buffer.compare(icoInfo?.png256 ?? Buffer.alloc(0), png) === 0);

// ---- 4. 接线 ----
const mainSrc = readFileSync(join(projectRoot, 'src', 'main.ts'), 'utf8');
check('src/main.ts 给 BrowserWindow 传了 icon',
  /iconPath/.test(mainSrc) && /'assets',\s*'icon\.ico'/.test(mainSrc) && /icon:\s*iconPath/.test(mainSrc));
const mainBuiltPath = join(projectRoot, 'out', 'main.js');
check('out/main.js 存在（先 npm run build）', existsSync(mainBuiltPath));
const mainBuilt = readFileSync(mainBuiltPath, 'utf8');
check('编译产物 out/main.js 也带上了图标接线',
  /'assets',\s*'icon\.ico'/.test(mainBuilt) && /icon:\s*\w+/.test(mainBuilt));
for (const f of ['icon.ico', 'icon.png', 'icon.svg']) {
  check(`out/assets/${f} 已被 copy-assets 拷进产物`, existsSync(join(projectRoot, 'out', 'assets', f)));
}
const html = readFileSync(join(projectRoot, 'src', 'renderer', 'index.html'), 'utf8');
check('界面侧栏品牌位用的是软件图标', /brand-mark"\s+src="\.\.\/assets\/icon\.png"/.test(html));

// ---- 5. 探针：坏样本必须被判失败（同一个 checkIco，不许另立软标准） ----
const corruptedType = Buffer.from(ico);
corruptedType.writeUInt16LE(0, 2); // type=0 是光标不是图标
let probe1 = false;
try { checkIco(corruptedType); } catch { probe1 = true; }
check('探针：type 改成光标必须报错', probe1);

const corruptedBounds = Buffer.from(ico);
corruptedBounds.writeUInt32LE(corruptedBounds.length + 100, 6 + 8 + 4); // 第 1 条 offset+size 越界
let probe2 = false;
try { checkIco(corruptedBounds); } catch { probe2 = true; }
check('探针：目录项数据越界必须报错', probe2);

const corruptedPng = Buffer.from(ico);
const lastEntry = 6 + (corruptedPng.readUInt16LE(4) - 1) * 16;
const lastOff = corruptedPng.readUInt32LE(lastEntry + 12);
corruptedPng[lastOff + 10] = (corruptedPng[lastOff + 10] + 1) & 0xff; // 动 256 条目里的一个字节
let probe3 = false;
try {
  const info = checkIco(corruptedPng);
  if (Buffer.compare(info.png256, png) !== 0) probe3 = true; // 与 icon.png 两张皮 -> 判失败
} catch { probe3 = true; }
check('探针：256 条目被换掉必须判失败', probe3);

// ---- 探针有效性自检：好样本必须能通过同一个 checkIco ----
check('探针有效性：真 ICO 能通过同一个 checkIco', icoError === null);

if (failures.length > 0) {
  console.error(`图标验收失败（${failures.length} 条）：${failures.join(' / ')}`);
  process.exit(1);
}
console.log('图标OK');
