#!/usr/bin/env python3
"""X へ1件だけ投稿する。GitHub Actions から呼ばれる。

  python scripts/post_to_x.py --slot release

やること
  1. data/alert.md に中身があれば何もしない
  2. 今日(日本時間)の data/queue/YYYY-MM-DD.json を読む。無ければスキップ
  3. 投稿文を検査する(140字以内 / 本文にURLなし / game_url が公開URLで始まる)
  4. DRY_RUN が "0" 以外なら、投稿せずに内容を表示して終わる
  5. release 枠はスクリーンショット付きで投稿し、URLは自己リプライで付ける
  6. 結果を data/posts.json に記録する

環境変数
  X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET
  GAME_BASE_URL  公開URLのベース(例: https://user.github.io/ai-game-studio/)
  DRY_RUN        "0" のときだけ本当に投稿する(未設定なら試運転扱い)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Windows のコンソールでも日本語が読めるようにする
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
QUEUE_DIR = ROOT / "data" / "queue"
POSTS_FILE = ROOT / "data" / "posts.json"
ALERT_FILE = ROOT / "data" / "alert.md"

JST = timezone(timedelta(hours=9))
SLOTS = ("release", "devlog", "wrapup")
MAX_CHARS = 140          # CLAUDE.md のルール
MAX_WEIGHTED = 280       # X 側の上限(全角は2文字ぶん)


def log(msg: str) -> None:
    print(msg, flush=True)


def weighted_len(text: str) -> int:
    """X の数え方。全角(東アジアの文字)は2、それ以外は1。"""
    total = 0
    for ch in text:
        total += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return total


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8") or "null") or default
    except json.JSONDecodeError as e:
        log(f"::error::{path} が壊れています: {e}")
        sys.exit(1)


def check_alert() -> None:
    if ALERT_FILE.exists() and ALERT_FILE.read_text(encoding="utf-8").strip():
        log("data/alert.md に中身があるので、投稿せずに終了します。")
        log("内容を確認して空にし、commit & push すると再開します。")
        sys.exit(0)


def load_queue(date_str: str) -> dict | None:
    path = QUEUE_DIR / f"{date_str}.json"
    if not path.exists():
        return None
    data = read_json(path, None)
    if not isinstance(data, dict):
        log(f"::error::{path} の形式が想定と違います。")
        sys.exit(1)
    return data


def validate(text: str, slot: str) -> None:
    if not text.strip():
        log(f"::error::{slot} の投稿文が空です。")
        sys.exit(1)
    if len(text) > MAX_CHARS:
        log(f"::error::{slot} の投稿文が {len(text)}字で、140字を超えています。")
        sys.exit(1)
    if weighted_len(text) > MAX_WEIGHTED:
        log(f"::error::{slot} の投稿文が X の上限を超えています。")
        sys.exit(1)
    if "http://" in text or "https://" in text:
        log(f"::error::{slot} の本文にURLが入っています(本文にURLは入れません)。")
        sys.exit(1)


def validate_game_url(url: str, base: str) -> None:
    if not url:
        return  # 失敗報告の日は空でよい
    if not base:
        log("::error::GAME_BASE_URL が設定されていません。")
        sys.exit(1)
    if not url.startswith(base):
        log(f"::error::game_url が公開URLのベースで始まっていません。\n  game_url: {url}\n  base: {base}")
        sys.exit(1)


def build_clients():
    keys = {
        "X_API_KEY": os.environ.get("X_API_KEY", ""),
        "X_API_SECRET": os.environ.get("X_API_SECRET", ""),
        "X_ACCESS_TOKEN": os.environ.get("X_ACCESS_TOKEN", ""),
        "X_ACCESS_TOKEN_SECRET": os.environ.get("X_ACCESS_TOKEN_SECRET", ""),
    }
    missing = [k for k, v in keys.items() if not v]
    if missing:
        log(f"::error::APIキーが設定されていません: {', '.join(missing)}")
        sys.exit(1)

    import tweepy

    client = tweepy.Client(
        consumer_key=keys["X_API_KEY"],
        consumer_secret=keys["X_API_SECRET"],
        access_token=keys["X_ACCESS_TOKEN"],
        access_token_secret=keys["X_ACCESS_TOKEN_SECRET"],
    )
    api = tweepy.API(
        tweepy.OAuth1UserHandler(
            keys["X_API_KEY"],
            keys["X_API_SECRET"],
            keys["X_ACCESS_TOKEN"],
            keys["X_ACCESS_TOKEN_SECRET"],
        )
    )
    return client, api


def record(entry: dict) -> None:
    posts = read_json(POSTS_FILE, [])
    if not isinstance(posts, list):
        posts = []
    posts.append(entry)
    POSTS_FILE.write_text(
        json.dumps(posts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    log(f"data/posts.json に記録しました({len(posts)}件目)。")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slot", required=True, choices=SLOTS)
    parser.add_argument("--date", help="投稿日を指定(既定: 日本時間の今日)")
    args = parser.parse_args()

    check_alert()

    date_str = args.date or datetime.now(JST).strftime("%Y-%m-%d")
    slot = args.slot
    dry_run = os.environ.get("DRY_RUN", "1") != "0"

    log(f"投稿枠: {slot} / 日付: {date_str} / 試運転: {'はい' if dry_run else 'いいえ'}")

    queue = load_queue(date_str)
    if queue is None:
        log("今日の投稿キューが無いのでスキップします。")
        return

    text = (queue.get("posts") or {}).get(slot, "")
    validate(text, slot)

    base = os.environ.get("GAME_BASE_URL", "").strip()
    game_url = (queue.get("game_url") or "").strip()
    validate_game_url(game_url, base)

    shot = (queue.get("screenshot") or "").strip()
    shot_path = ROOT / shot if shot else None
    if slot == "release" and shot_path and not shot_path.exists():
        log(f"スクリーンショットが見つかりません({shot})。画像なしで投稿します。")
        shot_path = None

    log("--- 投稿する内容 ---")
    log(f"タイトル: {queue.get('title', '(なし)')}")
    log(f"本文({len(text)}字):\n{text}")
    if slot == "release":
        log(f"画像: {shot if shot_path else '(なし)'}")
        log(f"リプライで付けるURL: {game_url or '(なし)'}")
    log("--------------------")

    if dry_run:
        log("試運転モードなので、実際には投稿しませんでした。")
        log("本番にするには GitHub の Variables で DRY_RUN を 0 にしてください。")
        return

    client, api = build_clients()

    media_ids = None
    if slot == "release" and shot_path:
        media = api.media_upload(filename=str(shot_path))
        media_ids = [media.media_id_string]
        log("スクリーンショットをアップロードしました。")

    res = client.create_tweet(text=text, media_ids=media_ids)
    tweet_id = str(res.data["id"])
    log(f"投稿しました: https://x.com/i/status/{tweet_id}")

    entry = {
        "date": date_str,
        "slot": slot,
        "tweet_id": tweet_id,
        "title": queue.get("title", ""),
        "text": text,
        "posted_at": datetime.now(JST).isoformat(timespec="seconds"),
        "metrics": None,
    }

    # release だけ、ゲームのURLを自己リプライで付ける
    if slot == "release" and game_url:
        reply_text = f"あそべるのはこちらです → {game_url}"
        reply = client.create_tweet(text=reply_text, in_reply_to_tweet_id=tweet_id)
        entry["reply_tweet_id"] = str(reply.data["id"])
        log("URLの自己リプライを付けました。")

    record(entry)


if __name__ == "__main__":
    main()
