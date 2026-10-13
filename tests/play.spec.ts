import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';
import { recordScenes } from './video';
import { measureFps } from './perf';

// ============================================================================
//  プレイテスト: 今日のゲームが壊れていないかを、実際に操作して確かめる(最小限)。
//  対象: ビル爆破解体(2026-10-15・オーナーの注文)
//  図面の柱をタップして爆薬を仕掛け、発破。ビルが崩れ、結果の判子が出て、次の現場へ進む。
//
//  ・ひと通り遊べるか(1本)/ 投稿用の動画 / 見直し用のスクショ / スマホで重くない(仕上げの最後に1回)
//  ・早送り(__simSpeed)は、崩れ終わるまでを短い時間で回すためだけに使う
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-15-bill-bakuha';
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
    if (!localStorage.getItem('bill-bakuha-v1')) localStorage.setItem('bill-bakuha-v1', JSON.stringify({ sound: !!cfg.sound }));
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
  await expect.poll(() => gt<string>(page, 'state')).toBe('plan');
}
// 動画とスクショで、場面の手前まで一気に進めるための段取り(遊びの確かめには使わない)
const stage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);
// 爆薬の置き方: 'implode' = 全部の階の全部の柱を、下の階から順に / 'fell' = いちばん下の階だけ、空き地の側を先に
const CHARGE = {
  implode: `(() => { job.levels.forEach((st, li) => B.cols.forEach((c, ci) => placeCharge(st, ci, Math.min(2, li)))); })()`,
  hook: `(() => { job.levels.forEach((st, li) => B.cols.forEach((c, ci) => placeCharge(st, ci, li === 0 ? (c.x < 0 ? 0 : 1) : Math.min(2, li)))); })()`,
  fell: `(() => { const si = job.sides.findIndex((s) => s.kind === 'open'); const n = SIDES[si].n; B.cols.forEach((c, ci) => placeCharge(0, ci, c.x * n[0] + c.z * n[1] > 0.1 ? 0 : 2)); })()`,
};
const snapCam = `cam.yaw = G.blastYaw; cam.g.yaw = G.blastYaw; cam.dist = fitDist(job.H) * 1.02; cam.ty = job.H * 0.47; cam.pitch = 0.04;`;

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(target!.name, 'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください').toBe(EXPECTED);
  });

  test('ひと通り遊べる: 図面の柱をタップして爆薬を仕掛け、発破するとビルが崩れ、判子の結果が出て、次の現場へ進める', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = await open(page, { seed: 3, sound: true });
    expect(await gt<boolean>(page, 'webgl'), 'WebGL2 が使えていません').toBe(true);
    await start(page);
    const job = await gt<any>(page, 'job');
    // 全部の階の、全部の柱をタップする(人がふつうにクリックする速さで)
    for (let li = 0; li < job.levels.length; li++) {
      await page.locator(`#lv-${li}`).click();
      await page.waitForTimeout(150);
      const cols = await gt<any[]>(page, 'planColumns');
      for (const c of cols) { await page.mouse.click(c.x, c.y); await page.waitForTimeout(60); }
    }
    expect(await gt<number>(page, 'charges'), '柱をタップしても爆薬が仕掛けられません').toBe(job.cols * job.levels.length);
    const H = job.height;
    await page.locator('#b-fire').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('count');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('blast');
    const t0 = Date.now();
    await page.waitForTimeout(1500);
    const mid = await gt<any>(page, 'building');
    expect(await gt<number>(page, 'debris'), '発破してもがれきが出ません').toBeGreaterThan(20);
    await page.evaluate(() => { (window as any).__simSpeed = 4; });
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 180_000 }).toBe('result');
    await page.evaluate(() => { (window as any).__simSpeed = 1; });
    const res = await gt<any>(page, 'result');
    const b = await gt<any>(page, 'building');
    console.log(`  ${job.floors}階 ${Math.round(H)}m → 途中 ${Math.round(mid.maxH)}m → 最後 ${Math.round(b.maxH)}m / 結果「${res.head}」★${res.stars} 収支${res.delta}万 / がれき${await gt<number>(page, 'debris')} / ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
    expect(b.maxH, '全部の柱を爆破しても崩れきりません').toBeLessThan(H * 0.3);
    await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#r-stamp')).toHaveText(res.head);
    await page.locator('#b-next').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('plan');
    expect((await gt<any>(page, 'job')).idx).toBe(1);
    expect(errors).toEqual([]);
  });

  test('スマホで重くない(CPU 4倍遅くても、30階のビルが崩れて土煙が広がる場面で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(180_000);
    await open(page, { seed: 71 });
    await stage(page, `forcedJob = { type: 'tower', F: 30 };`);
    await page.locator('#b-start').tap();
    await expect.poll(() => gt<string>(page, 'state')).toBe('plan');
    await stage(page, CHARGE.implode + '; fireNow();' + snapCam);
    await page.waitForTimeout(6000);
    const busy = await page.evaluate(() => { const g = (window as any).gameTest; return { dust: g.dust(), debris: g.debris(), q: g.quality() }; });
    const perf = await measureFps(page, 3000);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・画質の段階 ${busy.q}・土煙 ${busy.dust}・がれき ${busy.debris}`);
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
    const startP = async (page: Page, forced = '') => {
      if (forced) await stage(page, forced);
      await page.locator('#b-start').click();
      await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('plan');
    };
    const rest = (page: Page, clip: { until: number }) => page.waitForTimeout(Math.max(0, clip.until - Date.now()));
    await recordScenes(browser, target!.dir, [
      // ① つかみ: 30階のタワーが西へ傾きながら崩れ、1階・11階・21階の閃光が下から上へ連なる
      {
        seconds: 4,
        shortSeconds: 4.5,
        setup: async (page) => {
          await openFor(page, { seed: 81, sound: true });
          await startP(page, `forcedJob = { type: 'tower', F: 30 };`);
          await stage(page, CHARGE.hook);
          await page.waitForTimeout(300);
        },
        play: async (page, clip) => {
          await stage(page, 'fireNow();' + snapCam);
          await page.waitForTimeout(700);
          clip.mark();
          await page.waitForTimeout(900);
          if (!SHORT) await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          await rest(page, clip);
        },
      },
      // ② 基本: 図面の柱をタップして爆薬を仕掛け(順番の色を変えながら)、発破を押して 3・2・1
      {
        seconds: 6,
        shortSeconds: 4,
        setup: async (page) => {
          await openFor(page, { seed: 82, sound: true });
          await startP(page);
          await page.waitForTimeout(1200);
        },
        play: async (page, clip) => {
          clip.mark();
          const click = async (li: number, d: number, every: number) => {
            await page.locator(`.br[data-d="${d}"]`).click();
            await page.locator(`#lv-${li}`).click();
            const cols = await gt<any[]>(page, 'planColumns');
            for (const [i, c] of cols.entries()) if (i % every === 0) { await page.mouse.click(c.x, c.y); await page.waitForTimeout(SHORT ? 40 : 70); }
          };
          await click(0, 0, 1);
          await click(1, 1, 1);
          await click(2, 2, 1);
          await page.locator('#b-fire').click();
          await rest(page, clip);
        },
      },
      // ③ 発破: 空き地の側の柱が先に飛び、ビルが空き地へ倒れこんで土煙が上がる
      {
        seconds: 6,
        shortSeconds: 4,
        setup: async (page) => {
          await openFor(page, { seed: 83, sound: true });
          await startP(page);
          await stage(page, CHARGE.fell);
          await page.waitForTimeout(300);
        },
        play: async (page, clip) => {
          await stage(page, 'fireNow();' + snapCam);
          await page.waitForTimeout(300);
          clip.mark();
          await rest(page, clip);
        },
      },
      // ④ 結果: 煙が晴れて判子、次の無傷のビルが立っている(頭へ戻る)
      {
        seconds: 5,
        shortSeconds: 3,
        setup: async (page) => {
          await openFor(page, { seed: 84, sound: true });
          await startP(page);
          await stage(page, CHARGE.implode + '; fireNow();' + snapCam + ' window.__simSpeed = 5;');
          await expect.poll(() => gt<string>(page, 'state'), { timeout: 120_000 }).toBe('settle');
          await stage(page, 'window.__simSpeed = 1;');
        },
        play: async (page, clip) => {
          clip.mark();
          await expect.poll(() => gt<string>(page, 'state'), { timeout: 8_000 }).toBe('result');
          await page.waitForTimeout(SHORT ? 800 : 1600);
          await page.locator('#b-next').click();
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
    await page.waitForTimeout(2000);
    await shot('1title');
    await start(page);
    await page.waitForTimeout(1500);
    await shot('2plan');
    await stage(page, CHARGE.fell + '; updateHUD();');
    await page.waitForTimeout(500);
    await shot('3charged');
    await stage(page, 'fireNow();' + snapCam);
    await page.waitForTimeout(2500);
    await shot('4blast');
    await page.waitForTimeout(2500);
    await shot('5fall');
    await stage(page, 'window.__simSpeed = 5;');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 120_000 }).toBe('result');
    await page.waitForTimeout(800);
    await shot('6result');
  });
});
