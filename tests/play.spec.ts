import { test, expect, Page, Browser } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';
import { recordScenes, Clip } from './video';
import { measureFps } from './perf';

// ============================================================================
//  プレイテスト: 今日のゲームの「核の遊び」が本当に機能するかを、実際に操作して確かめる。
//  game.spec.ts は「エラーが出ないか」しか見ないので、遊べないゲームでも通ってしまう。
//  このファイルはゲームごとに中身が違うので、毎回、今日のゲームに合わせて書き直す。
//
//  対象: 夜盗の一手(2026-10-09)
//  一手ずつ進む潜入パズル。こちらが1マス動く(待つ)と、見張り・カメラ・犬が決まった予定どおり1手動く。
//  灯り(いま / 次の手)に立つと見つかる。見張りのマスに踏み込むと眠らせる(1回だけ)。倒れた体を見られると警報。
//  たんすの中は灯りが届かない(犬の匂いだけは届く)。宝石を持って窓に戻れば成功。屋敷は毎回作られる。
//
//  ・ゲームの決まりを、このファイルの中にもう一度、別に書く(Model)。gameTest から読むのは屋敷の図と予定だけ。
//    その決まりで総当たりした手順を、本物のキーで遊ばせる。ゲームと決まりがずれていれば、途中で捕まって落ちる
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-09-yato-no-itte';
const target = latestGame();
const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const isMobile = (page: Page) => page.evaluate(() => 'ontouchstart' in window);

type Sched = { c: number; d: number };
type Actor = { kind: number; R: number; sched: Sched[] };
type House = { n: number; seed: number; name: string; W: number; H: number; cells: number[]; start: number; win: number; items: number[]; hides: number[]; actors: Actor[]; L: number; par: number; req: number; parNoKO: number | null; genMs: number; attempt: number };
type Player = { p: number; t: number; ko: number; koGuard: number; body: number; items: number; hidden: boolean; by: number; why: string; caughtN: number; undo: number };
type Ev = { type: string; t: number; [k: string]: any };
const FLOOR = 0, WALL = 1, HIDE = 2, DESK = 3, GUARD = 0, CAM = 1, DOG = 2;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const KEYS = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Space'];

// ---------------------------------------------------------------------------
//  ゲームの決まり(テストの側で、ゲームとは別に書いたもの)
// ---------------------------------------------------------------------------
type Res = 'ok' | 'wall' | 'seen' | 'alarm' | 'bump' | 'win';
type St = { p: number; t: number; koG: number; body: number; items: number };
class Model {
  h: House; L: number; WH: number;
  lit: Set<number>[][][]; // lit[警戒][actor][t] … 灯り。宝石を持っていると警戒で どの灯りも1マス伸びる
  smell: Set<number>[][]; // smell[actor][t] … 犬の匂い(自分のマスと となり)
  constructor(h: House) {
    this.h = h; this.WH = h.W * h.H;
    const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
    this.L = h.actors.reduce((l, a) => (l * a.sched.length) / g(l, a.sched.length), 1);
    this.lit = [[], []]; this.smell = [];
    for (const a of h.actors) {
      const S1: Set<number>[] = [];
      for (const alert of [0, 1]) {
        const L1: Set<number>[] = [];
        for (let t = 0; t < this.L; t++) {
          const s = a.sched[t % a.sched.length], set = new Set<number>();
          if (a.kind !== CAM) set.add(s.c);
          if (s.d >= 0) {
            let x = s.c % h.W, y = Math.floor(s.c / h.W);
            for (let k = 0; k < a.R + alert; k++) { x += DX[s.d]; y += DY[s.d]; if (x < 0 || y < 0 || x >= h.W || y >= h.H) break; const c = y * h.W + x; if (this.block(c)) break; set.add(c); }
          }
          L1.push(set);
          if (!alert) { const sm = new Set<number>(); if (a.kind === DOG) { sm.add(s.c); for (let d = 0; d < 4; d++) { const c = s.c + DX[d] + DY[d] * h.W; if (!this.block(c)) sm.add(c); } } S1.push(sm); }
        }
        this.lit[alert].push(L1);
      }
      this.smell.push(S1);
    }
  }
  block(c: number) { const v = this.h.cells[c]; return v === WALL || v === DESK; }
  pos(i: number, t: number) { const a = this.h.actors[i]; return a.sched[t % a.sched.length]; }
  // t の時点で c を見ている相手(hide = たんすの中なら、犬の匂いだけ)
  seer(c: number, t: number, koG: number, hide: boolean, alert = 0): number {
    const tm = t % this.L;
    for (let i = 0; i < this.h.actors.length; i++) {
      if (i === koG) continue;
      if (this.smell[i][tm].has(c)) return i;
      if (!hide && this.lit[alert][i][tm].has(c)) return i;
    }
    return -1;
  }
  step(s: St, a: number, canKO: (g: number) => boolean = () => true): { r: Res; s: St; by: number } {
    const h = this.h;
    let np = s.p;
    if (a < 4) { const x = (s.p % h.W) + DX[a], y = Math.floor(s.p / h.W) + DY[a]; if (x < 0 || y < 0 || x >= h.W || y >= h.H) return { r: 'wall', s, by: -1 }; np = y * h.W + x; if (this.block(np)) return { r: 'wall', s, by: -1 }; }
    let { koG, body, items } = s;
    for (let i = 0; i < h.actors.length; i++) {
      if (i === koG || h.actors[i].kind === CAM || this.pos(i, s.t).c !== np) continue;
      if (h.actors[i].kind === GUARD && koG < 0 && canKO(i)) { koG = i; body = np; } else return { r: 'bump', s: { ...s, p: np }, by: i };
    }
    const it = h.items.indexOf(np); if (it >= 0) items |= 1 << it;
    const ns: St = { p: np, t: s.t + 1, koG, body, items };
    if (np === h.start && items & 1) return { r: 'win', s: ns, by: -1 };
    const hide = h.cells[np] === HIDE, alert = items & 1;
    for (const t of [s.t, s.t + 1]) {
      let by = this.seer(np, t, koG, hide, alert); if (by >= 0) return { r: 'seen', s: ns, by };
      if (body >= 0) { by = this.seer(body, t, koG, false, alert); if (by >= 0) return { r: 'alarm', s: ns, by }; }
    }
    return { r: 'ok', s: ns, by: -1 };
  }
  key(s: St) { return `${s.p},${s.t % this.L},${s.koG},${s.body},${s.items}`; }
  // 最短の手順を総当たりで探す
  search(goal: (r: Res, s: St, prev: St, by: number) => boolean, canKO: (g: number) => boolean = () => true, maxD = 90, allow: (s: St, prev: St) => boolean = () => true, from?: St): number[] | null {
    const s0: St = from ?? { p: this.h.start, t: 0, koG: -1, body: -1, items: 0 };
    let cur: { s: St; path: number[] }[] = [{ s: s0, path: [] }];
    const seen = new Set([this.key(s0)]);
    for (let d = 0; d < maxD && cur.length; d++) {
      const nxt: typeof cur = [];
      for (const { s, path } of cur) for (let a = 0; a < 5; a++) {
        const o = this.step(s, a, canKO);
        if (!allow(o.s, s)) continue;
        if (goal(o.r, o.s, s, o.by)) return [...path, a];
        if (o.r !== 'ok') continue;
        const k = this.key(o.s); if (seen.has(k)) continue;
        seen.add(k); nxt.push({ s: o.s, path: [...path, a] });
      }
      cur = nxt;
    }
    return null;
  }
  full() { return (1 << this.h.items.length) - 1; }
  solveFull(canKO?: (g: number) => boolean) { return this.search((r, s) => r === 'win' && s.items === this.full(), canKO); }
  // 見張りを気にしない最短の道(壁だけよける)
  shortest(from: number, to: number): number[] {
    const h = this.h, d = new Map<number, number>([[to, 0]]), q = [to];
    for (let i = 0; i < q.length; i++) for (let k = 0; k < 4; k++) { const n = q[i] + DX[k] + DY[k] * h.W; if (n < 0 || n >= this.WH || d.has(n) || this.block(n)) continue; d.set(n, d.get(q[i])! + 1); q.push(n); }
    const out: number[] = []; let c = from;
    while (c !== to) { for (let k = 0; k < 4; k++) { const n = c + DX[k] + DY[k] * h.W; if (d.get(n) === d.get(c)! - 1) { out.push(k); c = n; break; } } }
    return out;
  }
}

// ---------------------------------------------------------------------------
//  ページを開く
// ---------------------------------------------------------------------------
type Cfg = { seed: number; n?: number; hseed?: number; sound?: boolean };
function installBot(cfg: Cfg) {
  let s = cfg.seed >>> 0;
  Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // 保存データは はじめの1回だけ書く(再読み込みのたびに書くと、ゲームが残した記録を消してしまう)
  try {
    if (!localStorage.getItem('yato-no-itte-v1')) localStorage.setItem('yato-no-itte-v1', JSON.stringify({ sound: !!cfg.sound, n: cfg.n ?? 1, ...(cfg.hseed ? { seed: cfg.hseed } : {}) }));
  } catch { /* なし */ }
}
async function open(page: Page, cfg: Cfg) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(installBot, cfg);
  await page.goto(url());
  await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
  return errors;
}
async function start(page: Page) {
  if (await isMobile(page)) await page.locator('#b-start').tap(); else await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
}
const house = (page: Page) => gt<House>(page, 'house');
const player = (page: Page) => gt<Player>(page, 'player');
// 本物のキーで手順を遊ぶ
async function playKeys(page: Page, acts: number[], gap = 0) {
  for (const a of acts) { await page.keyboard.press(KEYS[a]); if (gap) await page.waitForTimeout(gap); }
}

// ページの中で遊ぶ雑な自動プレイヤー(KeyboardEvent を送る。ゲームは keydown の中で1手を進める)
//  random: 壁でない方向か「待つ」をでたらめに / straight: 見張りを気にせず宝石→窓の最短の道 /
//  greedy: 最短の道を行くが、行き先が いま光っていれば待つ(少しだけ考える)
//  見つかったら「最初から」(R)。budget 手を使い切るか、逃げきったら終わり
function inPageBot([kind, budget, seed, plan]: [string, number, number, number[][]]) {
  const w = window as any, g = w.gameTest, h = g.house();
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const press = (code: string) => w.dispatchEvent(new KeyboardEvent('keydown', { code }));
  const codes = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Space'];
  const dx = [0, 1, 0, -1], dy = [-1, 0, 1, 0];
  let used = 0, caught = 0, step = 0;
  while (used < budget && g.state() === 'play') {
    const p = g.player().p;
    let a = 4;
    if (kind === 'random') {
      const ok = [4]; for (let k = 0; k < 4; k++) { const c = p + dx[k] + dy[k] * h.W; if (h.cells[c] !== 1 && h.cells[c] !== 3) ok.push(k); }
      a = ok[Math.floor(rnd() * ok.length)];
    } else {
      const path = (g.player().items & 1) ? plan[1] : plan[0];
      // 道の上のどこにいるか(最初からやり直すと、道の頭に戻る)
      const idx = step;
      a = path[idx] ?? 4;
      if (kind === 'greedy' && a < 4) {
        const c = p + dx[a] + dy[a] * h.W, lit = g.lit();
        if (lit.now.includes(c) && rnd() < 0.85) a = 4;
      }
    }
    const before = g.player();
    press(codes[a]);
    used++;
    const after = g.player();
    if (kind !== 'random' && a < 4 && after.p !== before.p) step++;
    if ((after.items & 1) && !(before.items & 1)) step = 0;
    if (g.state() === 'caught') { caught++; step = 0; press('KeyR'); }
  }
  return { won: g.state() === 'escaped', used, caught };
}

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(target!.name, 'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください').toBe(EXPECTED);
  });

  test('テスト用の窓口 window.gameTest があり、3D(WebGL)で描いている', async ({ page }) => {
    const errors = await open(page, { seed: 1 });
    const ok = await page.evaluate(() => {
      const g = (window as any).gameTest;
      return !!g && ['state', 'score', 'webgl', 'house', 'player', 'lit', 'actorsNow', 'records', 'events', 'toScreen', 'quality', 'particles', 'overlay', 'sound'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
    expect(await gt<boolean>(page, 'webgl'), 'WebGL が使えていません').toBeTruthy();
    await start(page);
    await page.waitForTimeout(1200);
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '3Dの画面に何も描かれていないようです').toBeGreaterThan(40_000);
    expect(errors).toEqual([]);
  });

  // ------------------------------------------------------------------------
  //  核の遊び
  // ------------------------------------------------------------------------
  test('屋敷: 毎回の屋敷は、テスト側の決まりで総当たりしても解け、目安の手数はその最短と同じ。見張りを無視した最短の道では捕まる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', '屋敷の検算は desktop で');
    test.setTimeout(240_000);
    let exposed = 0, houses = 0;
    for (const [n, seed] of [[1, 11], [1, 12], [2, 13], [3, 14], [4, 15], [5, 16], [6, 17], [8, 18]]) {
      const ctx = await page.context().browser()!.newContext();
      const pg = await ctx.newPage();
      await open(pg, { seed, n });
      const h = await house(pg);
      const m = new Model(h);
      expect(m.L, '予定の周期が合いません').toBe(h.L);
      const sol = m.solveFull();
      const req = m.search((r) => r === 'win');
      const st = m.shortest(h.start, h.items[0]).concat(m.shortest(h.items[0], h.start));
      let s: St = { p: h.start, t: 0, koG: -1, body: -1, items: 0 }, naive: Res = 'ok';
      for (const a of st) { const o = m.step(s, a); naive = o.r; s = o.s; if (o.r !== 'ok') break; }
      const kinds = h.actors.map((a) => ['見張', 'カメラ', '犬'][a.kind]).join('');
      // 眠らせる場所しだいで、倒れた体が見つかる(どこで眠らせるかに意味がある)
      const alarm = m.search((r) => r === 'alarm');
      houses++; if (alarm) exposed++;
      console.log(`  ${n}件目 種${seed}: ${h.W - 2}×${h.H - 2}・${kinds}・周期${h.L}・目安${h.par}手(宝石だけ${h.req}手・眠らせないと${h.parNoKO ?? '-'}手)・見張りを無視した道 ${st.length}手→${naive}・体が見つかる手順 ${alarm ? alarm.length + '手' : 'なし'}・作るのに ${h.genMs}ms(${h.attempt}回目)`);
      expect(sol, `${n}件目 種${seed}: 全部盗んで逃げる手順が見つかりません`).not.toBeNull();
      expect(sol!.length, '目安の手数が、総当たりの最短と違います').toBe(h.par);
      expect(req!.length).toBe(h.req);
      expect(naive, '見張りを無視した最短の道で逃げきれてしまいます(考えなくても解ける)').not.toBe('win');
      expect(h.genMs, '屋敷を作るのに時間がかかりすぎます').toBeLessThan(4000);
      expect(h.attempt >= 0 && h.attempt <= 1600,`条件をゆるめないと屋敷が作れていません(${h.attempt}回目)`).toBeTruthy();
      await ctx.close();
    }
    expect(exposed, '眠らせた体がどこにあっても見つからない屋敷が多すぎます(眠らせる場所を考えなくてよい)').toBeGreaterThanOrEqual(houses - 1);
  });

  test('灯り: 画面の灯り(いま・次の手)はテスト側の決まりと同じ。灯りに踏み込むと見つかり、一手戻すと元に戻る', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await open(page, { seed: 21, n: 2 });
    await start(page);
    const h = await house(page), m = new Model(h);
    // 灯りの表示が決まりと同じか(何手か動きながら)
    const sol = m.solveFull()!;
    let s: St = { p: h.start, t: 0, koG: -1, body: -1, items: 0 };
    for (let i = 0; i < 6; i++) {
      const lit = await gt<{ now: number[]; next: number[] }>(page, 'lit');
      const want = (t: number) => { const set = new Set<number>(); for (let a = 0; a < h.actors.length; a++) { if (a === s.koG) continue; for (const c of m.lit[s.items & 1][a][t % m.L]) set.add(c); for (const c of m.smell[a][t % m.L]) set.add(c); } return [...set].sort((a, b) => a - b); };
      expect(lit.now.slice().sort((a, b) => a - b), `${s.t}手目: いまの灯りが決まりと違います`).toEqual(want(s.t));
      expect(lit.next.slice().sort((a, b) => a - b), `${s.t}手目: 次の手の灯りが決まりと違います`).toEqual(want(s.t + 1));
      await playKeys(page, [sol[i]]);
      s = m.step(s, sol[i]).s;
    }
    // 灯りに踏み込む手を探して、その手前まで進め、踏み込む
    const into = m.search((r) => r === 'seen', () => false)!;
    expect(into, '灯りに踏み込む手順が見つかりません').not.toBeNull();
    await page.keyboard.press('KeyR');
    await expect.poll(async () => (await player(page)).t).toBe(0);
    await playKeys(page, into.slice(0, -1));
    expect(await gt<string>(page, 'state'), '灯りに入る手前で もう見つかっています').toBe('play');
    const before = await player(page);
    await playKeys(page, into.slice(-1));
    expect(await gt<string>(page, 'state'), '灯りに踏み込んでも見つかりません').toBe('caught');
    await expect(page.locator('#caught')).toBeVisible();
    const pc = await player(page);
    console.log(`  ${into.length}手目に灯りへ: ${pc.why}`);
    // 一手戻す
    if (await isMobile(page)) await page.locator('#b-back').tap(); else await page.locator('#b-back').click();
    expect(await gt<string>(page, 'state')).toBe('play');
    const back = await player(page);
    expect([back.p, back.t, back.items], '一手戻しても元の場所に戻りません').toEqual([before.p, before.t, before.items]);
    await expect(page.locator('#caught')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('警戒: 宝石を盗んだ瞬間から、どの灯りも1マス遠くまで届く(画面の灯りも決まりどおりに伸びる)', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, { seed: 25, n: 4 });
    await start(page);
    const h = await house(page), m = new Model(h);
    const grab = m.search((r, s, prev) => r === 'ok' && !!(s.items & 1) && !(prev.items & 1))!;
    expect(grab, '宝石を取る手順が見つかりません').not.toBeNull();
    await playKeys(page, grab);
    const p = await player(page);
    expect(p.items & 1, '宝石を取れていません').toBe(1);
    const lit = await gt<{ now: number[]; next: number[] }>(page, 'lit');
    const set = (alert: number, t: number) => { const out = new Set<number>(); h.actors.forEach((_, a) => { if (a === p.koGuard) return; m.lit[alert][a][t % m.L].forEach((c) => out.add(c)); m.smell[a][t % m.L].forEach((c) => out.add(c)); }); return out; };
    const calm = set(0, p.t), alert = set(1, p.t);
    expect(lit.now.slice().sort((a, b) => a - b), '宝石を取ったあとの灯りが、決まり(1マス伸びる)と違います').toEqual([...alert].sort((a, b) => a - b));
    // 壁で止まっている灯りは伸びないので、巡回の1周ぶん(L手)を合わせて比べる
    let sumCalm = 0, sumAlert = 0;
    for (let t = 0; t < m.L; t++) { sumCalm += set(0, t).size; sumAlert += set(1, t).size; }
    console.log(`  ${grab.length}手目に宝石: いまの灯りのマス ${calm.size} → ${alert.size}・1周(${m.L}手)の合計 ${sumCalm} → ${sumAlert}`);
    expect(sumAlert - sumCalm, '警戒しても灯りが伸びていません(1手あたり平均1.2マス以上)').toBeGreaterThanOrEqual(m.L * 1.2);
    await expect(page.locator('#tip')).toContainText('警戒中');
  });

  test('眠らせる: 見張りのマスに踏み込むと眠り、灯りが消える。1回だけで、倒れた体をほかの灯りに見られると警報', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーで確かめる');
    test.setTimeout(180_000);
    let done = false;
    for (const [n, seed] of [[4, 31], [5, 32], [3, 33], [6, 34], [4, 35], [5, 36]]) {
      const ctx = await page.context().browser()!.newContext();
      const pg = await ctx.newPage();
      const errors = await open(pg, { seed, n });
      await start(pg);
      const h = await house(pg), m = new Model(h);
      // 体を見られて警報になる手順(眠らせたあと)
      const alarm = m.search((r) => r === 'alarm');
      // 眠らせる手順
      const ko = m.search((r, s) => r === 'ok' && s.koG >= 0);
      if (!alarm || !ko) { console.log(`  ${n}件目 種${seed}: 警報の手順 ${alarm?.length ?? 'なし'}・眠らせる手順 ${ko?.length ?? 'なし'}`); await ctx.close(); continue; }
      await playKeys(pg, ko);
      const p = await player(pg);
      expect(p.ko, '見張りのマスに踏み込んでも眠りません').toBeGreaterThan(0);
      expect((await gt<Ev[]>(pg, 'events')).some((e) => e.type === 'ko')).toBeTruthy();
      const an = await gt<{ active: boolean; c: number }[]>(pg, 'actorsNow');
      expect(an[p.koGuard].active, '眠らせた見張りが まだ動いています').toBeFalsy();
      const lit = await gt<{ now: number[] }>(pg, 'lit');
      for (const c of m.lit[p.items & 1][p.koGuard][(p.t) % m.L]) if (c !== p.body) expect(lit.now.includes(c) && m.seer(c, p.t, p.koGuard, false, p.items & 1) < 0, '眠らせた見張りの灯りが残っています').toBeFalsy();
      await expect(pg.locator('#dart')).toHaveClass(/used/);
      // 2人目には効かない: もう一度 見張りに踏み込む手順(眠らせたあと)は「ぶつかる」
      const second = m.search((r, s, prev, by) => r === 'bump' && prev.koG >= 0 && h.actors[by].kind === GUARD, () => true, 60);
      console.log(`  ${n}件目 種${seed}: ${ko.length}手目に眠らせた・警報まで ${alarm.length}手・2人目にぶつかる手順 ${second ? second.length + '手' : 'なし'}`);
      // 警報
      await pg.keyboard.press('KeyR');
      await playKeys(pg, alarm);
      expect(await gt<string>(pg, 'state'), '倒れた体を見られても警報になりません').toBe('caught');
      expect((await player(pg)).why).toContain('倒れた');
      await expect(pg.locator('#cStamp')).toHaveText('警報');
      if (second) {
        await pg.keyboard.press('KeyR');
        await playKeys(pg, second);
        expect(await gt<string>(pg, 'state'), '眠り矢を使ったあとで見張りに踏み込んでも捕まりません').toBe('caught');
      }
      expect(errors).toEqual([]);
      await ctx.close();
      done = true;
      break;
    }
    expect(done, '眠らせて警報になる屋敷が見つかりませんでした').toBeTruthy();
  });

  test('たんす: 中にいると見張りやカメラの灯りが当たっても見つからない。犬には嗅ぎつけられる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーで確かめる');
    test.setTimeout(180_000);
    let safe = false, dog = false;
    for (const [n, seed] of [[3, 41], [4, 42], [5, 43], [6, 44], [7, 45], [2, 46], [5, 47], [6, 48], [3, 49], [4, 50]]) {
      if (safe && dog) break;
      const ctx = await page.context().browser()!.newContext();
      const pg = await ctx.newPage();
      await open(pg, { seed, n });
      await start(pg);
      const h = await house(pg), m = new Model(h);
      const litByNonDog = (c: number, t: number, alert: number) => h.actors.some((a, i) => a.kind !== DOG && m.lit[alert][i][t % m.L].has(c));
      if (!safe) {
        const path = m.search((r, s) => r === 'ok' && h.cells[s.p] === HIDE && (litByNonDog(s.p, s.t - 1, s.items & 1) || litByNonDog(s.p, s.t, s.items & 1)), () => false, 70);
        if (path) {
          await playKeys(pg, path);
          const p = await player(pg);
          expect(await gt<string>(pg, 'state'), 'たんすの中にいるのに見つかりました').toBe('play');
          expect(p.hidden).toBeTruthy();
          console.log(`  ${n}件目 種${seed}: ${path.length}手目、灯りの当たるたんすの中で無事`);
          safe = true;
        }
      }
      if (!dog && h.actors.some((a) => a.kind === DOG)) {
        const path = m.search((r, s, prev, by) => r === 'seen' && h.cells[s.p] === HIDE && h.actors[by].kind === DOG, () => false, 70);
        if (path) {
          await pg.keyboard.press('KeyR');
          await playKeys(pg, path);
          const p = await player(pg);
          expect(await gt<string>(pg, 'state'), 'たんすの中でも、犬の匂いの輪に入れば見つかるはずです').toBe('caught');
          expect(h.actors[p.by].kind).toBe(DOG);
          expect(p.why).toContain('番犬');
          console.log(`  ${n}件目 種${seed}: たんすの中で ${p.why}`);
          dog = true;
        }
      }
      await ctx.close();
    }
    expect(safe, 'たんすで灯りをやり過ごす場面が見つかりませんでした').toBeTruthy();
    expect(dog, 'たんすの中で犬に嗅ぎつけられる場面が見つかりませんでした').toBeTruthy();
  });

  test('成功: 宝石と金貨袋を全部盗み、目安の手数で窓に戻ると★3の調書が出る。次の屋敷へ進み、再読み込みしても続きと記録が残る', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await open(page, { seed: 51, n: 1 });
    await start(page);
    const h = await house(page), m = new Model(h);
    const sol = m.solveFull()!;
    await playKeys(page, sol, 30);
    expect(await gt<string>(page, 'state'), '総当たりの手順どおりに動いたのに逃げきれません(ゲームと決まりがずれています)').toBe('escaped');
    await expect(page.locator('#report')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('#rStars')).toHaveText('★★★');
    await expect(page.locator('#rMoves')).toHaveText(`${h.par} 手(${h.par})`);
    const win = (await gt<Ev[]>(page, 'events')).find((e) => e.type === 'win')!;
    console.log(`  1件目: ${sol.length}手で★${win.stars}・金貨袋${win.gold}・眠らせた${win.ko}`);
    if (await isMobile(page)) await page.locator('#b-next').tap(); else await page.locator('#b-next').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    const h2 = await house(page);
    expect(h2.n, '次の屋敷に進みません').toBe(2);
    expect(JSON.stringify(h2.cells) === JSON.stringify(h.cells) && h2.W === h.W, '次の屋敷が同じ間取りです').toBeFalsy();
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    const h3 = await house(page);
    expect([h3.n, h3.seed], '再読み込みすると、続きの屋敷が変わります').toEqual([2, h2.seed]);
    expect((await gt<{ best: Record<string, number> }>(page, 'records')).best['1'], '★の記録が残っていません').toBe(3);
    await expect(page.locator('#rec')).toContainText('★3');
    expect(errors).toEqual([]);
  });

  test('スマホ: なぞる・となりのマスをタップで動き、自分をタップで待つ。ボタンは指で押せ、屋敷は上下の表示に隠れない', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    test.setTimeout(120_000);
    await open(page, { seed: 61, n: 3 });
    const v = page.viewportSize()!;
    const inside = (b: { x: number; y: number; width: number; height: number } | null) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5;
    const apart = (a: any, b: any) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    expect(inside(await page.locator('#b-start').boundingBox()), '「忍び込む」が画面の外です').toBeTruthy();
    await start(page);
    await page.waitForTimeout(800);
    const ids = ['#case', '#stat', '#b-snd', '#b-help', '#b-undo', '#b-wait', '#b-reset'];
    const bx: Record<string, any> = {};
    for (const id of ids) { bx[id] = await page.locator(id).boundingBox(); expect(inside(bx[id]), `${id} がはみ出しています`).toBeTruthy(); }
    for (const id of ['#b-snd', '#b-help', '#b-undo', '#b-wait', '#b-reset']) expect(Math.min(bx[id].width, bx[id].height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(apart(bx[ids[i]], bx[ids[j]]), `${ids[i]} と ${ids[j]} が重なっています`).toBeTruthy();
    // 屋敷の四すみが、上の表示と下のボタンのあいだに見える
    const h = await house(page);
    const topY = Math.max(bx['#case'].y + bx['#case'].height, bx['#stat'].y + bx['#stat'].height), botY = bx['#b-undo'].y;
    for (const c of [0, h.W - 1, (h.H - 1) * h.W, h.W * h.H - 1]) {
      const s = (await gt<{ x: number; y: number }>(page, 'toScreen', c))!;
      expect(s.x > 0 && s.x < v.width && s.y > topY - 6 && s.y < botY + 6, `屋敷のすみ(${c})が表示に隠れるか、画面の外です(${Math.round(s.x)},${Math.round(s.y)})`).toBeTruthy();
    }
    // 1マスの大きさ(指で押せるか)
    const a0 = (await gt<{ x: number; y: number }>(page, 'toScreen', h.start))!, a1 = (await gt<{ x: number; y: number }>(page, 'toScreen', h.start - h.W))!;
    console.log(`  1マスの高さ ${Math.abs(a0.y - a1.y).toFixed(0)}px(画面 ${v.width}×${v.height})`);
    const m = new Model(h), sol = m.solveFull()!;
    // 手順の最初の数手を、なぞる / タップで
    const cdp = await page.context().newCDPSession(page);
    let s: St = { p: h.start, t: 0, koG: -1, body: -1, items: 0 };
    for (let i = 0; i < 6; i++) {
      const a = sol[i], before = await player(page);
      if (i % 2 === 0) {
        // タップ: 行き先のマス(待つなら自分のマス)
        const dest = a < 4 ? s.p + DX[a] + DY[a] * h.W : s.p;
        const q = (await gt<{ x: number; y: number }>(page, 'toScreen', dest))!;
        await page.touchscreen.tap(q.x, q.y);
      } else {
        // なぞる
        const c = (await gt<{ x: number; y: number }>(page, 'toScreen', s.p))!;
        const ddx = a === 1 ? 60 : a === 3 ? -60 : 0, ddy = a === 2 ? 60 : a === 0 ? -60 : 0;
        if (a === 4) await page.locator('#b-wait').tap();
        else {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 1 }] } as any);
          for (let k = 1; k <= 5; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + (ddx * k) / 5, y: c.y + (ddy * k) / 5, id: 1 }] } as any); await page.waitForTimeout(16); }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any);
        }
      }
      s = m.step(s, a).s;
      await expect.poll(async () => (await player(page)).t, { message: `${i + 1}手目(${['上', '右', '下', '左', '待つ'][a]})を指で操作しても進みません` }).toBe(before.t + 1);
      expect((await player(page)).p, `${i + 1}手目: 指で動かした先が違います`).toBe(s.p);
    }
    await cdp.detach();
  });

  // ------------------------------------------------------------------------
  //  面白さの代わりになる数字
  // ------------------------------------------------------------------------
  test('腕の差: 考える自動プレイヤーは毎回★をとって逃げきり、でたらめ・まっすぐ・少しだけ考える自動プレイヤーは同じ手数ではほとんど逃げきれない', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(8 * 60_000);
    const tally: Record<string, { won: number; runs: number; caught: number }> = {};
    const add = (k: string, won: boolean, caught: number) => { tally[k] ??= { won: 0, runs: 0, caught: 0 }; tally[k].runs++; tally[k].won += won ? 1 : 0; tally[k].caught += caught; };
    const lines: string[] = [];
    for (const [n, seed] of [[1, 71], [2, 72], [3, 73], [4, 74], [5, 75], [6, 76]]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed, n });
      await start(page);
      const h = await house(page), m = new Model(h);
      // 考える: 総当たりで手順を組み、本物のキーで遊ぶ
      const sol = m.solveFull()!;
      await playKeys(page, sol);
      const won = (await gt<string>(page, 'state')) === 'escaped';
      const win = (await gt<Ev[]>(page, 'events')).find((e) => e.type === 'win');
      add('考える', won, 0);
      const budget = h.par * 3;
      const plan = [m.shortest(h.start, h.items[0]), m.shortest(h.items[0], h.start)];
      const row = [`${n}件目: 考える ${won ? `${sol.length}手で★${win?.stars}` : '失敗'}`];
      for (const kind of ['random', 'straight', 'greedy']) {
        for (const bs of [1, 2, 3]) {
          await page.reload();
          await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
          await start(page);
          const r = await page.evaluate(inPageBot, [kind, budget, seed * 10 + bs, plan] as [string, number, number, number[][]]);
          const name = { random: 'でたらめ', straight: 'まっすぐ', greedy: '少し考える' }[kind]!;
          add(name, r.won, r.caught);
          if (bs === 1) row.push(`${name} ${r.won ? '成功' : '失敗'}(${r.used}手で${r.caught}回見つかった)`);
        }
      }
      lines.push(row.join(' / '));
      await ctx.close();
    }
    for (const l of lines) console.log(`  ${l}`);
    const rate = (k: string) => tally[k].won / tally[k].runs;
    console.log(`  逃げきった割合(目安の3倍の手数まで、見つかったら最初から): ${Object.entries(tally).map(([k, v]) => `${k} ${v.won}/${v.runs}`).join('・')}`);
    expect(rate('考える'), '考えて遊んでも逃げきれない屋敷があります').toBe(1);
    expect(rate('でたらめ'), 'でたらめに動いても逃げきれてしまいます').toBeLessThanOrEqual(0.1);
    expect(rate('まっすぐ'), '見張りを気にせず まっすぐ行っても逃げきれてしまいます').toBe(0);
    expect(rate('少し考える'), '行き先が光っていたら待つ、だけで ほとんど逃げきれてしまいます').toBeLessThanOrEqual(0.5);
  });

  test('毎回ちがう: 種を変えると、間取り・見張りの数と巡回・宝の場所がちがう', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(120_000);
    const sig: string[] = [];
    for (const seed of [81, 82, 83, 84]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed, n: 4 });
      const h = await house(page);
      const walls = h.cells.map((c) => (c === WALL ? '#' : c === DESK ? 'T' : c === HIDE ? 'H' : '.')).join('');
      sig.push(JSON.stringify([walls, h.items, h.actors.map((a) => a.sched.map((s) => s.c))]));
      const routes = h.actors.map((a) => `${['見張', 'カメラ', '犬'][a.kind]}${a.sched.length}`).join(' ');
      console.log(`  種${seed}: ${h.name}・${routes}・宝石${h.items[0]}・目安${h.par}手`);
      for (let y = 0; y < h.H; y++) console.log(`     ${walls.slice(y * h.W, (y + 1) * h.W)}`);
      await ctx.close();
    }
    expect(new Set(sig).size, '屋敷が毎回同じです').toBe(sig.length);
  });

  test('選択の重さ: 誰を眠らせるか(眠らせないか)と、金貨袋を取るかで、最短の手数や解けるかどうかがはっきり変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(4 * 60_000);
    let houses = 0, differ = 0, greed = 0, order = 0;
    for (const [n, seed] of [[2, 91], [3, 92], [4, 93], [5, 94], [6, 95], [7, 96]]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed, n });
      const h = await house(page), m = new Model(h);
      const outs: string[] = [];
      const none = m.solveFull(() => false);
      outs.push(`眠らせない ${none ? none.length + '手' : '解けない'}`);
      const res = new Set<string>([none ? String(none.length) : 'x']);
      h.actors.forEach((a, i) => {
        if (a.kind !== GUARD) return;
        // この見張りを必ず眠らせる
        const p = m.search((r, s) => r === 'win' && s.items === m.full() && s.koG === i, (g) => g === i);
        outs.push(`見張り${i}を眠らせる ${p ? p.length + '手' : '解けない'}`);
        res.add(p ? String(p.length) : 'x');
      });
      const req = m.search((r) => r === 'win')!;
      if (req.length < h.par) greed++;
      // 金貨袋を、全部 宝石の前に取る / 全部 宝石のあと(警戒中)に取る
      const goldMask = m.full() & ~1;
      const before = m.search((r, s) => r === 'win' && s.items === m.full(), () => true, 90, (s, prev) => !(s.items & 1 && !(prev.items & 1)) || (prev.items & goldMask) === goldMask);
      const after = m.search((r, s) => r === 'win' && s.items === m.full(), () => true, 90, (s, prev) => !(s.items & goldMask & ~prev.items) || !!(prev.items & 1));
      outs.push(`袋を先に ${before ? before.length + '手' : '解けない'}・袋をあとに ${after ? after.length + '手' : '解けない'}`);
      if ((before?.length ?? -1) !== (after?.length ?? -1)) order++;
      houses++;
      if (res.size >= 2) differ++;
      console.log(`  ${n}件目 種${seed}: ${outs.join('・')}・宝石だけなら ${req.length}手(全部 ${h.par}手)`);
      await ctx.close();
    }
    expect(differ, '誰を眠らせても(眠らせなくても)結果が変わらない屋敷ばかりです').toBeGreaterThanOrEqual(houses - 1);
    expect(greed, '金貨袋を取っても取らなくても手数が変わらない屋敷ばかりです').toBeGreaterThanOrEqual(houses - 1);
    expect(order, '金貨袋を宝石の前に取っても後に取っても、手数が変わらない屋敷ばかりです').toBeGreaterThanOrEqual(Math.ceil(houses / 2));
  });

  // ------------------------------------------------------------------------
  //  重さ・動画・見直し
  // ------------------------------------------------------------------------
  test('スマホで重くない(CPU 4倍遅くても、見張りが多い屋敷で見つかった警報の最中に 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(3 * 60_000);
    await open(page, { seed: 101, n: 7 });
    await start(page);
    const h = await house(page), m = new Model(h);
    const sol = m.solveFull()!;
    await playKeys(page, sol.slice(0, Math.floor(sol.length / 2)));
    await page.waitForTimeout(3000);
    const ov = await gt<number>(page, 'overlay');
    // 灯りの中で見つかる(赤い警報と「!」が出ている場面)
    const into = m.search((r) => r === 'seen', () => false)!;
    await page.keyboard.press('KeyR');
    await playKeys(page, into);
    await page.waitForTimeout(500);
    expect(await gt<string>(page, 'state')).toBe('caught');
    const perf = await measureFps(page, 3000);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・床の灯りや粒 ${ov}枚・画質の段階 ${await gt<number>(page, 'quality')}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(6 * 60_000);
    const SHORT = process.env.SHORT_VIDEO === '1';
    const replay = (m: Model, acts: number[]) => { let s: St = { p: m.h.start, t: 0, koG: -1, body: -1, items: 0 }; for (const a of acts) s = m.step(s, a).s; return s; };
    const openFor = async (page: Page, cfg: Cfg) => {
      await page.addInitScript(installBot, cfg);
      await page.goto(url());
      await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    };
    // 残りの時間に手順を割りふって、止まらずに最後まで遊ぶ(最後の tail ミリ秒は結果を見せる)
    const pace = async (page: Page, clip: Clip, acts: number[], tail: number, lo = 150, hi = 420) => {
      for (let i = 0; i < acts.length; i++) {
        await page.keyboard.press(KEYS[acts[i]]);
        const gap = (clip.until - Date.now() - tail) / (acts.length - i);
        await page.waitForTimeout(Math.max(lo, Math.min(hi, gap)));
      }
    };
    let hook: { pre: number[]; ko: number[]; seen: number[] }, basic: number[] = [], heist: { pre: number[]; rest: number[] };
    await recordScenes(browser, target!.dir, [
      // ① つかみ: 見張りの背後から眠らせ、数歩すり抜けたところで灯りに入って「発見」
      {
        seconds: 4,
        shortSeconds: 4.5,
        setup: async (page) => {
          await openFor(page, { seed: 111, n: 4, sound: true });
          await start(page);
          const m = new Model(await house(page));
          const ko = m.search((r, s) => r === 'ok' && s.koG >= 0)!;
          const after = replay(m, ko);
          const seen = m.search((r, s) => r === 'seen' && s.t - after.t >= 2, () => false, 40, () => true, after)!;
          expect(ko && seen, '動画: 眠らせてから見つかる手順が見つかりません').toBeTruthy();
          const cut = Math.max(0, ko.length - 2);
          hook = { pre: ko.slice(0, cut), ko: ko.slice(cut), seen };
          await playKeys(page, hook.pre, 60);
          await page.waitForTimeout(2600);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.waitForTimeout(150);
          for (const a of hook.ko) { await page.keyboard.press(KEYS[a]); await page.waitForTimeout(280); }
          expect((await player(page)).ko, '動画: 眠らせられませんでした').toBeGreaterThan(0);
          await page.waitForTimeout(150);
          await playKeys(page, hook.seen, 240);
          expect(await gt<string>(page, 'state'), '動画: 見つかる場面になりません').toBe('caught');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
      // ② 基本: 計画書から忍び込み、灯りの切れ目を縫って宝石を盗み、窓から逃げる(1件目)
      {
        seconds: 10,
        setup: async (page) => {
          await openFor(page, { seed: 112, n: 1, sound: true });
          await page.waitForTimeout(1200);
          basic = new Model(await house(page)).solveFull()!;
        },
        play: async (page, clip) => {
          clip.mark();
          await page.waitForTimeout(1000);
          await start(page);
          await page.waitForTimeout(500);
          await pace(page, clip, basic, 1600);
          expect(await gt<string>(page, 'state'), '動画: 1件目を逃げきれません').toBe('escaped');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
      // ③ 宝石を盗んだ瞬間に屋敷が警戒し、灯りが伸びる。帰り道をすり抜けて★の調書
      {
        seconds: 5,
        setup: async (page) => {
          await openFor(page, { seed: 113, n: 5, sound: true });
          await start(page);
          const m = new Model(await house(page));
          const sol = m.solveFull()!;
          let j = 0, s: St = { p: m.h.start, t: 0, koG: -1, body: -1, items: 0 };
          for (; j < sol.length; j++) { s = m.step(s, sol[j]).s; if (s.items & 1) break; }
          const cut = Math.max(0, j - 1);
          heist = { pre: sol.slice(0, cut), rest: sol.slice(cut) };
          await playKeys(page, heist.pre, 60);
          await page.waitForTimeout(2600);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.waitForTimeout(200);
          await page.keyboard.press(KEYS[heist.rest[0]]);
          await page.waitForTimeout(300);
          await page.keyboard.press(KEYS[heist.rest[1]]);
          await page.waitForTimeout(450);
          expect((await player(page)).items & 1, '動画: 宝石を盗めていません').toBe(1);
          if (!SHORT) await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          await pace(page, clip, heist.rest.slice(2), 1500, 110, 300);
          expect(await gt<string>(page, 'state'), '動画: 逃げきれません').toBe('escaped');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
    ]);
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(3 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    await open(page, { seed: 121, n: 4 });
    await page.waitForTimeout(1200);
    await shot('1-title');
    await start(page);
    await page.waitForTimeout(1500);
    await shot('2-start');
    const h = await house(page), m = new Model(h);
    const sol = m.search((r, s) => r === 'win' && s.items === m.full() && s.koG >= 0) ?? m.solveFull()!;
    let s: St = { p: h.start, t: 0, koG: -1, body: -1, items: 0 }, k = 0;
    for (; k < sol.length; k++) { s = m.step(s, sol[k]).s; await page.keyboard.press(KEYS[sol[k]]); if (s.koG >= 0) break; }
    await page.waitForTimeout(700);
    await shot('3-ko');
    for (k++; k < sol.length - 1; k++) await page.keyboard.press(KEYS[sol[k]]);
    await page.waitForTimeout(700);
    await shot('4-busy');
    await page.keyboard.press(KEYS[sol[sol.length - 1]]);
    await page.waitForTimeout(2000);
    await shot('5-report');
    await page.reload();
    await start(page);
    const into = m.search((r) => r === 'seen', () => false)!;
    await playKeys(page, into);
    await page.waitForTimeout(900);
    await shot('6-caught');
    if (info.project.name !== 'mobile') {
      // 投稿用の動画のコマを9枚ずつ並べて見る
      for (const f of fs.readdirSync(target!.dir).filter((x) => /^play-\d+\.webm$/.test(x))) {
        const src = pathToFileURL(path.join(target!.dir, f)).href;
        await page.setContent('<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(3,1fr);gap:2px"></body>');
        // 再生しながら、決まった時刻のコマを canvas に写す(webm は飛ばし読みが不正確なため)
        const dur = await page.evaluate(async (src) => {
          const v = document.createElement('video'); v.src = src; v.muted = true;
          await new Promise((r) => (v.onloadeddata = r));
          const cs: HTMLCanvasElement[] = [];
          for (let i = 0; i < 9; i++) { const c = document.createElement('canvas'); c.width = v.videoWidth / 2; c.height = v.videoHeight / 2; c.style.width = '100%'; document.body.appendChild(c); cs.push(c); }
          let k = 0;
          await new Promise<void>((done) => {
            const grab = () => {
              while (k < 9 && (v.currentTime >= (v.duration * (k + 0.5)) / 9 || v.ended)) { cs[k].getContext('2d')!.drawImage(v, 0, 0, cs[k].width, cs[k].height); k++; }
              if (k >= 9 || v.ended) done(); else requestAnimationFrame(grab);
            };
            v.onended = () => grab();
            v.play().then(grab);
          });
          return v.duration;
        }, src);
        console.log(`  ${f}: ${dur.toFixed(2)}秒`);
        await page.screenshot({ path: path.join(dir, `video-${f}.png`), fullPage: true });
      }
      return;
    }
    for (const [w, hh, name] of [[844, 390, 'a-landscape'], [360, 640, 'b-small']] as const) {
      await page.setViewportSize({ width: w, height: hh });
      await page.goto(url());
      await page.waitForTimeout(1200);
      await shot(`${name}-title`);
      await start(page);
      await page.waitForTimeout(1500);
      await shot(`${name}-play`);
    }
  });
});
