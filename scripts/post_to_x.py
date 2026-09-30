#!/usr/bin/env python3
"""X へ1件だけ投稿する。GitHub Actions から呼ばれる。

  python scripts/post_to_x.py --slot release   毎日20:30 作品紹介
  python scripts/post_to_x.py --slot poll      月曜12:30 土曜の大作の題を決める投票(キューの poll)
  python scripts/post_to_x.py --slot weekly    日曜21:30 その週の作品をつないだまとめ動画

release のやること
  1. data/alert.md に中身があれば何もしない
  2. 今日(日本時間)の data/queue/YYYY-MM-DD.json を読む。無ければスキップ
  3. 投稿文を検査する(140字以内 / キューの本文にURLなし / game_url が公開URLで始まる)
  4. DRY_RUN が "0" 以外なら、投稿せずに内容を表示して終わる
  5. release 枠は、本文の最後にゲームのURLを付け、プレイ動画付きで投稿する
     (動画が使えなければスクリーンショット、それも駄目なら文字だけで投稿する)
     (URLを入れると X の文字数の上限を超える日だけ、URLは自己リプライで付ける)
  6. 結果を data/posts.json に記録する(動画のファイルは、日曜のまとめのあとに消す)

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
SLOTS = ("release", "poll", "weekly")
MAX_CHARS = 140          # CLAUDE.md のルール
MAX_WEIGHTED = 280       # X 側の上限(全角は2文字ぶん)
DAY_ONE = date(2026, 9, 29)  # 初めて投稿した日。この日を「1日目」として数える


def day_number(date_str: str) -> int:
    return (date.fromisoformat(date_str) - DAY_ONE).days + 1


def with_day_prefix(text: str, date_str: str) -> str:
    """release の本文の先頭に「【N日目】」を付ける。本文側に書かれていたら付け直す。"""
    body = re.sub(r"^\s*【\d+日目】\s*", "", text)
    return f"【{day_number(date_str)}日目】{body}"


def log(msg: str) -> None:
    print(msg, flush=True)


URL_RE = re.compile(r"https?://\S+")
URL_WEIGHT = 23  # X は URL を長さに関係なく23文字ぶんと数える


def weighted_len(text: str) -> int:
    """X の数え方。ラテン文字などは1、それ以外(日本語・記号・絵文字)は2、URL は23。"""
    total = URL_WEIGHT * len(URL_RE.findall(text))
    for ch in URL_RE.sub("", text):
        cp = ord(ch)
        light = cp <= 4351 or 8192 <= cp <= 8205 or 8208 <= cp <= 8223 or 8242 <= cp <= 8247
        total += 1 if light else 2
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


def create_post(client, api, text: str, mp4: Path | None, image: Path | None) -> tuple[str, str]:
    """動画 → 画像 → 文字だけ、の順に試して投稿する。(投稿ID, "video" / "image" / "none") を返す。"""

    def upload_image() -> list[str] | None:
        if not image:
            return None
        # 画像のアップロード(v1.1)は X 側で廃止が進んでいる。失敗しても本文の投稿は止めない
        try:
            media = api.media_upload(filename=str(image))
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
            log("動画をアップロードしました。")
        except Exception as e:
            log(f"::warning::動画のアップロードに失敗したので、画像で投稿します: {e}")
    if media_ids is None:
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
    return tweet_id, "video" if used_video else ("image" if media_ids else "none")


def record(entry: dict) -> None:
    posts = read_json(POSTS_FILE, [])
    if not isinstance(posts, list):
        posts = []
    posts.append(entry)
    POSTS_FILE.write_text(
        json.dumps(posts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    log(f"data/posts.json に記録しました({len(posts)}件目)。")


POLL_MINUTES = 3 * 24 * 60  # 月曜12:30に出して、木曜12:30に締め切る(金曜の夜に大作の題にする)


def post_poll(date_str: str, dry_run: bool) -> None:
    """その日のキューの poll(問いと選択肢)を投票つきで投稿する。"""
    queue = load_queue(date_str)
    poll = (queue or {}).get("poll")
    if not poll:
        log("今日のキューに投票(poll)が無いのでスキップします。")
        return
    text = str(poll.get("text", "")).strip()
    options = [str(o).strip() for o in poll.get("options") or []]
    validate(text, "poll")
    if not 2 <= len(options) <= 4 or any(not o or len(o) > 25 for o in options):
        log(f"::error::投票の選択肢は2〜4個、それぞれ1〜25字にしてください: {options}")
        sys.exit(1)

    log("--- 投稿する内容 ---")
    log(f"本文:\n{text}")
    log(f"選択肢: {' / '.join(options)}(受付 {POLL_MINUTES // 60} 時間)")
    log("--------------------")
    if dry_run:
        log("試運転モードなので、実際には投稿しませんでした。")
        return

    client, _ = build_clients()
    res = client.create_tweet(text=text, poll_options=options, poll_duration_minutes=POLL_MINUTES)
    tweet_id = str(res.data["id"])
    log(f"投稿しました: https://x.com/i/status/{tweet_id}")
    record({
        "date": date_str,
        "slot": "poll",
        "tweet_id": tweet_id,
        "text": text,
        "options": options,
        "posted_at": datetime.now(JST).isoformat(timespec="seconds"),
        "metrics": None,
        "poll_result": None,
    })


WEEKLY_CLIP_SECONDS = 2.5  # 1本あたりの長さ(7本で17.5秒)
WEEKDAYS = "月火水木金土日"


def find_cjk_font() -> str | None:
    for pattern in ("NotoSansCJK-Bold.ttc", "NotoSansCJK*.ttc", "NotoSansCJKjp*.otf", "*CJK*"):
        hits = sorted(Path("/usr/share/fonts").rglob(pattern)) if Path("/usr/share/fonts").exists() else []
        if hits:
            return str(hits[0])
    return None


def make_weekly_video(games: list[dict], date_str: str) -> Path | None:
    """その週の play.webm の頭を少しずつつなぎ、「N日目 タイトル」の字幕を付けた mp4 を作る。"""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        log("::warning::ffmpeg が無いので、まとめ動画は作れません。")
        return None
    font = find_cjk_font()
    if not font:
        log("::warning::日本語のフォントが無いので、字幕なしで作ります。")
    tmp = Path(tempfile.mkdtemp())
    d = WEEKLY_CLIP_SECONDS
    inputs: list[str] = []
    parts: list[str] = []
    for i, g in enumerate(games):
        src = ROOT / g["dir"] / "play.webm"
        inputs += ["-i", str(src)]
        label = tmp / f"label{i}.txt"
        label.write_text(f"{day_number(g['post_date'])}日目  {g['title']}", encoding="utf-8")
        text = (
            f",drawtext=fontfile={font}:textfile={label}:fontsize=40:fontcolor=white"
            ":x=32:y=h-th-36:box=1:boxcolor=black@0.55:boxborderw=14"
            if font else ""
        )
        parts.append(
            f"[{i}:v]trim=0:{d},setpts=PTS-STARTPTS,"
            "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,"
            f"fps=30,format=yuv420p{text},fade=t=in:st=0:d=0.12,fade=t=out:st={d - 0.12}:d=0.12[v{i}]"
        )
    # 音: 動画に音があればそれを、なければ無音を使う
    n = len(games)
    for i, g in enumerate(games):
        if has_audio(ROOT / g["dir"] / "play.webm"):
            parts.append(
                f"[{i}:a]atrim=0:{d},asetpts=PTS-STARTPTS,aresample=44100:async=1,"
                f"aformat=channel_layouts=stereo,apad=whole_dur={d},afade=t=out:st={d - 0.12}:d=0.12[a{i}]"
            )
        else:
            parts.append(f"anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:{d}[a{i}]")
    parts.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[v][a]")
    out = Path(tempfile.gettempdir()) / f"weekly-{date_str}.mp4"
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *inputs,
        "-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out),
    ]
    try:
        subprocess.run(cmd, check=True, timeout=600, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        log(f"::warning::まとめ動画を作れませんでした: {e.stderr.strip()[-800:]}")
        return None
    except (subprocess.SubprocessError, OSError) as e:
        log(f"::warning::まとめ動画を作れませんでした: {e}")
        return None
    log(f"まとめ動画を作りました({n}本・{n * d:.1f}秒・{out.stat().st_size / 1024 / 1024:.1f}MB)。")
    return out


def weekly_text(games: list[dict], base: str) -> str:
    """まとめの投稿文。入りきらなければ、作品の一覧を後ろから削る。"""
    head = f"今週つくったゲーム{len(games)}本をまとめました🎮 AIが毎日1本つくって公開しています"
    lines = [f"{WEEKDAYS[date.fromisoformat(g['post_date']).weekday()]} {g['title']}" for g in games]
    tail = f"▶ ぜんぶ遊べます {base}\n#AI #ClaudeCode #ブラウザゲーム" if base else "#AI #ClaudeCode #ブラウザゲーム"
    while True:
        text = "\n".join([head, *lines, tail])
        if weighted_len(text) <= MAX_WEIGHTED or not lines:
            return text
        lines.pop()


def post_weekly(date_str: str, dry_run: bool) -> None:
    """日曜の夜に、その週(直近7日)の作品の動画をつないで投稿する。済んだら動画を消す。"""
    history = read_json(ROOT / "data" / "history.json", [])
    since = (date.fromisoformat(date_str) - timedelta(days=6)).isoformat()
    week = [
        g for g in history
        if isinstance(g, dict) and g.get("status") == "success" and g.get("dir")
        and since <= g.get("post_date", "") <= date_str
    ]
    week.sort(key=lambda g: g["post_date"])
    games = [g for g in week if (ROOT / g["dir"] / "play.webm").exists()]
    log(f"今週の作品: {len(week)}本(動画があるもの {len(games)}本)")

    if len(games) < 3:
        log("動画のある作品が3本に満たないので、まとめは投稿しません。")
    else:
        base = os.environ.get("GAME_BASE_URL", "").strip()
        text = weekly_text(week, base)
        mp4 = make_weekly_video(games, date_str)
        log("--- 投稿する内容 ---")
        log(f"本文:\n{text}")
        log(f"動画: {mp4 or '(なし)'}")
        log("--------------------")
        if dry_run:
            log("試運転モードなので、実際には投稿しませんでした。")
            return
        client, api = build_clients()
        tweet_id, media = create_post(client, api, text, mp4, None)
        record({
            "date": date_str,
            "slot": "weekly",
            "tweet_id": tweet_id,
            "text": text,
            "games": [g["post_date"] for g in games],
            "media": media,
            "posted_at": datetime.now(JST).isoformat(timespec="seconds"),
            "metrics": None,
        })

    if dry_run:
        return
    # 投稿済みの作品の動画を消して、リポジトリと公開サイトを軽く保つ(まとめを出せなかった週も消す)
    for g in history:
        if isinstance(g, dict) and g.get("dir") and g.get("post_date", "") <= date_str:
            clip = ROOT / g["dir"] / "play.webm"
            if clip.exists():
                clip.unlink()
                log(f"動画を消しました({g['dir']}play.webm)。")


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
    if slot == "poll":
        post_poll(date_str, dry_run)
        return
    if slot == "weekly":
        post_weekly(date_str, dry_run)
        return

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

    # ゲームのURLは本文の最後に付ける(見てすぐ遊べるように)。上限を超える日だけリプライに回す
    link = "none"
    if slot == "release" and game_url:
        linked = f"{text}\n▶ あそぶ {game_url}"
        if weighted_len(linked) <= MAX_WEIGHTED:
            text, link = linked, "body"
        else:
            link = "reply"
            log("::warning::本文にURLを入れると X の文字数の上限を超えるので、URLはリプライで付けます。")

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
        where = {"body": "本文に入れる", "reply": "リプライで付ける"}.get(link, "(なし)")
        log(f"URL: {where}")
    log("--------------------")

    if dry_run:
        log("試運転モードなので、実際には投稿しませんでした。")
        log("本番にするには GitHub の Variables で DRY_RUN を 0 にしてください。")
        return

    client, api = build_clients()
    tweet_id, media = create_post(client, api, text, mp4, shot_path if slot == "release" else None)

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
        entry["media"] = media
        entry["link"] = link
    # 本文に入りきらなかった日だけ、ゲームのURLを自己リプライで付ける
    if link == "reply":
        reply_text = f"あそべるのはこちらです → {game_url}"
        reply = client.create_tweet(text=reply_text, in_reply_to_tweet_id=tweet_id)
        entry["reply_tweet_id"] = str(reply.data["id"])
        log("URLの自己リプライを付けました。")

    record(entry)
    # 動画(play.webm)は日曜の「週のまとめ」に使うので、ここでは消さない。まとめのときに消す


if __name__ == "__main__":
    main()
