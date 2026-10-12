# 工程记录

## 01 拖入并按后缀复制分类
- 能做什么：把一堆文件拖进窗口 → 选输出文件夹 → 点「开始整理」→ 输出文件夹里出现按后缀分好的五个分类文件夹（01_图片 / 02_文档 / 03_音视频 / 04_压缩包 / 05_其他）。只复制，不移动，不删原文件；同名自动改成「原名 (1).后缀」。
- 验收：`npm run 验收` 打印 分类逻辑OK + 复制落地OK + 窗口活着OK + 验收通过，退出码 0。
- 存档点：green/01
- 环境注意（重要，别再走一遍）：
  1. Electron 的 `node_modules\electron\dist` 需要有 `ALL APPLICATION PACKAGES`(S-1-15-2-1) 的读+执行权限，否则真程序启动时在 `install_dir_access.cc:52` 直接 FATAL 退出（此时连主进程的 JS 都还没跑）。已授权的位置：`node_modules\electron\dist`、工作区根 `E:\ideas\文件分类器`、`E:\ideas`（命令 `icacls <目录> /grant *S-1-15-2-1:(OI)(CI)(RX) /C`）。
  2. `electron.exe --version` **不经过**上面那道检查（它在浏览器进程起来之前就被启动器直接回答了）：用它当「能不能启动」的证据会骗人，必须用真程序启动（`npm run start` 或验收第 3 条那种方式）来判。
  3. 在 DSH 沙箱化的 shell 里，真程序启动会被上面那道检查拦住（实测：等待 2~3 秒即提前退出、stdout 无 ORGANIZER_READY、标记文件不存在）；同一条命令在**非沙箱的普通 PowerShell 窗口**里则三条全绿（等待 2 秒、未提前退出、stdout 有标记、标记文件存在，标记内容 `ORGANIZER_READY ... (did-finish-load)`）。**因此验收第 3 条必须在非沙箱的普通 PowerShell 窗口里跑**；第 1、2 条在沙箱里也能跑。
  4. 本机 `powershell` 是 Windows PowerShell 5.1（没有 `pwsh`）：它会把外部程序写往 stderr 的一句 `npm notice` 升级成致命错误（脚本里 `$ErrorActionPreference='Stop'` 时），所以验收脚本用 `Continue` + `$LASTEXITCODE` 判定成败；脚本打印的中文日志由 `>` 重定向写成 GBK，看日志时别用 UTF-8 打开。
