# 验收：文件批量整理器（本片）
# 标准由控制台写死，工作台只执行，不修改、不放宽。
# 跑法：npm run 验收   （= powershell -ExecutionPolicy Bypass -File scripts\验收.ps1）
#
# 十六条断言（缺一不通过）：
#   1 纯逻辑测试      accept-logic-test.js    -> 分类逻辑OK
#   2 真实复制测试    accept-copy-test.js     -> 复制落地OK
#   3 真程序活着      真启动 electron.exe     -> 窗口活着OK（沙箱 shell 里会被 install_dir_access.cc 拦下，需非沙箱窗口跑）
#   4 预览不落盘      accept-preview-test.js -> 预览不落盘OK
#   5 拖入取路径      accept-drop-path-test.js -> 拖入取路径OK
#     （拖入的文件必须真的进得来；含「探针有效性自检」与「界面产物真当脚本跑一遍」）
#   6 规则引擎        accept-rules-test.js -> 规则引擎OK（不依赖界面，纯逻辑）
#   7 规则编辑器      accept-rules-editor-test.js -> 规则编辑器OK（界面接线，不依赖真窗口）
#   8 文件夹各归各    accept-folder-plan-test.js -> 文件夹各归各OK（纯逻辑，真造临时目录与文件；
#     最终语义=散落的文件以子文件夹优先 + **往下沉到底**：子文件夹里的文件按原样保留相对路径；
#     某一层根下的文件，若那一层有和它同名的子文件夹（按文件名去扩展名比对、大小写不敏感、只比同一层、
#     不看里面装的是什么）就沉进去，进去再按同一规矩往下看，直到没有同名的可沉 → 停在那一层；
#     一次都没沉成 → 按规则新建分类夹；沉到底那层已有同名文件 → 换名不覆盖；
#     被同名文件占位 → 不动它、退回规则并说明。下沉只在同一棵源文件夹树内）
#   9 文件夹预览      accept-folder-preview-test.js -> 文件夹预览OK（界面接线，不依赖真窗口；
#     拖入文件夹 → 界面按源文件夹分组画预览，并写出控制台定的那句说明（一字不差核对）；
#     预览里能看出「哪条散文件沉到了哪一层、沉了几层」；
#     含「探针有效性自检」：拿内存里现造的「只并一层、不递归往下沉」的产物必须判失败）
#  10 撤销上一次整理  accept-undo-test.js -> 撤销OK（纯逻辑，真造临时目录与文件：
#     正常撤销/幂等/不删用户后加的东西/不删被改过的文件/删除失败不崩/跨重启可用/绝不越界；
#     **输出根目录本身永不删除**（只清它下面由程序新建、且变空的分类夹），
#     并核对该次撤销的删除审计日志真的记下了删了什么）
#  11 输出方向        accept-output-direction-test.js -> 输出方向OK（纯逻辑 + 界面接线：
#     输出=源、输出在源之下、输出是源的上一级 一律不许开工且一个字节都不写；
#     正常方向允许并真跑一次；散文件只校验「输出 != 文件所在目录」；含「探针有效性自检」）
#  12 AI 策略壳        accept-ai-strategy-test.js -> AI策略壳OK（纯逻辑，不联网络：
#     未配置时 isAiConfigured()=false、classifyByAi 回 ok:false + 人话；模块代码体里没有联网标识、没有取密钥的写法；
#     调用时把全局联网入口换成会抛错的哨兵，调完哨兵没被碰过；不写盘不删东西；接口形状齐全且产品里没有第二处 AI 实现；
#     含「探针有效性自检」：偷偷塞 fetch / 读环境变量 / 别处另抄一份实现的产物必须判失败）
#  13 AI 界面壳        accept-ai-ui-test.js -> AI界面壳OK（界面接线，真 ES module 在窗口式桩里真执行：
#     界面上有常显的「AI 分类：未配置」；**没分拣过也能直接用 AI 分法**（不撤销、不删东西、直接调 AI）；
#     只有「上一次整理就留在同一个输出目录里」时才先撤销，且撤销必须排在调 AI 之前（桩里记调用序列）；
#     撤销成功 + AI 未配置 → 界面说清「已撤销 N 个 + AI 分类还没配置」；真造临时目录验「输出里那份被撤掉、源文件一个没动」；
#     已经撤销过 / 在别的输出目录 → 不拦人、直接调 AI；撤销返回失败 → 不继续调 AI 且如实显示撤销报告；
#     含「探针有效性自检」：内存里现造的「先调 AI、后撤销」的产物必须判失败）
#  14 AI 真调用        accept-ai-live-test.js -> AI真调用OK（**本机假接口服务**，不依赖外网：
#     起一个 node 内建 http 的假服务（127.0.0.1 随机端口，形状模仿 OpenAI 兼容的 chat completions），
#     断言请求形状（URL / Bearer 密钥 / 模型名 / body 只带文件名+大小+修改时间，**不含文件内容与目录路径**）、
#     正常解析（分类名 → 文件名清单逐条一致）、五种坏响应全部安全失败（输出目录一个文件没多、没删、能回落规则）、
#     分批与进度（120 个文件 → 请求不止一次、进度单调不减且最后等于 120）、重试只针对可重试的错（500 重试、400 不重试）、
#     建议可执行（变成规则后用既有规则求值逐条核对一致，且没有第二套复制/计划实现）；
#     含「探针有效性自检」：「把文件内容塞进请求体」「返回不合形状也当成功」的坏产物必须判失败）
#  15 AI 配置          accept-ai-config-test.js -> AI配置OK（读写 / 缺配置 / 密钥不外泄 / 界面接线：
#     设置保存进本机配置文件（临时路径，不污染用户真实设置）→ 读回三项一致；
#     密钥为空 → 明确拒绝且**一个请求都不发**（假服务收到 0 次）；密钥不出现在项目目录任何文件与验收输出里；
#     界面密钥框是密码型；产品源码里没有 sk- 开头的字符串常量；界面接线真跑产物（三个输入 + 测试连接，
#     点保存把三项传下去、点测试连接显示成功与失败两种结果）；
#     含「探针有效性自检」：把密钥写进项目文件里 / 输入框改成普通文本型的产物必须判失败）
#
#  16 嵌套规则        accept-nested-rules-test.js -> 嵌套规则OK（纯逻辑，真造临时目录与文件 + 界面接线：
#     规则的分类名可以是多级相对路径（照片\风光 → <这一层>\照片\风光\文件），不含分隔符时行为与现在完全一致；
#     \ 与 / 等价；中间层真的被逐层创建；同深度同名不覆盖；与「子文件夹原样保留 / 沉进同名子文件夹」共存；
#     所有目标都在它原来那一层之下（文件只往深处）；危险分类名（..\..\外面 / C:\temp\x / \\server\share /
#     photos:bad / con / 结尾空格 / 结尾点）一律拒绝或有原因地安全归一化，源树之外的哨兵目录前后一个文件/目录都不多；
#     界面侧：规则行显示归一化后的实际目标、预览树里多层结构被真的画成两层/三层；
#     含「探针有效性自检」：内存里现造的「把 照片\风光 当成一个目录名」的产物必须判失败）
#
#  18 AI 分类落地    accept-ai-organize-test.js -> AI分类落地OK（纯逻辑，真造临时目录与文件：
#     AI 分好的「文件 → 分类」直接用于落盘（不先翻译成规则）：给了分类的按它落（含多级），没给的按规则回落；
#     源文件夹模式下只改「本来会建分类夹」的散文件，子文件夹里的文件仍原样保留；
#     危险分类名（..\..\外面 / C:\temp\x / CON）一律不进表 → 回落规则，源树之外哨兵不变；
#     输出方向校验、撤销、预览与落盘一致这三条照旧；
#     含「探针有效性自检」：抽掉 assignments 再跑一遍，落点必须变回按规则）
#
#  19 AI 结构          accept-ai-structure-test.js -> AI结构OK（纯逻辑 + 本机假接口服务：
#     **原文件夹已有的目录结构当分类方案**：从文件相对路径读出「票据 / 文档」这类已有分类（只发相对目录名，
#     不发绝对路径、不发盘符）；提示词里写明「优先放进已有分类、名字一字不差」；
#     真调用后落盘验「AI 分进来的散文件与原来就在那个夹子里的老文件落进同一个文件夹」；
#     含「探针有效性自检」：抽掉源文件夹再跑一遍（旧行为），同一套判据必须判失败）
#
#  17 热加载          accept-dev-hot-reload-test.js -> 热加载OK（真跑一次 npm run dev，不依赖真窗口：
#     `npm run dev` 能启动、打印「热加载就绪」、之后一直活着（沙箱里窗口起不来时它要明确打印
#     「窗口起不来（沙箱环境），热加载仍可用」并继续监听）；
#     改 src/renderer/** → dev 打印「重编译 + 刷新窗口」那类日志，且 out/renderer/renderer.js 真的被重新生成（mtime 前进）；
#     改 src/main.ts → dev 打印「重编译 + 主进程重启」那类日志，且 out/main.js 真的被重新生成；
#     连续 3 次快速变更 → 完整构建次数 < 3（合并窗口 100~300ms，可配 DSH_DEV_DEBOUNCE_MS）；
#     跑完临时改动全部还原、工作区回到跑之前的样子（含未跟踪文件）、没有新增被 git 跟踪的文件；
#     `npm run build` 仍然成功；含「探针有效性自检」：现造的「起来就退出」与「假装热加载但不重编译」
#     两个假 dev 喂给同一套断言必须判失败）
#
#  20 删源文件        accept-delete-sources-test.js -> 删源文件OK（纯逻辑，真造临时目录与文件）：
#  21 软件图标        accept-icon-test.js -> 图标OK（纯逻辑：SVG/PNG/ICO 结构合法 + 接线没断 + 坏样本反证）：
#     这是全产品唯一一次「动用户的原始文件」：只删这一次整理里**复制成功**的那几个源文件；
#     删之前逐个核对**输出里那份还在**（输出里那份被撤销/手删 → 跳过并说明，源文件必须留着）；
#     默认走回收站（主进程传 shell.trashItem），**给不出回收站能力时一个都不删**；
#     目录只 rmdir（只在空的时候成功）—— 里面还有东西就留着；源文件夹里用户后来加的文件一个都不碰；
#     幂等（删过一次再点只回一句人话、不再动手）；每个动作都写一行删除审计；
#     含「探针有效性自检」：「不看输出就删」的朴素实现必须在同一个场景里被判失败
#
# 编码约定：全链路 UTF-8。本脚本与 node 子进程之间按 UTF-8 走，日志也是 UTF-8，
# 所以看日志别按 GBK 解（那是乱码）。判定逻辑只看退出码 + 日志里的 ASCII 标记，与编码无关。

# 只让 cmdlet 的错误按 Stop 处理；外部程序（node/npm）往 stderr 写提示
# （比如 npm notice）在 Windows PowerShell 5.1 下会被升级成致命错误，所以这里用 Continue，
# 由每一条断言自己看 $LASTEXITCODE 和日志内容来判断成败。
$ErrorActionPreference = 'Continue'
# 统一 UTF-8：本脚本与它启动的 node 子进程之间按 UTF-8 走；读日志也一律显式 -Encoding UTF8
# （Windows PowerShell 5.1 默认按 ANSI/GBK 读文件，会把 node 写的 UTF-8 中文读成「鎷掔粷璁块棶」这类乱码）。
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
  Write-Host "设置 UTF-8 输出编码失败（不影响判定）：$($_.Exception.Message)"
}
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $projectRoot '.dsh-staging'
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Write-Step([string]$text) { Write-Host $text }

function Fail([string]$why) {
  Write-Host "验收失败:$why"
  exit 1
}

# ---------- 第 1 条：纯逻辑测试（不需要界面） ----------
$logic = $false
try {
  Write-Step '--- 1/16 纯逻辑测试 ---'
  $outDir = Join-Path $projectRoot 'out'
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $logicTestJs = Join-Path $stage 'accept-logic-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-logic-test.js') -Destination $logicTestJs -Force
  $logicLog = Join-Path $stage 'accept-logic.log'
  & node $logicTestJs $outDir *> $logicLog
  $logicCode = $LASTEXITCODE
  Get-Content -LiteralPath $logicLog -Encoding UTF8 -Tail 20 | ForEach-Object { Write-Host $_ }
  Write-Host "纯逻辑测试退出码=$logicCode  日志=$logicLog"
  if ($logicCode -eq 0 -and ((Get-Content -LiteralPath $logicLog -Encoding UTF8 -Raw) -match '分类逻辑OK')) {
    Write-Step '分类逻辑OK'
    $logic = $true
  }
} catch {
  Write-Host "纯逻辑测试异常：$($_.Exception.Message)"
}

# ---------- 第 2 条：真实复制测试（不需要界面） ----------
$copy = $false
try {
  Write-Step '--- 2/16 真实复制测试 ---'
  $caseDir = Join-Path $stage "accept-copy-$stamp"
  $srcDir = Join-Path $caseDir 'src'
  $dstDir = Join-Path $caseDir 'dst'
  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null

  # 9 个空文件：五类后缀 + 一个无后缀文件
  $names = @('t1.jpg', 't2.pdf', 't3.mp3', 't4.zip', 't5.xyz', 'noext', 't6.JPG', 't7.docx', 't8.mp4')
  foreach ($n in $names) {
    $p = Join-Path $srcDir $n
    [System.IO.File]::WriteAllText($p, '', (New-Object System.Text.UTF8Encoding($false)))
  }
  $srcFiles = @()
  foreach ($n in $names) { $srcFiles += (Join-Path $srcDir $n) }

  $copyTestJs = Join-Path $stage 'accept-copy-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-copy-test.js') -Destination $copyTestJs -Force
  $copyLog = Join-Path $stage 'accept-copy.log'
  $b64Paths = @($srcFiles | ForEach-Object { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_)) })
  $remoteArgs = @($copyTestJs, $dstDir) + $b64Paths
  & node @remoteArgs *> $copyLog
  $copyCode = $LASTEXITCODE
  Get-Content -LiteralPath $copyLog -Encoding UTF8 -Tail 30 | ForEach-Object { Write-Host $_ }
  Write-Host "真实复制测试退出码=$copyCode  日志=$copyLog"
  if ($copyCode -eq 0 -and ((Get-Content -LiteralPath $copyLog -Encoding UTF8 -Raw) -match '复制落地OK')) {
    Write-Step '复制落地OK'
    $copy = $true
  }
} catch {
  Write-Host "真实复制测试异常：$($_.Exception.Message)"
}

# ---------- 第 3 条：真程序活着 ----------
$alive = $false
$elProc = $null
try {
  Write-Step '--- 3/16 真程序活着 ---'
  $buildLog = Join-Path $stage 'accept-build.log'
  $nodeExe = (Get-Command node).Source
  # 用 node 直接跑 npm-cli.js，避开 npm.cmd 的批处理壳子（壳子会把 stderr 当成本命令失败）
  $npmCli = Join-Path (Split-Path -Parent $nodeExe) 'node_modules\npm\bin\npm-cli.js'
  if (Test-Path -LiteralPath $npmCli) {
    & $nodeExe $npmCli run build 2>$null | Out-File -LiteralPath $buildLog -Encoding utf8
  } else {
    # 找不到 npm-cli.js 就退回官方脚本，用 cmd 包一层
    cmd /c "npm run build > `"$buildLog`" 2>&1"
  }
  $buildCode = $LASTEXITCODE
  Write-Host "npm run build 退出码=$buildCode  日志=$buildLog"
  if ($buildCode -ne 0) {
    Get-Content -LiteralPath $buildLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  } else {
    $markerFile = Join-Path $projectRoot 'out\ORGANIZER_READY.txt'
    if (Test-Path -LiteralPath $markerFile) { Remove-Item -LiteralPath $markerFile -Force }
    $stdoutLog = Join-Path $stage 'accept-electron.stdout.log'
    $stderrLog = Join-Path $stage 'accept-electron.stderr.log'
    $userData = Join-Path $stage "electron-userdata-$stamp"
    New-Item -ItemType Directory -Force -Path $userData | Out-Null

    $electronExe = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
    $started = $false
    if (Test-Path -LiteralPath $electronExe) {
      $elProc = Start-Process -FilePath $electronExe -ArgumentList '.', "--user-data-dir=$userData", "--marker-file=$markerFile" -WorkingDirectory $projectRoot -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
      $started = $true
    } else {
      Write-Host "未找到 $electronExe"
    }

    if ($started) {
      $waited = 0
      while ($waited -lt 20 -and -not $elProc.HasExited) {
        Start-Sleep -Seconds 1
        $waited++
        if (Test-Path -LiteralPath $markerFile) { break }
      }
      $exitedEarly = $elProc.HasExited
      Start-Sleep -Seconds 1
      if (-not $exitedEarly -and $elProc.HasExited) { $exitedEarly = $true }

      $stdoutText = ''
      if (Test-Path -LiteralPath $stdoutLog) { $stdoutText = Get-Content -LiteralPath $stdoutLog -Encoding UTF8 -Raw }
      $hasMarkerInStdout = ($stdoutText -match 'ORGANIZER_READY')
      $hasMarkerFile = (Test-Path -LiteralPath $markerFile)
      Write-Host "electron 等待秒数=$waited  提前退出=$exitedEarly  stdout有标记=$hasMarkerInStdout  标记文件存在=$hasMarkerFile"
      if ($stdoutText -and $stdoutText.Length -gt 0) {
        Write-Host "electron stdout 尾部："
        Get-Content -LiteralPath $stdoutLog -Encoding UTF8 -Tail 5 | ForEach-Object { Write-Host $_ }
      }
      if ((Test-Path -LiteralPath $stderrLog) -and (Get-Item -LiteralPath $stderrLog).Length -gt 0) {
        Write-Host "electron stderr 尾部："
        Get-Content -LiteralPath $stderrLog -Encoding UTF8 -Tail 10 | ForEach-Object { Write-Host $_ }
      }

      if (-not $exitedEarly -and ($hasMarkerInStdout -or $hasMarkerFile)) {
        Write-Step '窗口活着OK'
        $alive = $true
      }
    }
  }
} catch {
  Write-Host "真程序测试异常：$($_.Exception.Message)"
} finally {
  if ($elProc -and -not $elProc.HasExited) {
    try { Stop-Process -Id $elProc.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

# ---------- 第 4 条：预览不落盘（不需要界面） ----------
$preview = $false
try {
  Write-Step '--- 4/16 预览不落盘 ---'
  $previewCase = Join-Path $stage "accept-preview-$stamp"
  $previewSrc = Join-Path $previewCase 'src'
  $previewOut = Join-Path $previewCase 'out-empty'
  New-Item -ItemType Directory -Force -Path $previewSrc | Out-Null
  New-Item -ItemType Directory -Force -Path $previewOut | Out-Null

  # 9 个空文件：五类后缀 + 一个无后缀文件
  $previewNames = @('p1.jpg', 'p2.pdf', 'p3.mp3', 'p4.zip', 'p5.xyz', 'noext', 'p6.JPG', 'p7.docx', 'p8.mp4')
  foreach ($n in $previewNames) {
    $p = Join-Path $previewSrc $n
    [System.IO.File]::WriteAllText($p, '', (New-Object System.Text.UTF8Encoding($false)))
  }
  $previewFiles = @()
  foreach ($n in $previewNames) { $previewFiles += (Join-Path $previewSrc $n) }

  $previewTestJs = Join-Path $stage 'accept-preview-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-preview-test.js') -Destination $previewTestJs -Force
  $previewLog = Join-Path $stage 'accept-preview.log'
  $b64Preview = @($previewFiles | ForEach-Object { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_)) })
  $previewArgs = @($previewTestJs, $outDir, $previewOut) + $b64Preview
  & node @previewArgs *> $previewLog
  $previewCode = $LASTEXITCODE
  Get-Content -LiteralPath $previewLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "预览测试退出码=$previewCode  日志=$previewLog"
  if ($previewCode -eq 0 -and ((Get-Content -LiteralPath $previewLog -Encoding UTF8 -Raw) -match '预览不落盘OK')) {
    Write-Step '预览不落盘OK'
    $preview = $true
  }
} catch {
  Write-Host "预览测试异常：$($_.Exception.Message)"
}

# ---------- 第 5 条：拖入取路径（拖进来的文件必须真的进得来） ----------
$dropPath = $false
try {
  Write-Step '--- 5/16 拖入取路径 ---'
  $dropTestJs = Join-Path $stage 'accept-drop-path-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-drop-path-test.js') -Destination $dropTestJs -Force
  $dropLog = Join-Path $stage 'accept-drop-path.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），脚本会读 out\preload.js 与 out\renderer\renderer.js
  # --experimental-vm-modules：脚本要用真正的 ES module 作用域验证「界面脚本能不能跑到底」，没有它就直接判失败
  $env:DSH_ACCEPT_STAGE = $stage
  & node --experimental-vm-modules $dropTestJs *> $dropLog
  $dropCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_STAGE -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $dropLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "拖入取路径测试退出码=$dropCode  日志=$dropLog"
  if ($dropCode -eq 0 -and ((Get-Content -LiteralPath $dropLog -Encoding UTF8 -Raw) -match '拖入取路径OK')) {
    Write-Step '拖入取路径OK'
    $dropPath = $true
  }
} catch {
  Write-Host "拖入取路径测试异常：$($_.Exception.Message)"
}

# ---------- 第 6 条：规则引擎（纯逻辑，不依赖界面） ----------
$ruleEngine = $false
try {
  Write-Step '--- 6/16 规则引擎 ---'
  $ruleTestJs = Join-Path $stage 'accept-rules-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-rules-test.js') -Destination $ruleTestJs -Force
  $ruleLog = Join-Path $stage 'accept-rules.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），脚本会 require out\core\index.js
  $env:DSH_ACCEPT_OUT = $outDir
  & node $ruleTestJs *> $ruleLog
  $ruleCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $ruleLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "规则引擎测试退出码=$ruleCode  日志=$ruleLog"
  if ($ruleCode -eq 0 -and ((Get-Content -LiteralPath $ruleLog -Encoding UTF8 -Raw) -match '规则引擎OK')) {
    Write-Step '规则引擎OK'
    $ruleEngine = $true
  }
} catch {
  Write-Host "规则引擎测试异常：$($_.Exception.Message)"
}

# ---------- 第 7 条：规则编辑器（界面接线，不依赖真窗口） ----------
$ruleEditor = $false
try {
  Write-Step '--- 7/16 规则编辑器 ---'
  $editorTestJs = Join-Path $stage 'accept-rules-editor-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-rules-editor-test.js') -Destination $editorTestJs -Force
  $editorLog = Join-Path $stage 'accept-rules-editor.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），
  # 脚本会读 out\renderer\renderer.js、out\preload.js、out\main.js，并把界面产物在窗口式桩里真跑一遍。
  # --experimental-vm-modules：要用真正的 ES module 作用域，没有它就直接判失败
  & node --experimental-vm-modules $editorTestJs *> $editorLog
  $editorCode = $LASTEXITCODE
  Get-Content -LiteralPath $editorLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "规则编辑器测试退出码=$editorCode  日志=$editorLog"
  if ($editorCode -eq 0 -and ((Get-Content -LiteralPath $editorLog -Encoding UTF8 -Raw) -match '规则编辑器OK')) {
    Write-Step '规则编辑器OK'
    $ruleEditor = $true
  }
} catch {
  Write-Host "规则编辑器测试异常：$($_.Exception.Message)"
}

# ---------- 第 8 条：文件夹各归各（纯逻辑，真造临时目录与文件） ----------
$folderPlan = $false
try {
  Write-Step '--- 8/16 文件夹各归各 ---'
  $folderPlanTestJs = Join-Path $stage 'accept-folder-plan-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-folder-plan-test.js') -Destination $folderPlanTestJs -Force
  $folderPlanLog = Join-Path $stage 'accept-folder-plan.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），脚本会 require out\core\index.js
  $env:DSH_ACCEPT_OUT = $outDir
  & node $folderPlanTestJs *> $folderPlanLog
  $folderPlanCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $folderPlanLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "文件夹各归各测试退出码=$folderPlanCode  日志=$folderPlanLog"
  if ($folderPlanCode -eq 0 -and ((Get-Content -LiteralPath $folderPlanLog -Encoding UTF8 -Raw) -match '文件夹各归各OK')) {
    Write-Step '文件夹各归各OK'
    $folderPlan = $true
  }
} catch {
  Write-Host "文件夹各归各测试异常：$($_.Exception.Message)"
}

# ---------- 第 9 条：文件夹预览（界面接线，不依赖真窗口） ----------
$folderPreview = $false
try {
  Write-Step '--- 9/16 文件夹预览 ---'
  $folderPreviewTestJs = Join-Path $stage 'accept-folder-preview-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-folder-preview-test.js') -Destination $folderPreviewTestJs -Force
  $folderPreviewLog = Join-Path $stage 'accept-folder-preview.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），
  # 脚本会读 out\renderer\renderer.js 并把界面产物在窗口式桩里真跑一遍。
  # --experimental-vm-modules：要用真正的 ES module 作用域，没有它就直接判失败
  $env:DSH_ACCEPT_STAGE = $stage
  $env:DSH_ACCEPT_OUT = $outDir
  & node --experimental-vm-modules $folderPreviewTestJs *> $folderPreviewLog
  $folderPreviewCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_STAGE -ErrorAction SilentlyContinue
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $folderPreviewLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "文件夹预览测试退出码=$folderPreviewCode  日志=$folderPreviewLog"
  if ($folderPreviewCode -eq 0 -and ((Get-Content -LiteralPath $folderPreviewLog -Encoding UTF8 -Raw) -match '文件夹预览OK')) {
    Write-Step '文件夹预览OK'
    $folderPreview = $true
  }
} catch {
  Write-Host "文件夹预览测试异常：$($_.Exception.Message)"
}

# ---------- 第 10 条：撤销上一次整理（纯逻辑，真造临时目录与文件） ----------
$undoOk = $false
try {
  Write-Step '--- 10/16 撤销上一次整理 ---'
  $undoTestJs = Join-Path $stage 'accept-undo-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-undo-test.js') -Destination $undoTestJs -Force
  $undoLog = Join-Path $stage 'accept-undo.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），脚本会 require out\core\index.js。
  # 记录一律走临时路径，绝不碰用户 userData 下真实的 organizer-last-run.json。
  $env:DSH_ACCEPT_OUT = $outDir
  & node $undoTestJs *> $undoLog
  $undoCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $undoLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "撤销测试退出码=$undoCode  日志=$undoLog"
  if ($undoCode -eq 0 -and ((Get-Content -LiteralPath $undoLog -Encoding UTF8 -Raw) -match '撤销OK')) {
    Write-Step '撤销OK'
    $undoOk = $true
  }
} catch {
  Write-Host "撤销测试异常：$($_.Exception.Message)"
}

# ---------- 第 11 条：输出方向（纯逻辑 + 界面接线，不依赖真窗口） ----------
$directionOk = $false
try {
  Write-Step '--- 11/16 输出方向 ---'
  $directionTestJs = Join-Path $stage 'accept-output-direction-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-output-direction-test.js') -Destination $directionTestJs -Force
  $directionLog = Join-Path $stage 'accept-output-direction.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build）；
  # 界面侧会把产物放进窗口式桩里真执行 —— --experimental-vm-modules 不能少。
  $env:DSH_ACCEPT_OUT = $outDir
  & node --experimental-vm-modules $directionTestJs *> $directionLog
  $directionCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $directionLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "输出方向测试退出码=$directionCode  日志=$directionLog"
  if ($directionCode -eq 0 -and ((Get-Content -LiteralPath $directionLog -Encoding UTF8 -Raw) -match '输出方向OK')) {
    Write-Step '输出方向OK'
    $directionOk = $true
  }
} catch {
  Write-Host "输出方向测试异常：$($_.Exception.Message)"
}

# ---------- 第 12 条：AI 策略壳（纯逻辑，不联网络） ----------
$aiStrategyOk = $false
try {
  Write-Step '--- 12/16 AI 策略壳 ---'
  $aiStrategyTestJs = Join-Path $stage 'accept-ai-strategy-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-ai-strategy-test.js') -Destination $aiStrategyTestJs -Force
  $aiStrategyLog = Join-Path $stage 'accept-ai-strategy.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），脚本会 require out\core\index.js
  # 并扫 src\core 下那个 AI 分类模块的源码、编译产物与其它产品文件。
  # 全程不联网络：脚本会把全局联网入口换成会抛错的哨兵，调完之后要求哨兵一个都没被碰过。
  # 设置一律走临时路径（DSH_AI_CONFIG_FILE）：免得这条去读用户真实保存的那份 AI 设置
  # （真实设置存在时「配好了没有」会是 true，那属于用户自己的机器状态，不该影响这条判据）。
  $env:DSH_ACCEPT_OUT = $outDir
  $env:DSH_AI_CONFIG_FILE = Join-Path $stage "accept-ai-config-$stamp.json"
  & node $aiStrategyTestJs *> $aiStrategyLog
  $aiStrategyCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Remove-Item Env:\DSH_AI_CONFIG_FILE -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $aiStrategyLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "AI策略壳测试退出码=$aiStrategyCode  日志=$aiStrategyLog"
  if ($aiStrategyCode -eq 0 -and ((Get-Content -LiteralPath $aiStrategyLog -Encoding UTF8 -Raw) -match 'AI策略壳OK')) {
    Write-Step 'AI策略壳OK'
    $aiStrategyOk = $true
  }
} catch {
  Write-Host "AI策略壳测试异常：$($_.Exception.Message)"
}

# ---------- 第 13 条：AI 界面壳（界面接线，真 ES module 在窗口式桩里执行） ----------
$aiUiOk = $false
try {
  Write-Step '--- 13/16 AI 界面壳 ---'
  $aiUiTestJs = Join-Path $stage 'accept-ai-ui-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-ai-ui-test.js') -Destination $aiUiTestJs -Force
  $aiUiLog = Join-Path $stage 'accept-ai-ui.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），
  # 脚本会读 out\renderer\renderer.js / out\preload.js / out\main.js，
  # 并把界面产物在窗口式桩里真跑一遍，还真的整理一次、真的撤销一次（记录走临时路径）。
  # --experimental-vm-modules：要用真正的 ES module 作用域，没有它就直接判失败
  $env:DSH_ACCEPT_OUT = $outDir
  & node --experimental-vm-modules $aiUiTestJs *> $aiUiLog
  $aiUiCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $aiUiLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "AI界面壳测试退出码=$aiUiCode  日志=$aiUiLog"
  if ($aiUiCode -eq 0 -and ((Get-Content -LiteralPath $aiUiLog -Encoding UTF8 -Raw) -match 'AI界面壳OK')) {
    Write-Step 'AI界面壳OK'
    $aiUiOk = $true
  }
} catch {
  Write-Host "AI界面壳测试异常：$($_.Exception.Message)"
}

# ---------- 第 14 条：AI 真调用（本机假接口服务，不依赖外网） ----------
$aiLiveOk = $false
try {
  Write-Step '--- 14/16 AI 真调用 ---'
  $aiLiveTestJs = Join-Path $stage 'accept-ai-live-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-ai-live-test.js') -Destination $aiLiveTestJs -Force
  $aiLiveLog = Join-Path $stage 'accept-ai-live.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），脚本会 require out\core\index.js。
  # 全程不出本机：脚本自己起一个假的接口服务（127.0.0.1 的随机端口），把程序的接口地址指过去。
  # 设置走临时路径，绝不碰用户真实保存的那份 AI 设置。
  $env:DSH_ACCEPT_OUT = $outDir
  & node $aiLiveTestJs *> $aiLiveLog
  $aiLiveCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $aiLiveLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "AI真调用测试退出码=$aiLiveCode  日志=$aiLiveLog"
  if ($aiLiveCode -eq 0 -and ((Get-Content -LiteralPath $aiLiveLog -Encoding UTF8 -Raw) -match 'AI真调用OK')) {
    Write-Step 'AI真调用OK'
    $aiLiveOk = $true
  }
} catch {
  Write-Host "AI真调用测试异常：$($_.Exception.Message)"
}

# ---------- 第 15 条：AI 配置（读写 / 缺配置 / 密钥不外泄 / 界面接线） ----------
$aiConfigOk = $false
try {
  Write-Step '--- 15/16 AI 配置 ---'
  $aiConfigTestJs = Join-Path $stage 'accept-ai-config-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-ai-config-test.js') -Destination $aiConfigTestJs -Force
  $aiConfigLog = Join-Path $stage 'accept-ai-config.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build），脚本会读 out\renderer\renderer.js 与 out\renderer\index.html，
  # 并把界面产物在窗口式桩里真跑一遍（点保存 / 点测试连接）。
  # --experimental-vm-modules：要用真正的 ES module 作用域，没有它就直接判失败
  $env:DSH_ACCEPT_OUT = $outDir
  & node --experimental-vm-modules $aiConfigTestJs *> $aiConfigLog
  $aiConfigCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $aiConfigLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "AI配置测试退出码=$aiConfigCode  日志=$aiConfigLog"
  if ($aiConfigCode -eq 0 -and ((Get-Content -LiteralPath $aiConfigLog -Encoding UTF8 -Raw) -match 'AI配置OK')) {
    Write-Step 'AI配置OK'
    $aiConfigOk = $true
  }
} catch {
  Write-Host "AI配置测试异常：$($_.Exception.Message)"
}

# ---------- 第 16 条：嵌套规则（纯逻辑，真造临时目录与文件；界面侧并进来） ----------
$nestedRulesOk = $false
try {
  Write-Step '--- 16/16 嵌套规则 ---'
  $nestedTestJs = Join-Path $stage 'accept-nested-rules-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-nested-rules-test.js') -Destination $nestedTestJs -Force
  $nestedLog = Join-Path $stage 'accept-nested-rules.log'
  # 这条要在 npm run build 之后跑（第 3 条已经跑过 build）：
  # 脚本会 require out\core\index.js，并把界面产物（out\renderer\renderer.js）放进窗口式桩里真跑一遍。
  # --experimental-vm-modules：要用真正的 ES module 作用域，没有它就直接判失败
  $env:DSH_ACCEPT_OUT = $outDir
  & node --experimental-vm-modules $nestedTestJs *> $nestedLog
  $nestedCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $nestedLog -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host "嵌套规则测试退出码=$nestedCode  日志=$nestedLog"
  if ($nestedCode -eq 0 -and ((Get-Content -LiteralPath $nestedLog -Encoding UTF8 -Raw) -match '嵌套规则OK')) {
    Write-Step '嵌套规则OK'
    $nestedRulesOk = $true
  }
} catch {
  Write-Host "嵌套规则测试异常：$($_.Exception.Message)"
}

# ---------- 第 17 条：AI 分类落地（AI 分好的结论直接预览 / 分拣 / 撤销，不经过规则表） ----------
$aiOrganizeOk = $false
try {
  Write-Step '--- 17/18 AI 分类落地 ---'
  $aiOrgTestJs = Join-Path $stage 'accept-ai-organize-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-ai-organize-test.js') -Destination $aiOrgTestJs -Force
  $aiOrgLog = Join-Path $stage 'accept-ai-organize.log'
  # 纯逻辑（不碰界面、不联网）：真造临时目录与文件，把「显式分类」跑完整条落盘链路
  $env:DSH_ACCEPT_OUT = $outDir
  & node $aiOrgTestJs *> $aiOrgLog
  $aiOrgCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $aiOrgLog -Encoding UTF8 -Tail 35 | ForEach-Object { Write-Host $_ }
  Write-Host "AI分类落地测试退出码=$aiOrgCode  日志=$aiOrgLog"
  if ($aiOrgCode -eq 0 -and ((Get-Content -LiteralPath $aiOrgLog -Encoding UTF8 -Raw) -match 'AI分类落地OK')) {
    Write-Step 'AI分类落地OK'
    $aiOrganizeOk = $true
  }
} catch {
  Write-Host "AI分类落地测试异常：$($_.Exception.Message)"
}

# ---------- 第 18 条：AI 结构（原文件夹已有目录结构当分类方案） ----------
$aiStructureOk = $false
try {
  Write-Step '--- 18/19 AI 结构 ---'
  $aiStructTestJs = Join-Path $stage 'accept-ai-structure-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-ai-structure-test.js') -Destination $aiStructTestJs -Force
  $aiStructLog = Join-Path $stage 'accept-ai-structure.log'
  # 纯逻辑 + 本机假接口服务（127.0.0.1，不出本机）；设置只活在内存里，不碰用户真实设置
  $env:DSH_ACCEPT_OUT = $outDir
  & node $aiStructTestJs *> $aiStructLog
  $aiStructCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $aiStructLog -Encoding UTF8 -Tail 35 | ForEach-Object { Write-Host $_ }
  Write-Host "AI结构测试退出码=$aiStructCode  日志=$aiStructLog"
  if ($aiStructCode -eq 0 -and ((Get-Content -LiteralPath $aiStructLog -Encoding UTF8 -Raw) -match 'AI结构OK')) {
    Write-Step 'AI结构OK'
    $aiStructureOk = $true
  }
} catch {
  Write-Host "AI结构测试异常：$($_.Exception.Message)"
}

# ---------- 第 19 条：热加载（真跑一次 npm run dev，不依赖真窗口） ----------
$hotReloadOk = $false
try {
  Write-Step '--- 19/19 热加载 ---'
  $hotTestJs = Join-Path $stage 'accept-dev-hot-reload-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-dev-hot-reload-test.js') -Destination $hotTestJs -Force
  $hotLog = Join-Path $stage 'accept-dev-hot-reload.log'
  # 这条自己起 npm run dev（scripts\dev.mjs，等于 npm run dev），自己临时改 src 下的两个源文件、
  # 自己按「改之前的原始字节」还原；日志一律写 .dsh-staging 下。
  # 「跑完和跑之前一模一样」这条判据在 node 那侧判（跑前/跑后 git status 逐字相同 + 没有新增被跟踪的文件）；
  # 这里另外按内容哈希核对一次它动过的那两个文件有没有还原干净。
  $env:DSH_ACCEPT_STAGE = $stage
  $env:DSH_ACCEPT_OUT = $outDir
  $gitLog = Join-Path $stage 'accept-dev-hot-reload.git.log'
  & cmd /c "git -C `"$projectRoot`" rev-parse --short HEAD > `"$gitLog`" 2>&1"
  $gitBefore = ((Get-Content -LiteralPath $gitLog -Encoding UTF8 -ErrorAction SilentlyContinue) -join ' ').Trim()
  $snapshotText = (& cmd /c "git -C `"$projectRoot`" hash-object src\renderer\renderer.ts src\main.ts 2>&1") -join '|'
  & node $hotTestJs *> $hotLog
  $hotCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_STAGE -ErrorAction SilentlyContinue
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  $snapshotAfter = (& cmd /c "git -C `"$projectRoot`" hash-object src\renderer\renderer.ts src\main.ts 2>&1") -join '|'
  & cmd /c "git -C `"$projectRoot`" rev-parse --short HEAD > `"$gitLog`" 2>&1"
  $gitAfter = ((Get-Content -LiteralPath $gitLog -Encoding UTF8 -ErrorAction SilentlyContinue) -join ' ').Trim()
  Get-Content -LiteralPath $hotLog -Encoding UTF8 -Tail 45 | ForEach-Object { Write-Host $_ }
  Write-Host "热加载测试退出码=$hotCode  日志=$hotLog"
  Write-Host "热加载测试前后提交=$gitBefore -> $gitAfter（相同=$($gitBefore -eq $gitAfter)）"
  Write-Host "热加载测试前后两个源文件的内容哈希=$snapshotText / $snapshotAfter（相同=$($snapshotText -eq $snapshotAfter)）"
  if ($snapshotText -ne $snapshotAfter) {
    # 真出了「临时改动没还原」才会走到这里：报失败，并把这两个文件还原回仓库版本
    $restoreLog = Join-Path $stage 'accept-dev-hot-reload.restore.log'
    & cmd /c "git -C `"$projectRoot`" checkout -- src\renderer\renderer.ts src\main.ts > `"$restoreLog`" 2>&1"
    Write-Host '验收失败:热加载（临时改动没还原干净，已把这两个文件还原回仓库版本）'
  }
  if ($hotCode -eq 0 -and ((Get-Content -LiteralPath $hotLog -Encoding UTF8 -Raw) -match '热加载OK') -and $snapshotText -eq $snapshotAfter) {
    Write-Step '热加载OK'
    $hotReloadOk = $true
  } else {
    Write-Host '验收失败:热加载'
  }
} catch {
  Write-Host "热加载测试异常：$($_.Exception.Message)"
}

# ---------- 第 20 条：删源文件（纯逻辑，真造临时目录与文件） ----------
$deleteSourcesOk = $false
try {
  Write-Step '--- 20/20 删源文件 ---'
  $delSrcTestJs = Join-Path $stage 'accept-delete-sources-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-delete-sources-test.js') -Destination $delSrcTestJs -Force
  $delSrcLog = Join-Path $stage 'accept-delete-sources.log'
  # 纯逻辑（不碰界面、不联网）：记录与审计一律走临时路径，绝不碰用户 userData 下的真实记录
  $env:DSH_ACCEPT_OUT = $outDir
  & node $delSrcTestJs *> $delSrcLog
  $delSrcCode = $LASTEXITCODE
  Remove-Item Env:\DSH_ACCEPT_OUT -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $delSrcLog -Encoding UTF8 -Tail 35 | ForEach-Object { Write-Host $_ }
  Write-Host "删源文件测试退出码=$delSrcCode  日志=$delSrcLog"
  if ($delSrcCode -eq 0 -and ((Get-Content -LiteralPath $delSrcLog -Encoding UTF8 -Raw) -match '删源文件OK')) {
    Write-Step '删源文件OK'
    $deleteSourcesOk = $true
  }
} catch {
  Write-Host "删源文件测试异常：$($_.Exception.Message)"
}

# ---------- 第 21 条：软件图标（纯逻辑：图标文件合法 + 接线没断 + 探针反证） ----------
$iconOk = $false
try {
  Write-Step '--- 21/21 软件图标 ---'
  $iconTestJs = Join-Path $stage 'accept-icon-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-icon-test.js') -Destination $iconTestJs -Force
  $iconLog = Join-Path $stage 'accept-icon.log'
  # 只读 assets / out / src 的产物文件，不联网、不碰窗口
  & node $iconTestJs *> $iconLog
  $iconCode = $LASTEXITCODE
  Get-Content -LiteralPath $iconLog -Encoding UTF8 -Tail 30 | ForEach-Object { Write-Host $_ }
  Write-Host "图标测试退出码=$iconCode  日志=$iconLog"
  if ($iconCode -eq 0 -and ((Get-Content -LiteralPath $iconLog -Encoding UTF8 -Raw) -match '图标OK')) {
    Write-Step '图标OK'
    $iconOk = $true
  }
} catch {
  Write-Host "图标测试异常：$($_.Exception.Message)"
}

if ($logic -and $copy -and $alive -and $preview -and $dropPath -and $ruleEngine -and $ruleEditor -and $folderPlan -and $folderPreview -and $undoOk -and $directionOk -and $aiStrategyOk -and $aiUiOk -and $aiLiveOk -and $aiConfigOk -and $nestedRulesOk -and $aiOrganizeOk -and $aiStructureOk -and $hotReloadOk -and $deleteSourcesOk -and $iconOk) {
  Write-Step '验收通过'
  exit 0
}

$failedSteps = @()
if (-not $logic) { $failedSteps += '纯逻辑测试' }
if (-not $copy) { $failedSteps += '真实复制测试' }
if (-not $alive) { $failedSteps += '真程序活着' }
if (-not $preview) { $failedSteps += '预览不落盘' }
if (-not $dropPath) { $failedSteps += '拖入取路径' }
if (-not $ruleEngine) { $failedSteps += '规则引擎' }
if (-not $ruleEditor) { $failedSteps += '规则编辑器' }
if (-not $folderPlan) { $failedSteps += '文件夹各归各' }
if (-not $folderPreview) { $failedSteps += '文件夹预览' }
if (-not $undoOk) { $failedSteps += '撤销' }
if (-not $directionOk) { $failedSteps += '输出方向' }
if (-not $aiStrategyOk) { $failedSteps += 'AI策略壳' }
if (-not $aiUiOk) { $failedSteps += 'AI界面壳' }
if (-not $aiLiveOk) { $failedSteps += 'AI真调用' }
if (-not $aiConfigOk) { $failedSteps += 'AI配置' }
if (-not $nestedRulesOk) { $failedSteps += '嵌套规则' }
if (-not $aiOrganizeOk) { $failedSteps += 'AI分类落地' }
if (-not $aiStructureOk) { $failedSteps += 'AI结构' }
if (-not $hotReloadOk) { $failedSteps += '热加载' }
if (-not $deleteSourcesOk) { $failedSteps += '删源文件' }
if (-not $iconOk) { $failedSteps += '软件图标' }
Fail ($failedSteps -join '+')
