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
//
// ショート用モード(環境変数 SHORT_VIDEO=1): 同じ setup / play で、YouTube ショート用に
// 縦長 1080x1920・スマホの設定・20秒で撮り、上下にテロップを重ねて shorts/投稿日_N日目_タイトル.webm に保存する。
// 夜の制作が終わったあとで、scripts/run_daily.ps1 がこのモードで「投稿用のプレイ動画を撮る」テストをもう一度走らせる。
const SHORT = process.env.SHORT_VIDEO === '1';
const REPO = path.join(__dirname, '..');
const DAY_ONE = Date.UTC(2026, 8, 29); // 2026-09-29 が1日目

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
  const seconds = SHORT ? 20 : opts.seconds ?? 10;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('Playwright の ffmpeg が見つかりません(npx playwright install ffmpeg で入ります)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'play-video-'));

  // 動画は GPU を使うブラウザで撮る。テスト用のブラウザは3Dを CPU で描くので、重い作品だとコマが落ちる
  // (10/6 のドミノの 1080x1920 で 11fps → GPU で 60fps)。起動できない環境では、渡されたブラウザで撮る
  let own: Browser | null = null;
  try {
    const { chromium } = await import('@playwright/test');
    own = await chromium.launch({
      channel: 'chromium',
      args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu-rasterization'],
    });
    browser = own;
  } catch (e) {
    console.log(`  動画: GPU のブラウザを起動できなかったので、ふつうのブラウザで撮ります(${String(e).slice(0, 80)})`);
  }
  // ショートは 1080x1920。GPU が使えないときは 540x960 で描いて撮り、最後に拡大する(描く量を4分の1にしてコマ落ちを防ぐ)
  const shortW = own ? 1080 : 540;
  const width = SHORT ? shortW : opts.width ?? 1280;
  const height = SHORT ? (shortW * 16) / 9 : opts.height ?? 720;
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: tmp, size: { width, height } },
    ...(SHORT ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}),
  });
  await context.addInitScript(tapAudio);
  // 撮影中にゲームが実際に描けたコマ数を数える(カクつきの確認用)
  await context.addInitScript(() => {
    const w = window as any;
    w.__frames = [];
    const tick = (t: number) => { w.__frames.push(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const page = await context.newPage();
  const t0 = Date.now();

  await opts.setup(page);
  const short = SHORT ? shortInfo(opts.dir) : null;
  if (short) await page.evaluate(addTelop, [short.top1, short.top2, short.bottom]);

  let crop = '';
  if (opts.focus && !SHORT) {
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
    // 古い書き方(play の2つ目を「終わりの時刻」の数値として使う)でも動くように
    valueOf() {
      return this.until;
    },
  } as Clip;
  await opts.play(page, clip);
  const end = markAt ? clip.until : Math.max(Date.now(), playAt + seconds * 1000);
  if (end > Date.now()) await page.waitForTimeout(end - Date.now());
  await restarting;
  const audio = await page.evaluate(stopAudio);
  const fps = await page.evaluate((ms) => {
    const f = ((window as any).__frames as number[]).filter((t) => t >= performance.now() - ms);
    const gaps = f.slice(1).map((x, i) => x - f[i]).sort((a, b) => a - b);
    return gaps.length ? { avg: Math.round(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)), p95: Math.round(gaps[Math.floor(gaps.length * 0.95)]) } : null;
  }, seconds * 1000);
  // 切り出しの始まり(録画の頭からの秒数)。mark があればその少し前から
  const from = markAt ? Math.max(start, (markAt - t0) / 1000 - lead) : start;

  const video = page.video();
  await context.close();
  if (own) await own.close();
  if (!video) throw new Error('動画が録画されていません');

  if (short) fs.mkdirSync(path.dirname(short.out), { recursive: true });
  const out = short ? short.out : path.join(opts.dir, 'play.webm');
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
      ...(short && width !== 1080 ? ['-vf', 'scale=1080:1920:flags=lanczos'] : crop && !short ? ['-vf', crop] : []),
      '-map', '0:v:0', '-c:v', 'libvpx', '-b:v', short ? '5M' : '1200k', '-crf', '6', '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0',
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
  const name = short ? `shorts/${path.basename(out)}` : `${path.basename(opts.dir)}/play.webm`;
  const smooth = fps ? `、描画 ${fps.avg}fps・p95 ${fps.p95}ms` : '';
  console.log(`  動画: ${name}(${how}${seconds}秒、${sound}、${mb.toFixed(1)}MB${smooth})`);
}

// ショートのテロップの文字と保存先。タイトルは投稿キュー(なければ作品一覧)から読む
function shortInfo(dir: string) {
  const name = path.basename(dir);
  const date = name.slice(0, 10);
  const read = (p: string) => {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  };
  const queue = read(path.join(REPO, 'data', 'queue', `${date}.json`));
  const history = (read(path.join(REPO, 'data', 'history.json')) || []) as { post_date?: string; title?: string }[];
  const title: string = queue?.title || history.find((g) => g.post_date === date)?.title || name.slice(11);
  const day = Math.round((Date.parse(`${date}T00:00:00Z`) - DAY_ONE) / 86400000) + 1;
  const file = `${date}_${day}日目_${title}`.replace(/[\\/:*?"<>|\s]+/g, '_');
  return {
    top1: '1日1本ゲーム制作',
    top2: `${day}日目『${title}』`,
    bottom: 'プロフィールのリンクから遊べます',
    out: path.join(REPO, 'shorts', `${file}.webm`),
  };
}

// ---- ここから下はブラウザの中で動く ----

// ショートのテロップ(20秒ずっと出す)。上は半透明の黒い帯、下はショートの画面の下2割に隠れない高さに置く
function addTelop([top1, top2, bottom]: string[]) {
  const css = document.createElement('style');
  css.textContent = `
    .tp{position:fixed;left:0;right:0;z-index:2147483647;text-align:center;pointer-events:none;
      font-family:"Yu Gothic UI","Yu Gothic","Hiragino Sans","Meiryo",sans-serif;font-weight:900;letter-spacing:.02em;white-space:nowrap}
    #tp-top{top:6%;background:rgba(0,0,0,.55);padding:2.8vw 0 3.1vw}
    #tp-top div{display:table;margin:0 auto;paint-order:stroke fill;-webkit-text-stroke:1.85vw #000;filter:drop-shadow(0 .83vw 0 rgba(0,0,0,.6))}
    #tp-top .l1{color:#fff;font-size:11.5vw;line-height:1.2}
    #tp-top .l2{color:#ffe14a;font-size:10.7vw;line-height:1.3;margin-top:1.1vw}
    #tp-bot{bottom:24%}
    #tp-bot span{display:inline-block;color:#fff;font-size:8vw;padding:2.4vw 4.6vw;background:rgba(0,0,0,.55);border-radius:2.8vw}`;
  document.head.appendChild(css);
  const top = document.createElement('div');
  top.id = 'tp-top';
  top.className = 'tp';
  const l1 = document.createElement('div');
  l1.className = 'l1';
  l1.textContent = top1;
  const l2 = document.createElement('div');
  l2.className = 'l2';
  l2.textContent = top2;
  top.append(l1, l2);
  const bot = document.createElement('div');
  bot.id = 'tp-bot';
  bot.className = 'tp';
  const span = document.createElement('span');
  span.textContent = bottom;
  bot.append(span);
  document.body.append(top, bot);
  // 画面の幅(94%)に収まるまで小さくする。タイトルの長さは日によって違うため
  for (const el of [l1, l2, span]) {
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.getBoundingClientRect().width > innerWidth * 0.94 && size > 16) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }
}

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
