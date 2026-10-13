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

  起動のきっかけは「毎日20:00」と「ログオンの3分後」の2つ(register_tasks.ps1)。
  直近の20:00以降に制作が最後まで終わった記録があれば、何もせずに終わる(ログオンのたびに作らないため)。
  昼間(5:00〜19:30)のログオンでは、今日の投稿ぶんがまだ無いときだけ作る(ストックがあれば20:00まで待つ)。
  途中で止まった回は記録が残らないので、次のログオンでやり直す。必ず動かしたいときは -Force を付ける。
#>

param([switch]$Force)

$ErrorActionPreference = 'Stop'

# Claude の出力(UTF-8)をログで文字化けさせないため
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

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
    # Xのトレンドを確かめるための検索(CLAUDE.md 2章の手順3)
    'WebSearch'
)

$logDir = Join-Path $repo 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# 直近の20:00の回が、もう最後まで終わっているなら何もしない(ログは書かない)
if (-not $Force) {
    $slot = (Get-Date).Date.AddHours(20)
    if ((Get-Date) -lt $slot) { $slot = $slot.AddDays(-1) }
    $done = Get-ChildItem $logDir -Filter 'run-*.log' |
        Where-Object { $_.LastWriteTime -ge $slot } |
        Select-String -Pattern '\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] === 制作が終わりました ===' |
        Where-Object { [datetime]$_.Matches[0].Groups[1].Value -ge $slot }
    if ($done) { exit 0 }

    # 昼間(5:00〜19:30)にログオンで起動したときは、今日の投稿ぶん(data\queue\今日.json)が無いときだけ作る。
    # ストックがあるのに昼間に作ると、オーナーが Claude を使う時間帯の使用量を食い、
    # テスト用のブラウザがマウスカーソルを閉じこめることもあった(2026-10-10)。続きは20:00の回で作る
    $now = Get-Date
    if ($now.Hour -ge 5 -and $now -lt $now.Date.AddHours(19).AddMinutes(30)) {
        $todayQueue = Join-Path $repo ('data\queue\' + $now.ToString('yyyy-MM-dd') + '.json')
        if (Test-Path $todayQueue) { exit 0 }
    }
}
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
$now = Get-Date -Format 'HH:mm'
$weekday = $weekdayMap[[string](Get-Date).DayOfWeek]
#    制作は2回の起動に分ける(2026-10-13、オーナーの方針)。1回の会話が長くなるほど、返事のたびに読み直す量が増えて使用量がかさむため。
#    1回目: 作る(手順1〜7)。作ったものはコミットしない / 2回目: 作りかけが残っていれば、仕上げ(手順8〜13)
$common = @"
投稿は GitHub Actions が行うので、自分では投稿しないでください。
この作業は、あなたが返事を終えた時点で終了し、完了の通知などは届きません。
コマンド(特にテスト)はバックグラウンドで実行せず、必ず終わるまで待ってください。
"@
$prompt = @"
今日は $today($weekday)、いまの時刻は $now です。
CLAUDE.md の「2. 毎日のワークフロー」に従って、今日の作業を進めてください。
今夜の制作は2回の起動に分けています。この1回目では、ゲームを作る日なら手順7(テストが通るまで。動画も撮る)で終えてください。
そのときは作ったものをコミットせずに終了してください。仕上げ(手順8)からは、2回目の起動が続けます。
ゲームを作らない日(ストックが十分な日など)は、いつもどおり最後の git push まで終えてから終了してください。
$common
"@

Write-Log "今日の日付を渡します: $today($weekday) $now"

# 制作に使うモデルを固定する(既定モデルに任せると、夜ごとに変わる可能性があるため)
$Model = 'claude-opus-5-5'
Write-Log "使うモデル: $Model"

function Invoke-Claude([string]$p) {
    $claudeArgs = @('-p', $p, '--model', $Model, '--permission-mode', 'acceptEdits', '--allowedTools') + $AllowedTools
    try {
        & $claude @claudeArgs 2>&1 |
            ForEach-Object {
                # Write-Output だと関数の戻り値に混ざるので、画面へは Write-Host で出す
                Write-Host $_
                Add-Content -Path $logFile -Value $_ -Encoding utf8
            }
        return $LASTEXITCODE
    } catch {
        Write-Log "実行中にエラーが出ました: $($_.Exception.Message)"
        return 1
    }
}

Write-Log '--- 1回目(作る) ---'
$code = Invoke-Claude $prompt

# コミットされていない games/ のフォルダが残っていれば、2回目の起動で仕上げる
if ($code -eq 0) {
    $wip = git -C $repo status --porcelain -- games 2>$null
    if ($wip) {
        $now2 = Get-Date -Format 'HH:mm'
        $prompt2 = @"
今日は $today($weekday)、いまの時刻は $now2 です。
今夜の制作の2回目の起動です。1回目の起動で作ったゲームが、コミットされずに games/ に残っています(手順7まで終わっているはずです)。
CLAUDE.md の「2. 毎日のワークフロー」の手順8(仕上げ)から手順13(git push)まで進めてください。
はじめに data/learnings.md とそのゲームの design.md を読み、``npx playwright test --grep-invert 動画`` を1回走らせてください。
通らなければ手順7から直してください。ゲーム本体や tests/play.spec.ts の全体は読まず、Grep で必要な所だけ読んでください。
$common
最後の git push まで終えてから、作業を終了してください。
"@
        Write-Log '--- 2回目(仕上げ) ---'
        $code = Invoke-Claude $prompt2
    }
}

if ($code -eq 0) {
    Write-Log '=== 制作が終わりました ==='
} else {
    Write-Log "=== 終了コード $code で終わりました(ログを確認してください) ==="
}

# 5. YouTube ショート用の縦長動画を作り、リポジトリの外の youtube_short フォルダに置く(アップロードはオーナーが手で行う)。
#    夜の Claude が書いた「投稿用のプレイ動画を撮る」テストを、ショート用モード(SHORT_VIDEO=1)でもう一度走らせる。
#    動画は shorts\ にでき(コミットしない)、まだ置いていないものだけをコピーする。失敗しても制作は止めない
if ($code -eq 0) {
    try {
        $latest = Get-ChildItem (Join-Path $repo 'games') -Directory | Sort-Object Name | Select-Object -Last 1
        $date = $latest.Name.Substring(0, 10)
        $shortsDir = Join-Path $repo 'shorts'
        $outDir = Join-Path (Split-Path -Parent $repo) 'youtube_short'
        if (-not (Get-ChildItem $shortsDir -Filter "${date}_*.webm" -ErrorAction SilentlyContinue)) {
            Write-Log "ショート用の動画を撮ります: $($latest.Name)"
            $env:SHORT_VIDEO = '1'
            # Windows PowerShell 5.1 は、外部コマンドの標準エラー(node の警告など)を 2>&1 で受けると
            # エラーとして扱い、'Stop' だとそこで止まってしまう(2026-10-04 に発生)。ここだけ 'Continue' にする
            $ErrorActionPreference = 'Continue'
            & npx playwright test tests/play.spec.ts -g '動画' --project=desktop 2>&1 |
                ForEach-Object { Add-Content -Path $logFile -Value "$_" -Encoding utf8 }
            Remove-Item Env:SHORT_VIDEO -ErrorAction SilentlyContinue
            # 場面ごとに撮った動画(shorts\parts\名前-1.webm, 名前-2.webm, …)を1本の mp4 につなぐ
            & python scripts/concat_video.py shorts/parts shorts 2>&1 |
                ForEach-Object { Write-Log "$_" }
            $ErrorActionPreference = 'Stop'
        }
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        Get-ChildItem $shortsDir -File -ErrorAction SilentlyContinue |
            Where-Object { ($_.Extension -in @('.mp4', '.webm')) -and -not (Test-Path (Join-Path $outDir $_.Name)) } |
            ForEach-Object {
                Copy-Item $_.FullName $outDir
                Write-Log "ショートを置きました: $($_.Name)"
            }
    } catch {
        Write-Log "ショート用の動画を作れませんでした: $($_.Exception.Message)"
    }
}

exit $code
