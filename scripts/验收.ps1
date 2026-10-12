# 验收：文件批量整理器（本片）
# 标准由控制台写死，工作台只执行，不修改、不放宽。
# 跑法：npm run 验收   （= powershell -ExecutionPolicy Bypass -File scripts\验收.ps1）

# 只让 cmdlet 的错误按 Stop 处理；外部程序（node/npm）往 stderr 写提示
# （比如 npm notice）在 Windows PowerShell 5.1 下会被升级成致命错误，所以这里用 Continue，
# 由每一条断言自己看 $LASTEXITCODE 和日志内容来判断成败。
$ErrorActionPreference = 'Continue'
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
  Write-Step '--- 1/3 纯逻辑测试 ---'
  $outDir = Join-Path $projectRoot 'out'
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $logicTestJs = Join-Path $stage 'accept-logic-test.js'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'accept-logic-test.js') -Destination $logicTestJs -Force
  $logicLog = Join-Path $stage 'accept-logic.log'
  & node $logicTestJs $outDir *> $logicLog
  $logicCode = $LASTEXITCODE
  Get-Content -LiteralPath $logicLog -Tail 20 | ForEach-Object { Write-Host $_ }
  Write-Host "纯逻辑测试退出码=$logicCode  日志=$logicLog"
  if ($logicCode -eq 0 -and ((Get-Content -LiteralPath $logicLog -Raw) -match '分类逻辑OK')) {
    Write-Step '分类逻辑OK'
    $logic = $true
  }
} catch {
  Write-Host "纯逻辑测试异常：$($_.Exception.Message)"
}

# ---------- 第 2 条：真实复制测试（不需要界面） ----------
$copy = $false
try {
  Write-Step '--- 2/3 真实复制测试 ---'
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
  Get-Content -LiteralPath $copyLog -Tail 30 | ForEach-Object { Write-Host $_ }
  Write-Host "真实复制测试退出码=$copyCode  日志=$copyLog"
  if ($copyCode -eq 0 -and ((Get-Content -LiteralPath $copyLog -Raw) -match '复制落地OK')) {
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
  Write-Step '--- 3/3 真程序活着 ---'
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
    Get-Content -LiteralPath $buildLog -Tail 40 | ForEach-Object { Write-Host $_ }
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
      if (Test-Path -LiteralPath $stdoutLog) { $stdoutText = Get-Content -LiteralPath $stdoutLog -Raw }
      $hasMarkerInStdout = ($stdoutText -match 'ORGANIZER_READY')
      $hasMarkerFile = (Test-Path -LiteralPath $markerFile)
      Write-Host "electron 等待秒数=$waited  提前退出=$exitedEarly  stdout有标记=$hasMarkerInStdout  标记文件存在=$hasMarkerFile"
      if ($stdoutText -and $stdoutText.Length -gt 0) {
        Write-Host "electron stdout 尾部："
        Get-Content -LiteralPath $stdoutLog -Tail 5 | ForEach-Object { Write-Host $_ }
      }
      if ((Test-Path -LiteralPath $stderrLog) -and (Get-Item -LiteralPath $stderrLog).Length -gt 0) {
        Write-Host "electron stderr 尾部："
        Get-Content -LiteralPath $stderrLog -Tail 10 | ForEach-Object { Write-Host $_ }
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

if ($logic -and $copy -and $alive) {
  Write-Step '验收通过'
  exit 0
}

$failedSteps = @()
if (-not $logic) { $failedSteps += '纯逻辑测试' }
if (-not $copy) { $failedSteps += '真实复制测试' }
if (-not $alive) { $failedSteps += '真程序活着' }
Fail ($failedSteps -join '+')
