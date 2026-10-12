# 工程记录

## 01 拖入并按后缀复制分类
- 能做什么：把一堆文件拖进窗口 → 选输出文件夹 → 点「开始整理」→ 输出文件夹里出现按后缀分好的五个分类文件夹（01_图片 / 02_文档 / 03_音视频 / 04_压缩包 / 05_其他）。只复制，不移动，不删原文件；同名自动改成「原名 (1).后缀」。
- 验收：`npm run 验收` 打印 分类逻辑OK + 复制落地OK + 窗口活着OK + 验收通过，退出码 0。
- 存档点：green/01
- 环境注意（重要，别再走一遍）：
  1. Electron 的 `node_modules\electron\dist` 需要有 `ALL APPLICATION PACKAGES`(S-1-15-2-1) 的读+执行权限，否则真程序启动时在 `install_dir_access.cc:52` 直接 FATAL 退出（此时连主进程的 JS 都还没跑）。已授权的位置：`node_modules\electron\dist`、工作区根 `E:\ideas\文件分类器`、`E:\ideas`（命令 `icacls <目录> /grant *S-1-15-2-1:(OI)(CI)(RX) /C`）。
  2. `electron.exe --version` **不经过**上面那道检查（它在浏览器进程起来之前就被启动器直接回答了）：用它当「能不能启动」的证据会骗人，必须用真程序启动（`npm run start` 或验收第 3 条那种方式）来判。
  3. 在 DSH 沙箱化的 shell 里，真程序启动会被上面那道检查拦住（实测：等待 2~3 秒即提前退出、stdout 无 ORGANIZER_READY、标记文件不存在）；同一条命令在**非沙箱的普通 PowerShell 窗口**里则三条全绿（等待 2 秒、未提前退出、stdout 有标记、标记文件存在，标记内容 `ORGANIZER_READY ... (did-finish-load)`）。**因此验收第 3 条必须在非沙箱的普通 PowerShell 窗口里跑**；第 1、2 条在沙箱里也能跑。
  4. 本机 `powershell` 是 Windows PowerShell 5.1（没有 `pwsh`）：它会把外部程序写往 stderr 的一句 `npm notice` 升级成致命错误（脚本里 `$ErrorActionPreference='Stop'` 时），所以验收脚本用 `Continue` + `$LASTEXITCODE` 判定成败。**【03 更正】本条后半句已作废**：`验收.ps1` 现在开头把 `[Console]::OutputEncoding`/`$OutputEncoding` 设为 UTF-8、读日志一律 `-Encoding UTF8`，日志是 **UTF-8**，别按 GBK 解（按 GBK 读会得到「鎷掔粷璁块棶」这种乱码）。

## 03 修「窗口里按钮和拖拽全是死的」+ 拖入取路径改对
- 能做什么：在真窗口里能把文件拖进来（一次多个）、能点「选择文件」挑文件、能预览；界面上「已选 N 个文件」如实变化。
- 故障与根因：窗口一打开，界面脚本第 2 行 `Object.defineProperty(exports, "__esModule", ...)` 抛 `Uncaught ReferenceError: exports is not defined`，脚本当场死掉、所有按钮和拖拽监听器一个都没挂上 → 表现为「点什么都没反应、文件也拖不进去」；另外 drop 里用 `File.path` 取路径，该属性在 Electron 32 已移除（本项目 44），所以即使脚本活着也拿不到路径。
- 修法：界面侧单独用 `tsconfig.renderer.json` 编成 ES module 并由 `index.html` 以 `<script type="module">` 加载（产物里零 exports/require/module；preload 与主进程仍是 CommonJS）；取路径改用 `webUtils.getPathForFile`，由 preload 通过 contextBridge 暴露 `pathForFile(file)`。
- 验收：`npm run 验收` 打印 分类逻辑OK + 复制落地OK + 预览不落盘OK + 拖入取路径OK（第 3 条「窗口活着」仍须在非沙箱 PowerShell 窗口里跑），退出码 0。
- 存档点：green/03
- 教训（重要）：
  1. 界面脚本的产物**必须当成普通脚本在「没有 exports/require/module」的作用域里真跑一遍**才算验过。本片第一次写的探针是死的：它在 Node 里用 `import()` 加载产物，Node 自己提供了 `exports`，于是把 `exports is not defined` 这个真故障掩护过去了。修法是真 ES module 作用域（`vm.SourceTextModule` + `--experimental-vm-modules`）求值 + 产物字节检查，并且用「故意重造旧产物」反证过探针会失败。
  2. `File.path` 在 Electron ≥32 已移除，拖拽取路径只能用 `webUtils.getPathForFile`（只能在 preload 里用）。
  3. 日志编码：Windows PowerShell 5.1 默认按 ANSI/GBK 读文件，Node 写的 UTF-8 日志会读成乱码；`验收.ps1` 现在开头把 `[Console]::OutputEncoding`/`$OutputEncoding` 设为 UTF-8、读日志一律 `-Encoding UTF8`，且该文件必须保持 UTF-8 带 BOM。
