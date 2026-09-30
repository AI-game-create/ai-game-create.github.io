import type { Browser, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 投稿用のプレイ動画を撮り、games/投稿日-slug/play.webm に保存する(10秒・音つき・1MB前後)。
// X には webm を載せられないので、投稿時に GitHub Actions が mp4 に変換する。
//
//   setup: ページを開いてゲームを始め、見せ場の手前まで進める(ここは動画に入らない)
//   play : 見せ場を遊ぶ。clip.until(Date.now() の値)を過ぎたら戻る。早く戻っても残りの秒数は撮り続ける
//          一番派手な瞬間に clip.mark() を呼ぶと、動画はその0.5秒前から始まる
//          (タイムラインでは最初の1秒で見るかどうかが決まるため)。mark のあとは clip.until が
//          「そこから10秒後」に変わるので、そのまま遊び続ける。mark しなければ play の始まりから撮る
//   maxSeconds: mark を待つ最長の秒数(既定30)
//   focus: 動画に映す範囲の CSS セレクタ(例: 'canvas')。省略するとページ全体を映す
//   sound: 音のないゲームだけ false にする。既定では、音が録れなければ失敗する
//
// Playwright の録画はページを開いた時点から始まるので、撮ったあとで
// Playwright に同梱の ffmpeg を使って、見せ場の区間とゲーム画面の範囲だけを切り出す。
//
// 音: Playwright の録画には音が入らないので、ゲームが Web Audio でスピーカー(destination)に
// つないだ音を、同じだけ録音用の出口にも流して MediaRecorder で録り、動画に重ねる。
// ゲーム側は何もしなくてよい(Web Audio 以外で鳴らした音は入らない)。
export type Clip = { readonly until: number; mark: () => void };

export async function recordPlayVideo(
  browser: Browser,
  opts: {
    dir: string;
    setup: (page: Page) => Promise<void>;
    play: (page: Page, clip: Clip) => Promise<void>;
    seconds?: number;
    maxSeconds?: number;
    focus?: string;
    sound?: boolean;
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
  await context.addInitScript(tapAudio);
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

  await page.evaluate(startAudio);
  const playAt = Date.now();
  const start = (playAt - t0) / 1000;
  const lead = 0.5;
  let markAt = 0;
  let restarting: Promise<unknown> = Promise.resolve();
  const clip: Clip = {
    get until() {
      return markAt ? markAt + (seconds - lead) * 1000 : playAt + (opts.maxSeconds ?? 30) * 1000;
    },
    mark() {
      if (markAt) return;
      markAt = Date.now();
      restarting = page.evaluate(restartAudio).catch(() => {});
    },
  };
  await opts.play(page, clip);
  const end = markAt ? clip.until : Math.max(Date.now(), playAt + seconds * 1000);
  if (end > Date.now()) await page.waitForTimeout(end - Date.now());
  await restarting;
  const audio = await page.evaluate(stopAudio);
  // 切り出しの始まり(録画の頭からの秒数)。mark があればその少し前から
  const from = markAt ? Math.max(start, (markAt - t0) / 1000 - lead) : start;

  const video = page.video();
  await context.close();
  if (!video) throw new Error('動画が録画されていません');

  const out = path.join(opts.dir, 'play.webm');
  const rawPath = await video.path();
  const audioPath = path.join(tmp, 'audio.webm');
  // 録音は play の始まり(mark したらその瞬間)から。切り出しの始まりとの差だけ、音を後ろにずらす
  const shift = audio ? start + audio.offset - from : 0;
  const audioIn = shift >= 0 ? ['-itsoffset', shift.toFixed(2)] : ['-ss', (-shift).toFixed(2)];
  const encode = (withAudio: boolean) =>
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', from.toFixed(2), '-i', rawPath,
      ...(withAudio ? [...audioIn, '-i', audioPath] : []),
      '-t', String(seconds),
      ...(crop ? ['-vf', crop] : []),
      '-map', '0:v:0', '-c:v', 'libvpx', '-b:v', '1200k', '-crf', '6', '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0',
      ...(withAudio ? ['-map', '1:a:0', '-c:a', 'copy'] : ['-an']),
      out,
    ]);
  if (!audio && opts.sound !== false) {
    throw new Error(
      '動画に音が入りませんでした。テストで音を切っていないか、ゲームが Web Audio で音を鳴らしているかを確かめてください' +
        '(音のないゲームなら sound: false を渡す)',
    );
  }
  if (audio) fs.writeFileSync(audioPath, Buffer.from(audio.b64, 'base64'));
  encode(!!audio);
  fs.rmSync(tmp, { recursive: true, force: true });
  const mb = fs.statSync(out).size / 1024 / 1024;
  const sound = audio ? '音つき' : '音なし';
  const how = markAt ? '見せ場の0.5秒前から' : '見せ場の印(mark)がないので play の始まりから';
  console.log(`  動画: ${path.basename(opts.dir)}/play.webm(${how}${seconds}秒、${sound}、${mb.toFixed(1)}MB)`);
}

// ---- ここから下はブラウザの中で動く ----

// ページが読み込まれる前に仕込む。destination につながれた音を、録音用の出口にも流す
function tapAudio() {
  const w = window as any;
  if (w.__playAudio || typeof AudioNode === 'undefined') return;
  const connect = AudioNode.prototype.connect as any;
  const taps: { ctx: any; node: MediaStreamAudioDestinationNode }[] = [];
  w.__playAudio = { taps };
  (AudioNode.prototype as any).connect = function (this: AudioNode, dest: any, ...rest: any[]) {
    const r = connect.call(this, dest, ...rest);
    try {
      if (dest instanceof AudioDestinationNode && typeof dest.context.createMediaStreamDestination === 'function') {
        let t = taps.find((x) => x.ctx === dest.context);
        if (!t) {
          t = { ctx: dest.context, node: dest.context.createMediaStreamDestination() };
          taps.push(t);
          // 何も鳴っていない間も音声が途切れないよう、無音を流し続ける(途切れると音と映像がずれる)
          const hush = dest.context.createConstantSource();
          hush.offset.value = 0;
          connect.call(hush, t.node);
          hush.start();
        }
        connect.call(this, t.node, ...rest);
      }
    } catch {
      // 録音できなくても、ゲームの音は止めない
    }
    return r;
  };
}

// 見せ場の始まりで録音を始める。まだ音が一度も鳴っていなければ、鳴り始めた時点から録る
function startAudio() {
  const a = (window as any).__playAudio;
  if (!a) return;
  a.t0 = performance.now();
  a.chunks = [];
  a.begin = () => {
    const t = a.taps[a.taps.length - 1];
    if (!t) return false;
    a.rec = new MediaRecorder(t.node.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
    a.rec.ondataavailable = (e: BlobEvent) => e.data.size && a.chunks.push(e.data);
    a.rec.start();
    a.offset = (performance.now() - a.t0) / 1000;
    return true;
  };
  if (!a.begin()) a.timer = setInterval(() => a.begin() && clearInterval(a.timer), 50);
}

// mark されたら録音をやり直す(録った音声の途中から切ると、頭に雑音が入るため)
function restartAudio() {
  const a = (window as any).__playAudio;
  if (!a || !a.begin) return;
  clearInterval(a.timer);
  if (a.rec) {
    a.rec.ondataavailable = null;
    a.rec.stop();
    a.rec = null;
  }
  a.chunks = [];
  if (!a.begin()) a.timer = setInterval(() => a.begin() && clearInterval(a.timer), 50);
}

async function stopAudio(): Promise<{ b64: string; offset: number } | null> {
  const a = (window as any).__playAudio;
  if (!a) return null;
  clearInterval(a.timer);
  if (!a.rec) return null;
  await new Promise((r) => {
    a.rec.onstop = r;
    a.rec.stop();
  });
  const buf = new Uint8Array(await new Blob(a.chunks, { type: 'audio/webm' }).arrayBuffer());
  if (buf.length === 0) return null;
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { b64: btoa(s), offset: a.offset };
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
