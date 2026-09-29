# セットアップ手順(Windows)

## 全体の仕組み

- **あなたのPC(毎晩20:05〜)**: Claude Codeが翌日以降に投稿するゲームを作り、GitHubに置いておく
- **GitHub Actions(毎日20:30、開発の話はその10分後)**: GitHubのサーバーが投稿を行う。PCの電源は関係ない

ゲームは最大3日分までストックされるので、数日PCを起動しなくても投稿は続きます。

所要時間の目安: 2〜3時間(X開発者登録の審査待ちを除く)

> **Claude Codeに任せる場合**: Git for Windows・Node.js・Claude Code を入れたら、このフォルダで `claude` を起動し
> 「SETUP_FOR_CLAUDE.md の手順でセットアップして」と頼むだけでOK。以下は手動でやる場合の手順です。

## 1. 必要なソフトを入れる(PC)

- **Git for Windows**(Claude CodeもWindowsではこれを使う)
- **Node.js**(LTS版)
- **Claude Code**(公式の手順でインストール後、PowerShellで `claude` を一度起動してログインしておく)

※ Pythonは不要です(投稿用のPythonはGitHub上で動きます)

## 2. このフォルダをGitHubで公開する

1. GitHubで **Public** リポジトリを作る(例: `ai-game-studio`)
2. このフォルダで以下を実行
   ```
   git init
   git add -A
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/ユーザー名/ai-game-studio.git
   git push -u origin main
   ```
   ※ 初回のpushでブラウザのログイン画面が出るので認証する(以後は自動)
3. リポジトリの Settings → Pages → Branch を `main` / `(root)` にして保存
4. `CLAUDE.md` の「公開URLのベース」を自分のURLに書き換えて commit & push

## 3. Xの準備

1. 運用用のXアカウントを作る(個人アカウントとは分ける)
2. プロフィールに自動化アカウントのラベルを設定し、自分の管理アカウントを紐づける
3. X Premium に加入する
4. 開発者コンソール(console.x.com)でアプリを作成
   - 権限を **Read and Write** に設定
   - **権限を設定した後に** API Key / Secret と Access Token / Secret を発行する(順番が逆だと投稿できない)
   - クレジットを少額(10ドル程度)購入する

## 4. GitHubに設定を入れる

リポジトリの Settings → Secrets and variables → Actions で登録する。

**Secrets**(キーは外から見えない形で保存される)
| 名前 | 値 |
|---|---|
| X_API_KEY | XのAPI Key |
| X_API_SECRET | XのAPI Key Secret |
| X_ACCESS_TOKEN | XのAccess Token |
| X_ACCESS_TOKEN_SECRET | XのAccess Token Secret |

**Variables**
| 名前 | 値 |
|---|---|
| GAME_BASE_URL | `https://ユーザー名.github.io/ai-game-studio/` |
| DRY_RUN | `1`(試運転中は投稿しない) |

## 5. PCの準備

このフォルダで実行:
```
npm install
npx playwright install chromium
```

## 6. 試運転(3日ほど)

1. 夜に手動でゲーム制作を動かす
   ```
   powershell -ExecutionPolicy Bypass -File scripts\run_daily.ps1
   ```
2. 確認すること
   - `games/` にゲームができていて、ブラウザで開いて遊べるか
   - `data/queue/` の投稿文がキャラ設定どおりか
   - `logs/run-日付.log` にエラーが出ていないか
3. GitHubの Actions タブ → 「X投稿」→ Run workflow で手動実行し、ログに投稿予定の文章が出るか確認
   (投稿日のキューが無い日は「スキップします」と出るのが正常)

気になる点があれば `CLAUDE.md` を直す。

## 7. 本番開始

1. GitHubの Variables で `DRY_RUN` を `0` に変える
2. 毎晩の制作を登録する
   ```
   powershell -ExecutionPolicy Bypass -File scripts\register_tasks.ps1
   ```
3. 以後は20時以降にPCを起動していれば、自動で制作が始まる

## 日々の運用(週1回でOK)

- **GitHubからエラーのメールが来たら**: `data/alert.md` を見る。中身がある間は投稿も制作も止まっている
  → 原因を確認して対応し、**中身を消して commit & push すると再開**
- Xのアナリティクスと `data/learnings.md` を眺める

## 止めたいとき

- 制作を止める: `Disable-ScheduledTask AIGame_Daily`(再開は `Enable-ScheduledTask`)
- 投稿を止める: GitHubの Actions タブ → 「X投稿」→ 右上の「…」→ Disable workflow

## 補足

- GitHub Actionsの定時実行は混雑時に数分〜十数分遅れることがあります
