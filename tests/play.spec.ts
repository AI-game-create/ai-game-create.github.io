import { test, expect, Page } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';

// ============================================================================
//  プレイテスト: 今日のゲームの「核の遊び」が本当に機能するかを、実際に操作して確かめる。
//  game.spec.ts は「エラーが出ないか」しか見ないので、遊べないゲームでも通ってしまう。
//  このファイルはゲームごとに中身が違うので、毎回、今日のゲームに合わせて書き直す。
//
//  対象: なげなわコメット(2026-09-29)
//  ゲーム側の window.gameTest(読み取り専用)から状態を読む。
// ============================================================================

const EXPECTED = '2026-09-29-nagenawa-comet';
const target = latestGame();

type Snap = {
  W: number; H: number; S: number;
  P: { x: number; y: number } | null;
  enemies: { x: number; y: number; type: string }[];
  bullets: { x: number; y: number }[];
};

const url = () => pathToFileURL(target!.html).href;
const get = <T>(page: Page, fn: string) =>
  page.evaluate((f) => (window as any).gameTest[f](), fn) as Promise<T>;
const snap = (page: Page) => page.evaluate(() => (window as any).gameTest.snapshot()) as Promise<Snap>;

async function start(page: Page) {
  await page.goto(url());
  await page.click('#btnStart');
  await expect.poll(() => get<string>(page, 'state')).toBe('play');
}

// 人間に近いつもりの自動プレイヤー。
// 敵のかたまりを選んで、動きを目で追いながら囲む。トゲ・ボス・弾が近いときは逃げる。
// mode='suicide' のときは、わざとトゲやボスに当たりに行く(ゲームオーバーの確認用)。
async function autoplay(page: Page, done: () => Promise<boolean>, limitMs: number, mode: 'hunt' | 'suicide' = 'hunt') {
  const box = (await page.locator('#cv').boundingBox())!;
  const t0 = Date.now();
  let center: { x: number; y: number; big: boolean } | null = null;
  let step = 0, a = 0;
  while (Date.now() - t0 < limitMs) {
    if (await done()) return true;
    const d = await snap(page);
    if (!d.P || d.enemies.length === 0) { await page.waitForTimeout(50); continue; }
    const threats = [...d.enemies.filter((e) => e.type === 'spike' || e.type === 'boss'), ...d.bullets];

    if (mode === 'suicide') {
      if (threats[0]) await page.mouse.move(box.x + threats[0].x, box.y + threats[0].y);
      await page.waitForTimeout(30);
      continue;
    }

    let near: { x: number; y: number } | null = null, nd = Infinity;
    for (const t of threats) {
      const dd = Math.hypot(t.x - d.P.x, t.y - d.P.y);
      if (dd < nd) { nd = dd; near = t; }
    }
    if (near && nd < 75 * d.S) {
      const ax = d.P.x - near.x, ay = d.P.y - near.y, l = Math.hypot(ax, ay) || 1;
      const tx = Math.max(20, Math.min(d.W - 20, d.P.x + (ax / l) * 140 * d.S));
      const ty = Math.max(20, Math.min(d.H - 20, d.P.y + (ay / l) * 140 * d.S));
      await page.mouse.move(box.x + tx, box.y + ty);
      await page.waitForTimeout(16);
      center = null;
      continue;
    }

    if (!center || step > 36) {
      let best = d.enemies[0], bc = -1;
      for (const e of d.enemies) {
        let c = 0;
        for (const f of d.enemies) if (Math.hypot(e.x - f.x, e.y - f.y) < 110 * d.S) c++;
        if (c > bc) { bc = c; best = e; }
      }
      center = { x: best.x, y: best.y, big: bc >= 3 };
      a = Math.atan2(d.P.y - best.y, d.P.x - best.x);
      step = 0;
    }
    let tgt = d.enemies[0], td = Infinity;
    for (const e of d.enemies) {
      const dd = Math.hypot(e.x - center.x, e.y - center.y);
      if (dd < td) { td = dd; tgt = e; }
    }
    center.x += (tgt.x - center.x) * 0.5;
    center.y += (tgt.y - center.y) * 0.5;
    const R = (center.big ? 110 : 75) * d.S;
    a += 0.19;
    step++;
    await page.mouse.move(box.x + center.x + Math.cos(a) * R, box.y + center.y + Math.sin(a) * R);
    await page.waitForTimeout(16);
  }
  return done();
}

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(
      target!.name,
      'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください',
    ).toBe(EXPECTED);
  });

  test('テスト用の窓口 window.gameTest がある', async ({ page }) => {
    await page.goto(url());
    const ok = await page.evaluate(() => {
      const g = (window as any).gameTest;
      return !!g && ['state', 'score', 'wave', 'lives', 'shards', 'loops', 'lastCatch', 'snapshot'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
  });

  // 元のバグ(しっぽが短すぎて、ふつうの大きさの円では輪が閉じない)を捕まえるためのテスト。
  // 敵の近くで小さく回るだけだと、しっぽが短くても輪が閉じてしまい見逃す。
  test('人が描く大きさの円で輪が閉じる', async ({ page }) => {
    test.setTimeout(60_000);
    await start(page);
    const box = (await page.locator('#cv').boundingBox())!;
    const d = await snap(page);
    const short = Math.min(d.W, d.H);
    for (const rate of [0.10, 0.15, 0.20]) {
      const r = short * rate;
      const before = await get<number>(page, 'loops');
      // 人の手の速さ(毎秒 約400px)で、1周と少し描く
      const cx = d.W / 2, cy = d.H / 2, w = 400 / r, total = Math.PI * 2 * 1.15;
      await page.mouse.move(box.x + cx + r, box.y + cy);
      await page.waitForTimeout(400);
      const t0 = Date.now();
      for (let a = 0; a < total; a = ((Date.now() - t0) / 1000) * w) {
        await page.mouse.move(box.x + cx + Math.cos(a) * r, box.y + cy + Math.sin(a) * r);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(300);
      const after = await get<number>(page, 'loops');
      console.log(`  半径 ${Math.round(r)}px(短辺の${rate * 100}%): 輪 ${after - before} 個`);
      expect(after, `半径${Math.round(r)}pxの円を描いても輪が閉じません(しっぽが短すぎる可能性)`).toBeGreaterThan(before);
    }
  });

  test('敵を囲むと得点が入る', async ({ page }) => {
    test.setTimeout(90_000);
    await start(page);
    const t0 = Date.now();
    const scored = await autoplay(page, async () => (await get<number>(page, 'score')) > 0, 40_000);
    console.log(`  最初の得点まで: ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
    expect(scored, '40秒間、敵を追いかけて囲み続けても得点が入りません(輪が閉じていない可能性)').toBeTruthy();
  });

  test('1プレイを最後まで遊び、かけらをもらってリトライできる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', '長いので desktop だけで行う');
    test.setTimeout(9 * 60_000);
    await page.setViewportSize({ width: 1200, height: 900 });
    await start(page);

    // 避けながら本気で遊んで、1プレイの長さを測る。
    // 途中で「3種類以上の敵がいる中で、2体以上まとめて捕まえた瞬間」が来たら、投稿用のスクショを撮る。
    let shot = false;
    const isOver = async () => {
      if (!shot) {
        const c = await get<{ n: number; ago: number }>(page, 'lastCatch');
        if (c.n >= 2 && c.ago < 0.3 && (await get<number>(page, 'wave')) >= 3) {
          const s = await snap(page);
          if (new Set(s.enemies.map((e) => e.type)).size >= 3 && s.enemies.length >= 6) {
            await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
            shot = true;
            console.log('  見せ場のスクショを撮りました');
          }
        }
      }
      return (await get<string>(page, 'state')) === 'over';
    };
    const t0 = Date.now();
    let over = await autoplay(page, isOver, 6 * 60_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (!over) over = await autoplay(page, isOver, 60_000, 'suicide');
    expect(over, 'ゲームオーバーになりません').toBeTruthy();

    const score = await get<number>(page, 'score');
    const wave = await get<number>(page, 'wave');
    console.log(`  1プレイの計測: ${secs}秒 / ウェーブ${wave} / スコア${score}`);
    expect(wave, 'ウェーブが進んでいません').toBeGreaterThanOrEqual(3);

    // 結果画面
    await expect(page.locator('#veil')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#btnStart')).toHaveText('リトライ');
    const shards = await get<number>(page, 'shards');
    expect(shards, 'かけらの数がスコアと合いません').toBe(Math.floor(score / 15));

    // 再読み込みしても残る
    await page.reload();
    expect(await get<number>(page, 'shards'), 'かけらが保存されていません').toBe(shards);

    // 強化を買える(最初の強化は30個)
    if (shards >= 30) {
      await page.locator('.buy').first().click();
      expect(await get<number>(page, 'shards'), '強化を買えません').toBe(shards - 30);
    }

    // リトライ
    await page.click('#btnStart');
    await expect.poll(() => get<string>(page, 'state')).toBe('play');
  });
});
