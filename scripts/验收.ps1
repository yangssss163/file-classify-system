# 验收：文件批量整理器（本片）
# 标准由控制台写死，工作台只执行，不修改、不放宽。
# 跑法：npm run 验收   （= powershell -ExecutionPolicy Bypass -File scripts\验收.ps1）
#
# 九条断言（缺一不通过）：
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
#     正常撤销/幂等/不删用户后加的东西/不删被改过的文件/删除失败不崩/跨重启可用/绝不越界）
#  11 输出方向        accept-output-direction-test.js -> 输出方向OK（纯逻辑 + 界面接线：
#     输出=源、输出在源之下、输出是源的上一级 一律不许开工且一个字节都不写；
#     正常方向允许并真跑一次；散文件只校验「输出 != 文件所在目录」；含「探针有效性自检」）
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
  Write-Step '--- 1/9 纯逻辑测试 ---'
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
  Write-Step '--- 2/9 真实复制测试 ---'
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
  Write-Step '--- 3/9 真程序活着 ---'
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
  Write-Step '--- 4/9 预览不落盘 ---'
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
  Write-Step '--- 5/9 拖入取路径 ---'
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
  Write-Step '--- 6/9 规则引擎 ---'
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
  Write-Step '--- 7/9 规则编辑器 ---'
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
  Write-Step '--- 8/9 文件夹各归各 ---'
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
  Write-Step '--- 9/9 文件夹预览 ---'
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
  Write-Step '--- 10/11 撤销上一次整理 ---'
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
  Write-Step '--- 11/11 输出方向 ---'
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

if ($logic -and $copy -and $alive -and $preview -and $dropPath -and $ruleEngine -and $ruleEditor -and $folderPlan -and $folderPreview -and $undoOk -and $directionOk) {
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
Fail ($failedSteps -join '+')
