import { test, expect, Page } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';
import { recordPlayVideo } from './video';

// ============================================================================
//  プレイテスト: 今日のゲームの「核の遊び」が本当に機能するかを、実際に操作して確かめる。
//  game.spec.ts は「エラーが出ないか」しか見ないので、遊べないゲームでも通ってしまう。
//  このファイルはゲームごとに中身が違うので、毎回、今日のゲームに合わせて書き直す。
//
//  対象: ゆうやけワイヤーフライト(2026-09-30)
//  ゲーム側の window.gameTest(読み取り専用)から状態を読む。
// ============================================================================

const EXPECTED = '2026-09-30-wire-flight';
const target = latestGame();

type Enemy = { id: number; type: string; x: number; z: number; vz: number; hp: number; r: number; leaving: boolean; sx: number; sy: number; sr: number };
type Snap = {
  W: number; H: number; XR: number; PZ: number; px: number;
  guide: { x1: number; y1: number; x2: number; y2: number } | null;
  boss: boolean;
  enemies: Enemy[];
  bullets: { x: number; z: number; vx: number; vz: number }[];
  gates: { x: number; z: number }[];
  fences: { gx: number; gw: number; z: number }[];
};

const url = () => pathToFileURL(target!.html).href;
const get = <T>(page: Page, fn: string) =>
  page.evaluate((f) => (window as any).gameTest[f](), fn) as Promise<T>;
const snap = (page: Page) => page.evaluate(() => (window as any).gameTest.snapshot()) as Promise<Snap>;
const mouseXFor = (page: Page, x: number) =>
  page.evaluate((v) => (window as any).gameTest.mouseXFor(v), x) as Promise<number>;

async function start(page: Page) {
  await page.goto(url());
  await page.click('#btnStart');
  await expect.poll(() => get<string>(page, 'state')).toBe('play');
}

// 自動プレイヤー。弾と突っこんでくるピラミッドの着弾位置を読んで、危ない所を避けながら、
// 連鎖が続くように同じ形の敵を優先して狙う。ショットが弱いうちは金の輪をくぐりに行く。
// mode='suicide' のときは、わざと弾の着弾点に立つ(ゲームオーバーの確認用)。
async function autoplay(page: Page, done: () => Promise<boolean>, limitMs: number, mode: 'play' | 'suicide' = 'play') {
  const box = (await page.locator('#cv').boundingBox())!;
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    if (await done()) return true;
    const d = await snap(page);
    if (!d.guide) { await page.waitForTimeout(50); continue; }
    // 人の目は着弾点をぴったりは読めないので、読みに少し誤差を入れる
    const threats: { x: number; t: number; w: number }[] = [];
    for (const b of d.bullets) {
      if (b.z <= d.PZ) continue;
      const t = (b.z - d.PZ) / -b.vz;
      threats.push({ x: b.x + b.vx * t + (Math.random() - 0.5) * 0.5, t, w: 0.48 });
    }
    for (const e of d.enemies) {
      if (e.type !== 'pyra' || e.z <= d.PZ) continue;
      threats.push({ x: e.x, t: (e.z - d.PZ) / -e.vz, w: e.r * 0.7 + 0.3 });
    }
    const walls = d.fences.filter((f) => f.z > d.PZ).map((f) => ({ ...f, t: (f.z - d.PZ) / 20 }));
    const danger = (x: number) =>
      threats.reduce((s, th) => s + (th.t < 1.4 && Math.abs(th.x - x) < th.w + 0.3 ? 1.6 - th.t : 0), 0) +
      walls.reduce((s, f) => s + (f.t < 1.6 && Math.abs(x - f.gx) > f.gw / 2 - 0.45 ? (1.8 - f.t) * 2 : 0), 0);

    let goal = d.px;
    if (mode === 'suicide') {
      const th = threats.sort((a, b) => a.t - b.t)[0];
      if (th) goal = th.x;
    } else {
      const power = await get<number>(page, 'power');
      const chain = await get<{ n: number; type: string }>(page, 'chain');
      const gate = d.gates.filter((g) => g.z < 32 && g.z > d.PZ).sort((a, b) => a.z - b.z)[0];
      const foes = d.enemies.filter((e) => !e.leaving && e.z < 58 && e.z > d.PZ + 2);
      if (gate && power < 3) goal = gate.x;
      else if (foes.length) {
        const cost = (e: Enemy) => Math.abs(e.x - d.px) + (e.type !== chain.type ? 1.5 : 0) + e.z * 0.03;
        goal = foes.sort((a, b) => cost(a) - cost(b))[0].x;
      }
      let best = goal, bc = Infinity;
      const cands = [goal, d.px];
      for (let x = -d.XR; x <= d.XR; x += 0.4) cands.push(x);
      for (const c of cands) {
        const k = danger(c) * 20 + Math.abs(c - goal) * 0.3 + Math.abs(c - d.px) * 0.1;
        if (k < bc) { bc = k; best = c; }
      }
      goal = best;
      const soon = threats.some((th) => th.t < 0.25 && Math.abs(th.x - d.px) < th.w);
      if (soon && (await get<boolean>(page, 'rollReady'))) await page.keyboard.press('Space');
    }
    const mx = await mouseXFor(page, goal);
    await page.mouse.move(box.x + mx, box.y + box.height * 0.75);
    // 人の反応の速さ: 見てから動くまで0.15秒ほど(読み取りの時間も足すと0.2秒前後)
    await page.waitForTimeout(mode === 'play' ? 150 : 40);
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
      return !!g && ['state', 'score', 'sector', 'lives', 'power', 'chain', 'kills', 'gates', 'best', 'bestSector',
        'unlocked', 'plane', 'rolling', 'rollReady', 'lastKill', 'killLog', 'basePts', 'mouseXFor', 'snapshot']
        .every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
  });

  // 3Dシューティングで一番こわいのは「画面では重なって見えるのに当たらない」こと。
  // ここでは内部の座標を使わず、画面に見えているもの(敵の位置と、水色の線)だけを見て、
  // 人と同じように「線が敵に重なるようにマウスを少しずつ動かす」やり方で狙う。
  //
  // 「撃破数」だけを見ると、見た目と当たりがずれていても通ってしまう(敵が左右にゆれるので、
  // 追いかけているうちに、ずれた位置でも偶然当たる)。そこで「線が敵の真ん中に重なった瞬間から
  // 0.7秒以内に、その敵に弾が当たったか」を1回ずつ判定し、命中率を見る。
  test('画面の水色の線を敵に重ねると、弾が当たって壊せる', async ({ page }) => {
    test.setTimeout(90_000);
    await start(page);
    const box = (await page.locator('#cv').boundingBox())!;
    let mx = box.width / 2;
    // 手の効き具合: マウスを1px動かしたとき、敵の高さで線が何px動くか。
    // 奥の敵ほど遠近法で線が少ししか動かないので、固定の手加減だと合わせきれない
    // (スマホは敵が小さく、判定の幅が4px前後しかない)。人と同じように、動かしながら覚える。
    let gain = 0.5;
    let prev: { mx: number; lx: number; sy: number } | null = null;
    const t0 = Date.now();
    let first = -1, tried = 0, hitN = 0;
    let ep: { id: number; hp: number; kills: number; until: number } | null = null;
    while (Date.now() - t0 < 50_000) {
      const d = await snap(page);
      const g = d.guide!;
      const kills = await get<number>(page, 'kills');
      if (first < 0 && kills > 0) first = (Date.now() - t0) / 1000;
      if (tried >= 12 && kills >= 8) break;
      // 線の上で、敵と同じ高さ(画面のy)の点を求める
      const lineX = (sy: number) => g.x1 + ((sy - g.y1) / (g.y2 - g.y1)) * (g.x2 - g.x1);
      const vis = d.enemies.filter((e) => e.type !== 'pyra' && e.z < 50 && !e.leaving && e.sy > g.y2 && e.sy < g.y1);
      let e = ep ? vis.find((v) => v.id === ep!.id) : undefined;
      if (ep) {
        const hit = e ? e.hp < ep.hp : kills > ep.kills;
        if (hit || !e || Date.now() > ep.until) {
          tried++;
          if (hit) hitN++;
          ep = null;
        }
      }
      if (!e && vis.length) e = vis.sort((a, b) => Math.abs(a.sx - lineX(a.sy)) - Math.abs(b.sx - lineX(b.sy)))[0];
      if (e) {
        const lx = lineX(e.sy);
        // 前回の手の動きと、それで線が動いた量から、手の効き具合を覚え直す
        if (prev && Math.abs(mx - prev.mx) > 3 && Math.abs(e.sy - prev.sy) < 20) {
          const r = (lx - prev.lx) / (mx - prev.mx);
          if (r > 0.05 && r < 2) gain = gain * 0.5 + r * 0.5;
        }
        const gap = e.sx - lx;
        // 画面の上で、線が敵の真ん中あたり(見た目の半径の5割以内)に重なったら、判定を始める
        if (!ep && Math.abs(gap) < e.sr * 0.5) ep = { id: e.id, hp: e.hp, kills, until: Date.now() + 700 };
        prev = { mx, lx, sy: e.sy };
        // 人の手: 1回の修正は大きすぎず、見てから0.1秒ほどで次の修正
        mx = Math.max(5, Math.min(box.width - 5, mx + Math.max(-60, Math.min(60, (gap / gain) * 0.8))));
        await page.mouse.move(box.x + mx, box.y + box.height * 0.75, { steps: 3 });
      }
      await page.waitForTimeout(100);
    }
    const kills = await get<number>(page, 'kills');
    console.log(`  最初の撃破まで: ${first.toFixed(1)}秒 / 撃破: ${kills} / 線を重ねた${tried}回のうち、0.7秒以内に当たった: ${hitN}回`);
    expect(tried, '線を敵に重ねる場面が作れません').toBeGreaterThanOrEqual(12);
    expect(hitN / tried, '線を敵の真ん中に重ねても、弾が当たりません(見た目と当たりがずれている可能性)').toBeGreaterThanOrEqual(0.75);
    expect(kills, '画面を見て線を敵に重ねても、8体壊せません').toBeGreaterThanOrEqual(8);
    expect(await get<number>(page, 'score'), '敵を壊しても得点が入りません').toBeGreaterThan(0);
  });

  test('キーボードで動けて、スペースで回避できる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーボードは desktop で確かめる');
    await start(page);
    const x0 = (await snap(page)).px;
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(400);
    await page.keyboard.up('ArrowRight');
    const x1 = (await snap(page)).px;
    expect(x1 - x0, '→キーで右に動きません').toBeGreaterThan(1.5);
    await page.keyboard.down('a');
    await page.waitForTimeout(400);
    await page.keyboard.up('a');
    expect((await snap(page)).px, 'Aキーで左に動きません').toBeLessThan(x1 - 1.5);
    await page.keyboard.press('Space');
    expect(await get<boolean>(page, 'rolling'), 'スペースで回避しません').toBeTruthy();
  });

  test('指でなぞると動き、タップで回避できる', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'タッチは mobile で確かめる');
    await start(page);
    const box = (await page.locator('#cv').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x?: number, y?: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: x === undefined ? [] : [{ x: box.x + x, y: box.y + y! }],
      } as any);
    const y = box.height * 0.8;
    const x0 = (await snap(page)).px;
    // 人の指の速さ: 画面幅の3割を0.4秒ほどで右へなぞる
    await touch('touchStart', box.width * 0.4, y);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', box.width * (0.4 + 0.3 * (i / 12)), y);
      await page.waitForTimeout(33);
    }
    await touch('touchEnd');
    await page.waitForTimeout(400);
    const x1 = (await snap(page)).px;
    console.log(`  なぞった後の位置: ${x0.toFixed(2)} → ${x1.toFixed(2)}`);
    expect(x1 - x0, '指でなぞっても動きません').toBeGreaterThan(1.5);
    expect(await get<boolean>(page, 'rolling'), 'なぞっただけで回避が出ています').toBeFalsy();
    await touch('touchStart', box.width * 0.5, y);
    await page.waitForTimeout(60);
    await touch('touchEnd');
    expect(await get<boolean>(page, 'rolling'), 'タップで回避しません').toBeTruthy();
  });

  test('金の輪をくぐるとショットが強くなる', async ({ page }) => {
    test.setTimeout(60_000);
    await start(page);
    const p0 = await get<number>(page, 'power');
    const ok = await autoplay(page, async () => (await get<number>(page, 'gates')) > 0, 30_000);
    expect(ok, '30秒のあいだ金の輪をくぐれません(輪が出ない、または当たり判定がない)').toBeTruthy();
    expect(await get<number>(page, 'power'), '輪をくぐってもショットが強くなりません').toBeGreaterThan(p0);
  });

  test('1プレイを最後まで遊び、連鎖の倍率・区間の進行・記録の保存・リトライを確かめる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', '長いので desktop だけで行う');
    test.setTimeout(9 * 60_000);
    await page.setViewportSize({ width: 1200, height: 900 });
    await start(page);

    // 見せ場: 区間2以降で、4連鎖以上の撃破の直後(線が飛び散って倍率が出ている瞬間)に撮る
    let shot = false, bossSeen = false, maxSector = 1;
    const log: { id: number; type: string; chain: number; pts: number; hurt: number }[] = [];
    let seen = 0, lives = await get<number>(page, 'lives');
    const t00 = Date.now();
    const isOver = async () => {
      const lv = await get<number>(page, 'lives');
      if (lv < lives) console.log(`  被弾: ${Math.round((Date.now() - t00) / 1000)}秒 / 区間${await get<number>(page, 'sector')} / 残りハート${lv}`);
      lives = lv;
      const k = await get<{ chain: number; ago: number }>(page, 'lastKill');
      maxSector = Math.max(maxSector, await get<number>(page, 'sector'));
      if (!shot && k.chain >= 4 && k.ago < 0.2 && maxSector >= 2) {
        const s = await snap(page);
        if (s.enemies.length >= 4) {
          await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          shot = true;
          console.log(`  見せ場のスクショを撮りました(区間${maxSector}、${k.chain}連鎖)`);
        }
      }
      if (!bossSeen && (await snap(page)).boss) bossSeen = true;
      // killLog は最後の60件だけなので、通し番号で新しい分だけ足す
      for (const k of await get<typeof log>(page, 'killLog')) {
        if (k.id > seen) { log.push(k); seen = k.id; }
      }
      return (await get<string>(page, 'state')) === 'over';
    };
    const t0 = Date.now();
    let over = await autoplay(page, isOver, 6 * 60_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (!over) {
      console.log('  6分で終わらなかったので、わざと当たりに行きます');
      over = await autoplay(page, isOver, 90_000, 'suicide');
    }
    expect(over, 'ゲームオーバーになりません').toBeTruthy();
    if (!shot) {
      console.log('  見せ場が来なかったので、スクショは撮り直しません');
    }

    const score = await get<number>(page, 'score');
    const sector = await get<number>(page, 'sector');
    console.log(`  1プレイの計測: ${secs}秒 / 区間${sector} / スコア${score} / 撃破${await get<number>(page, 'kills')} / 最大連鎖${await get<number>(page, 'maxChain')} / 回避成功${await get<number>(page, 'dodges')} / ボス${bossSeen ? '出現' : '未到達'}`);
    expect(sector, '区間が進んでいません').toBeGreaterThanOrEqual(3);

    // 連鎖のルール: 同じ形が続けば連鎖+1、違う形か被弾のあとは1から。得点は 基本点 × 連鎖(最大10)
    const base = await get<Record<string, number>>(page, 'basePts');
    expect(log.length, '撃破の記録が取れていません').toBeGreaterThan(10);
    let bad = '';
    for (let i = 0; i < log.length; i++) {
      const k = log[i], prev = log[i - 1];
      const want = prev && prev.type === k.type && prev.hurt === k.hurt ? prev.chain + 1 : 1;
      if (i > 0 && k.chain !== want) bad = `${i}件目: ${prev.type}×${prev.chain} の次の ${k.type} が ×${k.chain}(期待 ×${want})`;
      if (k.pts !== base[k.type] * Math.min(k.chain, 10)) bad = `${i}件目: ${k.type}×${k.chain} の得点が ${k.pts}`;
    }
    expect(bad, `連鎖の計算がおかしい: ${bad}`).toBe('');
    expect(Math.max(...log.map((k) => k.chain)), '連鎖が一度も3以上になりません').toBeGreaterThanOrEqual(3);

    // 結果画面
    await expect(page.locator('#veil')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#btnStart')).toHaveText('リトライ');
    expect(await get<number>(page, 'best'), '自己ベストが記録されていません').toBe(score);

    // 再読み込みしても残る
    await page.reload();
    expect(await get<number>(page, 'best'), '自己ベストが保存されていません').toBe(score);
    expect(await get<number>(page, 'bestSector'), '到達区間が保存されていません').toBe(sector);

    // 区間4まで行けたら、新しい機体が使える
    if (sector >= 4) {
      expect(await get<string[]>(page, 'unlocked'), '区間4に着いたのに、つばめが使えません').toContain('swallow');
      await page.locator('.plane', { hasText: 'つばめ' }).click();
    }

    // リトライ
    await page.click('#btnStart');
    await expect.poll(() => get<string>(page, 'state')).toBe('play');
    if (sector >= 4) expect(await get<string>(page, 'plane'), '選んだ機体で始まりません').toBe('swallow');
  });
  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(3 * 60_000);
    // 区間2まで進めて敵が増えてから、自動プレイヤーが連鎖を狙う10秒を撮る
    await recordPlayVideo(browser, {
      dir: target!.dir,
      focus: '#cv',
      setup: async (page) => {
        await start(page);
        await autoplay(page, async () => (await get<number>(page, 'sector')) >= 2, 90_000);
      },
      play: async (page, until) => {
        await autoplay(page, async () => Date.now() >= until || (await get<string>(page, 'state')) === 'over', until - Date.now());
      },
    });
  });
});
