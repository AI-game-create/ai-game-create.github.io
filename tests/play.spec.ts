import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';
import { recordScenes } from './video';
import { measureFps } from './perf';

// ============================================================================
//  プレイテスト: 今日のゲームが壊れていないかを、実際に操作して確かめる(最小限)。
//  対象: 竹林の小道、24枚(2026-10-14・オーナーの注文)
//  古いカメラとフィルム24枚で、竹林を朝6時から夜21時まで歩き、帳面の「お題」に合う写真を撮る。
//  最後に撮った写真がアルバムになり、点がつく。
//
//  ・ひと通り遊べるか(1本)/ 投稿用の動画 / 見直し用のスクショ / スマホで重くない(仕上げの最後に1回)
//  ・早送り(__simSpeed)は、一日を短い時間で回すためだけに使う
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-14-chikurin-24';
const target = latestGame();
const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const REVIEW = path.join(__dirname, '..', 'test-results', 'review');

type Cfg = { seed: number; sound?: boolean; save?: Record<string, unknown> };
function installInit(cfg: Cfg) {
  let s = cfg.seed >>> 0;
  Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try {
    if (!localStorage.getItem('chikurin-24-v1')) localStorage.setItem('chikurin-24-v1', JSON.stringify(Object.assign({ sound: !!cfg.sound }, cfg.save || {})));
  } catch { /* なし */ }
}
async function open(page: Page, cfg: Cfg) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(installInit, cfg);
  await page.goto(url());
  await expect.poll(() => page.evaluate(() => !!(window as any).gameTest), { timeout: 30_000 }).toBeTruthy();
  return errors;
}
async function start(page: Page) {
  await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
}

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(target!.name, 'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください').toBe(EXPECTED);
  });

  test('ひと通り遊べる: 構えて撮ると写真が帳面に貼られ、W で歩き ← で見回せ、21時で散歩が終わってアルバムが開き、もう一度歩ける', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = await open(page, { seed: 3, sound: true });
    expect(await gt<boolean>(page, 'webgl'), 'WebGL2 が使えていません').toBe(true);
    await start(page);
    await page.waitForTimeout(400);
    // 撮る
    await page.keyboard.press('KeyQ');
    await expect.poll(async () => (await gt<any>(page, 'player')).raiseT).toBe(1);
    await expect(page.locator('#vf')).toHaveClass(/on/);
    await page.waitForTimeout(1200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(1600);
    const ph = await gt<any[]>(page, 'photos');
    expect((await gt<any>(page, 'film')).left, '撮ってもフィルムが減りません').toBe(23);
    expect(ph.length).toBe(1);
    expect(ph[0].hasImage, '写真の絵がありません').toBe(true);
    if (ph[0].topic) await expect(page.locator(`.row[data-id="${ph[0].topic}"] canvas`), '帳面に写真が貼られていません').toHaveCount(1);
    await page.keyboard.press('KeyQ');
    // 歩く・見回す
    const p0 = await gt<any>(page, 'player');
    await page.keyboard.down('KeyW'); await page.waitForTimeout(2000); await page.keyboard.up('KeyW');
    const p1 = await gt<any>(page, 'player');
    const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    expect(moved, 'W で前に進みません').toBeGreaterThan(4);
    await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(500); await page.keyboard.up('ArrowLeft');
    const p2 = await gt<any>(page, 'player');
    const turned = Math.abs(((p2.yaw - p1.yaw + 9 * Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(turned, '← で向きが変わりません').toBeGreaterThan(0.5);
    // 一日を早送りして、散歩の終わりまで
    await page.evaluate(() => { (window as any).__simSpeed = 30; });
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 200_000 }).toBe('album');
    await expect(page.locator('#album')).toBeVisible();
    const len = await gt<number>(page, 'time');
    console.log(`  写真: ${ph[0].topic || '-'} ${ph[0].score}点 / ${moved.toFixed(1)}m 歩いた / 1回の散歩の長さ: ${(len / 60).toFixed(1)}分`);
    await page.evaluate(() => { (window as any).__simSpeed = 1; });
    await page.locator('#b-again').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    expect((await gt<any>(page, 'film')).left).toBe(24);
    expect(errors).toEqual([]);
  });

  test('スマホで重くない(CPU 4倍遅くても、朝霧の竹林で光の筋が差し、風で竹がいっせいにしなる場面で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(180_000);
    await open(page, { seed: 71 });
    await page.locator('#b-start').tap();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    // 段取り: 朝7時の竹林の中で、朝日のほうを向き、風が来る直前にする
    await page.evaluate(() => (0, eval)(`G.t = (7.0 - DAY0) / (DAY1 - DAY0) * DAYLEN; P.x = 92; P.z = 39.5; P.y = groundH(P.x, P.z); P.yaw = sunAz(7.0) + 0.1; P.pitch = 0.25; G.gusts = [{ t0: G.t + 6.5 - (92 + 210) / 14, peak: 1 }];`));
    await page.waitForTimeout(500);
    const busy = await page.evaluate(() => { const g = (window as any).gameTest; return { canopy: g.player().canopy, drawn: g.bamboo().drawn, sun: g.sun().vis }; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.waitForTimeout(6000);
    // 測っているあいだも、指で少しずつ見回す(gameTest は読まない)
    const vp = page.viewportSize()!;
    const look = (async () => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vp.width * 0.7, y: vp.height * 0.4, id: 1 }] }); for (let k = 0; k < 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vp.width * 0.7 - k * 2, y: vp.height * 0.4, id: 1 }] }); await page.waitForTimeout(220); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); })();
    const perf = await measureFps(page, 3000);
    await look;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const after = await page.evaluate(() => { const g = (window as any).gameTest; return { gust: g.wind().gust, q: g.quality() }; });
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・画質の段階 ${after.q}・葉の覆い ${busy.canopy.toFixed(2)}・竹の区画 ${busy.drawn}・太陽 ${busy.sun.toFixed(2)}・風 ${after.gust.toFixed(2)}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  // 動画と見直しのスクショで、場面の手前まで一気に進めるための段取り(遊びの確かめには使わない)
  const stage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);
  const atHour = (h: number) => `G.t = (${h} - DAY0) / (DAY1 - DAY0) * DAYLEN;`;
  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(10 * 60_000);
    const SHORT = process.env.SHORT_VIDEO === '1';
    const openFor = async (page: Page, cfg: Cfg) => {
      await page.addInitScript(installInit, cfg);
      await page.goto(url());
      await expect.poll(() => page.evaluate(() => !!(window as any).gameTest), { timeout: 30_000 }).toBeTruthy();
    };
    const startP = async (page: Page) => { await page.locator('#b-start').click(); await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('play'); };
    await recordScenes(browser, target!.dir, [
      // ① つかみ: 朝霧の竹林に光の筋。風が抜けて竹がいっせいにしなり、シャッターの白い光
      {
        seconds: 4.5,
        shortSeconds: 5,
        setup: async (page) => {
          await openFor(page, { seed: 81, sound: true });
          await startP(page);
          await stage(page, `${atHour(7.05)} P.x = 92; P.z = 39.5; P.y = groundH(P.x, P.z); P.yaw = sunAz(7.05) + 0.12; P.pitch = 0.42; G.gusts = [{ t0: G.t + 1.6 - (92 + 210) / 14, peak: 1 }]; G.news = new Set([6.02]);`);
          await page.keyboard.press('KeyQ');
          await page.waitForTimeout(600);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.waitForTimeout(1100);
          if (!SHORT) await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          await page.waitForTimeout(150);
          await page.keyboard.press('Space');
          await page.waitForTimeout(500);
          await page.keyboard.down('ArrowLeft');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
          await page.keyboard.up('ArrowLeft');
        },
      },
      // ② 基本: 帳面のお題を見ながら霧の小道を歩き、構えて三分割に置き、撮った一枚が帳面に貼られる
      {
        seconds: 10,
        shortSeconds: 6,
        setup: async (page) => {
          await openFor(page, { seed: 82, sound: true });
          await startP(page);
          await stage(page, `${atHour(6.4)} G.news = new Set([6.02]);`);
          await page.waitForTimeout(300);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.keyboard.down('KeyW');
          await page.waitForTimeout(3200);
          await page.keyboard.up('KeyW');
          await page.keyboard.press('KeyQ');
          await page.waitForTimeout(900);
          await page.keyboard.down('ArrowRight'); await page.waitForTimeout(160); await page.keyboard.up('ArrowRight');
          await page.waitForTimeout(700);
          await page.keyboard.press('Space');
          await page.waitForTimeout(1900);
          await page.keyboard.press('KeyQ');
          await page.keyboard.down('KeyW');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
          await page.keyboard.up('KeyW');
        },
      },
      // ③ 夕方: 橋の上で、川面に映る夕日を撮る
      {
        seconds: 5,
        shortSeconds: 4,
        setup: async (page) => {
          await openFor(page, { seed: 83, sound: true });
          await startP(page);
          await stage(page, `${atHour(17.0)} P.x = -196; P.z = 140; P.y = groundH(P.x, P.z); P.yaw = sunAz(17.0) + 0.3; P.pitch = -0.06; G.news = new Set(NEWS.map((n) => n[0]));`);
          await page.waitForTimeout(400);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(520); await page.keyboard.up('ArrowLeft');
          await page.keyboard.press('KeyQ');
          await page.waitForTimeout(1000);
          await page.keyboard.press('Space');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
      // ④ 夜: 灯籠のともる池のほとりに蛍
      {
        seconds: 4.5,
        shortSeconds: 3,
        setup: async (page) => {
          let s = 84;
          for (; s < 120; s++) {
            await openFor(page, { seed: s, sound: true });
            if ((await gt<any[]>(page, 'places')).some((p) => p.kind === 'shishi')) break;
          }
          await startP(page);
          await stage(page, `(() => { ${atHour(19.4)} const pl = L.places.find((p) => p.kind === 'shishi'); pl.found = true; const pd = pondOf(pl); const ax = Math.sin(pl.axis), az = -Math.cos(pl.axis); P.x = pl.x - ax * 4.5 + az * 3.5; P.z = pl.z - az * 4.5 - ax * 3.5; P.y = groundH(P.x, P.z); P.yaw = Math.atan2(pd.x - P.x, -(pd.z - P.z)) - 0.25; P.pitch = 0.02; G.news = new Set(NEWS.map((n) => n[0])); })()`);
          await page.waitForTimeout(400);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.keyboard.down('ArrowRight'); await page.waitForTimeout(700); await page.keyboard.up('ArrowRight');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
    ]);
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(5 * 60_000);
    const shot = (name: string) => page.screenshot({ path: path.join(REVIEW, `${info.project.name}-${name}.png`) });
    fs.mkdirSync(REVIEW, { recursive: true });
    await open(page, { seed: 91 });
    await page.evaluate(() => { (window as any).__lockQ = 1; });
    await page.waitForTimeout(2500);
    await shot('1title');
    await page.locator('#b-start').click();
    await page.waitForTimeout(2500);
    await shot('2start');
    await stage(page, `${atHour(7.1)} P.x = 92; P.z = 39.5; P.y = groundH(P.x, P.z); P.yaw = sunAz(7.1) + 0.1; P.pitch = 0.3; G.gusts = [{ t0: G.t + 2 - (92 + 210) / 14, peak: 1 }];`);
    await page.waitForTimeout(3500);
    await shot('3shafts');
    await page.keyboard.press('KeyQ');
    await page.waitForTimeout(800);
    await shot('4finder');
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    await shot('5paste');
    await page.keyboard.press('KeyQ');
    await stage(page, `${atHour(12.5)} P.x = -163; P.z = 60; P.y = groundH(P.x, P.z); P.yaw = 262 * DEG; P.pitch = 0.04;`);
    await page.waitForTimeout(2500);
    await shot('6river');
    await stage(page, `${atHour(17.05)} P.x = -196; P.z = 140; P.y = groundH(P.x, P.z); P.yaw = sunAz(17.05) + 0.15; P.pitch = -0.08;`);
    await page.waitForTimeout(2500);
    await shot('7sunset');
    await stage(page, `${atHour(19.3)} P.x = -163; P.z = 32; P.y = groundH(P.x, P.z); P.yaw = 0; P.pitch = 0.0;`);
    await page.waitForTimeout(2500);
    await shot('8night');
    for (const pl of await gt<any[]>(page, 'places')) {
      await stage(page, `(() => { ${atHour(13.0)} const pl = L.places.find((p) => p.kind === '${pl.kind}'); pl.found = true; const ax = Math.sin(pl.axis), az = -Math.cos(pl.axis); P.x = pl.x - ax * 5; P.z = pl.z - az * 5; P.y = groundH(P.x, P.z); P.yaw = Math.atan2(pl.subj[0] - P.x, -(pl.subj[2] - P.z)); P.pitch = 0.02; })()`);
      await page.waitForTimeout(1500);
      await shot('9place-' + pl.kind);
    }
    await stage(page, `${atHour(20.97)}`);
    await expect(page.locator('#album')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await shot('10album');
  });
});
