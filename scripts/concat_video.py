#!/usr/bin/env python3
"""場面ごとに撮った動画(play-1.webm, play-2.webm, …)を1本の mp4(H.264 + AAC)につなぐ。

  python scripts/concat_video.py 入力フォルダ 出力フォルダ

入力フォルダの「名前-1.webm, 名前-2.webm, …」を名前ごとにまとめてつなぎ、出力フォルダに「名前.mp4」を作る
(すでにあれば作らない)。夜の制作のあとで run_daily.ps1 がショートをつなぐのに使う。
X に載せる動画は post_to_x.py がこのファイルの concat_parts() でつなぐ。

ffmpeg は PATH にあるもの、なければ Python の imageio-ffmpeg に入っているものを使う。
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path


def find_ffmpeg() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def probe(ffmpeg: str, path: Path) -> tuple[float, int, int, bool]:
    """(長さの秒数, 幅, 高さ, 音があるか)。ffprobe が無い環境もあるので ffmpeg の表示から読む。"""
    r = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True, text=True, errors="replace")
    info = r.stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", info)
    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0
    v = re.search(r"Video: .*?(\d{2,5})x(\d{2,5})", info)
    w, h = (int(v.group(1)), int(v.group(2))) if v else (1280, 720)
    return dur, w, h, "Audio:" in info


def part_number(path: Path) -> int:
    m = re.search(r"-(\d+)\.webm$", path.name)
    return int(m.group(1)) if m else 0


def concat_parts(parts: list[Path], out: Path, max_width: int = 1920) -> Path | None:
    """parts を順につないで out(mp4)を作る。大きさは1本目に合わせる。音が無い場面は無音で埋める。"""
    ffmpeg = find_ffmpeg()
    if not ffmpeg or not parts:
        return None
    parts = sorted(parts, key=part_number)
    infos = [probe(ffmpeg, p) for p in parts]
    _, w, h, _ = infos[0]
    if w > max_width:
        h = round(h * max_width / w)
        w = max_width
    w, h = w - w % 2, h - h % 2
    inputs: list[str] = []
    for p in parts:
        inputs += ["-i", str(p)]
    chains: list[str] = []
    for i, (dur, _, _, audio) in enumerate(infos):
        chains.append(
            f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,"
            f"setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v{i}]"
        )
        if audio:
            chains.append(f"[{i}:a]aresample=44100:async=1,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}]")
        else:
            chains.append(f"anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:{max(dur, 0.1):.3f}[a{i}]")
    n = len(parts)
    chains.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[v][a]")
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *inputs,
        "-filter_complex", ";".join(chains), "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out),
    ]
    try:
        subprocess.run(cmd, check=True, timeout=600, capture_output=True, text=True, errors="replace")
    except subprocess.CalledProcessError as e:
        print(f"つなげませんでした: {e.stderr.strip()[-600:]}", flush=True)
        return None
    except (subprocess.SubprocessError, OSError) as e:
        print(f"つなげませんでした: {e}", flush=True)
        return None
    return out


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    groups: dict[str, list[Path]] = {}
    for p in sorted(src.glob("*-*.webm")):
        base = re.sub(r"-\d+\.webm$", "", p.name)
        groups.setdefault(base, []).append(p)
    for base, parts in groups.items():
        out = dst / f"{base}.mp4"
        if out.exists():
            continue
        made = concat_parts(parts, out)
        print(f"{'つなぎました' if made else 'つなげませんでした'}: {out.name}({len(parts)}場面)", flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
