import { test, expect, Page, CDPSession } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';
import { recordPlayVideo, Clip } from './video';
import { measureFps } from './perf';

// ============================================================================
//  プレイテスト: 今日のゲームの「核の遊び」が本当に機能するかを、実際に操作して確かめる。
//  game.spec.ts は「エラーが出ないか」しか見ないので、遊べないゲームでも通ってしまう。
//  このファイルはゲームごとに中身が違うので、毎回、今日のゲームに合わせて書き直す。
//
//  対象: ころがれ!どんぐり山(2026-10-03・土曜の3D大作枠)
//  どんぐりを左右に操って山道をころがり、なかまを集め、いがをよけ、谷をとびこえて池まで行く。
//  ゲーム側の window.gameTest(読み取り専用)から、どんぐりの位置や道の上のものを読む。
//  操作はすべて本物の入力で行う(キー / マウス / 指)。
// ============================================================================

const EXPECTED = '2026-10-03-donguri-downhill';
const target = latestGame();
const SKEY = 'donguri-yama-v1';

type Ball = { s: number; u: number; vs: number; vu: number; h: number; air: boolean; fall: boolean; inv: number; sunk: boolean; cpS: number; boost: number };
type Piece = { t: string; s0: number; s1: number; mod: string; gap0?: number; gap1?: number; rampS?: number; mushS?: number };
type Info = { id: string; name: string; goal: number; len: number; lip: number; cps: number[]; gold: number; silver: number;
  sim: { t: number; falls: number; hits: number; n: number; total: number }; pieces: Piece[]; friends: number; burrs: number; mush: number; piles: number };
type Items = { friends: { s: number; u: number; h: number; got: boolean }[]; burrs: { s: number; u: number }[]; mush: { s: number; u: number; launch: boolean }[]; piles: { s: number; u: number; used: boolean }[] };
type Tr = { w: number; wallL: boolean; wallR: boolean; floor: boolean; kind: number; k: number; ramp: number };
type Ev = { type: string; t: number; s: number; i?: number; lose?: number; k?: number };
type Result = { course: number; t: number; medal: string; n: number; total: number; falls: number; hits: number; picked: number; lost: number; newBest: boolean; firstClear: boolean; gold: number; silver: number };
type Ctx = { info: Info; items: Items; tr: Tr[] };

const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const isMobile = (page: Page) => page.viewportSize()!.width < 500;
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------------------
//  ゲームの開き方
// ---------------------------------------------------------------------------
async function open(page: Page, cleared = 0, sound = false) {
  await page.goto(url());
  const best: Record<string, unknown> = {};
  for (let i = 1; i <= cleared; i++) best[`c${i}`] = { t: 99, n: 0, medal: 'bronze', total: 30 };
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), [SKEY, { best, sound, hints: { how: 1 }, last: 0 }] as const);
  await page.reload();
  await expect.poll(() => gt<string>(page, 'state')).toBe('title');
}
async function start(page: Page, n: number): Promise<Ctx> {
  await page.locator(`.post[data-n="${n}"]`).click();
  await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('play');
  return ctxOf(page);
}
async function ctxOf(page: Page): Promise<Ctx> {
  const info = await gt<Info>(page, 'info');
  const items = await gt<Items>(page, 'items');
  const tr = await page.evaluate((len) => {
    const g = (window as any).gameTest;
    const out = [];
    for (let s = 0; s <= len; s += 1) out.push(g.track(s));
    return out;
  }, info.len);
  return { info, items, tr };
}

// ---------------------------------------------------------------------------
//  手: キー / マウス / 指。steer(-1〜1)で左右、jump() でジャンプ
// ---------------------------------------------------------------------------
type Hand = { name: string; steer: (x: number) => Promise<void>; jump: () => Promise<void>; release: () => Promise<void> };
function keyHand(page: Page, wasd = false): Hand {
  let cur = 0;
  const L = wasd ? 'a' : 'ArrowLeft', R = wasd ? 'd' : 'ArrowRight';
  const h: Hand = {
    name: wasd ? 'A D キー' : '矢印キー',
    async steer(x) {
      const want = x > 0.3 ? 1 : x < -0.3 ? -1 : 0;
      if (want === cur) return;
      if (cur === 1) await page.keyboard.up(R);
      if (cur === -1) await page.keyboard.up(L);
      if (want === 1) await page.keyboard.down(R);
      if (want === -1) await page.keyboard.down(L);
      cur = want;
    },
    async jump() { await page.keyboard.press(wasd ? 'w' : 'Space'); },
    async release() { await h.steer(0); },
  };
  return h;
}
async function mouseHand(page: Page): Promise<Hand> {
  const vp = page.viewportSize()!;
  const cx = vp.width / 2, cy = vp.height * 0.72, span = Math.min(vp.width, vp.height) * 0.16;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  return {
    name: 'マウス',
    async steer(x) { await page.mouse.move(cx + clamp(x, -1, 1) * span * 0.95, cy); },
    async jump() { await page.keyboard.press('Space'); },
    async release() { await page.mouse.up(); },
  };
}
async function touchHand(page: Page, cdp?: CDPSession): Promise<Hand> {
  const c = cdp ?? (await page.context().newCDPSession(page));
  const vp = page.viewportSize()!;
  const cx = vp.width * 0.4, cy = vp.height * 0.7, span = Math.min(vp.width, vp.height) * 0.16;
  const jb = await page.locator('#b-jump').boundingBox();
  let x = cx;
  const f1 = () => ({ x, y: cy, id: 1 });
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [f1()] } as any);
  return {
    name: '指',
    async steer(v) {
      const nx = cx + clamp(v, -1, 1) * span * 0.95;
      if (Math.abs(nx - x) < 1) return;
      x = nx;
      await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [f1()] } as any);
    },
    async jump() {
      // 2本目の指で ジャンプボタンを おす
      const j = { x: jb!.x + jb!.width / 2, y: jb!.y + jb!.height / 2, id: 2 };
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [f1(), j] } as any);
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [f1()] } as any);
    },
    async release() { await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any); },
  };
}
const deviceHand = (page: Page) => (isMobile(page) ? touchHand(page) : Promise.resolve(keyHand(page)));

// ---------------------------------------------------------------------------
//  自動プレイヤー: 道の先を見て、いがを避け、なかまと落ち葉の山をねらい、
//  ジャンプ台・きのこ・橋では まん中を走る。人と同じく、見てから手を動かす(遅れがある)
// ---------------------------------------------------------------------------
function trAt(c: Ctx, s: number) { return c.tr[clamp(Math.round(s), 0, c.tr.length - 1)]; }
function chooseLane(c: Ctx, b: Ball) {
  const s = b.s, look = Math.max(10, b.vs);
  const wmin = Math.min(trAt(c, s).w, trAt(c, s + look * 0.5).w, trAt(c, s + look).w) / 2;
  const lim = Math.max(0, wmin - 0.8);
  let center = false;
  for (let d = 0; d <= look + 8; d += 2) if ([1, 2, 3, 6, 9].includes(trAt(c, s + d).kind)) center = true;
  const mid = trAt(c, s + look * 0.5);
  let best = 1e9, lane = 0;
  for (let L = -lim; L <= lim + 1e-6; L += Math.max(0.25, lim / 6)) {
    let cost = Math.abs(L - b.u) * 0.12 + (center ? Math.abs(L) * 3 : 0);
    if (!mid.wallL) cost += Math.max(0, -L) * 0.6;
    if (!mid.wallR) cost += Math.max(0, L) * 0.6;
    for (const x of c.items.burrs) { const d = x.s - s; if (d < 0.5 || d > look + 4) continue; const du = Math.abs(L - x.u); if (du < 1.7) cost += 20 * (1 - du / 1.7) + 6; }
    for (const f of c.items.friends) { const d = f.s - s; if (d < 0.5 || d > look || f.h > 2) continue; if (Math.abs(L - f.u) < 0.9) cost -= 3; }
    for (const p of c.items.piles) { const d = p.s - s; if (d < 0.5 || d > look) continue; if (Math.abs(L - p.u) < 1.2) cost -= 2; }
    for (const m of c.items.mush) { const d = m.s - s; if (d > 0.5 && d < look + 4 && Math.abs(L - m.u) < 1.0) cost -= m.launch ? 30 : 1.5; }
    if (cost < best) { best = cost; lane = L; }
  }
  return lane;
}
let seed = 4242;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
type DriveOpt = {
  until?: (b: Ball) => boolean;
  aim?: (b: Ball) => number | null | undefined;
  noJump?: boolean;
  jumpAt?: (b: Ball) => boolean;
  err?: number; // 人らしい ねらいのずれ(m)
  lag?: number; // 見てから手を動かすまでの おくれ(ms)
  onTick?: (b: Ball) => Promise<void>;
  maxMs?: number;
};
async function drive(page: Page, c: Ctx, hand: Hand, opt: DriveOpt = {}) {
  const t0 = Date.now();
  let err = 0, errAt = 0, lastJumpS = -99;
  let b: Ball | null = null;
  while (true) {
    const snap = await page.evaluate(() => { const g = (window as any).gameTest; return { st: g.state() as string, b: g.ball() as Ball }; });
    if (snap.st !== 'play') break;
    b = snap.b;
    if (opt.until && opt.until(b)) break;
    if (Date.now() - t0 > (opt.maxMs ?? 200_000)) break;
    if (opt.onTick) await opt.onTick(b);
    if (opt.err && Date.now() - errAt > 1500) { err = (rnd() * 2 - 1) * opt.err; errAt = Date.now(); }
    let lane = opt.aim ? opt.aim(b) : null;
    if (lane === null || lane === undefined) lane = chooseLane(c, b) + err;
    await hand.steer(clamp((lane - b.u) * 0.9 - b.vu * 0.32, -1, 1));
    let jump = false;
    if (!opt.noJump && b.inv <= 0 && !b.air && b.s - lastJumpS > 4) {
      for (const x of c.items.burrs) { const d = x.s - b.s; if (d > 0 && d < b.vs * 0.3 && Math.abs(x.u - b.u) < 1.0) jump = true; }
    }
    if (opt.jumpAt && !b.air && opt.jumpAt(b)) jump = true;
    if (jump) { lastJumpS = b.s; await hand.jump(); }
    await page.waitForTimeout(opt.lag ?? 25);
  }
  await hand.steer(0);
  return b;
}
async function playToEnd(page: Page, c: Ctx, hand: Hand, opt: DriveOpt = {}) {
  const t0 = Date.now();
  await drive(page, c, hand, opt);
  await expect.poll(() => gt<string>(page, 'state'), { timeout: 30_000 }).toBe('result');
  return { r: (await gt<Result>(page, 'result'))!, secs: (Date.now() - t0) / 1000 };
}
const events = (page: Page) => gt<Ev[]>(page, 'events');

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(target!.name, 'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください').toBe(EXPECTED);
  });

  test('テスト用の窓口 window.gameTest があり、3D(WebGL)で描いている', async ({ page }) => {
    await page.goto(url());
    const ok = await page.evaluate(() => {
      const g = (window as any).gameTest;
      return !!g && ['state', 'course', 'score', 'friends', 'time', 'ball', 'track', 'info', 'items', 'stats', 'events', 'followers', 'ballScreen',
        'splashes', 'plops', 'result', 'progress', 'quality', 'sound', 'particles', 'webgl'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
    expect(await gt<boolean>(page, 'webgl'), 'WebGL が使えていません').toBeTruthy();
    // 画面が1色ではない(本当に何か描けている)
    await page.waitForTimeout(800);
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '3Dの画面に何も描かれていないようです').toBeGreaterThan(20_000);
  });

  test('コースの作り: どの坂も、谷の前にチェックポイント・ジャンプ台のまわりに いがなし・お手本が落ちずにゴールできる', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, 4);
    const rows: string[] = [];
    let prevGoal = 0;
    for (let n = 1; n <= 6; n++) {
      const c = await start(page, n);
      const { info, items } = c;
      rows.push(`${info.name} ${info.goal.toFixed(0)}m なかま${info.friends} いが${info.burrs} きのこ${info.mush} 落ち葉${info.piles} お手本${info.sim.t.toFixed(1)}秒(落ちた${info.sim.falls})`);
      expect(info.sim.falls, `${info.name}: お手本が谷や崖に落ちます`).toBe(0);
      expect(info.sim.t, `${info.name}: お手本がゴールできません`).toBeLessThan(200);
      expect(info.friends, `${info.name}: なかまがいません`).toBeGreaterThanOrEqual(10);
      for (const p of info.pieces.filter((x) => x.t === 'J' || x.t === 'M')) {
        const cp = info.cps.filter((s) => s <= p.s0 + 0.01);
        expect(cp.length && p.s0 - cp[cp.length - 1] < 30, `${info.name}: ${p.t} の谷の手前にチェックポイントがありません`).toBeTruthy();
        expect(p.gap1! - p.gap0!, `${info.name}: 谷の幅がおかしい`).toBeGreaterThan(5);
        for (const b of items.burrs) expect(b.s > p.s0 - 12 && b.s < p.s1 + 1, `${info.name}: 谷の前後に いががあります(s=${b.s.toFixed(0)})`).toBeFalsy();
        if (p.t === 'M') expect(items.mush.some((m) => m.launch && Math.abs(m.s - p.mushS!) < 0.1), `${info.name}: 谷の前に きのこがありません`).toBeTruthy();
        if (p.t === 'J') expect(c.tr[Math.round(p.rampS! + 5)].ramp, `${info.name}: 谷の前に ジャンプ台がありません`).toBeGreaterThan(0.2);
      }
      // いがは必ず よけられる(道のどこかに 2m 以上の すきまがある)
      for (const b of items.burrs) {
        const same = items.burrs.filter((x) => Math.abs(x.s - b.s) < 2);
        const w = c.tr[Math.round(b.s)].w / 2;
        const blocked = (u: number) => same.some((x) => Math.abs(x.u - u) < 1.0 + 0.5);
        let free = 0, bestFree = 0;
        for (let u = -w + 0.5; u <= w - 0.5; u += 0.1) { free = blocked(u) ? 0 : free + 0.1; bestFree = Math.max(bestFree, free); }
        expect(bestFree, `${info.name}: いがで道がふさがっています(s=${b.s.toFixed(0)})`).toBeGreaterThanOrEqual(0.3);
      }
      if (n <= 5) { expect(info.goal, `${info.name}: まえの坂より短い`).toBeGreaterThan(prevGoal * 0.95); prevGoal = info.goal; }
      await page.keyboard.press('Escape');
      await page.locator('#b-quit').click();
      await expect.poll(() => gt<string>(page, 'state')).toBe('title');
    }
    console.log(`  ${rows.join('\n  ')}`);
  });

  // 核の遊び: 左右に操ると、そちらへ ころがる(キー・マウス・指 どれでも)
  test('左右の操作: おした向きに ころがる', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    await start(page, 1);
    const makers: (() => Promise<Hand>)[] = isMobile(page) ? [() => touchHand(page)] : [async () => keyHand(page), async () => keyHand(page, true), () => mouseHand(page)];
    for (const make of makers) {
      const hand = await make();
      for (const dir of [1, -1]) {
        const a = await gt<Ball>(page, 'ball');
        await hand.steer(dir);
        await page.waitForTimeout(450); // 人が ちょっと おさえるくらい
        await hand.steer(0);
        await page.waitForTimeout(150);
        const b = await gt<Ball>(page, 'ball');
        console.log(`  ${hand.name} ${dir > 0 ? '右' : '左'}: u ${a.u.toFixed(2)} → ${b.u.toFixed(2)}`);
        expect((b.u - a.u) * dir, `${hand.name}で ${dir > 0 ? '右' : '左'}に動きません`).toBeGreaterThan(1.0);
        // まん中へ もどす
        const c = await ctxOf(page);
        await drive(page, c, hand, { aim: () => 0, until: (x) => Math.abs(x.u) < 0.3 && Math.abs(x.vu) < 1, maxMs: 4000 });
      }
      await hand.release();
    }
    expect((await gt<Ball>(page, 'ball')).vs, '坂を ころがっても 速くなりません').toBeGreaterThan(8);
  });

  test('なかま: ふれると うしろに ついてくる。2m はなれて通ると つかない', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page);
    const c = await start(page, 1);
    const hand = await deviceHand(page);
    const rows = c.items.friends.filter((f, i, a) => f.h === 0 && i + 2 < a.length && a[i + 1].u === f.u && a[i + 2].u === f.u && Math.abs(a[i + 1].s - f.s - 3.2) < 0.01);
    expect(rows.length, '3つならびの なかまが見つかりません').toBeGreaterThanOrEqual(2);
    // 1列目: まっすぐ ねらって とる
    const r1 = rows[0];
    await drive(page, c, hand, { aim: (b) => (b.s > r1.s - 30 && b.s < r1.s + 8 ? r1.u : null), until: (b) => b.s > r1.s + 9, noJump: true });
    let it = await gt<Items>(page, 'items');
    const got1 = it.friends.filter((f) => f.u === r1.u && f.s >= r1.s && f.s < r1.s + 7).map((f) => f.got);
    console.log(`  ねらって通った: ${got1}`);
    expect(got1.every(Boolean), 'なかまの上を通っても つきません').toBeTruthy();
    expect(await gt<number>(page, 'friends')).toBeGreaterThanOrEqual(3);
    // うしろに 1.25m おきに ならぶ
    await page.waitForTimeout(500);
    const fo = await gt<{ ball: number[]; list: number[][] }>(page, 'followers');
    const gaps = [dist(fo.ball, fo.list[0]), ...fo.list.slice(1).map((p, k) => dist(p, fo.list[k]))];
    console.log(`  ならびの間かく: ${gaps.map((g) => g.toFixed(2)).join(', ')}`);
    for (const g of gaps) expect(g, 'なかまが うしろに ならんでいません').toBeGreaterThan(0.7);
    for (const g of gaps) expect(g, 'なかまが はなれすぎです').toBeLessThan(2.0);
    // 2列目: 2m よこを通る
    const r2 = rows.find((r) => r.s > r1.s + 40 && Math.abs(r.u) <= c.tr[Math.round(r.s)].w / 2 - 0.5)!;
    const side = r2.u > 0 ? -2.0 : 2.0;
    const before = await gt<number>(page, 'friends');
    await drive(page, c, hand, { aim: (b) => (b.s > r2.s - 30 && b.s < r2.s + 8 ? r2.u + side : null), until: (b) => b.s > r2.s + 9, noJump: true });
    it = await gt<Items>(page, 'items');
    const got2 = it.friends.filter((f) => f.u === r2.u && f.s >= r2.s && f.s < r2.s + 7).map((f) => f.got);
    const b2 = await gt<Ball>(page, 'ball');
    console.log(`  2m よこを通った: ${got2}(なかま ${before} → ${await gt<number>(page, 'friends')}・いまの u ${b2.u.toFixed(1)})`);
    expect(got2.some(Boolean), '2m はなれて通ったのに なかまが つきました').toBeFalsy();
    await hand.release();
  });

  test('いが: ぶつかると なかまが3こ はぐれて 遅くなる。ジャンプで とびこえれば だいじょうぶ', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, 1);
    const c = await start(page, 2);
    const hand = await deviceHand(page);
    // なかまを 4こ以上 あつめる
    await drive(page, c, hand, { until: (b) => b.s > 60 });
    let n0 = await gt<number>(page, 'friends');
    let tries = 0;
    while (n0 < 4 && tries++ < 20) { const s0 = (await gt<Ball>(page, 'ball')).s; await drive(page, c, hand, { until: (b) => b.s > s0 + 40 }); n0 = await gt<number>(page, 'friends'); }
    expect(n0, 'なかまが集まりません').toBeGreaterThanOrEqual(4);
    // 1つ目の いが: まっすぐ ぶつかる
    const s0 = (await gt<Ball>(page, 'ball')).s;
    const single = (x: { s: number; u: number }) => !c.items.burrs.some((y) => y !== x && Math.abs(y.s - x.s) < 12);
    const b1 = c.items.burrs.find((x) => x.s > s0 + 35 && single(x))!;
    expect(b1, 'ぶつかる いがが見つかりません').toBeTruthy();
    let before: Ball | null = null;
    await drive(page, c, hand, { aim: (b) => (b.s > b1.s - 40 ? b1.u : null), noJump: true, until: (b) => b.s > b1.s + 3,
      onTick: async (b) => { if (b1.s - b.s < 4 && b1.s - b.s > 0 && !before) before = b; } });
    const after = await gt<Ball>(page, 'ball');
    const ev = await events(page);
    const hit = ev.filter((e) => e.type === 'hit');
    const stA = await gt<{ lost: number; n: number }>(page, 'stats');
    console.log(`  ぶつかった: なかま ${n0} → いま ${stA.n}(はぐれた ${stA.lost})・速さ ${before!.vs.toFixed(1)} → ${after.vs.toFixed(1)}・hit ${hit.length}回`);
    expect(hit.length, 'いがに ぶつかっても 何も起きません').toBe(1);
    expect(Math.abs(hit[0].s - b1.s), 'ぶつかった場所が いがの位置とちがいます').toBeLessThan(1.5);
    expect(hit[0].lose, 'ぶつかっても なかまが はぐれません').toBe(3);
    expect(stA.lost, 'はぐれた なかまの数が あいません').toBe(3);
    expect(after.vs, 'ぶつかっても 遅くなりません').toBeLessThan(before!.vs * 0.75);
    // 2つ目の いが: まっすぐ むかって、手前でジャンプ
    const b2 = c.items.burrs.find((x) => x.s > b1.s + 30 && single(x))!;
    let hAt = -1;
    await drive(page, c, hand, {
      aim: (b) => (b.s > b2.s - 40 ? b2.u : null), noJump: true, until: (b) => b.s > b2.s + 3,
      jumpAt: (b) => b2.s - b.s > 0 && b2.s - b.s < b.vs * 0.28,
      onTick: async (b) => { if (hAt < 0 && Math.abs(b.s - b2.s) < 0.6) hAt = b.h; },
    });
    const ev2 = await events(page);
    console.log(`  ジャンプで こえた: いがの上での高さ ${hAt.toFixed(2)}m・hit ${ev2.filter((e) => e.type === 'hit').length}回`);
    expect(ev2.filter((e) => e.type === 'jump' && Math.abs(e.s - b2.s) < 12).length, 'ジャンプできていません').toBeGreaterThanOrEqual(1);
    expect(ev2.filter((e) => e.type === 'hit').length, 'とびこえたのに いがに ぶつかりました').toBe(1);
    expect(hAt, 'いがの上を とんでいません').toBeGreaterThan(0.9);
    await hand.release();
  });

  test('ジャンプ台で谷を とびこえる・さくのない所で はしに寄ると落ちて、チェックポイントから やりなおし', async ({ page }) => {
    test.setTimeout(150_000);
    await open(page, 1);
    const c = await start(page, 2);
    const hand = await deviceHand(page);
    const J = c.info.pieces.find((p) => p.t === 'J')!;
    // ふつうに走って 谷をこえる(谷の上は ずっと空中)
    let overGap = 0, airOver = 0;
    await drive(page, c, hand, { until: (b) => b.s > J.gap1! + 8, onTick: async (b) => { if (b.s > J.gap0! + 0.5 && b.s < J.gap1! - 0.5) { overGap++; if (b.air) airOver++; } } });
    const st = await gt<{ falls: number }>(page, 'stats');
    console.log(`  谷(${(J.gap1! - J.gap0!).toFixed(0)}m)の上: ${airOver}/${overGap} 回 空中・落ちた ${st.falls}`);
    expect(st.falls, 'ジャンプ台から 谷をこえられません').toBe(0);
    expect(overGap, '谷の上を 通っていません').toBeGreaterThan(0);
    expect(airOver, '谷の上で 空中に いません').toBe(overGap);
    // 右に さくのない カーブで、右へ 寄りつづける
    const open1 = c.info.pieces.find((p) => p.s0 > J.s1 && (p.mod.includes('r') || p.mod.includes('o')))!;
    expect(open1, 'さくのない所が ありません').toBeTruthy();
    const dir = open1.mod.includes('r') || open1.mod.includes('o') ? 1 : -1;
    const fallsBefore = (await gt<{ falls: number }>(page, 'stats')).falls;
    const tBefore = await gt<number>(page, 'time');
    let fellAt = -1;
    await drive(page, c, hand, { aim: (b) => (b.s > open1.s0 + 4 ? dir * 6 : null), noJump: true, until: (b) => { if (b.fall && fellAt < 0) fellAt = b.s; return fellAt > 0 && !b.fall; }, maxMs: 30_000 });
    const after = await gt<Ball>(page, 'ball');
    const st2 = await gt<{ falls: number }>(page, 'stats');
    const cpBefore = c.info.cps.filter((s) => s <= fellAt).pop()!;
    console.log(`  s=${fellAt.toFixed(0)} で落ちた → s=${after.s.toFixed(0)} から(チェックポイント ${cpBefore.toFixed(0)})・時間 ${tBefore.toFixed(1)} → ${(await gt<number>(page, 'time')).toFixed(1)}`);
    expect(fellAt, 'さくのない所で はしに寄っても 落ちません').toBeGreaterThan(open1.s0);
    expect(st2.falls).toBe(fallsBefore + 1);
    expect(after.s, 'チェックポイントから やりなおしになりません').toBeLessThan(fellAt);
    expect(Math.abs(after.s - cpBefore), 'やりなおしの場所が チェックポイントではありません').toBeLessThan(6);
    expect(await gt<number>(page, 'time'), '落ちている間 時間が止まっています').toBeGreaterThan(tBefore + 1);
    await hand.release();
  });

  test('きのこ: まん中に のると 大ジャンプで谷をこえる。はずすと 谷に落ちる。落ち葉の山で 速くなる', async ({ page }) => {
    test.setTimeout(150_000);
    await open(page, 3);
    const c = await start(page, 4);
    const hand = await deviceHand(page);
    const Ms = c.info.pieces.filter((p) => p.t === 'M');
    expect(Ms.length).toBeGreaterThanOrEqual(2);
    // 落ち葉の山: ねらって つっこむ
    const pile = c.items.piles.find((p) => p.s > 30)!;
    let vBefore = 0;
    if (pile.s < Ms[0].s0) {
      await drive(page, c, hand, { aim: (b) => (b.s > pile.s - 30 ? pile.u : null), until: (b) => b.s > pile.s + 1, onTick: async (b) => { if (pile.s - b.s < 3 && pile.s - b.s > 0) vBefore = b.vs; } });
    }
    // 1つ目のきのこ: まん中
    let maxH = 0;
    await drive(page, c, hand, { aim: (b) => (b.s > Ms[0].s0 - 5 && b.s < Ms[0].gap1! ? 0 : null), until: (b) => b.s > Ms[0].gap1! + 6, onTick: async (b) => { if (b.s > Ms[0].mushS!) maxH = Math.max(maxH, b.h); } });
    const ev = await events(page);
    const st = await gt<{ falls: number; bounces: number; boosts: number }>(page, 'stats');
    console.log(`  きのこ: はねた ${st.bounces}回・いちばん高く ${maxH.toFixed(1)}m・落ちた ${st.falls}`);
    expect(ev.some((e) => e.type === 'bounce' && Math.abs(e.s - Ms[0].mushS!) < 2), 'きのこに のっても はねません').toBeTruthy();
    expect(maxH, 'きのこで 大ジャンプしません').toBeGreaterThan(3);
    expect(st.falls, 'きのこで はねても 谷をこえられません').toBe(0);
    if (vBefore) {
      const boost = ev.find((e) => e.type === 'boost');
      console.log(`  落ち葉の山: boost ${!!boost}・その前の速さ ${vBefore.toFixed(1)}`);
      expect(boost, '落ち葉の山に つっこんでも 何も起きません').toBeTruthy();
    }
    // 2つ目のきのこ: わざと 横を通る
    const M2 = Ms[1];
    await drive(page, c, hand, { aim: (b) => (b.s > M2.s0 + 2 ? 2.4 : null), noJump: true, until: (b) => b.fall || b.s > M2.gap1! + 4, maxMs: 60_000 });
    const b2 = await gt<Ball>(page, 'ball');
    console.log(`  きのこを はずした: fall ${b2.fall}・s ${b2.s.toFixed(0)}(谷 ${M2.gap0!.toFixed(0)}〜${M2.gap1!.toFixed(0)})`);
    expect(b2.fall, 'きのこを はずしても 谷に落ちません').toBeTruthy();
    expect(b2.s).toBeGreaterThan(M2.gap0! - 1);
    await hand.release();
  });

  test('はじめの坂: ゴールして池に とびこみ、なかまも 1ぴきずつ とびこむ。記録が残り、つぎの坂がひらく', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', '長いので desktop で確かめる');
    test.setTimeout(4 * 60_000);
    await open(page);
    await expect(page.locator('.post[data-n="2"]'), 'まだ遊んでいない 2つ目の坂が選べます').toBeDisabled();
    await expect(page.locator('.post[data-n="6"]'), 'きょうの坂が はじめから選べます').toBeDisabled();
    const c = await start(page, 1);
    const hand = keyHand(page);
    let sawGoal = false;
    await drive(page, c, hand, { err: 0.3 });
    await expect.poll(() => gt<string>(page, 'state')).not.toBe('play');
    sawGoal = (await gt<string>(page, 'state')) === 'goal';
    await expect.poll(() => gt<number>(page, 'splashes'), { timeout: 10_000, message: '池に とびこみません' }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 30_000 }).toBe('result');
    const r = (await gt<Result>(page, 'result'))!;
    const ev = await events(page);
    const plops = ev.filter((e) => e.type === 'plop').length;
    console.log(`  はじめの坂(矢印キー): ${r.t.toFixed(1)}秒・${r.medal}・なかま ${r.n}/${r.total}・落ちた ${r.falls}・いが ${r.hits}・池にとびこんだ なかま ${plops}`);
    expect(sawGoal, 'ゴールの場面がありません').toBeTruthy();
    expect(r.n, 'なかまを 1こも つれてこられません').toBeGreaterThan(0);
    expect(plops, 'なかまが 池に とびこみません').toBe(r.n);
    expect(r.t).toBeGreaterThan(20);
    await expect(page.locator('#r-time')).toHaveText(new RegExp(`^${Math.floor(r.t / 60)}:`));
    await expect(page.locator('#b-next'), 'はじめてゴールしたのに「つぎの坂へ」が出ません').toBeVisible();
    await expect(page.locator('#r-note')).toContainText('ひらいた');
    // 再読み込みしても 記録が残る
    await page.reload();
    await expect.poll(() => gt<string>(page, 'state')).toBe('title');
    const prog = await gt<{ best: Record<string, { t: number; n: number; medal: string }>; unlocked: boolean[] }>(page, 'progress');
    expect(prog.best.c1?.t, '記録が保存されていません').toBeCloseTo(r.t, 1);
    expect(prog.unlocked[1], '2つ目の坂が ひらきません').toBeTruthy();
    await expect(page.locator('.post[data-n="1"] .st')).toContainText(':');
    await expect(page.locator('.post[data-n="2"]')).toBeEnabled();
    // もういちど(Rキー)と、つぎの坂へ
    await page.locator('.post[data-n="1"]').click();
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 10_000 }).toBe('play');
    expect(await gt<number>(page, 'friends'), 'やりなおしても なかまが 残っています').toBe(0);
  });

  test('ひとやすみ: 止めている間は 時間も どんぐりも 止まり、つづけると 続きから', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で確かめる');
    test.setTimeout(60_000);
    await open(page);
    await start(page, 1);
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await expect.poll(() => gt<string>(page, 'state')).toBe('pause');
    const a = await gt<Ball>(page, 'ball'), ta = await gt<number>(page, 'time');
    await page.waitForTimeout(1500);
    const b = await gt<Ball>(page, 'ball');
    expect(b.s, '止めているのに 進んでいます').toBeCloseTo(a.s, 3);
    expect(await gt<number>(page, 'time')).toBeCloseTo(ta, 3);
    await page.locator('#b-resume').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    await page.waitForTimeout(600);
    expect((await gt<Ball>(page, 'ball')).s, 'つづけても 進みません').toBeGreaterThan(a.s + 3);
    await page.locator('#b-pause').click();
    await page.locator('#b-quit').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('title');
  });

  // 人くらいの手(ねらいが ±0.7m ずれる・見てから 120ms おくれる)で、すべての坂を 最後まで くだれるか
  for (const [from, to] of [[1, 3], [4, 6]]) {
    test(`むずかしさ: ${from}〜${to}番目の坂を 音ありで くだりきれる`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'desktop で測る');
      test.setTimeout(9 * 60_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const log: string[] = [];
      await open(page, 4, true);
      for (let n = from; n <= to; n++) {
        const c = await start(page, n);
        const { r, secs } = await playToEnd(page, c, keyHand(page), { err: 0.7, lag: 120, maxMs: 240_000 });
        log.push(`${c.info.name}: ${r.t.toFixed(1)}秒(金${c.info.gold}・銀${c.info.silver})${r.medal} なかま${r.n}/${r.total} 落ちた${r.falls} いが${r.hits}`);
        expect(r.t, `${c.info.name}: 人くらいの手で 時間がかかりすぎます`).toBeLessThan(c.info.sim.t * 2.2);
        expect(errors, `${c.info.name}: 遊んでいる間に エラーが出ました`).toEqual([]);
        if (n === 1) expect(r.falls, 'はじめの坂で 落ちます').toBe(0);
        await page.locator('#b-menu').click();
        await expect.poll(() => gt<string>(page, 'state')).toBe('title');
        void secs;
      }
      console.log(`  ${log.join('\n  ')}`);
    });
  }

  test('スマホ: 画面に収まり、指で押せる大きさで、指で はじめの坂を くだりきれる', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    test.setTimeout(4 * 60_000);
    await open(page, 5);
    const vp = page.viewportSize()!;
    const inside = (b: { x: number; y: number; width: number; height: number } | null) =>
      !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= vp.width + 0.5 && b.y + b.height <= vp.height + 0.5;
    for (let n = 1; n <= 6; n++) {
      const b = await page.locator(`.post[data-n="${n}"]`).boundingBox();
      expect(inside(b), `坂の看板 ${n} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(b!.width, b!.height), `坂の看板 ${n} が小さすぎます`).toBeGreaterThanOrEqual(44);
    }
    for (const id of ['#snd', '#b-how']) {
      const b = await page.locator(id).boundingBox();
      expect(inside(b) && Math.min(b!.width, b!.height) >= 44, `${id} が押しにくいです`).toBeTruthy();
    }
    await page.locator('.post[data-n="1"]').tap();
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 10_000 }).toBe('play');
    for (const id of ['#b-pause', '#b-jump', '#h-time', '#h-fr']) {
      const b = await page.locator(id).boundingBox();
      expect(inside(b), `${id} が画面からはみ出しています`).toBeTruthy();
      if (id.startsWith('#b')) expect(Math.min(b!.width, b!.height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    }
    // どんぐりが 指(ジャンプボタン)に かくれない
    const bs = await gt<{ x: number; y: number }>(page, 'ballScreen');
    const jb = (await page.locator('#b-jump').boundingBox())!;
    expect(bs.y < jb.y - 20 || bs.x < jb.x - 20, 'どんぐりが ジャンプボタンに かくれます').toBeTruthy();
    expect(bs.y, 'どんぐりが 画面の下すぎます').toBeLessThan(vp.height * 0.85);
    // かるく タップで ジャンプ
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vp.width / 2, y: vp.height * 0.6 }] } as any);
    await page.waitForTimeout(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any);
    await expect.poll(async () => (await events(page)).filter((e) => e.type === 'jump').length, { message: 'タップで ジャンプしません' }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(900);
    await page.locator('#b-jump').tap();
    await expect.poll(async () => (await events(page)).filter((e) => e.type === 'jump').length, { message: 'ジャンプボタンで ジャンプしません' }).toBeGreaterThanOrEqual(2);
    // 指で 最後まで
    const c = await ctxOf(page);
    const { r } = await playToEnd(page, c, await touchHand(page, cdp), { err: 0.3, lag: 40 });
    console.log(`  スマホで はじめの坂: ${r.t.toFixed(1)}秒・${r.medal}・なかま ${r.n}/${r.total}・落ちた ${r.falls}`);
    await page.waitForTimeout(900);
    for (const id of ['#b-next', '#b-retry', '#b-menu']) {
      const bb = await page.locator(id).boundingBox();
      expect(inside(bb), `${id} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(bb!.width, bb!.height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    }
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(4 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    await open(page, 4);
    await page.waitForTimeout(1200);
    await shot('1-title');
    await page.locator('#b-how').click();
    await page.waitForTimeout(300);
    await shot('2-how');
    await page.locator('#b-how-x').click();
    let c = await start(page, 1);
    await page.waitForTimeout(800);
    await shot('3-start');
    let hand = await deviceHand(page);
    // 落ち葉の山に つっこんだ瞬間
    const pile = c.items.piles[0];
    await drive(page, c, hand, { aim: (b) => (b.s > pile.s - 30 ? pile.u : null), until: (b) => b.s > pile.s + 2 });
    await page.waitForTimeout(150);
    await shot('4-boost');
    await drive(page, c, hand, { until: (b) => b.s > c.info.goal - 2 });
    await page.waitForTimeout(1500);
    await shot('5-splash');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 30_000 }).toBe('result');
    await page.waitForTimeout(900);
    await shot('6-result');
    await hand.release();
    // きのこで とぶ
    await page.locator('#b-menu').click();
    c = await start(page, 4);
    hand = await deviceHand(page);
    const M = c.info.pieces.find((p) => p.t === 'M')!;
    await drive(page, c, hand, { until: (b) => b.s > M.mushS! + 5 });
    await shot('7-mushroom');
    await drive(page, c, hand, { until: (b) => b.s > 300 });
    await shot('8-dusk');
    await hand.release();
    // 夜の坂
    await page.keyboard.press('Escape');
    await page.locator('#b-quit').click();
    c = await start(page, 5);
    hand = await deviceHand(page);
    await drive(page, c, hand, { until: (b) => b.s > 140 });
    await shot('9-night');
    await hand.release();
    if (info.project.name !== 'mobile') return;
    for (const [w, h, name] of [[844, 390, 'a-landscape'], [360, 640, 'b-small']] as const) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, 4);
      await shot(`${name}-title`);
      c = await start(page, 2);
      await page.waitForTimeout(3000);
      await shot(`${name}-play`);
    }
  });

  test('スマホで重くない(CPU 4倍遅くても、落ち葉が舞う夕ぐれの坂で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(2 * 60_000);
    await open(page, 4);
    const c = await start(page, 4);
    const cdp = await page.context().newCDPSession(page);
    const hand = await touchHand(page, cdp);
    // 落ち葉の山に つっこんで、つぶが いちばん多い場面にする
    const pile = c.items.piles.find((p) => p.s > 20)!;
    await drive(page, c, hand, { aim: (b) => (b.s > pile.s - 30 ? pile.u : null), until: (b) => b.s > pile.s + 1 });
    const parts = await gt<number>(page, 'particles');
    // 測っているあいだは gameTest を読まない。指を左右に ゆらしつづける
    const busy = (async () => {
      const end = Date.now() + 3300;
      let k = 0;
      while (Date.now() < end) { await hand.steer(Math.sin(k++ * 0.7) * 0.6); await page.waitForTimeout(90); }
    })();
    const [perf] = await Promise.all([measureFps(page, 3000), busy]);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・つぶ ${parts}・画質の段階 ${await gt<number>(page, 'quality')}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
    await hand.release();
  });

  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(3 * 60_000);
    // 夕ぐれの きのこの坂。なかまを つれて、きのこで 谷を とびこえる瞬間から始める
    await recordPlayVideo(browser, {
      dir: target!.dir,
      setup: async (page) => {
        await open(page, 3, true); // 動画には音を入れるので、音はオンで始める
      },
      play: async (page, clip: Clip) => {
        const c = await start(page, 4);
        const hand = keyHand(page);
        const M = c.info.pieces.filter((p) => p.t === 'M');
        let marked = false, markAt = 0, shot = false;
        await drive(page, c, hand, {
          aim: (b) => (M.some((m) => b.s > m.s0 - 5 && b.s < m.gap1!) ? 0 : null),
          onTick: async (b) => {
            if (!marked && b.air && b.h > 0.8 && M.some((m) => b.s > m.mushS! && b.s < m.gap1!) && (await gt<number>(page, 'friends')) >= 3) {
              marked = true;
              markAt = Date.now();
              clip.mark();
            }
            // 投稿画像(動画が使えないとき用): なかまを つれて 谷の上を とんでいる瞬間
            if (marked && !shot && Date.now() - markAt > 350) {
              shot = true;
              await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
              console.log('  見せ場のスクショを撮りました(きのこで 谷を とびこえる瞬間)');
            }
          },
          until: () => Date.now() > clip.until,
        });
        console.log(`  動画: なかま ${await gt<number>(page, 'friends')}・mark ${marked}`);
        await hand.release();
      },
    });
  });
});
