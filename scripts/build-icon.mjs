/**
 * 图标流水线：assets/icon.svg（唯一手写源文件）→ assets/icon.png + assets/icon.ico
 * ------------------------------------------------------------------
 * 跑法：npm run icon
 *
 * 为什么要这个脚本：
 *   - 图标改一次要出 7 个尺寸，手改容易漏、也容易跟矢量稿走样；
 *   - Windows 的窗口 / 任务栏 / 资源管理器只认 .ico，而 ICO 是「一堆小图裹一个头」，
 *     格式本身很简单（ICONDIR + 每图一条目录项 + 图数据），自己写比再引一个打包依赖干净。
 *
 * 出什么：
 *   - assets/icon.png  256×256，带透明 —— 界面里、文档里用
 *   - assets/icon.ico  16/24/32/48/64 走 BMP 位图条目（老一点的 Windows 也认），
 *                      128/256 走 PNG 条目（体积省一大截，Vista 起都支持）
 *
 * 一条硬规矩：只认 assets/icon.svg。脚本不读别的图、不联网、不碰 src/。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const svgPath = join(projectRoot, 'assets', 'icon.svg');
const pngOut = join(projectRoot, 'assets', 'icon.png');
const icoOut = join(projectRoot, 'assets', 'icon.ico');

/** ICO 里 BMP 条目的尺寸（这些用位图，兼容性最好） */
const BMP_SIZES = [16, 24, 32, 48, 64];
/** ICO 里 PNG 条目的尺寸（大图用 PNG，省体积） */
const PNG_SIZES = [128, 256];
/** 单独出一份 PNG 给界面 / 文档用 */
const PLAIN_PNG_SIZE = 256;

function renderPng(size) {
  const svg = readFileSync(svgPath, 'utf8');
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return img.render().asPng();
}

/** RGBA（resvg 出的就是 RGBA）→ BGRA 且按底到顶排，这是 DIB 的规矩 */
function toDib(rgba, size) {
  const rowBytes = size * 4;
  const xor = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y += 1) {
    const srcRow = y * rowBytes;
    const dstRow = (size - 1 - y) * rowBytes;
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  return xor;
}

/** 32 位图标也要带 AND 掩码（1bpp，每行补齐 4 字节）；全 0 = 整图不透明 */
function emptyMask(size) {
  const rowBytes = Math.ceil(size / 32) * 4;
  return Buffer.alloc(rowBytes * size);
}

function bmpEntry(size) {
  const svg = readFileSync(svgPath, 'utf8');
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
  const xor = toDib(rendered.pixels, size);
  const mask = emptyMask(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight：XOR + AND 两张合起来
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(xor.length + mask.length, 20); // biSizeImage
  return Buffer.concat([header, xor, mask]);
}

function main() {
  mkdirSync(join(projectRoot, 'assets'), { recursive: true });
  const entries = [];

  for (const size of BMP_SIZES) {
    entries.push({ size, data: bmpEntry(size), kind: 'bmp' });
  }
  for (const size of PNG_SIZES) {
    entries.push({ size, data: renderPng(size), kind: 'png' });
  }

  // ICONDIR：6 字节头 + 每图一条 16 字节目录项，图数据跟在后面
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = 图标
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((entry, i) => {
    const at = 6 + i * 16;
    dir.writeUInt8(entry.size === 256 ? 0 : entry.size, at); // 256 在字节里记作 0
    dir.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 1);
    dir.writeUInt8(0, at + 2); // 颜色数：0 = 256 色以上
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // planes
    dir.writeUInt16LE(32, at + 6); // bitCount
    dir.writeUInt32LE(entry.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  writeFileSync(icoOut, Buffer.concat([dir, ...entries.map((e) => e.data)]));
  writeFileSync(pngOut, renderPng(PLAIN_PNG_SIZE));

  const list = entries.map((e) => `${e.size}(${e.kind})`).join(' ');
  console.log(`icon.svg -> icon.png (${PLAIN_PNG_SIZE}px), icon.ico [${list}]`);
  console.log(`ico ${(dir.length + entries.reduce((n, e) => n + e.data.length, 0)) / 1024 | 0} KB`);
}

main();
