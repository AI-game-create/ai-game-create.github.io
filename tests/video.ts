import type { Browser, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 投稿用のプレイ動画を撮り、games/投稿日-slug/play.webm に保存する(10秒前後・1MB前後)。
// X には webm を載せられないので、投稿時に GitHub Actions が mp4 に変換する。
//
//   setup: ページを開いてゲームを始め、見せ場の手前まで進める(ここは動画に入らない)
//   play : 見せ場を遊ぶ。until(Date.now() の値)を過ぎたら戻る。早く戻っても残りの秒数は撮り続ける
//   focus: 動画に映す範囲の CSS セレクタ(例: 'canvas')。省略するとページ全体を映す
//
// Playwright の録画はページを開いた時点から始まるので、撮ったあとで
// Playwright に同梱の ffmpeg を使って、見せ場の区間とゲーム画面の範囲だけを切り出す。
export async function recordPlayVideo(
  browser: Browser,
  opts: {
    dir: string;
    setup: (page: Page) => Promise<void>;
    play: (page: Page, until: number) => Promise<void>;
    seconds?: number;
    focus?: string;
    width?: number;
    height?: number;
  },
): Promise<void> {
  const seconds = opts.seconds ?? 10;
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('Playwright の ffmpeg が見つかりません(npx playwright install ffmpeg で入ります)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'play-video-'));

  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: tmp, size: { width, height } },
  });
  const page = await context.newPage();
  const t0 = Date.now();

  await opts.setup(page);

  let crop = '';
  if (opts.focus) {
    const box = await page.locator(opts.focus).first().boundingBox();
    if (box) {
      // 画面からはみ出した部分を除き、動画にできるよう偶数にそろえる
      const x = Math.max(0, Math.floor(box.x));
      const y = Math.max(0, Math.floor(box.y));
      const w = Math.min(width - x, Math.floor(box.width)) & ~1;
      const h = Math.min(height - y, Math.floor(box.height)) & ~1;
      if (w >= 64 && h >= 64) crop = `crop=${w}:${h}:${x}:${y}`;
    }
  }

  const start = (Date.now() - t0) / 1000;
  const until = Date.now() + seconds * 1000;
  await opts.play(page, until);
  const rest = until - Date.now();
  if (rest > 0) await page.waitForTimeout(rest);

  const video = page.video();
  await context.close();
  if (!video) throw new Error('動画が録画されていません');

  const out = path.join(opts.dir, 'play.webm');
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', start.toFixed(2), '-i', await video.path(), '-t', String(seconds),
    ...(crop ? ['-vf', crop] : []),
    '-an', '-c:v', 'libvpx', '-b:v', '1200k', '-crf', '6', '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0',
    out,
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
  const mb = fs.statSync(out).size / 1024 / 1024;
  console.log(`  動画: ${path.basename(opts.dir)}/play.webm(${start.toFixed(1)}秒目から${seconds}秒、${mb.toFixed(1)}MB)`);
}

// Playwright がブラウザと一緒に入れている ffmpeg を探す
function findFfmpeg(): string | null {
  const home = os.homedir();
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Caches', 'ms-playwright')
        : path.join(home, '.cache', 'ms-playwright'));
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('ffmpeg')).sort().reverse();
  for (const d of dirs) {
    const exe = fs.readdirSync(path.join(root, d)).find((f) => f.startsWith('ffmpeg'));
    if (exe) return path.join(root, d, exe);
  }
  return null;
}
