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
//  対象: まるい星のおとどけ便(2026-10-05)
//  小さな丸い星を歩きまわり、ポストで荷物を頭に積んで、同じ色の家へ届ける。
//  1回の配達で届けるほど ♥ が増える(+1, +2, +3…)が、積むほど ゆれて落としやすい。
//  ゲーム側の window.gameTest(読み取り専用)から、ボクの位置や家の場所を読む。
//  操作はすべて本物の入力で行う(キー / マウスのドラッグ / 指)。
// ============================================================================

const EXPECTED = '2026-10-05-hoshi-otodoke';
const target = latestGame();
const SKEY = 'marui-hoshi-v1';

type V3 = [number, number, number];
type Box = { to: number; express: boolean; left: number };
type Player = { p: V3; v: V3; speed: number; face: V3; stack: Box[]; cap: number; sway: number; lim: number; combo: number; stun: number };
type House = { id: number; name: string; em: string; active: boolean; ready: boolean; p: V3; door: V3 };
type Obst = { p: V3; r: number; k: string };
type Ev = { type: string; t: number; to?: number; k?: number; gain?: number; why?: string; d?: number; effect?: string; id?: number; cap?: number; onTime?: boolean; express?: boolean };
type Stats = { hearts: number; delivered: number; best: number; drops: number; frags: number; time: number; playTime: number; finale: boolean };

const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const isMobile = (page: Page) => page.viewportSize()!.width < 500;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const tang = (p: V3, v: V3) => sub(v, sc(p, dot(p, v)));
const R = 13;
const sdist = (a: V3, b: V3) => R * Math.acos(clamp(dot(a, b), -1, 1));

// ---------------------------------------------------------------------------
//  ゲームの開き方(保存データを書いてから読み直す)
// ---------------------------------------------------------------------------
async function open(page: Page, hearts = 0, sound = false, extra: Record<string, unknown> = {}) {
  await page.goto(url());
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), [SKEY, { hearts, sound, played: hearts > 0, finale: hearts >= 300, ...extra }] as const);
  await page.reload();
  await expect.poll(() => gt<string>(page, 'state')).toBe('title');
}
async function start(page: Page) {
  await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
  await page.waitForTimeout(1500); // カメラが ボクに寄るまで
}

// ---------------------------------------------------------------------------
//  手: キー / マウス / 指。go(x, y) で「画面の右 x・上 y」(-1〜1)へ歩く
// ---------------------------------------------------------------------------
type Hand = { name: string; analog: boolean; go: (x: number, y: number) => Promise<void>; release: () => Promise<void> };
function keyHand(page: Page, wasd = false): Hand {
  const K = wasd ? { u: 'w', d: 's', l: 'a', r: 'd' } : { u: 'ArrowUp', d: 'ArrowDown', l: 'ArrowLeft', r: 'ArrowRight' };
  const held = new Set<string>();
  const h: Hand = {
    name: wasd ? 'WASD' : '矢印キー',
    analog: false,
    async go(x, y) {
      const want = new Set<string>();
      const l = Math.hypot(x, y);
      if (l > 0.2) {
        const a = Math.atan2(y, x); // 8方向に まるめる
        const s = Math.round(a / (Math.PI / 4));
        const ax = Math.round(Math.cos(s * Math.PI / 4)), ay = Math.round(Math.sin(s * Math.PI / 4));
        if (ax > 0) want.add(K.r); if (ax < 0) want.add(K.l); if (ay > 0) want.add(K.u); if (ay < 0) want.add(K.d);
      }
      for (const k of [...held]) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
      for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
    },
    async release() { await h.go(0, 0); },
  };
  return h;
}
const JR = 56;
async function mouseHand(page: Page, at = [0.5, 0.62]): Promise<Hand> {
  const vp = page.viewportSize()!;
  const cx = vp.width * at[0], cy = vp.height * at[1];
  let down = false;
  return {
    name: 'マウスのドラッグ',
    analog: true,
    async go(x, y) {
      if (!down) { await page.mouse.move(cx, cy); await page.mouse.down(); down = true; }
      await page.mouse.move(cx + clamp(x, -1, 1) * JR * 0.95, cy - clamp(y, -1, 1) * JR * 0.95);
    },
    async release() { if (down) { await page.mouse.move(cx, cy); await page.mouse.up(); down = false; } },
  };
}
async function touchHand(page: Page, cdp?: CDPSession): Promise<Hand> {
  const c = cdp ?? (await page.context().newCDPSession(page));
  const vp = page.viewportSize()!;
  const cx = vp.width * 0.5, cy = vp.height * 0.6;
  let down = false, lx = cx, ly = cy;
  return {
    name: '指',
    analog: true,
    async go(x, y) {
      const nx = cx + clamp(x, -1, 1) * JR * 0.95, ny = cy - clamp(y, -1, 1) * JR * 0.95;
      if (!down) { await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] } as any); down = true; }
      if (Math.abs(nx - lx) < 0.5 && Math.abs(ny - ly) < 0.5) return;
      lx = nx; ly = ny;
      await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: nx, y: ny, id: 1 }] } as any);
    },
    async release() { if (down) { await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any); down = false; lx = cx; ly = cy; } },
  };
}
const deviceHand = (page: Page) => (isMobile(page) ? touchHand(page) : mouseHand(page));

// ---------------------------------------------------------------------------
//  自動プレイヤー: 目的地の方へ、木や家をよけながら歩く。
//  smooth: 人がそっと親指を動かすように、入力を少しずつ変える(急に向きを変えない)
// ---------------------------------------------------------------------------
type Snap = { st: string; pl: Player; fr: { f: V3; r: V3 }; mets: { p: V3; t: number; T: number }[]; last: Ev | null };
async function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => { const g = (window as any).gameTest; const ev = g.events(); return { st: g.state(), pl: g.player(), fr: g.frame(), mets: g.meteors(), last: ev[ev.length - 1] || null }; });
}
function steerTo(s: Snap, obst: Obst[], goal: V3, avoidMeteors = true) {
  const p = s.pl.p;
  let d = norm(tang(p, sub(goal, p)));
  const dist = sdist(p, goal);
  for (const o of obst) {
    const od = sdist(p, o.p);
    if (od > o.r + 2.6 || od < 1e-3) continue;
    if (sdist(o.p, goal) < o.r + 0.1) continue; // 目的地そのもの(ポストなど)は よけない
    if (dist < od - 0.5) continue; // 目的地のほうが近い
    const to = norm(tang(p, sub(o.p, p)));
    const ahead = dot(to, d);
    if (ahead < 0.1) continue;
    // よこへ よける(目的地に近い側へ)
    let side = norm(sub(d, sc(to, ahead)));
    if (len(sub(d, sc(to, ahead))) < 0.05) side = norm([to[1] * p[2] - to[2] * p[1], to[2] * p[0] - to[0] * p[2], to[0] * p[1] - to[1] * p[0]]);
    const w = clamp((o.r + 2.6 - od) / 2.2, 0, 1.4) * ahead;
    d = norm(add(d, sc(side, w * 1.8)));
  }
  if (avoidMeteors) for (const m of s.mets) {
    const md = sdist(p, m.p);
    if (md < 3.4 && m.t < m.T) d = norm(add(d, sc(norm(tang(p, sub(p, m.p))), (3.4 - md) * 1.2)));
  }
  return { x: dot(d, s.fr.r), y: dot(d, s.fr.f), dist };
}
type DriveOpt = { smooth?: boolean; arrive?: number; maxMs?: number; until?: (s: Snap) => boolean; lag?: number; slowNear?: boolean; keep?: { ix: number; iy: number } };
async function walkTo(page: Page, hand: Hand, obst: Obst[], goal: V3 | (() => V3), opt: DriveOpt = {}) {
  const t0 = Date.now();
  let ix = opt.keep ? opt.keep.ix : 0, iy = opt.keep ? opt.keep.iy : 0;
  let s = await snap(page);
  while (true) {
    s = await snap(page);
    if (s.st !== 'play') break;
    const g = typeof goal === 'function' ? goal() : goal;
    const st = steerTo(s, obst, g);
    if (st.dist < (opt.arrive ?? 1.0)) break;
    if (opt.until && opt.until(s)) break;
    if (Date.now() - t0 > (opt.maxMs ?? 30_000)) break;
    let m = 1;
    if (opt.slowNear !== false && hand.analog) m = clamp(st.dist / 3, 0.45, 1);
    let tx = st.x * m, ty = st.y * m;
    if (opt.smooth) {
      // 親指を そっと動かす: 1回に 0.12 ずつ近づける。積んでいる数が多いほど ゆっくり
      const n = s.pl.stack.length;
      const lim = clamp(0.95 - n * 0.06, 0.55, 0.95);
      const l = Math.hypot(tx, ty); if (l > lim) { tx *= lim / l; ty *= lim / l; }
      const step = 0.06;
      ix += clamp(tx - ix, -step, step); iy += clamp(ty - iy, -step, step);
    } else { ix = tx; iy = ty; }
    await hand.go(ix, iy);
    await page.waitForTimeout(opt.lag ?? 40);
  }
  if (opt.keep) { opt.keep.ix = ix; opt.keep.iy = iy; return s; } // 止まらずに次へ
  if (opt.smooth) {
    // そっと止まる
    for (let k = 0; k < 5 && (Math.abs(ix) > 0.05 || Math.abs(iy) > 0.05); k++) { ix *= 0.55; iy *= 0.55; await hand.go(ix, iy); await page.waitForTimeout(50); }
  }
  await hand.go(0, 0);
  return s;
}
async function stopSoft(page: Page, hand: Hand) {
  // そっと止まる(入力を少しずつ 0 に)
  const s = await snap(page);
  let ix = 0, iy = 0;
  if (s.pl.speed > 0.1) { ix = dot(norm(s.pl.v), s.fr.r) * 0.6; iy = dot(norm(s.pl.v), s.fr.f) * 0.6; }
  for (let k = 0; k < 6; k++) { ix *= 0.6; iy *= 0.6; await hand.go(ix, iy); await page.waitForTimeout(50); }
  await hand.go(0, 0);
}
const events = (page: Page) => gt<Ev[]>(page, 'events');
const houses = (page: Page) => gt<House[]>(page, 'houses');
const player = (page: Page) => gt<Player>(page, 'player');
const POST: V3 = [0, 1, 0];
// 星の上の場所(北極からの角度 th・まわりの角度 ph)。ゲームの dirTP と同じ
const dirOf = (th: number, ph: number): V3 => { const t = th * Math.PI / 180, p = ph * Math.PI / 180; return [Math.sin(t) * Math.sin(p), Math.cos(t), Math.sin(t) * Math.cos(p)]; };

// ひと仕事: ポストで積めるだけ積んで、近い家から順に届けて、ポストへもどる
async function oneTrip(page: Page, hand: Hand, opt: DriveOpt = {}) {
  const obst = await gt<Obst[]>(page, 'obstacles');
  await walkTo(page, hand, obst, POST, { ...opt, arrive: 2.2, maxMs: 40_000 });
  // 積みおわるまで待つ
  await expect.poll(async () => { const p = await player(page); const q = (await gt<{ queue: unknown[] }>(page, 'post')).queue.length; return p.stack.length >= p.cap || q === 0; }, { timeout: 8000 }).toBeTruthy();
  for (let guard = 0; guard < 14; guard++) {
    const pl = await player(page);
    const lo = await gt<{ p: V3; h: number }[]>(page, 'loose');
    if (!pl.stack.length && !lo.length) break;
    const hs = (await houses(page)).filter((h) => h.ready);
    // 落とした荷物が近ければ拾う
    const near = lo.filter((b) => sdist(pl.p, b.p) < 9).sort((a, b) => sdist(pl.p, a.p) - sdist(pl.p, b.p))[0];
    if (near && pl.stack.length < pl.cap) { await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), near.p, { ...opt, arrive: 0.6, maxMs: 15_000 }); continue; }
    const want = hs.filter((h) => pl.stack.some((b) => b.to === h.id));
    if (!want.length) break;
    const next = want.sort((a, b) => sdist(pl.p, a.door) - sdist(pl.p, b.door))[0];
    const before = pl.stack.length;
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), next.door, { ...opt, arrive: 0.8, maxMs: 30_000, until: (s) => s.pl.stack.length < before && !s.pl.stack.some((b) => b.to === next.id) });
  }
}

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(target!.name, 'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください').toBe(EXPECTED);
  });

  test('テスト用の窓口 window.gameTest があり、3D(WebGL)で描いている', async ({ page }) => {
    await page.goto(url());
    const ok = await page.evaluate(() => {
      const g = (window as any).gameTest;
      return !!g && ['state', 'score', 'hearts', 'webgl', 'player', 'frame', 'houses', 'post', 'loose', 'meteors', 'frags', 'obstacles', 'events', 'stats', 'cap', 'miles',
        'screen', 'playerScreen', 'quality', 'particles', 'sound'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
    expect(await gt<boolean>(page, 'webgl'), 'WebGL が使えていません').toBeTruthy();
    await page.waitForTimeout(800);
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '3Dの画面に何も描かれていないようです').toBeGreaterThan(20_000);
  });

  // 核の遊び(1): おした向きへ歩く。画面の上 = 前、右 = 右(キー・マウス・指 どれでも)
  test('歩く: おした向きへ歩き、Q E(⟲⟳)で見る向きが回る', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page);
    await start(page);
    const makers: (() => Promise<Hand>)[] = isMobile(page) ? [() => touchHand(page)] : [async () => keyHand(page), async () => keyHand(page, true), () => mouseHand(page)];
    for (const make of makers) {
      const hand = await make();
      for (const [dx, dy, name] of [[0, -1, '下'], [-1, 0, '左'], [0, 1, '上'], [1, 0, '右']] as const) {
        const a = await snap(page);
        await hand.go(dx, dy);
        await page.waitForTimeout(350); // 人が ちょっと おすくらい
        const b = await snap(page);
        await hand.go(0, 0);
        const v = b.pl.v;
        const along = dot(v, a.fr.r) * dx + dot(v, a.fr.f) * dy;
        const across = Math.abs(dot(v, a.fr.r) * dy - dot(v, a.fr.f) * dx);
        console.log(`  ${hand.name} ${name}: おした向きの速さ ${along.toFixed(2)}・よこ ${across.toFixed(2)}`);
        expect(along, `${hand.name}で ${name}へ歩きません`).toBeGreaterThan(2.5);
        expect(across, `${hand.name}で ${name}を おしたのに ななめに進みます`).toBeLessThan(0.8);
        await page.waitForTimeout(700);
      }
      await hand.release();
    }
    // 見る向きを回す
    const f0 = (await snap(page)).fr;
    if (isMobile(page)) {
      const b = (await page.locator('#b-rr').boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 3 }] } as any);
      await page.waitForTimeout(500);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any);
    } else {
      await page.keyboard.down('e'); await page.waitForTimeout(500); await page.keyboard.up('e');
    }
    const f1 = (await snap(page)).fr;
    const turned = Math.acos(clamp(dot(f0.f, f1.f), -1, 1));
    console.log(`  見る向き: ${(turned * 180 / Math.PI).toFixed(0)}度 回った(右回り ${dot(f1.f, f0.r).toFixed(2)})`);
    expect(turned, '見る向きが回りません').toBeGreaterThan(0.5);
    expect(dot(f1.f, f0.r), '右回りのボタンで 左に回りました').toBeGreaterThan(0);
  });

  // 核の遊び(2): ポストで積み、同じ色の家に近づくと届く。1回で届けるほど ♥ が増える
  test('配達: ポストで積み、同じ色の家に近づくと届く。はなれていると届かず、ちがう家にも届かない。2こ目+2・3こ目+3', async ({ page }) => {
    test.setTimeout(150_000);
    await open(page);
    await start(page);
    const hand = await deviceHand(page);
    const obst = await gt<Obst[]>(page, 'obstacles');
    const q0 = (await gt<{ queue: Box[] }>(page, 'post')).queue.map((q) => q.to);
    await walkTo(page, hand, obst, POST, { arrive: 2.2 });
    await expect.poll(async () => (await player(page)).stack.length, { message: 'ポストで荷物が積めません' }).toBe(3);
    const pl = await player(page);
    console.log(`  積んだ荷物: ${pl.stack.map((b) => b.to).join(',')}(ポストの列 ${q0.slice(0, 3).join(',')})`);
    expect(pl.stack.map((b) => b.to), 'ポストに並んでいた順に積まれていません').toEqual(q0.slice(0, 3));
    expect((await events(page)).filter((e) => e.type === 'pickup').length).toBe(3);
    const hs = (await houses(page)).filter((h) => h.ready);
    expect(hs.map((h) => h.id), 'はじめに住んでいるのは3けん').toEqual([0, 1, 2]);
    let hearts = 0;
    // ちがう家(積んでいない家)には届かない
    const other = hs.find((h) => !pl.stack.some((b) => b.to === h.id));
    if (other) {
      await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), other.door, { arrive: 0.7 });
      await page.waitForTimeout(700);
      const p2 = await player(page);
      console.log(`  ちがう家(${other.name})の前: 荷物 ${p2.stack.length}こ・♥${await gt<number>(page, 'hearts')}`);
      expect(p2.stack.length, '積んでいない家に 荷物が届きました').toBe(3);
      expect(await gt<number>(page, 'hearts')).toBe(0);
    }
    // 届け先の家: まず 5m 手前で止まる → 届かない。近づくと届く
    let k = 0;
    while ((await player(page)).stack.length) {
      const cur = await player(page);
      const h = hs.filter((x) => cur.stack.some((b) => b.to === x.id)).sort((a, b) => sdist(cur.p, a.door) - sdist(cur.p, b.door))[0];
      const n = cur.stack.filter((b) => b.to === h.id).length;
      await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), h.door, { arrive: 5.5 });
      await stopSoft(page, hand);
      await page.waitForTimeout(500);
      const far = await player(page);
      const dFar = sdist(far.p, h.door);
      expect(far.stack.length, `${h.name}さんの家から ${dFar.toFixed(1)}m はなれているのに届きました`).toBe(cur.stack.length);
      await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), h.door, { arrive: 0.8 });
      await expect.poll(async () => (await player(page)).stack.filter((b) => b.to === h.id).length, { message: `${h.name}さんの家に近づいても届きません` }).toBe(0);
      await page.waitForTimeout(700);
      const ev = (await events(page)).filter((e) => e.type === 'deliver');
      const mine = ev.slice(-n);
      for (const e of mine) { k++; hearts += k; expect(e.to, '届いた家が ちがいます').toBe(h.id); expect(e.k, 'れんぞくの数が ちがいます').toBe(k); expect(e.gain).toBe(k); }
      console.log(`  ${h.name}さん: ${n}こ届いた(${dFar.toFixed(1)}m はなれていた間は届かない)・♥${await gt<number>(page, 'hearts')}`);
    }
    expect(await gt<number>(page, 'hearts'), '♥が 1+2+3 になっていません').toBe(hearts);
    expect(hearts).toBe(6);
    await expect(page.locator('#m-h')).toHaveText('6');
    await hand.release();
  });

  // 核の遊び(3): 積むほど ゆれる。急な切りかえしで落ち、そっと歩けば落とさない
  test('グラグラ: 3こなら左右に切りかえしても平気。8こだと落ちる。そっと歩けば8こでも落とさず、落とした荷物は拾える', async ({ page }) => {
    test.setTimeout(180_000);
    const keys = isMobile(page) ? () => touchHand(page) : async () => keyHand(page);
    const zigzag = async (_old: Hand, ms: number) => {
      const hand = await keys(); // 指は いちど はなしているかもしれないので、新しく置きなおす
      // ぶつからないよう、左右(または上下)の ひらけたほうの向きで切りかえす
      const s = await snap(page);
      const obst = await gt<Obst[]>(page, 'obstacles');
      const clear = (d: V3) => { let m = 99; for (let t = 0; t <= 3.5; t += 0.25) { const q = norm(add(s.pl.p, sc(d, t / R))); for (const o of obst) m = Math.min(m, sdist(q, o.p) - o.r); } return m; };
      const lr = Math.min(clear(s.fr.r), clear(sc(s.fr.r, -1))), ud = Math.min(clear(s.fr.f), clear(sc(s.fr.f, -1)));
      const ax = lr >= ud ? [1, 0] : [0, 1];
      const t0 = Date.now(); let dir = 1;
      const before = (await events(page)).filter((e) => e.type === 'drop' && e.why === 'sway').length;
      let vmax = 0;
      while (Date.now() - t0 < ms) {
        await hand.go(dir * ax[0], dir * ax[1]); dir = -dir;
        await page.waitForTimeout(750);
        vmax = Math.max(vmax, (await player(page)).speed);
        if ((await events(page)).filter((e) => e.type === 'drop' && e.why === 'sway').length > before) break;
      }
      await hand.release();
      // 本当に走って切りかえしたか(動いていなければ、このテストは何も確かめていない)
      expect(vmax, '切りかえしの間に ボクが走っていません(テストの操作が効いていない)').toBeGreaterThan(3.5);
      return (await events(page)).filter((e) => e.type === 'drop' && e.why === 'sway').length - before;
    };
    // 3こ(流れ星は まだ ふらない)
    await open(page, 10);
    await start(page);
    let hand = await keys();
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2 });
    await expect.poll(async () => (await player(page)).stack.length).toBe(3);
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), [0, 0, 1], { maxMs: 1200 });
    const d3 = await zigzag(hand, 6000);
    console.log(`  3こで 左右に切りかえし 6秒: 落とした ${d3}`);
    expect(d3, '3こしか積んでいないのに 落ちます').toBe(0);
    await hand.release();
    // 8こ: 左右の切りかえしで落ちる
    await open(page, 262);
    await start(page);
    hand = await keys();
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2, smooth: true });
    await expect.poll(async () => (await player(page)).stack.length, { timeout: 15_000 }).toBe(8);
    // キーでも、歩きだす・止まる・直角に曲がる だけなら落とさない(ひらけた方向を えらぶ)
    {
      const s = await snap(page);
      const obst = await gt<Obst[]>(page, 'obstacles');
      const dirs = Array.from({ length: 8 }, (_, i) => [Math.round(Math.cos(i * Math.PI / 4)), Math.round(Math.sin(i * Math.PI / 4))] as const);
      const world = (p: V3, x: number, y: number) => norm(tang(p, add(sc(s.fr.r, x), sc(s.fr.f, y))));
      const clear = (p: V3, d: V3, L: number) => { let m = 99; for (let t = 0; t <= L; t += 0.25) { const q = norm(add(p, sc(d, t / R))); for (const o of obst) m = Math.min(m, sdist(q, o.p) - o.r); } return m; };
      let best = { c: -1, a: dirs[0], b: dirs[2] };
      for (let i = 0; i < 8; i++) for (const j of [i + 2, i + 6]) {
        const a = dirs[i], b = dirs[j % 8];
        const da = world(s.pl.p, a[0], a[1]);
        const mid = norm(add(s.pl.p, sc(da, 2.6 / R)));
        const c = Math.min(clear(s.pl.p, da, 2.8), clear(mid, world(mid, b[0], b[1]), 2.8));
        if (c > best.c) best = { c, a, b };
      }
      const k0 = (await events(page)).length;
      await hand.go(best.a[0], best.a[1]); await page.waitForTimeout(900);
      await hand.go(0, 0); await page.waitForTimeout(1300);
      await hand.go(best.b[0], best.b[1]); await page.waitForTimeout(600);
      await hand.go(best.a[0], best.a[1]); await page.waitForTimeout(700);
      await hand.go(0, 0); await page.waitForTimeout(1300);
      const ev = (await events(page)).slice(k0);
      const sw = ev.filter((e) => e.type === 'drop' && e.why === 'sway');
      const imp = ev.filter((e) => e.type === 'impact' && (e.d ?? 99) < 5);
      console.log(`  8こで キー: 歩きだす・止まる・直角に曲がる → ゆれで落とした ${sw.length}(ぶつかった ${ev.filter((e) => e.type === 'bump').length}・近くの流れ星 ${imp.length}・ひらけた幅 ${best.c.toFixed(1)}m)`);
      if (!imp.length) expect(sw.length, 'キーで ふつうに歩くだけで 8この荷物を落とします').toBe(0);
    }
    // 8こに積みなおして、ポストから少しはなれた ひらけた所で 左右に切りかえす
    // (流れ星に当たって 8こより減ったら、積みなおして やりなおす)
    let d8 = 0;
    for (let attempt = 0; attempt < 3 && d8 === 0; attempt++) {
      await walkTo(page, await deviceHand(page), await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2, smooth: true });
      await expect.poll(async () => (await player(page)).stack.length, { timeout: 15_000 }).toBe(8);
      const p = (await player(page)).p;
      const away = norm(add(POST, sc(norm(tang(POST, sub(p, POST))), 4.6 / R)));
      await walkTo(page, await deviceHand(page), await gt<Obst[]>(page, 'obstacles'), away, { arrive: 0.6, smooth: true, maxMs: 8000 });
      await page.waitForTimeout(800);
      if ((await player(page)).stack.length < 8) continue;
      const k0 = (await events(page)).length;
      d8 = await zigzag(hand, 8000);
      const hitBefore = (await events(page)).slice(k0).some((e) => e.type === 'impact' && e.effect === 'hit');
      if (hitBefore && d8 === 0) continue; // 流れ星で荷物が減った回は数えない
      if (d8 === 0) break;
    }
    const pAfter = await player(page);
    console.log(`  8こで 左右に切りかえし: 落とした ${d8}(のこり ${pAfter.stack.length}こ)`);
    expect(d8, '8こ積んで 左右に切りかえしても 落ちません').toBeGreaterThanOrEqual(1);
    // 落とした荷物を拾う
    await page.waitForTimeout(900);
    const lo = await gt<{ p: V3; h: number; to: number }[]>(page, 'loose');
    expect(lo.length, '落とした荷物が 星の上に ありません').toBeGreaterThanOrEqual(1);
    const reg0 = (await events(page)).filter((e) => e.type === 'regrab').length;
    const regrabs = async () => (await events(page)).filter((e) => e.type === 'regrab').length;
    for (let i = 0; i < 4 && (await regrabs()) === reg0; i++) {
      // いちばん近い 落ちた荷物へ(すべって動くので、そのつど場所を読みなおす)
      const me = (await player(page)).p;
      const near = (await gt<{ p: V3 }[]>(page, 'loose')).sort((a, b) => sdist(me, a.p) - sdist(me, b.p))[0];
      if (!near) break;
      console.log(`  落とした荷物まで ${sdist(me, near.p).toFixed(1)}m`);
      await walkTo(page, await deviceHand(page), await gt<Obst[]>(page, 'obstacles'), near.p, { arrive: 0.4, maxMs: 6000, smooth: true });
      await page.waitForTimeout(300);
    }
    await expect.poll(async () => (await events(page)).filter((e) => e.type === 'regrab').length, { message: '落とした荷物が拾えません' }).toBeGreaterThan(reg0);
    await hand.release();
    // そっと歩けば、8こでも落とさずに遠くの家まで行ける(流れ星で ゆれた分は数えない)
    await open(page, 262);
    await start(page);
    hand = await deviceHand(page);
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2, smooth: true });
    await expect.poll(async () => (await player(page)).stack.length, { timeout: 15_000 }).toBe(8);
    const hs = (await houses(page)).filter((h) => h.ready).sort((a, b) => sdist(POST, b.door) - sdist(POST, a.door));
    const t0 = Date.now();
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), hs[0].door, { smooth: true, arrive: 3.5, maxMs: 40_000 });
    const ev = await events(page);
    const sway = ev.filter((e) => e.type === 'drop' && e.why === 'sway');
    const nearImpacts = ev.filter((e) => e.type === 'impact' && (e.d ?? 99) < 5);
    const own = sway.filter((d) => !nearImpacts.some((m) => d.t - m.t >= 0 && d.t - m.t < 2.5));
    console.log(`  8こで そっと ${hs[0].name}さんの家へ(${((Date.now() - t0) / 1000).toFixed(1)}秒): ゆれで落とした ${sway.length}(流れ星のせいでないもの ${own.length})・近くに落ちた流れ星 ${nearImpacts.length}`);
    expect(own.length, 'そっと歩いても 8この荷物を落とします').toBe(0);
    await hand.release();
  });

  test('ふえる: ♥6で かえるさんが ひっこしてきて、♥15で荷台が4こになる。再読み込みしても残る', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, 4);
    expect((await houses(page))[3].active, '♥4なのに かえるさんが もう住んでいます').toBeFalsy();
    await start(page);
    const hand = await deviceHand(page);
    await oneTrip(page, hand);
    await expect.poll(async () => (await events(page)).some((e) => e.type === 'movein' && e.id === 3), { message: 'かえるさんが ひっこしてきません' }).toBeTruthy();
    await expect.poll(async () => (await houses(page))[3].ready, { timeout: 5000 }).toBeTruthy();
    await expect(page.locator('#toast')).toContainText('かえる');
    const obst = await gt<Obst[]>(page, 'obstacles');
    expect(obst.filter((o) => o.k === 'house').length, '新しい家に ぶつかれません').toBe(4);
    // 新しい家あての荷物も ポストに来る
    let saw3 = false;
    for (let i = 0; i < 4 && !saw3; i++) {
      saw3 = (await gt<{ queue: Box[] }>(page, 'post')).queue.some((q) => q.to === 3) || (await player(page)).stack.some((b) => b.to === 3);
      if (!saw3) await oneTrip(page, hand);
    }
    expect(saw3, 'かえるさんあての荷物が来ません').toBeTruthy();
    // ♥15 まで
    for (let i = 0; i < 6 && (await gt<number>(page, 'hearts')) < 15; i++) await oneTrip(page, hand);
    expect(await gt<number>(page, 'hearts')).toBeGreaterThanOrEqual(15);
    expect(await gt<number>(page, 'cap'), '♥15なのに 荷台が ひろがりません').toBe(4);
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2 });
    await expect.poll(async () => (await player(page)).stack.length, { message: '4こ積めません' }).toBe(4);
    const st = await gt<Stats>(page, 'stats');
    console.log(`  ♥${st.hearts}・届けた ${st.delivered}こ・いちばんの れんぞく ${st.best}`);
    await hand.release();
    // 再読み込み
    await page.reload();
    await expect.poll(() => gt<string>(page, 'state')).toBe('title');
    const st2 = await gt<Stats>(page, 'stats');
    expect(st2.hearts, '♥が保存されていません').toBe(st.hearts);
    expect(st2.delivered).toBe(st.delivered);
    expect((await houses(page))[3].active, 'かえるさんの家が 保存されていません').toBeTruthy();
    await expect(page.locator('#b-start')).toHaveText('つづきから配達');
    await expect(page.locator('#t-prog')).toContainText(`♥${st.hearts}`);
  });

  test('流れ星: ♥28までは ふらない。赤い輪が1.5秒以上前に出て、にげれば当たらない。止まっていると当たって荷物を落とす。かけらで+3♥', async ({ page }) => {
    test.setTimeout(240_000);
    // ♥20: ふらない
    await open(page, 20);
    await start(page);
    await page.waitForTimeout(12_000);
    expect((await events(page)).filter((e) => e.type === 'meteor').length, '♥28より前に流れ星が ふりました').toBe(0);
    // ♥120: 4こ積んで、止まって待つ → いつか当たる
    await open(page, 120);
    await start(page);
    let hand = await deviceHand(page);
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), dirOf(30, 300), { arrive: 1, smooth: true });
    await hand.release();
    const hitAt = Date.now();
    await expect.poll(async () => (await events(page)).some((e) => e.type === 'impact' && e.effect === 'hit'), { timeout: 90_000, intervals: [500], message: '止まっていても 流れ星に当たりません' }).toBeTruthy();
    const ev = await events(page);
    const hit = ev.find((e) => e.type === 'impact' && e.effect === 'hit')!;
    console.log(`  止まって待つと ${((Date.now() - hitAt) / 1000).toFixed(0)}秒で当たった`);
    // 荷物がなくても当たる。荷物があれば落とす
    void hit;
    // かけら: 落ちた場所に出る。拾うと +3
    await expect.poll(async () => (await gt<unknown[]>(page, 'frags')).length, { timeout: 30_000, message: '流れ星のかけらが ありません' }).toBeGreaterThanOrEqual(1);
    const fr = await gt<{ p: V3; life: number }[]>(page, 'frags');
    const impacts = (await events(page)).filter((e) => e.type === 'impact') as (Ev & { p: V3 })[];
    for (const f of fr) expect(impacts.some((m) => sdist(m.p, f.p) < 0.01), 'かけらが 流れ星の落ちた所に ありません').toBeTruthy();
    const hs = await houses(page);
    for (const m of impacts) {
      expect(sdist(m.p, POST), 'ポストに流れ星が落ちました').toBeGreaterThan(2.9);
      for (const h of hs.filter((x) => x.active)) expect(sdist(m.p, h.p), `${h.name}さんの家に流れ星が落ちました`).toBeGreaterThan(2.3);
    }
    hand = await deviceHand(page);
    const h0 = await gt<number>(page, 'hearts');
    const near = fr.sort((a, b) => a.life - b.life).pop()!;
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), near.p, { arrive: 0.4, maxMs: 12_000 });
    await expect.poll(async () => (await events(page)).filter((e) => e.type === 'frag').length, { message: 'かけらが拾えません' }).toBeGreaterThanOrEqual(1);
    expect(await gt<number>(page, 'hearts')).toBeGreaterThanOrEqual(h0 + 3);
    await hand.release();
    // 荷物を積んで止まっている → 当たると落とす
    await open(page, 120);
    await start(page);
    hand = await deviceHand(page);
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2, smooth: true });
    await expect.poll(async () => (await player(page)).stack.length, { timeout: 10_000 }).toBe(6);
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), dirOf(30, 300), { arrive: 1, smooth: true });
    await hand.release();
    await expect.poll(async () => (await events(page)).some((e) => e.type === 'impact' && e.effect === 'hit'), { timeout: 90_000, intervals: [500] }).toBeTruthy();
    const ev2 = await events(page);
    const h2 = ev2.find((e) => e.type === 'impact' && e.effect === 'hit')!;
    const drops = ev2.filter((e) => e.type === 'drop' && e.why === 'meteor' && Math.abs(e.t - h2.t) < 0.05);
    console.log(`  6こ積んで当たった: その場で落とした ${drops.length}こ・目が回る ${(await player(page)).stun.toFixed(2)}`);
    expect(drops.length, '流れ星に当たっても 荷物を落としません').toBe(2);
    // にげる: 赤い輪を見てから 走って にげれば当たらない
    await open(page, 200);
    await start(page);
    hand = await deviceHand(page);
    const t0 = Date.now();
    let warned = 0, close = 0, threats = 0, minWarn = 9;
    const seen = new Set<string>();
    let ix = 0, iy = 0;
    while (Date.now() - t0 < 60_000) {
      const s = await snap(page);
      const threat = s.mets.filter((m) => sdist(s.pl.p, m.p) < 3.2);
      for (const m of s.mets) { const key = m.p.map((x) => x.toFixed(3)).join(); if (!seen.has(key)) { seen.add(key); warned++; minWarn = Math.min(minWarn, m.T - m.t); const d = sdist(s.pl.p, m.p); if (d < 1.6) close++; if (d < 3.2) threats++; } }
      if (threat.length) {
        let away: V3 = [0, 0, 0];
        for (const m of threat) away = add(away, sc(norm(tang(s.pl.p, sub(s.pl.p, m.p))), 3.2 - sdist(s.pl.p, m.p)));
        const d = norm(away); ix = dot(d, s.fr.r); iy = dot(d, s.fr.f);
      } else { ix *= 0.8; iy *= 0.8; }
      await hand.go(ix, iy);
      await page.waitForTimeout(150); // 人の反応(見てから 0.15秒)
    }
    await hand.release();
    const ev3 = await events(page);
    const hits3 = ev3.filter((e) => e.type === 'impact' && e.effect === 'hit').length;
    console.log(`  にげながら60秒: 流れ星 ${warned}こ(3m以内 ${threats}こ・足もと ${close}こ)・当たった ${hits3}・輪が出てから落ちるまで 最短 ${minWarn.toFixed(2)}秒`);
    expect(threats, '近くに流れ星が来ません').toBeGreaterThanOrEqual(3);
    expect(close, '足もとをねらう流れ星が来ません').toBeGreaterThanOrEqual(1);
    expect(hits3, 'にげても 流れ星に当たります').toBe(0);
    expect(minWarn, '赤い輪が出てから すぐ落ちます').toBeGreaterThan(1.4);
  });

  test('おいそぎ便: 金の荷物を時間内に届けると +5♥', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    await open(page, 16);
    await start(page);
    const hand = await deviceHand(page);
    let got: Ev | undefined;
    for (let i = 0; i < 10 && !got; i++) {
      const obst = await gt<Obst[]>(page, 'obstacles');
      await walkTo(page, hand, obst, POST, { arrive: 2.2 });
      await expect.poll(async () => (await player(page)).stack.length, { timeout: 8000 }).toBe(await gt<number>(page, 'cap'));
      const pl = await player(page);
      const ex = pl.stack.find((b) => b.express);
      if (ex) {
        console.log(`  おいそぎ便: ${ex.to}番の家へ・のこり ${ex.left.toFixed(1)}秒`);
        expect(ex.left, '時間が短すぎます').toBeGreaterThan(10);
        const h = (await houses(page))[ex.to];
        await walkTo(page, hand, obst, h.door, { arrive: 0.8, maxMs: 40_000, until: (s) => !s.pl.stack.some((b) => b.express) });
        await page.waitForTimeout(800);
        got = (await events(page)).filter((e) => e.type === 'deliver' && e.express).pop();
      }
      await oneTrip(page, hand);
    }
    expect(got, 'おいそぎ便が来ません').toBeTruthy();
    console.log(`  届いた: 間にあった ${got!.onTime}・♥+${got!.gain}(れんぞく ${got!.k})`);
    expect(got!.onTime, 'まっすぐ向かったのに 間にあいません').toBeTruthy();
    expect(got!.gain, 'おいそぎ便の +5 が つきません').toBe(got!.k! + 5);
    await hand.release();
  });

  test('ほしまつり: ♥300で 花火と寄せ書き。そのあとも配達をつづけられ、記録に残る', async ({ page }) => {
    test.setTimeout(150_000);
    await open(page, 292);
    expect((await houses(page)).every((h) => h.active), '♥292で 8けん そろっていません').toBeTruthy();
    await start(page);
    const hand = await deviceHand(page);
    await oneTrip(page, hand);
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 10_000, message: 'ほしまつりに なりません' }).toBe('finale');
    await hand.release();
    await expect(page.locator('#fin')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(1500);
    expect(await gt<number>(page, 'particles'), '花火が上がりません').toBeGreaterThan(100);
    await expect(page.locator('#yose span')).toHaveCount(8);
    await page.locator('#b-cont').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    await expect(page.locator('#next-t')).toContainText('どこまでも');
    await page.reload();
    await expect.poll(() => gt<string>(page, 'state')).toBe('title');
    expect((await gt<Stats>(page, 'stats')).finale).toBeTruthy();
    await expect(page.locator('#t-prog')).toContainText('ほしまつり済み');
  });

  test('ひとやすみ: 止めている間は ボクも流れ星も止まり、つづけると続きから', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で確かめる');
    await open(page, 60);
    await start(page);
    const hand = keyHand(page);
    await hand.go(0, 1); await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await expect.poll(() => gt<string>(page, 'state')).toBe('pause');
    const a = await player(page);
    await page.waitForTimeout(1500);
    const b = await player(page);
    expect(sdist(a.p, b.p), '止めているのに 進んでいます').toBeLessThan(0.01);
    await hand.go(0, 0);
    await page.locator('#b-resume').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    await hand.go(0, -1); await page.waitForTimeout(600); await hand.go(0, 0);
    expect(sdist(b.p, (await player(page)).p), 'つづけても 歩けません').toBeGreaterThan(1);
  });

  // 長さと むずかしさ: 人くらいの手(そっと動かす・0.1秒おくれ)で、はじめから ほしまつりまで
  for (const [from, to] of [[0, 90], [90, 300]] as const) {
    test(`長さ: ♥${from} → ♥${to} を 音ありで遊ぶ`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'desktop で測る');
      test.setTimeout(10 * 60_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await open(page, from, true);
      await start(page);
      const hand = await mouseHand(page);
      const t0 = Date.now();
      const log: string[] = [];
      let trips = 0;
      while ((await gt<number>(page, 'hearts')) < to && Date.now() - t0 < 9 * 60_000) {
        const h0 = await gt<number>(page, 'hearts'), d0 = (await gt<Stats>(page, 'stats')).drops;
        const ts = Date.now();
        await oneTrip(page, hand, { smooth: true, lag: 100 });
        if ((await gt<string>(page, 'state')) === 'finale') break;
        trips++;
        const st = await gt<Stats>(page, 'stats');
        log.push(`${trips}回目: 荷台${await gt<number>(page, 'cap')} ♥${h0}→${st.hearts} ${((Date.now() - ts) / 1000).toFixed(0)}秒 落とした${st.drops - d0}`);
      }
      const st = await gt<Stats>(page, 'stats');
      console.log(`  ${log.join('\n  ')}`);
      console.log(`  ♥${from}→${st.hearts}: ${((Date.now() - t0) / 60000).toFixed(1)}分・${trips}往復・落とした${st.drops}・かけら${st.frags}`);
      expect(st.hearts, `${to} まで届きません`).toBeGreaterThanOrEqual(to);
      expect(errors, '遊んでいる間に エラーが出ました').toEqual([]);
      if (to === 300) expect(await gt<string>(page, 'state')).toBe('finale');
      await hand.release();
    });
  }

  test('スマホ: 画面に収まり、指で押せる大きさで、ボクが 指や表示に かくれない', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    test.setTimeout(90_000);
    await open(page, 262);
    const vp = page.viewportSize()!;
    const inside = (b: { x: number; y: number; width: number; height: number } | null) =>
      !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= vp.width + 0.5 && b.y + b.height <= vp.height + 0.5;
    for (const id of ['#b-start', '#b-how']) {
      const b = await page.locator(id).boundingBox();
      expect(inside(b), `${id} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(b!.width, b!.height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    }
    await page.locator('#b-start').tap();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    await page.waitForTimeout(1500);
    for (const id of ['#b-pause', '#snd', '#b-rl', '#b-rr']) {
      const b = await page.locator(id).boundingBox();
      expect(inside(b), `${id} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(b!.width, b!.height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    }
    const hand = await touchHand(page);
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2, smooth: true });
    await expect.poll(async () => (await player(page)).stack.length, { timeout: 15_000 }).toBe(8);
    await page.waitForTimeout(500);
    const cargo = (await page.locator('#cargo').boundingBox())!;
    const rot = (await page.locator('#rot').boundingBox())!;
    expect(inside(cargo), '荷台の表示が はみ出しています').toBeTruthy();
    const apart = (a: typeof cargo, b: typeof cargo) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    expect(apart(cargo, rot), '荷台の表示と ⟲⟳ が重なっています').toBeTruthy();
    const ps = await gt<{ x: number; y: number }>(page, 'playerScreen');
    const top = (await page.locator('#next').boundingBox())!;
    console.log(`  ボクの位置: (${ps.x.toFixed(0)}, ${ps.y.toFixed(0)})・荷台の表示の上 ${cargo.y.toFixed(0)}・画面 ${vp.width}x${vp.height}`);
    expect(ps.y, 'ボクが 荷台の表示に かくれます').toBeLessThan(cargo.y - 60);
    expect(ps.y, 'ボクが 上の表示に かくれます').toBeGreaterThan(top.y + top.height + 60);
    await hand.release();
  });

  test('スマホで重くない(CPU 4倍遅くても、8こ積んで流れ星がふる中で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(2 * 60_000);
    await open(page, 262);
    await start(page);
    const cdp = await page.context().newCDPSession(page);
    const hand = await touchHand(page, cdp);
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2, smooth: true });
    await expect.poll(async () => (await player(page)).stack.length, { timeout: 15_000 }).toBe(8);
    const hs = (await houses(page)).filter((h) => h.ready).sort((a, b) => sdist(POST, b.door) - sdist(POST, a.door));
    await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), hs[1].door, { smooth: true, maxMs: 2500 });
    const parts = await gt<number>(page, 'particles');
    // 測っているあいだは gameTest を読まない。指を ゆっくり動かしつづける
    const busy = (async () => {
      const end = Date.now() + 3300;
      let k = 0;
      while (Date.now() < end) { await hand.go(Math.sin(k * 0.3) * 0.5, 0.6); k++; await page.waitForTimeout(90); }
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
    // 8こ積んで夜がわへ。高い荷物のすぐ近くに流れ星が落ちた瞬間から始め、そのまま家々へ届ける
    await recordPlayVideo(browser, {
      dir: target!.dir,
      focus: '#gl',
      setup: async (page) => {
        await open(page, 262, true); // 動画には音を入れるので、音はオンで始める
        await start(page);
        const hand = await mouseHand(page);
        await walkTo(page, hand, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2, smooth: true });
        await expect.poll(async () => (await player(page)).stack.length, { timeout: 15_000 }).toBe(8);
        await hand.release();
      },
      play: async (page, clip: Clip) => {
        const hand = await mouseHand(page, [0.8, 0.78]); // ボクに重ならない右下で操作する
        let marked = false, markAt = 0, shot = false;
        const start = Date.now();
        const keep = { ix: 0, iy: 0 };
        const obst = await gt<Obst[]>(page, 'obstacles');
        while (Date.now() < clip.until) {
          const pl = await player(page);
          const lo = await gt<{ p: V3 }[]>(page, 'loose');
          const hs = (await houses(page)).filter((h) => h.ready);
          let goal: V3;
          if (lo.length && pl.stack.length < pl.cap) goal = lo[0].p;
          else if (!pl.stack.length) goal = POST;
          else goal = hs.filter((h) => pl.stack.some((b) => b.to === h.id)).sort((a, b) => sdist(pl.p, a.door) - sdist(pl.p, b.door))[0].door;
          await walkTo(page, hand, obst, goal, {
            smooth: true, arrive: 0.8, maxMs: 500, keep,
            until: (s) => {
              const e = s.last;
              // 見せ場: 5こ以上 積んで歩いているすぐ近くに 流れ星が落ちた瞬間(なければ 22秒後の配達)
              const big = !!e && ((e.type === 'impact' && (e.d ?? 99) < 6 && s.pl.stack.length >= 5) || (Date.now() - start > 22_000 && e.type === 'deliver'));
              if (!marked && big) { marked = true; markAt = Date.now(); clip.mark(); console.log(`  見せ場: ${e!.type}(${e!.d ?? e!.k})・荷物 ${s.pl.stack.length}こ`); }
              return Date.now() > clip.until;
            },
          });
          // 投稿画像(動画が使えないとき用)
          if (marked && !shot && Date.now() - markAt > 300) {
            shot = true;
            await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          }
        }
        console.log(`  動画: ♥${await gt<number>(page, 'hearts')}・mark ${marked}`);
        await hand.release();
      },
    });
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(4 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    await open(page);
    await page.waitForTimeout(1200);
    await shot('1-title');
    await start(page);
    await shot('2-start');
    const hand = await deviceHand(page);
    const obst = await gt<Obst[]>(page, 'obstacles');
    await walkTo(page, hand, obst, POST, { arrive: 2.2 });
    await page.waitForTimeout(900);
    await shot('3-pickup');
    await oneTrip(page, hand);
    await shot('4-delivered');
    await hand.release();
    // にぎやかな場面: 荷台8こ・流れ星
    await open(page, 262);
    await start(page);
    const h2 = await deviceHand(page);
    await walkTo(page, h2, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2, smooth: true });
    await page.waitForTimeout(2200);
    const hs = (await houses(page)).filter((h) => h.ready);
    const far = hs.sort((a, b) => sdist(POST, b.door) - sdist(POST, a.door))[0];
    await walkTo(page, h2, await gt<Obst[]>(page, 'obstacles'), far.door, { smooth: true, maxMs: 6000 });
    await shot('5-busy');
    await walkTo(page, h2, await gt<Obst[]>(page, 'obstacles'), far.door, { smooth: true, maxMs: 20000, arrive: 1.5 });
    await page.waitForTimeout(300);
    await shot('6-night');
    await h2.release();
    if (info.project.name !== 'mobile') return;
    // 横持ち・小さいスマホ
    for (const [w, h, name] of [[844, 390, 'a-landscape'], [360, 640, 'b-small']] as const) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, 150);
      await page.waitForTimeout(900);
      await shot(`${name}-title`);
      const sb = (await page.locator('#b-start').boundingBox())!;
      expect(sb.y + sb.height, `${name}: 「はいたつ開始」が画面の外です`).toBeLessThanOrEqual(h);
      await start(page);
      const h3 = await touchHand(page);
      await walkTo(page, h3, await gt<Obst[]>(page, 'obstacles'), POST, { arrive: 2.2, smooth: true });
      await page.waitForTimeout(2500);
      await h3.release();
      await shot(`${name}-play`);
    }
  });
});
