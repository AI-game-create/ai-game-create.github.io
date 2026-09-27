# セットアップ手順書(Claude Code用)

このファイルは、オーナーから「セットアップして」と頼まれたときにClaude Codeが従う手順書です。

## このセッションでの注意

- これは**セットアップ作業**です。CLAUDE.md の「毎日のワークフロー」(ゲーム制作)は実行しないこと
- CLAUDE.md の安全ルールのうち「CLAUDE.md・scripts・.github を変更しない」は、このセッションに限り**手順5の公開URLの書き換えだけ**例外とする
- **APIキーやパスワードは絶対に聞かない・受け取らない・表示しない**。キーの入力はオーナー自身が別のPowerShellで行う(手順8)
- ログインやブラウザ操作が必要な場面では、オーナーに具体的なコマンドや操作を伝えて、終わるまで待つ
- 各手順が終わるたびに、何をしたかを1〜2行で報告してから次へ進む
- エラーが出たら自力で2回まで対処し、それでもダメならオーナーに状況を説明して止まる

---

## 手順1. 前提ソフトの確認

以下のバージョンを確認する。

```
git --version
node --version
npm --version
gh --version
```

- `gh`(GitHub CLI)が無ければ `winget install --id GitHub.cli -e` でインストールし、
  オーナーに「PowerShellを開き直して、もう一度 claude を起動してください」と伝えて止まる
- git / node が無い場合はオーナーに公式サイトからのインストールを案内して止まる

## 手順2. オーナーに確認する

次の2点を質問する(オーナーの回答を待つ)。

1. GitHubのリポジトリ名(おすすめ: `ai-game-studio`)
2. AIキャラクターの名前(決まっていなければ CLAUDE.md の仮名のままでよい)

キャラクター名が指定されたら、CLAUDE.md の「名前:」の行だけ書き換える。

## 手順3. GitHubへのログイン確認

```
gh auth status
```

ログインしていなければ、オーナーに次を伝えて完了を待つ。

> 別のPowerShellで `gh auth login` を実行し、「GitHub.com」「HTTPS」「ブラウザでログイン」を選んでください。終わったら教えてください。

## 手順4. リポジトリを作って公開する

```
git init
git add -A
git commit -m "init"
git branch -M main
gh repo create <リポジトリ名> --public --source . --push
```

## 手順5. GitHub Pages を有効にし、公開URLを設定する

```
gh api -X POST repos/{owner}/<リポジトリ名>/pages -f "source[branch]=main" -f "source[path]=/"
```
(`{owner}` は `gh api user --jq .login` で取得したユーザー名に置き換える。すでに有効ならエラーになるが問題ない)

公開URLのベースは `https://<ユーザー名>.github.io/<リポジトリ名>/`。

- CLAUDE.md の「公開URLのベース」の行をこのURLに書き換える
- GitHubの変数を設定する
  ```
  gh variable set GAME_BASE_URL --body "https://<ユーザー名>.github.io/<リポジトリ名>/"
  gh variable set DRY_RUN --body "1"
  ```
- `git add -A` → `git commit -m "setup: 公開URLを設定"` → `git push`

## 手順6. PCの依存関係を入れる

```
npm install
npx playwright install chromium
```

## 手順7. Xの準備をオーナーに依頼する

以下をそのままオーナーに伝え、完了を待つ(ここは人間にしかできない)。

> ここからはXの作業なので、あなたにお願いします。
> 1. 運用用のXアカウントを作る(個人アカウントとは分ける)
> 2. プロフィールに自動化アカウントのラベルを設定し、管理者としてあなたの個人アカウントを紐づける
> 3. X Premium に加入する
> 4. console.x.com でアプリを作り、権限を **Read and Write** にする
> 5. **権限を設定した後に**、API Key / API Key Secret / Access Token / Access Token Secret の4つを発行する
> 6. クレジットを10ドル程度購入する
>
> キーはまだどこにも貼らないでください。終わったら「終わった」とだけ教えてください。

## 手順8. APIキーの登録(オーナー自身が行う)

オーナーに次を伝える。**キーの値はこのチャットに絶対に貼らないよう、はっきり伝えること。**

> セキュリティのため、キーはあなた自身が登録してください。**このチャットにはキーを貼らないでください。**
> このフォルダで**新しいPowerShellを開き**、次の4つを1行ずつ実行してください。
> 実行すると入力を求められるので、対応するキーを貼り付けてEnterを押します。
> ```
> gh secret set X_API_KEY
> gh secret set X_API_SECRET
> gh secret set X_ACCESS_TOKEN
> gh secret set X_ACCESS_TOKEN_SECRET
> ```
> 終わったら教えてください。

完了の連絡が来たら `gh secret list` で4つが登録されていることを確認する(値は表示されない)。

## 手順9. 投稿の仕組みを確認する(試運転モード)

```
gh workflow run post.yml -f slot=release
```
数秒待ってから
```
gh run list --workflow post.yml --limit 1
gh run watch
```
ログに「今日の投稿キューが無いのでスキップします」と出て成功していればOK
(まだゲームを作っていないので、スキップが正常な結果)。

## 手順10. 完了報告

オーナーに以下を伝えてセットアップを終える。

> セットアップが完了しました。現在は **試運転モード(投稿はしない)** です。
>
> **次にやること**
> 1. 今夜、PowerShellで次を実行して、試しにゲームを1本作らせてください
>    `powershell -ExecutionPolicy Bypass -File scripts\run_daily.ps1`
> 2. できたゲーム(`games/` フォルダ)をブラウザで開いて遊べるか、`data/queue/` の投稿文が良さそうかを確認
> 3. 2〜3日試して問題なければ、本番開始:
>    - `gh variable set DRY_RUN --body "0"`
>    - `powershell -ExecutionPolicy Bypass -File scripts\register_tasks.ps1`
>
> 公開ページ: https://<ユーザー名>.github.io/<リポジトリ名>/ (反映まで数分かかります)

※ 毎晩の自動実行(register_tasks.ps1)は、オーナーが試運転を確認するまで登録しないこと。
