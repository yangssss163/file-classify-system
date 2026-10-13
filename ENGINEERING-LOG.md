# 工程记录

## 存档点对照（想回到哪一版就看这里）
- `green/01` — 第 01 片：拖入文件 → 按后缀复制分类 → 输出文件夹里出现五个分类文件夹。（只复制，不动原文件）
- `green/03` — 第 03 片：在 01 的基础上，多了「预览（不落盘）」，并且修好了真窗口里按钮/拖拽全死、拖入取路径失效的问题。**在这之前的一版。**
- `green/04` — 第 04 片：在上面基础上，分类规则改成用户自己可配、可存可读（后缀 / 文件名关键词 / 大小分档 / 修改时间分档，四种条件可组合，从上往下第一条命中的生效），规则存到 userData 下、下次打开还在，预览与「开始整理」用同一套规则。**这是目前可用的最新版本。**
- 说明：**没有 `green/02`** —— 第 02 片是「预览」，当时人工验收点还没确认，所以没单独打点；它已经包含在 `green/03` 里。以后每片过了都会依次打 `green/04`、`green/05`…，不再跳号。

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

## 04 分类规则可自己配、可存可读
- 能做什么：界面里能配分类规则 —— 条件有四种（后缀 / 文件名关键词 / 大小分档 / 修改时间分档），同一条规则里不同条件之间是「并且」、同一种条件多值之间是「或者」；规则从上往下**第一条命中的生效**；都不命中进「05_其他」。规则能保存到 userData 下的 organizer-rules.json，下次打开自动读回，坏了或丢了就回落默认规则并给提示。预览和「开始整理」用同一套规则、同一个求值函数。
- 界面：规则行有启用勾选 / 规则名 / 条件 / 上移 / 下移 / 删除，另有「新增规则」「恢复默认规则」「保存规则」「加载规则」，并显示「当前共 N 条规则（启用 M 条）」。**新增规则默认插到第一行（最优先命中），不想让它优先就点「下移」。**
- 验收：`npm run 验收` 打印 分类逻辑OK + 复制落地OK + 预览不落盘OK + 拖入取路径OK + 规则引擎OK + 规则编辑器OK（第 3 条「窗口活着」仍须在非沙箱 PowerShell 窗口里跑）。
- 存档点：green/04
- 教训：新增规则的默认位置只有一套语义（列表行顺序 = 求值顺序）。这一片为此来回改了两次：先按「新规则排最后」做，用户要的是「排第一行、优先命中」。定这类默认值时要直接问用户「你希望新加的东西排在最前还是最后」，别猜。
