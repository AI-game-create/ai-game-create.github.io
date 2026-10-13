import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';
import { recordScenes } from './video';
import { measureFps } from './perf';

// ============================================================================
//  プレイテスト: 今日のゲームが壊れていないかを、実際に操作して確かめる(最小限)。
//  対象: ネズミ1万匹で城攻め(2026-10-16・オーナーの注文)
//  12匹の群れをドラッグで食べ物へ導いて増やし、敵を飲み込みながら城へ。大広間を埋めると落城。
//
//  ・ひと通り遊べるか(1本)/ 投稿用の動画 / 見直し用のスクショ / スマホで重くない(仕上げの最後に1回)
//  ・早送り(__simSpeed)は、長い道のりを短い時間で回すためだけに使う
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-16-nezumi-shiro';
const target = latestGame();
const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const REVIEW = path.join(__dirname, '..', 'test-results', 'review');

type Cfg = { seed: number; sound?: boolean };
function installInit(cfg: Cfg) {
  let s = cfg.seed >>> 0;
  Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try {
    if (!localStorage.getItem('nezumi-shiro-v1')) localStorage.setItem('nezumi-shiro-v1', JSON.stringify({ sound: !!cfg.sound }));
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
// 動画とスクショで、場面の手前まで一気に進めるための段取り(遊びの確かめには使わない)
const stage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);
const NO_HINTS = `G.hints = { village: 1, granary: 1, town: 1, soldier: 1, wall: 1, hall: 1, split: 1 }; hint('', 0.01);`;
// 世界の (x, z) を画面の座標にして、画面の内側に収める
async function screenPos(page: Page, x: number, z: number) {
  const p = await gt<{ x: number; y: number; front: boolean }>(page, 'screenOf', x, z);
  const vp = page.viewportSize()!;
  return { x: Math.min(vp.width - 10, Math.max(10, p.x)), y: Math.min(vp.height - 10, Math.max(vp.height * 0.08, p.front ? p.y : 0)) };
}

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(target!.name, 'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください').toBe(EXPECTED);
  });

  test('ひと通り遊べる: ドラッグで群れを食べ物へ導くと増え、敵を飲み込みながら城へ進み、大広間を埋めると落城して遊び直せる', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = await open(page, { seed: 3, sound: true });
    expect(await gt<boolean>(page, 'webgl'), 'WebGL2 が使えていません').toBe(true);
    await start(page);
    expect(await gt<number>(page, 'count')).toBe(12);
    // 雑な自動プレイヤー: 前方の近い食べ物へ、なければ道の先へ、指(マウス)を押したまま動かす
    await page.evaluate(() => { (window as any).__simSpeed = 3; });
    const t0 = Date.now();
    let first = await screenPos(page, 0, 8);
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    let firstGrow = 0;
    let lastLog = 0;
    while (Date.now() - t0 < 170_000) {
      const st = await gt<string>(page, 'state');
      if (st !== 'play') break;
      const c = await gt<{ x: number; z: number; n: number }>(page, 'center');
      if (c.z > 384) break; // 城壁を越えた
      const foods = (await gt<any[]>(page, 'foods')).filter((f) => f.amt > 0 && f.z > c.z - 5 && f.z < c.z + 40);
      foods.sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z));
      const wp = foods.length ? foods[0] : { x: 0, z: c.z + 14 };
      const p = await screenPos(page, wp.x, wp.z);
      await page.mouse.move(p.x, p.y, { steps: 4 });
      if (!firstGrow && (await gt<number>(page, 'count')) > 12) firstGrow = (Date.now() - t0) / 1000;
      if (Date.now() - lastLog > 20_000) {
        lastLog = Date.now();
        console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}秒: ${await gt<string>(page, 'zone')} z=${c.z.toFixed(0)} ${c.n}匹(最多${await gt<number>(page, 'maxCount')}) 敵${await gt<number>(page, 'kills')} 時間${(await gt<number>(page, 'time')).toFixed(0)}`);
      }
      await page.waitForTimeout(200);
    }
    await page.mouse.up();
    const c = await gt<{ x: number; z: number; n: number }>(page, 'center');
    const maxN = await gt<number>(page, 'maxCount');
    const kills = await gt<number>(page, 'kills');
    const deaths = await gt<Record<string, number>>(page, 'deaths');
    console.log(`  自動プレイ: ${await gt<string>(page, 'state')} z=${c.z.toFixed(0)} 残り${await gt<number>(page, 'count')}匹 最多${maxN} 飲み込んだ敵${kills} 失った ${JSON.stringify(deaths)} ゲーム内${(await gt<number>(page, 'time')).toFixed(0)}秒 / 初めて増えた ${firstGrow}秒`);
    expect(firstGrow, '食べ物へ導いても群れが増えません').toBeGreaterThan(0);
    expect(maxN, '食べ物を食べても群れがほとんど増えません').toBeGreaterThan(300);
    expect(kills, '群れで敵を飲み込めません').toBeGreaterThan(0);
    expect(c.z > 300 || (await gt<string>(page, 'state')) !== 'play', '群れが城下町まで進めません').toBeTruthy();
    // 終わりまで: (自動プレイが城に届かなかったときは)中庭まで段取りで進め、大広間へ導く
    if ((await gt<string>(page, 'state')) === 'play') {
      await page.evaluate(() => { (window as any).__simSpeed = 1; });
      await stage(page, `debugWarp(WALL_Z + WALL_T + 5, 3000, 0)`);
      await page.waitForTimeout(1500); // カメラが城壁の場面から戻るのを待つ
      const vp = page.viewportSize()!;
      await page.mouse.move(vp.width / 2, vp.height / 2);
      await page.mouse.down();
      const t1 = Date.now();
      while (Date.now() - t1 < 40_000 && (await gt<string>(page, 'state')) === 'play') {
        const p = await screenPos(page, 0, 432);
        await page.mouse.move(p.x, p.y, { steps: 3 });
        await page.waitForTimeout(250);
      }
      await page.mouse.up();
      const c2 = await gt<{ x: number; z: number; n: number }>(page, 'center');
      console.log(`  大広間: ${await gt<number>(page, 'hall')}匹 / 飲み込んだ敵 ${await gt<number>(page, 'kills')} / ${((Date.now() - t1) / 1000).toFixed(0)}秒 / 群れ x=${c2.x.toFixed(0)} z=${c2.z.toFixed(0)} / 失った ${JSON.stringify(await gt(page, 'deaths'))} 警鐘 ${JSON.stringify(await gt(page, 'alarm'))}`);
    }
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 20_000 }).toBe('result');
    await expect(page.locator('#result')).toBeVisible();
    console.log(`  結果: ${await page.locator('#r-head').textContent()} / ${await page.locator('#r-sub').textContent()}`);
    await page.locator('#b-again').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    expect(await gt<number>(page, 'count')).toBe(12);
    expect(errors).toEqual([]);
  });

  test('スマホで重くない(CPU 4倍遅くても、1万匹が城壁を登る場面で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(180_000);
    await open(page, { seed: 71 });
    await page.locator('#b-start').tap();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    await stage(page, `debugWarp(WALL_Z - 14, 10000, 0, 120); T[0] = { x: 0, z: WALL_Z + 12 }; ${NO_HINTS}`);
    await page.waitForTimeout(7000);
    const busy = await page.evaluate(() => { const g = (window as any).gameTest; return { n: g.count(), climb: g.climbing(), q: g.quality(), p: g.particles() }; });
    const perf = await measureFps(page, 3000);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・画質の段階 ${busy.q}・${busy.n}匹(登っている ${busy.climb})・粒 ${busy.p}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(10 * 60_000);
    const SHORT = process.env.SHORT_VIDEO === '1';
    const openFor = async (page: Page, cfg: Cfg) => {
      await page.addInitScript(installInit, cfg);
      await page.goto(url());
      await expect.poll(() => page.evaluate(() => !!(window as any).gameTest), { timeout: 30_000 }).toBeTruthy();
    };
    const startP = async (page: Page) => {
      await page.locator('#b-start').click();
      await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('play');
    };
    const rest = (page: Page, clip: { until: number }) => page.waitForTimeout(Math.max(0, clip.until - Date.now()));
    // 群れを (x, z) へ導き続ける(指を押したまま、カメラが動いても狙いを合わせ直す)
    const lead = async (page: Page, until: number, pick: () => Promise<{ x: number; z: number }>) => {
      let p = await pick(); let s = await screenPos(page, p.x, p.z);
      await page.mouse.move(s.x, s.y); await page.mouse.down();
      while (Date.now() < until) {
        p = await pick(); s = await screenPos(page, p.x, p.z);
        await page.mouse.move(s.x, s.y, { steps: 3 });
        await page.waitForTimeout(150);
      }
      await page.mouse.up();
    };
    await recordScenes(browser, target!.dir, [
      // ① つかみ: 1万匹が月夜の城壁を波のように登って越えてくる。城の内側から見下ろすと、何千もの目が光る
      {
        seconds: 4,
        shortSeconds: 5,
        setup: async (page) => {
          await openFor(page, { seed: 81, sound: true });
          await startP(page);
          await stage(page, `debugWarp(WALL_Z - 13, 10400, 0, 150); T[0] = { x: 0, z: WALL_Z + 12 }; ${NO_HINTS}`);
        },
        play: async (page, clip) => {
          await expect.poll(() => gt<number>(page, 'climbing'), { timeout: 20_000, intervals: [100] }).toBeGreaterThan(2200);
          await page.waitForTimeout(600);
          clip.mark();
          await page.waitForTimeout(1300);
          if (!SHORT) await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          await rest(page, clip);
        },
      },
      // ② 基本: 下水道の12匹をドラッグで残飯へ導くと、食べた分だけ増えていく
      {
        seconds: 5,
        shortSeconds: 3.5,
        setup: async (page) => {
          await openFor(page, { seed: 82, sound: true });
          await startP(page);
          await page.waitForTimeout(600);
        },
        play: async (page, clip) => {
          clip.mark();
          await lead(page, clip.until - 200, async () => {
            const c = await gt<{ x: number; z: number }>(page, 'center');
            const f = (await gt<any[]>(page, 'foods')).filter((f) => f.amt > 0 && f.z > c.z - 3).sort((a, b) => a.z - b.z)[0];
            return f || { x: 0, z: c.z + 10 };
          });
          await rest(page, clip);
        },
      },
      // ③ 穀物倉: 700匹が穀物の山に群がり、数が一気に跳ね上がる
      {
        seconds: 6,
        shortSeconds: 4,
        setup: async (page) => {
          await openFor(page, { seed: 83, sound: true });
          await startP(page);
          await stage(page, `debugWarp(186, 700, world.granSide * 3, 70); ${NO_HINTS}`);
          await page.waitForTimeout(300);
        },
        play: async (page, clip) => {
          clip.mark();
          await lead(page, clip.until - 100, async () => {
            const c = await gt<{ x: number; z: number }>(page, 'center');
            const f = (await gt<any[]>(page, 'foods')).filter((f) => f.kind === 'grain' && f.amt > 0).sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z))[0];
            return f || { x: c.x, z: c.z + 8 };
          });
          await rest(page, clip);
        },
      },
      // ④ 落城: 中庭の兵士を飲み込み、大群が大広間へなだれ込んで旗が落ちる
      {
        seconds: 7,
        shortSeconds: 4.5,
        setup: async (page) => {
          await openFor(page, { seed: 84, sound: true });
          await startP(page);
          await stage(page, `debugWarp(WALL_Z + WALL_T + 6, 9200, 0, 120); ${NO_HINTS}`);
          await page.waitForTimeout(300);
        },
        play: async (page, clip) => {
          clip.mark();
          await lead(page, clip.until - 100, async () => ({ x: 0, z: 434 }));
          await rest(page, clip);
        },
      },
    ]);
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(5 * 60_000);
    const shot = (name: string) => page.screenshot({ path: path.join(REVIEW, `${info.project.name}-${name}.png`) });
    fs.mkdirSync(REVIEW, { recursive: true });
    await open(page, { seed: 91 });
    await page.waitForTimeout(2500);
    await shot('1title');
    await start(page);
    await page.waitForTimeout(1500);
    await shot('2sewer');
    await stage(page, `debugWarp(110, 260, 0, 50)`);
    await page.waitForTimeout(1500);
    await shot('3village');
    await stage(page, `debugWarp(255, 2500, 0, 100); T[0] = { x: 0, z: 270 };`);
    await page.waitForTimeout(3000);
    await shot('4fire');
    await stage(page, `debugWarp(WALL_Z - 12, 8000, 0, 150); T[0] = { x: 0, z: WALL_Z + 12 };`);
    await page.waitForTimeout(7000);
    await shot('5wall');
    await stage(page, `debugWarp(WALL_Z + WALL_T + 6, 6000, 0, 150); T[0] = { x: 0, z: 434 };`);
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 60_000 }).toBe('result');
    await page.waitForTimeout(600);
    await shot('6result');
  });
});
