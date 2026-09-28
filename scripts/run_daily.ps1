<#
  毎晩の制作を1回だけ動かす。
    powershell -ExecutionPolicy Bypass -File scripts\run_daily.ps1

  やること: git pull → alert確認 → Claude Code に今日の作業を頼む → ログを残す
  ログ: logs\run-YYYY-MM-DD.log

  権限について:
    全権限のバイパスはしない。ファイル編集は自動承認(acceptEdits)にしつつ、
    コマンド実行は $AllowedTools に並べたものだけを許可する。
    ここに無いコマンドが必要になった場合、Claude は実行せずに
    data\alert.md に書いて終了する(CLAUDE.md の安全ルール)。
#>

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# 毎晩の作業に必要なコマンドだけを許可する
$AllowedTools = @(
    'Bash(git status:*)'
    'Bash(git add:*)'
    'Bash(git commit:*)'
    'Bash(git pull:*)'
    'Bash(git push:*)'
    'Bash(git diff:*)'
    'Bash(git log:*)'
    'Bash(npx playwright test:*)'
    'Bash(npm test:*)'
)

$logDir = Join-Path $repo 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir ("run-" + (Get-Date -Format 'yyyy-MM-dd') + ".log")

function Write-Log {
    param([string]$Message)
    $line = "[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] $Message"
    Write-Output $line
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

function Resolve-ClaudeExe {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }

    # VSCode拡張に同梱されている実行ファイルを探す(拡張の更新でフォルダ名が変わるため新しい順)
    $extRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
    if (Test-Path $extRoot) {
        $cands = Get-ChildItem $extRoot -Directory -Filter 'anthropic.claude-code-*' -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending
        foreach ($c in $cands) {
            $p = Join-Path $c.FullName 'resources\native-binary\claude.exe'
            if (Test-Path $p) { return $p }
        }
    }
    return $null
}

$weekdayMap = @{
    'Sunday' = '日曜日'; 'Monday' = '月曜日'; 'Tuesday' = '火曜日'; 'Wednesday' = '水曜日'
    'Thursday' = '木曜日'; 'Friday' = '金曜日'; 'Saturday' = '土曜日'
}

Write-Log '=== 制作をはじめます ==='

# 1. 最新を取り込む(GitHub Actions が posts.json を更新しているため)
try {
    $pull = & git pull --rebase --autostash
    Write-Log ("git pull: " + ($pull -join ' / '))
} catch {
    Write-Log "git pull に失敗しました: $($_.Exception.Message)"
    Write-Log '中断します。手元の変更を確認してください。'
    exit 1
}

# 2. 異常フラグの確認
$alert = Join-Path $repo 'data\alert.md'
if (Test-Path $alert) {
    $body = Get-Content $alert -Raw -Encoding utf8
    if ($null -ne $body -and $body.Trim().Length -gt 0) {
        Write-Log 'data\alert.md に中身があるので、制作せずに終了します。'
        Write-Log '内容を確認して空にし、commit & push すると再開します。'
        exit 0
    }
}

# 3. Claude Code を探す
$claude = Resolve-ClaudeExe
if ($null -eq $claude) {
    Write-Log 'Claude Code の実行ファイルが見つかりませんでした。'
    Write-Log 'PowerShell で claude が使えるか確認してください(投稿は止まりません)。'
    exit 1
}
Write-Log "使う実行ファイル: $claude"

# 4. 今日の作業を頼む
$today = Get-Date -Format 'yyyy-MM-dd'
$weekday = $weekdayMap[[string](Get-Date).DayOfWeek]
$prompt = @"
今日は $today($weekday)です。
CLAUDE.md の「2. 毎日のワークフロー」に従って、今日の作業を最後まで進めてください。
投稿は GitHub Actions が行うので、自分では投稿しないでください。
"@

Write-Log "今日の日付を渡します: $today($weekday)"

# 制作に使うモデルを固定する(既定モデルに任せると、夜ごとに変わる可能性があるため)
$Model = 'claude-opus-5-5'
Write-Log "使うモデル: $Model"

$claudeArgs = @('-p', $prompt, '--model', $Model, '--permission-mode', 'acceptEdits', '--allowedTools') + $AllowedTools

try {
    & $claude @claudeArgs 2>&1 |
        ForEach-Object {
            Write-Output $_
            Add-Content -Path $logFile -Value $_ -Encoding utf8
        }
    $code = $LASTEXITCODE
} catch {
    Write-Log "実行中にエラーが出ました: $($_.Exception.Message)"
    $code = 1
}

if ($code -eq 0) {
    Write-Log '=== 制作が終わりました ==='
} else {
    Write-Log "=== 終了コード $code で終わりました(ログを確認してください) ==="
}

exit $code
