/**
 * 构建收尾：把 renderer 的静态资源（html/css）复制到 out/renderer。
 * 只有编译产物落在 out/，源码目录里永远只有源码。
 * 注意：产物目录的清理在 package.json 的 prebuild（npm run clean）里做，
 * 那一步在 tsc 之前；这里再删就会把刚编出来的 js 一起删掉。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const from = join(projectRoot, 'src', 'renderer');
const to = join(projectRoot, 'out', 'renderer');

mkdirSync(to, { recursive: true });

const assets = ['index.html', 'style.css'];
for (const asset of assets) {
  const src = join(from, asset);
  if (!existsSync(src)) {
    console.error(`缺少静态资源：${src}`);
    process.exit(1);
  }
  copyFileSync(src, join(to, asset));
  console.log(`copied ${asset} -> out/renderer/${asset}`);
}
