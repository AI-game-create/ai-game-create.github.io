#!/usr/bin/env python3
"""投稿の反応(インプレッション・いいね・リポスト)を集めて data/posts.json を更新する。

  python scripts/fetch_metrics.py

直近14日ぶんの投稿だけを対象にする(X 側が古い投稿の非公開指標を返さないため)。
キーが無いときや対象が無いときは、何もせず正常終了する。
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Windows のコンソールでも日本語が読めるようにする
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
POSTS_FILE = ROOT / "data" / "posts.json"
ALERT_FILE = ROOT / "data" / "alert.md"

JST = timezone(timedelta(hours=9))
LOOKBACK_DAYS = 14
BATCH = 100


def log(msg: str) -> None:
    print(msg, flush=True)


def main() -> None:
    if ALERT_FILE.exists() and ALERT_FILE.read_text(encoding="utf-8").strip():
        log("data/alert.md に中身があるので、何もせず終了します。")
        return

    if not POSTS_FILE.exists():
        log("data/posts.json がまだありません。")
        return

    try:
        posts = json.loads(POSTS_FILE.read_text(encoding="utf-8") or "[]")
    except json.JSONDecodeError as e:
        log(f"::error::data/posts.json が壊れています: {e}")
        sys.exit(1)

    if not isinstance(posts, list) or not posts:
        log("記録された投稿がまだありません。")
        return

    limit = (datetime.now(JST) - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    targets = {
        str(p["tweet_id"]): p
        for p in posts
        if isinstance(p, dict) and p.get("tweet_id") and str(p.get("date", "")) >= limit
    }
    if not targets:
        log(f"直近{LOOKBACK_DAYS}日の投稿がないので、集める対象がありません。")
        return

    keys = [
        os.environ.get("X_API_KEY", ""),
        os.environ.get("X_API_SECRET", ""),
        os.environ.get("X_ACCESS_TOKEN", ""),
        os.environ.get("X_ACCESS_TOKEN_SECRET", ""),
    ]
    if not all(keys):
        log("APIキーが設定されていないので、反応の取得をスキップします。")
        return

    import tweepy

    client = tweepy.Client(
        consumer_key=keys[0],
        consumer_secret=keys[1],
        access_token=keys[2],
        access_token_secret=keys[3],
    )

    ids = list(targets.keys())
    updated = 0

    for i in range(0, len(ids), BATCH):
        chunk = ids[i : i + BATCH]
        # user_auth=True: 投稿と同じ鍵(ユーザーとしての認証)で読む。
        # 既定の False だと Bearer トークンを使おうとして、401 Unauthorized になる
        # 投票の結果(選択肢ごとの票数)も一緒に取る
        extra = {
            "user_auth": True,
            "expansions": ["attachments.poll_ids"],
            "poll_fields": ["options", "voting_status", "end_datetime"],
        }
        fields = ["public_metrics", "non_public_metrics", "created_at", "attachments"]
        try:
            res = client.get_tweets(ids=chunk, tweet_fields=fields, **extra)
        except Exception as e:  # 非公開指標が使えないプランなど
            log(f"非公開指標が取れなかったので、公開指標だけにします({e})。")
            try:
                res = client.get_tweets(ids=chunk, tweet_fields=["public_metrics", "created_at", "attachments"], **extra)
            except Exception as e2:
                log(f"::warning::反応の取得に失敗しました: {e2}")
                return

        polls = {str(p.id): p for p in (res.includes or {}).get("polls", [])}
        for tw in res.data or []:
            pub = getattr(tw, "public_metrics", None) or {}
            nonpub = getattr(tw, "non_public_metrics", None) or {}
            entry = targets.get(str(tw.id))
            if entry is None:
                continue
            entry["metrics"] = {
                "impressions": nonpub.get("impression_count", pub.get("impression_count", 0)),
                "likes": pub.get("like_count", 0),
                "reposts": pub.get("retweet_count", 0),
                "replies": pub.get("reply_count", 0),
                "bookmarks": pub.get("bookmark_count", 0),
                "fetched_at": datetime.now(JST).isoformat(timespec="seconds"),
            }
            poll_ids = (getattr(tw, "attachments", None) or {}).get("poll_ids") or []
            poll = polls.get(str(poll_ids[0])) if poll_ids else None
            if poll is not None:
                entry["poll_result"] = {
                    "status": poll.voting_status,
                    "options": [{"label": o["label"], "votes": o["votes"]} for o in poll.options],
                }
            updated += 1

        for err in getattr(res, "errors", None) or []:
            log(f"取得できなかった投稿があります: {err.get('detail', err)}")

    POSTS_FILE.write_text(
        json.dumps(posts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    log(f"{updated}件の反応を更新しました。")


if __name__ == "__main__":
    main()
