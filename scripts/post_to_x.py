#!/usr/bin/env python3
"""X へ1件だけ投稿する。GitHub Actions から呼ばれる。

  python scripts/post_to_x.py --slot release

やること
  1. data/alert.md に中身があれば何もしない
  2. 今日(日本時間)の data/queue/YYYY-MM-DD.json を読む。無ければスキップ
  3. 投稿文を検査する(140字以内 / 本文にURLなし / game_url が公開URLで始まる)
  4. DRY_RUN が "0" 以外なら、投稿せずに内容を表示して終わる
  5. release 枠はプレイ動画付きで投稿し、URLは自己リプライで付ける
     (動画が使えなければスクリーンショット、それも駄目なら文字だけで投稿する)
  6. 結果を data/posts.json に記録する(動画のファイルは投稿後に消す)

環境変数
  X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET
  GAME_BASE_URL  公開URLのベース(例: https://user.github.io/ai-game-studio/)
  DRY_RUN        "0" のときだけ本当に投稿する(未設定なら試運転扱い)

動画は games/…/play.webm を ffmpeg で mp4(H.264)に変換して載せる。ffmpeg が無ければ画像にする。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
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
DAY_ONE = date(2026, 9, 29)  # 初めて投稿した日。この日を「1日目」として数える


def with_day_prefix(text: str, date_str: str) -> str:
    """release の本文の先頭に「【N日目】」を付ける。本文側に書かれていたら付け直す。"""
    n = (date.fromisoformat(date_str) - DAY_ONE).days + 1
    body = re.sub(r"^\s*【\d+日目】\s*", "", text)
    return f"【{n}日目】{body}"


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


def has_audio(src: Path) -> bool:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return False
    try:
        r = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, timeout=60,
        )
    except (subprocess.SubprocessError, OSError):
        return False
    return bool(r.stdout.strip())


def webm_to_mp4(src: Path) -> Path | None:
    """X に載せられる mp4(H.264 + AAC)に変換する。できなければ None。"""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        log("::warning::ffmpeg が無いので、動画は使いません。")
        return None
    out = Path(tempfile.gettempdir()) / f"{src.parent.name}.mp4"
    sound = has_audio(src)
    if sound:
        # ゲームの音を使う。音声のすき間は無音で埋めて、映像とずれないようにする
        extra_input, audio = [], ["-map", "0:a:0", "-af", "aresample=async=1:first_pts=0"]
    else:
        # 音のない動画を受け付けない場合に備えて、無音の音声を付ける
        extra_input = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
        audio = ["-map", "1:a:0"]
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src), *extra_input,
        "-map", "0:v:0", *audio, "-shortest", "-t", "60",
        "-vf", r"scale=trunc(min(1280\,iw)/2)*2:-2,fps=30,format=yuv420p",
        "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart",
        str(out),
    ]
    try:
        subprocess.run(cmd, check=True, timeout=300, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        log(f"::warning::動画を mp4 にできなかったので、動画は使いません: {e.stderr.strip()[-500:]}")
        return None
    except (subprocess.SubprocessError, OSError) as e:
        log(f"::warning::動画を mp4 にできなかったので、動画は使いません: {e}")
        return None
    log(f"動画を mp4 にしました({out.stat().st_size / 1024 / 1024:.1f}MB、{'ゲームの音つき' if sound else '音なし'})。")
    return out


def upload_video(api, mp4: Path) -> str:
    """動画をアップロードし、X 側の変換が終わるまで待つ(最大3分。過ぎたら失敗扱い)。"""
    media = api.media_upload(
        filename=str(mp4), media_category="tweet_video", chunked=True, wait_for_async_finalize=False
    )
    deadline = time.monotonic() + 180
    while True:
        info = getattr(media, "processing_info", None) or {}
        state = info.get("state")
        if state in (None, "succeeded"):
            return media.media_id_string
        if state == "failed" or "error" in info:
            raise RuntimeError(f"X 側で動画の処理に失敗しました: {info}")
        if time.monotonic() > deadline:
            raise RuntimeError("X 側の動画の処理が3分で終わりませんでした")
        time.sleep(max(1, int(info.get("check_after_secs", 3))))
        media = api.get_media_upload_status(media.media_id)


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
    if slot == "release" and text.strip():
        text = with_day_prefix(text, date_str)
    validate(text, slot)

    base = os.environ.get("GAME_BASE_URL", "").strip()
    game_url = (queue.get("game_url") or "").strip()
    validate_game_url(game_url, base)

    shot = (queue.get("screenshot") or "").strip()
    shot_path = ROOT / shot if shot else None
    if slot == "release" and shot_path and not shot_path.exists():
        log(f"スクリーンショットが見つかりません({shot})。画像なしで投稿します。")
        shot_path = None

    video = (queue.get("video") or "").strip()
    mp4 = None
    if slot == "release" and video:
        if (ROOT / video).exists():
            mp4 = webm_to_mp4(ROOT / video)  # 試運転でも変換までは行い、動くことを確かめる
        else:
            log(f"動画が見つかりません({video})。画像で投稿します。")

    log("--- 投稿する内容 ---")
    log(f"タイトル: {queue.get('title', '(なし)')}")
    log(f"本文({len(text)}字):\n{text}")
    if slot == "release":
        log(f"動画: {video if mp4 else '(なし)'}")
        log(f"画像: {shot if shot_path else '(なし)'}")
        log(f"リプライで付けるURL: {game_url or '(なし)'}")
    log("--------------------")

    if dry_run:
        log("試運転モードなので、実際には投稿しませんでした。")
        log("本番にするには GitHub の Variables で DRY_RUN を 0 にしてください。")
        return

    client, api = build_clients()

    def upload_image() -> list[str] | None:
        if not shot_path:
            return None
        # 画像のアップロード(v1.1)は X 側で廃止が進んでいる。失敗しても本文の投稿は止めない
        try:
            media = api.media_upload(filename=str(shot_path))
            log("スクリーンショットをアップロードしました。")
            return [media.media_id_string]
        except Exception as e:
            log(f"::warning::スクリーンショットのアップロードに失敗したので、画像なしで投稿します: {e}")
            return None

    media_ids = None
    used_video = False
    if mp4:
        try:
            media_ids = [upload_video(api, mp4)]
            used_video = True
            log("プレイ動画をアップロードしました。")
        except Exception as e:
            log(f"::warning::動画のアップロードに失敗したので、画像で投稿します: {e}")
    if media_ids is None and slot == "release":
        media_ids = upload_image()

    try:
        res = client.create_tweet(text=text, media_ids=media_ids)
    except Exception as e:
        if not used_video:
            raise
        # 動画付きの投稿が断られたら、画像で出し直す(投稿はまだできていない)
        log(f"::warning::動画付きで投稿できなかったので、画像で投稿します: {e}")
        used_video = False
        media_ids = upload_image()
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
    if slot == "release":
        entry["media"] = "video" if used_video else ("image" if media_ids else "none")

    # release だけ、ゲームのURLを自己リプライで付ける
    if slot == "release" and game_url:
        reply_text = f"あそべるのはこちらです → {game_url}"
        reply = client.create_tweet(text=reply_text, in_reply_to_tweet_id=tweet_id)
        entry["reply_tweet_id"] = str(reply.data["id"])
        log("URLの自己リプライを付けました。")

    record(entry)

    # 動画は投稿のためだけに置いている。投稿が済んだら消して、リポジトリと公開サイトを軽く保つ
    if video and (ROOT / video).exists():
        (ROOT / video).unlink()
        log(f"投稿が済んだので、動画を消しました({video})。")


if __name__ == "__main__":
    main()
