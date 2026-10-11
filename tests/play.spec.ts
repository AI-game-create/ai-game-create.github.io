import { test, expect, Page, Browser } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';
import { recordScenes } from './video';
import { measureFps } from './perf';

// ============================================================================
//  プレイテスト: 今日のゲームの「核の遊び」が本当に機能するかを、実際に操作して確かめる。
//  対象: 汐見湾ナイトラン(2026-10-13・オーナーの注文)
//  夜の港町を車で走り、光の柱で仕事(運び・強奪)を受けて稼ぐ。悪いことをすると手配度が上がり、パトカーが追ってくる。
//  見通しの外へ逃げ切るか、見られずに車を乗りかえると手配が下がる。手持ちは隠れ家の金庫に入れるまで確定しない。
//
//  ・自動プレイヤーはページの中で動く(window.__autoStep が 1/60 秒ごとに呼ばれる)。本物のキー(KeyboardEvent)で操る
//  ・ゲームから読むのは、街の形・自分と車とパトカーの位置・仕事の場所だけ。道すじと判断はテストの側で考える
//  ・早送り(__simSpeed)と、描かずに遊びだけ進める(__noDraw)は、自動プレイを短い時間で回すためだけに使う
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-13-shiomi-nightrun';
const target = latestGame();
const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const REVIEW = path.join(__dirname, '..', 'test-results', 'review');
const PEEK_ON = false; // 調べるときだけ true にする(様子見のテスト)

type Cfg = { seed: number; sound?: boolean; save?: Record<string, unknown> };
function installInit(cfg: Cfg) {
  let s = cfg.seed >>> 0;
  Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try {
    if (!localStorage.getItem('shiomi-nightrun-v1')) localStorage.setItem('shiomi-nightrun-v1', JSON.stringify(Object.assign({ sound: !!cfg.sound }, cfg.save || {})));
  } catch { /* なし */ }
}
async function open(page: Page, cfg: Cfg) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(installInit, cfg);
  await page.goto(url());
  await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
  return errors;
}
async function start(page: Page) {
  await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
}

// ---------------------------------------------------------------------------
//  自動プレイヤー(ページの中で動く)
//   think   : 近い仕事を取り(強奪は近くて車が元気なときだけ)、手配がつけば見通しを切る交差点へ逃げ、
//             見られていなければ近くの車に乗りかえる。手持ちがたまるか2件こなしたら、手配のないときに隠れ家へ
//   safe    : 運びだけ。1件ごとに隠れ家へ入れる
//   greedy  : 強奪を優先し、手持ちを積みつづける(12万円をこえるまで隠れ家に寄らない)。逃げるのも雑
//   reckless: アクセル全開で、交差点ででたらめに曲がる。仕事も手配も気にしない
//   random  : でたらめな交差点を目ざして走る。手配も気にしない
//   goto    : cfg.to まで走って止まる(個別の確かめ用)
//   rammer  : いちばん近いパトカーに体当たりしにいく
// ---------------------------------------------------------------------------
type BotCfg = { kind: 'think' | 'safe' | 'greedy' | 'reckless' | 'random' | 'goto' | 'rammer'; seed: number; maxT?: number; to?: number[]; noJack?: boolean; stopAtStars?: number; untilEvent?: string; idle?: boolean };
function botInstall(cfg: BotCfg) {
  const w = window as any, g = w.gameTest;
  const city = g.city(), P = city.P, NX = city.NX, NZ = city.NZ, HR = city.HR;
  let sd = (cfg.seed >>> 0) || 1;
  const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const down: Record<string, boolean> = {};
  const key = (code: string, on: boolean) => { if (!!down[code] === on) return; down[code] = on; w.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code })); };
  const tap = (code: string) => { w.dispatchEvent(new KeyboardEvent('keydown', { code })); w.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const ang = (a: number, b: number) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const nodeOf = (x: number, z: number) => [clamp(Math.round(x / P), 0, NX), clamp(Math.round(z / P), 0, NZ)];
  const B: any = (w.__bot = { cfg, done: false, err: '', t: 0, wps: null, goal: null, goalKey: '', planT: 0, stuck: 0, rev: 0, log: [], logT: 0, result: null, escT: 0, jackT: 0, mode: '', lastTurn: null, banks: 0 });
  function bfs(a: number[], b: number[], avoid?: (n: number[]) => number) {
    const Wn = NX + 1, Hn = NZ + 1, id = (i: number, j: number) => j * Wn + i;
    const dist = new Float64Array(Wn * Hn).fill(1e9), prev = new Int32Array(Wn * Hn).fill(-1), done = new Uint8Array(Wn * Hn);
    dist[id(a[0], a[1])] = 0;
    for (;;) {
      let c = -1, best = 1e9;
      for (let k = 0; k < dist.length; k++) if (!done[k] && dist[k] < best) { best = dist[k]; c = k; }
      if (c < 0) break;
      done[c] = 1;
      if (c === id(b[0], b[1])) break;
      const ci = c % Wn, cj = (c / Wn) | 0;
      for (const [ni, nj] of [[ci + 1, cj], [ci - 1, cj], [ci, cj + 1], [ci, cj - 1]]) {
        if (ni < 0 || nj < 0 || ni >= Wn || nj >= Hn) continue;
        const n = id(ni, nj), wgt = 1 + (avoid ? avoid([ni, nj]) : 0);
        if (dist[c] + wgt < dist[n]) { dist[n] = dist[c] + wgt; prev[n] = c; }
      }
    }
    const path: number[][] = [];
    for (let c = id(b[0], b[1]); c >= 0; c = prev[c]) path.unshift([c % Wn, (c / Wn) | 0]);
    return path;
  }
  // 左側の車線ぞいの通り道(交差点の中心から左へ 2.4m ずらす)
  function plan(p: any, gx: number, gz: number, avoid?: (n: number[]) => number) {
    const fx = Math.cos(p.h), fz = Math.sin(p.h);
    // 進行方向の先にある交差点から始める(いきなりUターンしない)
    const onH = Math.abs(p.z - Math.round(p.z / P) * P) < HR, onV = Math.abs(p.x - Math.round(p.x / P) * P) < HR;
    let s = nodeOf(p.x, p.z);
    if (onH && !onV) s = [clamp(fx > 0 ? Math.ceil(p.x / P) : Math.floor(p.x / P), 0, NX), clamp(Math.round(p.z / P), 0, NZ)];
    else if (onV && !onH) s = [clamp(Math.round(p.x / P), 0, NX), clamp(fz > 0 ? Math.ceil(p.z / P) : Math.floor(p.z / P), 0, NZ)];
    // ゴールのある道の両端のうち近いほう
    const gH = Math.abs(gz - Math.round(gz / P) * P) < HR + 1, gV = Math.abs(gx - Math.round(gx / P) * P) < HR + 1;
    let ends: number[][] = [nodeOf(gx, gz)];
    if (gH && !gV) ends = [[clamp(Math.floor(gx / P), 0, NX), clamp(Math.round(gz / P), 0, NZ)], [clamp(Math.ceil(gx / P), 0, NX), clamp(Math.round(gz / P), 0, NZ)]];
    else if (gV && !gH) ends = [[clamp(Math.round(gx / P), 0, NX), clamp(Math.floor(gz / P), 0, NZ)], [clamp(Math.round(gx / P), 0, NX), clamp(Math.ceil(gz / P), 0, NZ)]];
    // 来た道へ戻る(Uターン)は選ばない
    const back = [s[0] - Math.round(onH && !onV ? Math.sign(fx) : 0), s[1] - Math.round(onV && !onH ? Math.sign(fz) : 0)];
    const firsts = (onH !== onV) ? [[s[0] + 1, s[1]], [s[0] - 1, s[1]], [s[0], s[1] + 1], [s[0], s[1] - 1]].filter(([a, b]) => a >= 0 && b >= 0 && a <= NX && b <= NZ && !(a === back[0] && b === back[1])) : [];
    let best: number[][] | null = null, bl = 1e9;
    for (const e of ends) {
      const tail = Math.hypot(e[0] * P - gx, e[1] * P - gz) / P;
      if (e[0] === s[0] && e[1] === s[1]) { const l = 1 + tail; if (l < bl) { bl = l; best = [s]; } continue; }
      if (firsts.length) { for (const f of firsts) { const path = [s, ...bfs(f, e, avoid)]; const l = path.length + tail; if (l < bl) { bl = l; best = path; } } }
      else { const path = bfs(s, e, avoid); const l = path.length + tail; if (l < bl) { bl = l; best = path; } }
    }
    const nodes = best || [s];
    // 同じ道の上でゴールが前にあるなら、交差点を通らずに行く
    const ahead = ((gx - p.x) * fx + (gz - p.z) * fz);
    const sameRoad = (onH && gH && !onV && Math.abs(gz - p.z) < 10 && Math.abs(Math.round(gz / P) - Math.round(p.z / P)) === 0) || (onV && gV && !onH && Math.abs(gx - p.x) < 10 && Math.round(gx / P) === Math.round(p.x / P));
    const wps: number[][] = [];
    if (!(sameRoad && ahead > 0)) {
      for (let k = 0; k < nodes.length; k++) {
        const n = nodes[k], x = n[0] * P, z = n[1] * P;
        const prev = k > 0 ? nodes[k - 1] : null, next = k < nodes.length - 1 ? nodes[k + 1] : null;
        let ox = 0, oz = 0;
        const addL = (a: number[], b: number[]) => { const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[1] - a[1]); ox += dz * 2.4; oz += -dx * 2.4; };
        if (prev) addL(prev, n); else if (next) addL(n, next);
        if (next && prev) { const d1 = [n[0] - prev[0], n[1] - prev[1]], d2 = [next[0] - n[0], next[1] - n[1]]; if (d1[0] !== d2[0] || d1[1] !== d2[1]) addL(n, next); }
        wps.push([x + ox, z + oz]);
      }
    }
    wps.push([gx, gz]);
    return wps;
  }
  function drive(p: any, vMax: number, stopAtEnd: boolean) {
    const wps = B.wps;
    while (wps.length > 1) {
      const [x, z] = wps[0], d = Math.hypot(x - p.x, z - p.z);
      const [nx, nz] = wps[1];
      const pass = (p.x - x) * (nx - x) + (p.z - z) * (nz - z) > 0;
      if (d < 7 || (d < 16 && pass)) wps.shift(); else break;
    }
    let [tx, tz] = wps[0];
    const d = Math.hypot(tx - p.x, tz - p.z);
    // 前の車をよける(右へ出て追いこす)
    let brakeFor = 99;
    if (B.t - (B.obsT || 0) > 0.1) {
      B.obsT = B.t; B.obs = null;
      const fx = Math.cos(p.h), fz = Math.sin(p.h);
      for (const c of g.cars()) {
        if (c.id === p.id) continue;
        const rx = c.x - p.x, rz = c.z - p.z, f = rx * fx + rz * fz, l = -rx * fz + rz * fx;
        if (f > 1 && f < 10 + p.speed * 0.9 && Math.abs(l) < 2.6 && (!B.obs || f < B.obs.f)) B.obs = { f, l, x: c.x, z: c.z };
      }
    }
    if (B.obs && wps.length >= 1) {
      const o = B.obs, fx = Math.cos(p.h), fz = Math.sin(p.h), side = o.l > 0.3 ? -1 : 1;
      const sx = -fz * side * 3.6, sz = fx * side * 3.6;
      const ox = o.x + sx, oz = o.z + sz;
      if (!g.solid(ox, oz, 1.2)) { tx = ox; tz = oz; } else brakeFor = o.f;
    }
    const a = ang(p.h, Math.atan2(tz - p.z, tx - p.x));
    // 曲がり角までの距離で速さを決める
    let vw = vMax;
    if (wps.length > 1) {
      const [nx, nz] = wps[1];
      const turn = Math.abs(ang(Math.atan2(tz - p.z, tx - p.x), Math.atan2(nz - tz, nx - tx)));
      if (turn > 0.5) vw = Math.min(vw, Math.sqrt(10.5 * 10.5 + 2 * 13 * Math.max(0, d - 8)));
    } else if (stopAtEnd) vw = Math.min(vw, Math.max(0, (d - 2.5) * 0.9));
    if (Math.abs(a) > 0.8) vw = Math.min(vw, 9);
    if (brakeFor < 99) vw = Math.min(vw, Math.max(0, (brakeFor - 6) * 1.2));
    const v = p.fwd;
    const want = clamp(a * 2.6, -1, 1);
    key('ArrowRight', want > p.steer + 0.12);
    key('ArrowLeft', want < p.steer - 0.12);
    key('ArrowUp', v < vw - 0.5);
    key('ArrowDown', v > vw + 2.5 || (stopAtEnd && wps.length === 1 && d < 3 && v > 0.6));
    key('Space', false);
    return d;
  }
  function unstuck(p: any) {
    if (B.rev > 0) { B.rev -= 1 / 60; key('ArrowUp', false); key('ArrowDown', true); key('ArrowLeft', B.revS > 0); key('ArrowRight', B.revS < 0); if (B.rev <= 0) { key('ArrowDown', false); B.wps = null; } return true; }
    const atGoal = B.wps && B.wps.length === 1 && Math.hypot(B.wps[0][0] - p.x, B.wps[0][1] - p.z) < 5;
    if ((down.ArrowUp && p.speed < 1.2) || (!atGoal && p.speed < 0.8)) B.stuck += 1 / 60; else B.stuck = Math.max(0, B.stuck - 1 / 60);
    if (B.stuck > (down.ArrowUp ? 1.2 : 1.8)) { B.stuck = 0; B.rev = 1.1; B.revS = p.steer >= 0 ? 1 : -1; return true; }
    return false;
  }
  const releaseAll = () => { for (const c of Object.keys(down)) key(c, false); };
  function setGoal(p: any, x: number, z: number, keyStr: string, avoid?: (n: number[]) => number, replan = 0) {
    if (!B.wps || B.goalKey !== keyStr || (replan && B.t - B.planT > replan)) { B.wps = plan(p, x, z, avoid); B.goalKey = keyStr; B.planT = B.t; }
  }
  function pickEscape(p: any, cops: any[]) {
    const n0 = nodeOf(p.x, p.z);
    let best: number[] | null = null, bs = -1e9;
    const fx = Math.cos(p.h), fz = Math.sin(p.h);
    for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) {
      const md = Math.abs(i - n0[0]) + Math.abs(j - n0[1]);
      if (md < 1 || md > 3) continue;
      const x = i * P, z = j * P;
      let minC = 999, seen = 0;
      for (const c of cops) { const d = Math.hypot(c.x - x, c.z - z); minC = Math.min(minC, d); if (d < 120 && g.los(c.x, c.z, x, z)) seen++; }
      const dp = Math.hypot(x - p.x, z - p.z);
      const fw = ((x - p.x) * fx + (z - p.z) * fz) / (dp || 1);
      const dark = Math.abs(x - city.hwyX) < 2 ? 25 : 0;
      const turn = i !== n0[0] && j !== n0[1] ? 25 : 0;
      const sc = Math.min(minC, 160) - dp * 0.3 - seen * 45 + fw * 30 + dark + turn + rnd() * 10;
      if (sc > bs) { bs = sc; best = [x, z]; }
    }
    return best;
  }
  B.step = () => {
    try {
      if (B.done) { w.__simSpeed = 1e-6; return; }
      const st = g.state();
      if (st !== 'play') { releaseAll(); B.done = true; B.result = g.stats(); return; }
      B.t += 1 / 60;
      const p = g.player(), W = g.wanted(), S = g.stats();
      if ((cfg.maxT && g.time() > cfg.maxT) || (cfg.stopAtStars !== undefined && W.stars >= cfg.stopAtStars) || (cfg.untilEvent && g.events().some((e: any) => e.type === cfg.untilEvent))) { releaseAll(); B.done = true; B.result = S; return; }
      if (cfg.idle) { releaseAll(); return; }
      if (p.jacking) { releaseAll(); return; }
      if (unstuck(p)) return;
      const k = cfg.kind;
      if (k === 'reckless') {
        // 全開で、交差点に入るたびにでたらめな方向へ
        const n = nodeOf(p.x, p.z), key2 = n.join(',');
        if (!B.wps || B.wps.length <= 1 || B.goalKey !== key2 && Math.hypot(n[0] * P - p.x, n[1] * P - p.z) < 9) {
          const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => [n[0] + a, n[1] + b]).filter(([a, b]) => a >= 0 && b >= 0 && a <= NX && b <= NZ);
          const t2 = opts[Math.floor(rnd() * opts.length)];
          B.wps = [[t2[0] * P, t2[1] * P]]; B.goalKey = key2;
        }
        const [tx, tz] = B.wps[0];
        const a = ang(p.h, Math.atan2(tz - p.z, tx - p.x));
        const want = clamp(a * 2.6, -1, 1);
        key('ArrowRight', want > p.steer + 0.12); key('ArrowLeft', want < p.steer - 0.12);
        key('ArrowUp', true); key('ArrowDown', false);
        if (Math.hypot(tx - p.x, tz - p.z) < 8) B.wps = null;
        return;
      }
      if (k === 'random') {
        if (!B.wps || B.wps.length === 0 || (B.wps.length === 1 && Math.hypot(B.wps[0][0] - p.x, B.wps[0][1] - p.z) < 8)) { B.wps = plan(p, Math.floor(rnd() * (NX + 1)) * P, Math.floor(rnd() * (NZ + 1)) * P); B.goalKey = 'r'; }
        drive(p, 20 + rnd() * 15, false);
        return;
      }
      if (k === 'goto') { setGoal(p, cfg.to![0], cfg.to![1], 'goto'); const d = drive(p, 22, true); if (d < 3 && p.speed < 0.5) { releaseAll(); B.done = true; B.result = S; } return; }
      if (k === 'rammer') {
        const cops = g.police().filter((c: any) => c.hp > 0);
        if (!cops.length) { releaseAll(); return; }
        cops.sort((a: any, b: any) => a.dist - b.dist);
        const c = cops[0];
        if (c.dist < 40 && g.los(p.x, p.z, c.x, c.z)) {
          const a = ang(p.h, Math.atan2(c.z - p.z, c.x - p.x)), want = clamp(a * 3, -1, 1);
          key('ArrowRight', want > p.steer + 0.12); key('ArrowLeft', want < p.steer - 0.12); key('ArrowUp', true); key('ArrowDown', false);
          return;
        }
        setGoal(p, c.x, c.z, 'cop' + c.id, undefined, 2);
        drive(p, 26, false);
        return;
      }
      // ---- 考える系(think / safe / greedy) ----
      const J = g.jobs(), H = g.hideout();
      const cops = W.stars > 0 ? g.police().filter((c: any) => c.hp > 0 && c.mode !== 'patrol') : [];
      // 燃えている・傷んだ: 止まって乗りかえ
      const wantJack = !cfg.noJack && (p.burning || p.hp < p.hpMax * 0.3 || (k !== 'greedy' && W.stars > 0 && !W.seen && W.need - W.evadeT > 4));
      if (wantJack) {
        const cars = g.cars().filter((c: any) => (c.role === 'parked' || c.role === 'traffic') && c.hp > 0 && !c.exploded && c.speed < 5);
        let near: any = null, nd = 1e9;
        for (const c of cars) { const d = Math.hypot(c.x - p.x, c.z - p.z); if (d < nd) { nd = d; near = c; } }
        if (near && nd < (p.burning ? 30 : 22)) {
          if (g.canJack()) { releaseAll(); if (B.t - B.jackT > 0.5) { B.jackT = B.t; tap('KeyE'); } return; }
          setGoal(p, near.x, near.z, 'jack' + near.id, undefined, 1);
          drive(p, 14, true);
          return;
        }
      }
      if (W.stars > 0) {
        // 逃げる: 追っ手の見通しを切る交差点へ。着いたら次を選ぶ
        B.mode = 'evade';
        const wantNew = !B.wps || B.goalKey.slice(0, 3) !== 'esc' || B.wps.length <= 1 || B.t - B.escT > (k === 'greedy' ? 6 : 2.5);
        if (wantNew) {
          const t2 = k === 'greedy' ? [Math.floor(rnd() * (NX + 1)) * P, Math.floor(rnd() * (NZ + 1)) * P] : pickEscape(p, cops.length ? cops : g.police().filter((c: any) => c.hp > 0));
          if (t2) { B.wps = plan(p, t2[0], t2[1]); B.goalKey = 'esc' + B.t; B.escT = B.t; }
        }
        drive(p, k === 'greedy' ? 34 : 30, false);
        return;
      }
      const a = J.active;
      // 巡回のパトカーのいる交差点を避けて道を選ぶ(荷物を怪しまれないように)
      const patrols = k === 'greedy' ? [] : g.police().filter((c: any) => c.hp > 0 && c.mode === 'patrol');
      const avoidCops = patrols.length ? (n: number[]) => patrols.some((c: any) => Math.hypot(c.x - n[0] * P, c.z - n[1] * P) < 70) ? 4 : 0 : undefined;
      if (a) {
        if (a.kind === 'deliver') { B.mode = 'deliver'; setGoal(p, a.tx, a.tz, 'd' + a.tx, avoidCops, 3); drive(p, a.variant === 'fragile' && k !== 'greedy' ? 17 : k === 'safe' ? 24 : 28, true); return; }
        if (a.phase === 'hunt') {
          B.mode = 'hunt';
          const v = a.van, dv = Math.hypot(v.x - p.x, v.z - p.z);
          if (dv < 35 && g.los(p.x, p.z, v.x, v.z)) {
            // まっすぐ体当たり。当たったら少し下がって、もう一度
            if (B.backT > 0) { B.backT -= 1 / 60; key('ArrowUp', false); key('ArrowDown', true); key('ArrowLeft', false); key('ArrowRight', false); return; }
            if (B.lastHits === undefined) B.lastHits = v.hits;
            if (v.hits !== B.lastHits) { B.lastHits = v.hits; B.backT = 0.9; }
            const lead = 0.4, tx = v.x + v.vx * lead, tz = v.z + v.vz * lead;
            const an = ang(p.h, Math.atan2(tz - p.z, tx - p.x)), want = clamp(an * 3, -1, 1);
            key('ArrowRight', want > p.steer + 0.12); key('ArrowLeft', want < p.steer - 0.12); key('ArrowUp', true); key('ArrowDown', false);
            return;
          }
          setGoal(p, v.x, v.z, 'van', undefined, 1.5); drive(p, 30, false); return;
        }
        B.mode = 'grab'; setGoal(p, a.bag.x, a.bag.z, 'bag'); drive(p, 14, false); return;
      }
      // 隠れ家へ寄るか
      const bankAt = k === 'safe' ? 1 : k === 'greedy' ? 120000 : 22000;
      if (S.carried >= bankAt || (k === 'think' && S.chain >= 2 && S.carried > 0) || (p.hp < p.hpMax * 0.45 && k !== 'greedy')) {
        B.mode = 'bank';
        setGoal(p, H.x, H.z, 'hide');
        drive(p, 26, true);
        return;
      }
      // 仕事を選ぶ
      let best: any = null, bs = 1e9;
      for (const o of J.offers) {
        let d = Math.hypot(o.x - p.x, o.z - p.z);
        // 考える: 強奪は手ぶら(手持ち0)で、車が元気なときだけ。捕まっても失うものがない
        if (o.kind === 'heist') { if (k === 'safe') continue; if (k === 'greedy') d *= 0.3; else if (p.hp < p.hpMax * 0.7 || d > 160 || S.carried > 0) continue; else d *= 1.2; }
        if (d < bs) { bs = d; best = o; }
      }
      if (best) { B.mode = 'job'; setGoal(p, best.x, best.z, 'o' + best.id); drive(p, 28, true); return; }
      releaseAll();
    } catch (e) { B.err = String((e as Error).stack || e); }
    finally {
      B.logT -= 1 / 60;
      if (B.logT <= 0 && w.__botLog) { B.logT = w.__botLogDt || 2; try { const p = g.player(), W = g.wanted(), S = g.stats(); B.log.push(`${Math.round(g.time())}s ${B.mode}${B.obs ? ` obs${B.obs.f.toFixed(0)}/${B.obs.l.toFixed(1)}` : ''}${B.rev > 0 ? ' REV' : ''} h${p.h.toFixed(2)} st${p.steer.toFixed(1)} wp0${B.wps && B.wps[0] ? B.wps[0].map((v: number) => v.toFixed(0)).join(',') : ''} (${p.x.toFixed(0)},${p.z.toFixed(0)}) v${p.speed.toFixed(0)} hp${p.hp.toFixed(0)} ★${W.stars}${W.seen ? 's' : ''} ¥${S.banked}/${S.carried} wp${B.wps ? B.wps.length : '-'}`); } catch { /* なし */ } }
    }
  };
  w.__autoStep = B.step;
}
async function runBot(page: Page, cfg: BotCfg, opts: { speed?: number; noDraw?: boolean; timeout?: number } = {}) {
  await page.evaluate(([c, o]) => { (window as any).__simSpeed = o.speed ?? 20; (window as any).__noDraw = o.noDraw ?? true; }, [cfg, opts] as const);
  await page.evaluate(botInstall, cfg);
  // 終わったらすぐに時間を止める(読むまでのあいだに早送りで先へ進まないように)
  await expect.poll(() => page.evaluate(() => { const w = window as any, b = w.__bot; if (b.done || b.err) { w.__simSpeed = 1e-6; return true; } return false; }), { timeout: opts.timeout ?? 300_000, intervals: [200] }).toBeTruthy();
  const bot = await page.evaluate(() => { const b = (window as any).__bot; (window as any).__autoStep = null; return { result: b.result || (window as any).gameTest.stats(), err: b.err, log: b.log }; });
  expect(bot.err, `自動プレイヤーが止まりました: ${bot.err}`).toBe('');
  return bot;
}
// 1回ぶん遊ばせて結果を返す(新しいページで)
async function playOnce(browser: Browser, cfg: BotCfg, seed: number, opts: { speed?: number } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const errors = await open(page, { seed });
    await start(page);
    const bot = await runBot(page, { ...cfg, seed }, { speed: opts.speed ?? 20 });
    const ev = await gt<any[]>(page, 'events');
    const extra = { hide: await gt<any>(page, 'hideout'), offers: (await gt<any>(page, 'jobs')).offers, state: await gt<string>(page, 'state') };
    return { ...bot, ev, errors, ...extra };
  } finally { await ctx.close(); }
}

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(target!.name, 'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください').toBe(EXPECTED);
  });

  test('テスト用の窓口 window.gameTest があり、3D(WebGL2)で夜の街を描いている', async ({ page }) => {
    const errors = await open(page, { seed: 1 });
    expect(await gt<boolean>(page, 'webgl'), 'WebGL2 が使えていません').toBe(true);
    await start(page);
    await page.waitForTimeout(1500);
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '画面がほとんど描かれていません').toBeGreaterThan(15_000);
    const c = await gt<any>(page, 'city');
    console.log(`  街: ビル${c.buildings}棟・看板${c.signs}枚・路地${c.alleys.length}本 / HDR ${await gt(page, 'hdr')}`);
    expect(c.buildings).toBeGreaterThan(60);
    expect(errors).toEqual([]);
  });

  test('運転: 人の速さで ↑ で走り出し、← → で向きが変わり、Space で横にすべり、↓ で止まる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーボードで確かめる');
    const errors = await open(page, { seed: 2 });
    await start(page);
    await page.evaluate(() => { (window as any).__noDraw = true; });
    const p0 = await gt<any>(page, 'player');
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1800);
    const p1 = await gt<any>(page, 'player');
    const ahead = (p1.x - p0.x) * Math.cos(p0.h) + (p1.z - p0.z) * Math.sin(p0.h);
    console.log(`  1.8秒アクセル: ${(p1.speed * 3.6).toFixed(0)}km/h・前へ${ahead.toFixed(1)}m`);
    expect(p1.speed, 'アクセルで速くならない').toBeGreaterThan(9);
    expect(ahead, '前へ進まない').toBeGreaterThan(8);
    // 右へ曲がる(h が増える)
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(600);
    await page.keyboard.down('Space');
    let maxSlip = 0;
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(60); maxSlip = Math.max(maxSlip, (await gt<any>(page, 'player')).slip); }
    await page.keyboard.up('Space');
    await page.keyboard.up('ArrowRight');
    const p2 = await gt<any>(page, 'player');
    let dh = p2.h - p1.h; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    console.log(`  右へ: 向き ${dh.toFixed(2)}rad・ドリフト中の横すべり最大 ${maxSlip.toFixed(1)}m/s`);
    expect(dh, '→ で右へ曲がらない').toBeGreaterThan(0.5);
    expect(maxSlip, 'Space で横にすべらない').toBeGreaterThan(3);
    await page.keyboard.up('ArrowUp');
    await page.keyboard.down('ArrowDown');
    await expect.poll(async () => (await gt<any>(page, 'player')).fwd, { timeout: 2500, intervals: [50], message: '↓ で止まらない' }).toBeLessThan(1);
    // 押しつづけるとバックする
    await expect.poll(async () => (await gt<any>(page, 'player')).fwd, { timeout: 3000, message: '↓ でバックしない' }).toBeLessThan(-2);
    await page.keyboard.up('ArrowDown');
    expect(errors).toEqual([]);
  });

  test('ぶつかる: 人の速さで壁へ突っこむと、火花が散り、車が傷む。傷んだ車は煙を出し、燃えると数秒で爆発する', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーボードで確かめる');
    const errors = await open(page, { seed: 4 });
    await start(page);
    await page.evaluate(() => { (window as any).__noDraw = true; });
    // 右へ切って道を横切り、向こう側の歩道とビルへ
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(900);
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(450);
    await page.keyboard.up('ArrowRight');
    let parts = 0;
    await expect.poll(async () => { parts = Math.max(parts, await gt<number>(page, 'particles')); const p = await gt<any>(page, 'player'); return p.hp < p.hpMax; }, { timeout: 6000, intervals: [50], message: '壁にぶつかっても傷まない' }).toBe(true);
    for (let i = 0; i < 5; i++) { parts = Math.max(parts, await gt<number>(page, 'particles')); await page.waitForTimeout(40); }
    await page.keyboard.up('ArrowUp');
    const p = await gt<any>(page, 'player');
    console.log(`  衝突: 車の傷み ${(100 - p.hp / p.hpMax * 100).toFixed(0)}%・粒 ${parts}`);
    expect(p.hp, 'ぶつかっても車が傷まない').toBeLessThan(p.hpMax);
    expect(parts, '火花が出ない').toBeGreaterThan(3);
    // 燃える → 爆発(ここだけ段取りで車を燃やす)
    await page.evaluate(() => (0, eval)('G.car.hp = 0;'));
    await expect.poll(async () => (await gt<any>(page, 'player')).burning, { timeout: 2000 }).toBe(true);
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 9000, message: '燃えた車が爆発しない' }).not.toBe('play');
    const ev = await gt<any[]>(page, 'events');
    expect(ev.some((e) => e.type === 'explode'), '爆発しない').toBe(true);
    expect(errors).toEqual([]);
  });

  test('運びの仕事と金庫: 青い柱で仕事を受け、行き先に届けると手持ちが増え、手配のないときに隠れ家に止まると金庫へ入る', async ({ page }) => {
    test.setTimeout(180_000);
    // 自動プレイヤーが途中で捕まる晩もあるので、金庫まで届いた晩で確かめる(最大3晩)
    let errors: string[] = [], bot: any = null, ev: any[] = [], pg = page;
    for (const seed of [13, 14, 15]) {
      pg = seed === 13 ? page : await (await page.context().browser()!.newContext()).newPage();
      errors = await open(pg, { seed });
      await start(pg);
      bot = await runBot(pg, { kind: 'think', seed, untilEvent: 'bank', maxT: 240 });
      ev = await gt<any[]>(pg, 'events');
      if (ev.some((e) => e.type === 'bank')) break;
      console.log(`  種${seed}: 金庫まで届かず(${(await gt<any>(pg, 'stats')).cause || '時間切れ'})`);
    }
    const page2 = pg;
    const acc = ev.find((e) => e.type === 'accept'), del = ev.find((e) => e.type === 'deliver'), bank = ev.find((e) => e.type === 'bank');
    console.log(`  受けた ${acc?.t}s → 届けた ${del?.t}s(${del?.pay}円)→ 金庫 ${bank?.t}s(${bank?.got}円・上乗せ${bank?.bonus})`);
    expect(acc, '仕事を受けられない').toBeTruthy();
    expect(del && del.pay, '届けても手持ちが増えない').toBeGreaterThan(0);
    expect(bank && bank.got, '隠れ家で金庫に入らない').toBeGreaterThan(0);
    const s = await gt<any>(page2, 'stats');
    expect(s.banked).toBe(bank.got);
    expect(s.carried, '金庫に入れたあとも手持ちが残っている').toBe(0);
    expect((await gt<any>(page2, 'hud')).vault).toContain(bank.got.toLocaleString('ja-JP'));
    expect(bot.err).toBe('');
    expect(errors).toEqual([]);
  });

  test('手配と逃走: パトカーに体当たりすると手配度が上がって追われ、見通しの外へ逃げ切ると手配が消える', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await open(page, { seed: 21 });
    await start(page);
    await runBot(page, { kind: 'rammer', seed: 21, stopAtStars: 1, maxT: 120 });
    const w1 = await gt<any>(page, 'wanted');
    expect(w1.stars, 'パトカーにぶつけても手配度が上がらない').toBeGreaterThanOrEqual(1);
    const t1 = await gt<number>(page, 'time');
    // 数秒で追っ手がそろう
    await page.evaluate(() => { (window as any).__simSpeed = 4; });
    await expect.poll(async () => (await gt<any[]>(page, 'police')).filter((c) => c.mode === 'chase' && c.hp > 0).length, { timeout: 15000, message: 'パトカーが追ってこない' }).toBeGreaterThanOrEqual(2);
    await runBot(page, { kind: 'think', seed: 21, untilEvent: 'clear', maxT: t1 + 150, noJack: true });
    let ev = await gt<any[]>(page, 'events');
    let clr = ev.find((e) => e.type === 'clear');
    const tries = [`種21: ${clr ? `${(clr.t - t1).toFixed(0)}秒で逃げ切り` : `だめ(${(await gt<any>(page, 'stats')).cause || '時間切れ'})`}`];
    // 逃げ切れるかは腕と運しだい。考える自動プレイヤーで、ほかの晩でも試す
    for (const seed of [22, 25]) {
      if (clr) break;
      const ctx = await page.context().browser()!.newContext(); const p2 = await ctx.newPage();
      await open(p2, { seed }); await start(p2);
      await runBot(p2, { kind: 'rammer', seed, stopAtStars: 1, maxT: 120 });
      const ta = await gt<number>(p2, 'time');
      await runBot(p2, { kind: 'think', seed, untilEvent: 'clear', maxT: ta + 150, noJack: true });
      ev = await gt<any[]>(p2, 'events'); clr = ev.find((e) => e.type === 'clear');
      tries.push(`種${seed}: ${clr ? `${(clr.t - ta).toFixed(0)}秒で逃げ切り` : 'だめ'}`);
      if (clr) expect((await gt<any>(p2, 'wanted')).stars).toBe(0);
      await ctx.close();
    }
    console.log(`  手配がついてから: ${tries.join(' / ')}`);
    expect(clr, '逃げても手配が消えない').toBeTruthy();
    expect(errors).toEqual([]);
  });

  test('乗りかえ: 止まって近くの車で E を押すと乗りかわる。見られていなければ手配が一段下がる', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await open(page, { seed: 5 });
    await start(page);
    await page.evaluate(() => { (window as any).__noDraw = true; });
    const me = await gt<any>(page, 'player');
    // いちばん近い駐車中の車の横まで走る
    const cars = (await gt<any[]>(page, 'cars')).filter((c) => c.role === 'parked');
    cars.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
    const tgt = cars[0];
    await runBot(page, { kind: 'goto', seed: 5, to: [tgt.x - Math.sin(tgt.h) * 3.6, tgt.z + Math.cos(tgt.h) * 3.6], maxT: 80 });
    await page.evaluate(() => { (window as any).__simSpeed = 1; });
    await expect.poll(() => gt<boolean>(page, 'canJack'), { timeout: 3000, message: '近くの車に乗りかえられない' }).toBe(true);
    await page.keyboard.press('KeyE');
    await expect.poll(async () => (await gt<any>(page, 'player')).id, { timeout: 4000, message: 'E で乗りかわらない' }).not.toBe(me.id);
    // 手配中・見られていないときに乗りかえる(手配★2を段取りでつけ、追っ手は遠くに置く)
    await page.evaluate(() => (0, eval)(`G.stars = 2; G.maxStars = 2; G.seen = false; G.lastKnown = { x: G.car.x + 300, z: G.car.z }; G.evadeT = 0; for (const c of G.cars) if (c.role === 'police') removeCar(c);`));
    // さっき降りた車がすぐ横にある
    await expect.poll(() => gt<boolean>(page, 'canJack'), { timeout: 3000 }).toBe(true);
    const s0 = (await gt<any>(page, 'wanted')).stars;
    await page.keyboard.press('KeyE');
    await expect.poll(async () => (await gt<any>(page, 'wanted')).stars, { timeout: 4000, message: '見られずに乗りかえても手配が下がらない' }).toBe(s0 - 1);
    console.log(`  乗りかえ: ${me.type} → ${(await gt<any>(page, 'player')).type}・手配 ★${s0} → ★${s0 - 1}`);
    expect(errors).toEqual([]);
  });

  test('強奪: 赤い柱で受けると現金輸送車が現れ、3回体当たりすると扉が開き、現金を拾うと大金が入って手配度が★2以上になる', async ({ browser }) => {
    test.setTimeout(300_000);
    let done: any = null;
    for (const seed of [31, 32, 33, 34]) {
      const r = await playOnce(browser, { kind: 'greedy', seed, untilEvent: 'heist', maxT: 260 }, seed);
      const h = r.ev.find((e: any) => e.type === 'heist');
      if (h) { done = { r, h, seed }; break; }
    }
    expect(done, '強奪を最後までこなせない').toBeTruthy();
    const ev = done.r.ev;
    const hits = ev.filter((e: any) => e.type === 'vanHit').length, open2 = ev.find((e: any) => e.type === 'vanOpen');
    const st = ev.filter((e: any) => e.type === 'stars' && e.t >= done.h.t - 0.01);
    console.log(`  強奪(種${done.seed}): 体当たり${hits}回 → 扉 ${open2?.t}s → 現金 ${done.h.pay}円 ${done.h.t}s → ★${st[0]?.stars}`);
    expect(hits).toBeGreaterThanOrEqual(3);
    expect(open2).toBeTruthy();
    expect(done.h.pay).toBeGreaterThanOrEqual(40000);
    expect(st[0]?.stars, '強奪しても手配度が上がらない').toBeGreaterThanOrEqual(2);
    expect(done.r.errors).toEqual([]);
  });

  test('確保と結果: 手配中に止まっているとパトカーに囲まれて確保され、手持ちは没収。結果が出て、もう一晩遊べ、記録は再読み込みしても残る', async ({ page }) => {
    test.setTimeout(240_000);
    // まず金庫に入れる(自動プレイヤーが途中で捕まる晩もあるので、最大3晩)
    let errors: string[] = [], banked = 0, seed = 13;
    for (seed of [13, 14, 15]) {
      if (seed !== 13) page = await (await page.context().browser()!.newContext()).newPage();
      errors = await open(page, { seed });
      await start(page);
      await runBot(page, { kind: 'think', seed, untilEvent: 'bank', maxT: 240 });
      banked = (await gt<any>(page, 'stats')).banked;
      if (banked > 0) break;
    }
    expect(banked).toBeGreaterThan(0);
    await runBot(page, { kind: 'rammer', seed, stopAtStars: 1, maxT: 400 });
    await page.evaluate(() => (0, eval)('G.carried = 12300; G.car.hp = G.car.T.hp;'));
    await runBot(page, { kind: 'think', seed, idle: true, maxT: 500 }, { speed: 4 });
    const st = await gt<any>(page, 'stats');
    console.log(`  確保: ${st.cause}・没収 ${st.lost}円・金庫 ${st.banked}円`);
    expect(st.cause, '止まっていても確保されない').toBe('busted');
    expect(st.lost).toBe(12300);
    await page.evaluate(() => { (window as any).__simSpeed = 4; });
    await expect(page.locator('#result')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#rep')).toContainText(banked.toLocaleString('ja-JP'));
    await page.evaluate(() => { (window as any).__simSpeed = 1; });
    await page.locator('#b-retry').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    expect((await gt<any>(page, 'stats')).banked, 'もう一晩は金庫0から').toBe(0);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    expect((await gt<any>(page, 'save')).best, '記録が残らない').toBe(banked);
    await expect(page.locator('#best')).toContainText(banked.toLocaleString('ja-JP'));
    expect(errors).toEqual([]);
  });

  test('腕の差: 考える自動プレイヤーは、「暴走」「でたらめ」の1.5倍以上を金庫に入れる(1晩3分・種4つ)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で1回');
    test.setTimeout(600_000);
    const seeds = [41, 42, 43, 44];
    const res: Record<string, number[]> = { think: [], reckless: [], random: [] };
    const lens: number[] = [];
    for (const kind of ['think', 'reckless', 'random'] as const) for (const seed of seeds) {
      const r = await playOnce(browser, { kind, seed, maxT: 180 }, seed);
      res[kind].push(r.result.banked);
      if (kind === 'think') lens.push(r.result.t);
      expect(r.errors).toEqual([]);
    }
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const t = avg(res.think), k = avg(res.reckless), d = avg(res.random);
    console.log(`  金庫の平均: 考える ${t.toFixed(0)}円 [${res.think.join(', ')}] / 暴走 ${k.toFixed(0)}円 / でたらめ ${d.toFixed(0)}円・考えるの1晩の長さ ${lens.map((v) => Math.round(v)).join(', ')}秒`);
    expect(t, '考えて遊んでも稼げない').toBeGreaterThan(0);
    expect(t, '暴走と変わらない').toBeGreaterThanOrEqual(k * 1.5);
    expect(t, 'でたらめと変わらない').toBeGreaterThanOrEqual(d * 1.5);
    expect(res.think.filter((v) => v > 0).length, '考えても稼げない晩が多い').toBeGreaterThanOrEqual(3);
  });

  test('毎回ちがう: 遊ぶたびに、隠れ家の場所・路地の並び・仕事の場所・その晩の出来事が変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で1回');
    test.setTimeout(300_000);
    const outs: any[] = [];
    for (const seed of [51, 52, 53]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed });
      const c = await gt<any>(page, 'city'), h = await gt<any>(page, 'hideout'), j = await gt<any>(page, 'jobs');
      await start(page);
      await runBot(page, { kind: 'think', seed, maxT: 120 });
      const ev = (await gt<any[]>(page, 'events')).filter((e) => ['accept', 'deliver', 'bank', 'stars', 'heist', 'jack', 'clear'].includes(e.type));
      outs.push({ hide: `${Math.round(h.x)},${Math.round(h.z)}`, alleys: c.alleys.map((a: any) => `${Math.round(a.x0)},${Math.round(a.z0)}`).join('|'), offers: j.offers.map((o: any) => `${o.kind[0]}${Math.round(o.x)},${Math.round(o.z)}`).join('|'), ev: ev.map((e) => `${e.type}${Math.round(e.t / 5)}`).join(' ') });
      await ctx.close();
    }
    for (const o of outs) console.log(`  隠れ家 ${o.hide} / 路地 ${o.alleys.split('|').length}本 / 仕事 ${o.offers} / ${o.ev.slice(0, 80)}`);
    for (const k of ['hide', 'alleys', 'offers', 'ev']) expect(new Set(outs.map((o) => o[k])).size, `${k} が毎回同じ`).toBe(3);
  });

  test('選択の重さ: 「堅実(運びだけ・1件ごとに金庫へ)」と「欲張り(強奪・積みつづける)」で、金庫の額・失う額・手配のされ方がはっきり変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で1回');
    test.setTimeout(600_000);
    const seeds = [61, 62, 63, 64];
    const res: Record<string, any[]> = { safe: [], greedy: [] };
    for (const kind of ['safe', 'greedy'] as const) for (const seed of seeds) {
      const r = await playOnce(browser, { kind, seed, maxT: 180 }, seed);
      res[kind].push(r.result);
    }
    const sum = (a: any[], f: (r: any) => number) => a.reduce((s, r) => s + f(r), 0);
    const line = (k: string) => `金庫 ${sum(res[k], (r) => r.banked)}円・手持ちのまま(失うかもしれない額) ${sum(res[k], (r) => r.carried + r.lost)}円・最高★ ${res[k].map((r) => r.maxStars).join('/')}・強奪 ${sum(res[k], (r) => r.heists)}件`;
    console.log(`  堅実: ${line('safe')}\n  欲張り: ${line('greedy')}`);
    const bs = sum(res.safe, (r) => r.banked), bg = sum(res.greedy, (r) => r.banked);
    const rs = sum(res.safe, (r) => r.carried + r.lost), rg = sum(res.greedy, (r) => r.carried + r.lost);
    expect(Math.max(bs, bg), '選び方で金庫の額が変わらない').toBeGreaterThanOrEqual(Math.min(bs, bg) * 1.5 + 1);
    expect(rg, '欲張っても失うかもしれない額が増えない').toBeGreaterThan(rs * 1.5);
    expect(sum(res.greedy, (r) => r.maxStars), '欲張っても手配されない').toBeGreaterThan(sum(res.safe, (r) => r.maxStars));
  });

  test('スマホ: 画面のボタンでアクセル・ハンドル・乗りかえができる。ボタンは指で押せる大きさで、はみ出さず重ならない', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で確かめる');
    test.setTimeout(150_000);
    const errors = await open(page, { seed: 7 });
    await page.locator('#b-start').tap();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    await page.evaluate(() => { (window as any).__noDraw = true; });
    const vp = page.viewportSize()!;
    const boxes: Record<string, any> = {};
    for (const id of ['t-left', 't-right', 't-gas', 't-brk', 't-hb', 'snd']) {
      const b = (await page.locator('#' + id).boundingBox())!;
      expect(b, `${id} が見えない`).toBeTruthy();
      expect(Math.min(b.width, b.height), `${id} が小さすぎる`).toBeGreaterThanOrEqual(44);
      expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width && b.y + b.height <= vp.height, `${id} が画面からはみ出す`).toBe(true);
      boxes[id] = b;
    }
    const ids = Object.keys(boxes);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = boxes[ids[i]], b = boxes[ids[j]];
      const ov = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(ov, `${ids[i]} と ${ids[j]} が重なっている`).toBe(false);
    }
    const ctr = (id: string) => ({ x: boxes[id].x + boxes[id].width / 2, y: boxes[id].y + boxes[id].height / 2 });
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, pts: { x: number; y: number }[]) => cdp.send('Input.dispatchTouchEvent', { type: type as any, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
    const p0 = await gt<any>(page, 'player');
    await touch('touchStart', [ctr('t-gas')]);
    await page.waitForTimeout(1500);
    const p1 = await gt<any>(page, 'player');
    expect(p1.speed, 'アクセルのボタンで走らない').toBeGreaterThan(6);
    await touch('touchStart', [ctr('t-gas'), ctr('t-left')]);
    await page.waitForTimeout(700);
    await touch('touchEnd', []);
    const p2 = await gt<any>(page, 'player');
    let dh = p2.h - p1.h; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    console.log(`  スマホ: アクセル1.5秒で ${(p1.speed * 3.6).toFixed(0)}km/h・◀ で向き ${dh.toFixed(2)}rad`);
    expect(dh, '◀ のボタンで左へ曲がらない').toBeLessThan(-0.3);
    await touch('touchStart', [ctr('t-brk')]);
    await expect.poll(async () => (await gt<any>(page, 'player')).fwd, { timeout: 3000 }).toBeLessThan(1);
    await touch('touchEnd', []);
    // 近くの車の横で止まると「乗りかえ」が出て、押すと乗りかわる
    const me = await gt<any>(page, 'player');
    const cars = (await gt<any[]>(page, 'cars')).filter((c) => c.role === 'parked').sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
    await runBot(page, { kind: 'goto', seed: 7, to: [cars[0].x - Math.sin(cars[0].h) * 3.6, cars[0].z + Math.cos(cars[0].h) * 3.6], maxT: 80 });
    await page.evaluate(() => { (window as any).__simSpeed = 1; });
    await expect(page.locator('#t-act')).toBeVisible({ timeout: 4000 });
    const ab = (await page.locator('#t-act').boundingBox())!;
    expect(Math.min(ab.width, ab.height)).toBeGreaterThanOrEqual(44);
    await touch('touchStart', [{ x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 }]);
    await touch('touchEnd', []);
    await expect.poll(async () => (await gt<any>(page, 'player')).id, { timeout: 4000, message: '「乗りかえ」で乗りかわらない' }).not.toBe(me.id);
    expect(errors).toEqual([]);
  });

  test('スマホで重くない(CPU 4倍遅くても、手配★4でパトカーとヘリに追われる夜の街で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(180_000);
    await open(page, { seed: 71 });
    await page.locator('#b-start').tap();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    // 段取り: 手配★4にして追っ手を呼ぶ(しばらく自動で逃げまわる)
    await page.evaluate(() => (0, eval)(`G.stars = 4; G.maxStars = 4; G.lastKnown = { x: G.car.x, z: G.car.z }; G.seen = true; for (let k = 0; k < 4; k++) spawnPolice('chase');`));
    await page.evaluate(botInstall, { kind: 'think', seed: 71, noJack: true } as BotCfg);
    await page.waitForTimeout(9000);
    await page.evaluate(() => { const w = window as any; w.__autoStep = null; for (const c of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'Space']) window.dispatchEvent(new KeyboardEvent('keyup', { code: c })); });
    const busy = await page.evaluate(() => { const g = (window as any).gameTest; return { cops: g.police().filter((c: any) => c.mode === 'chase').length, heli: !!g.wanted().heli, near: g.police().filter((c: any) => c.dist < 120).length }; });
    // 遅いCPUにしてから画質が落ち着くのを待ち、測る(測っているあいだは gameTest を読まない)
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(5000);
    const perf = await measureFps(page, 3000);
    await page.keyboard.up('ArrowUp');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・画質の段階 ${await gt<number>(page, 'quality')}・追っ手${busy.cops}台(近く${busy.near})・ヘリ${busy.heli ? 'あり' : 'なし'}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  // 動画と見直しのスクショで、場面の手前まで一気に進めるための段取り(遊びの確かめには使わない)
  const stage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);
  const STAGE_CHASE = `(() => {
    const z = 2 * P - LANE, x0 = 1.2 * P;
    for (const c of G.cars.slice()) if (c !== G.car && Math.abs(c.z - 2 * P) < 9 && c.x > x0 - 30 && c.x < x0 + 200) removeCar(c);
    const me = G.car; me.x = x0; me.z = z; me.h = 0; me.vx = 27; me.vz = 0; me.w = 0;
    const b = mkCar('police', x0 + 52, 2 * P + 2.4, Math.PI, 'police'); b.ai.mode = 'chase'; b.hp = 0; b.burning = true; b.fuse = 1.25; b.vx = -4; G.cars.push(b);
    for (const [dx, dz] of [[115, 3.2], [140, -1.5]]) { const c = mkCar('police', x0 + dx, 2 * P + dz, Math.PI, 'police'); c.ai.mode = 'chase'; c.vx = -16; G.cars.push(c); }
    G.stars = 3; G.maxStars = 3; G.seen = true; G.lastKnown = { x: me.x, z: me.z }; G.spawnT = 99;
    cam.snap = true;
  })()`;
  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(10 * 60_000);
    const SHORT = process.env.SHORT_VIDEO === '1';
    const openFor = async (page: Page, cfg: Cfg) => {
      await page.addInitScript(installInit, cfg);
      await page.goto(url());
      await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    };
    const startP = async (page: Page) => { await page.locator('#b-start').click(); await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('play'); };
    // 最初の仕事が隠れ家から近い晩を選ぶ(②で、受けるところまで映すため)
    let seed2 = 62;
    {
      const ctx = await browser.newContext(); const p = await ctx.newPage();
      for (let s = 62; s < 90; s++) {
        await p.addInitScript(installInit, { seed: s }); await p.goto(url());
        await expect.poll(() => p.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
        const h = await gt<any>(p, 'hideout'), c = await gt<any>(p, 'city');
        const hh = ({ n: Math.PI, s: 0, w: Math.PI / 2, e: -Math.PI / 2 } as Record<string, number>)[h.side];
        const tx = h.x + Math.cos(hh) * 70, tz = h.z + Math.sin(hh) * 70;
        if (tx > 5 && tx < c.MAPX - 5 && tz > 5 && tz < c.MAPZ - 5) { seed2 = s; break; }
      }
      await ctx.close();
    }
    await recordScenes(browser, target!.dir, [
      // ① つかみ: 回転灯のパトカーが迫る濡れた大通りを飛ばす。目の前で燃えていたパトカーが爆発して宙を舞う
      {
        seconds: 4,
        shortSeconds: 6,
        setup: async (page) => {
          await openFor(page, { seed: 61, sound: true });
          await startP(page);
          await page.waitForTimeout(2500);
          await stage(page, STAGE_CHASE);
          await page.waitForTimeout(150);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.keyboard.down('ArrowUp');
          await expect.poll(async () => (await gt<any[]>(page, 'events')).some((e) => e.type === 'explode'), { timeout: 8000, intervals: [50] }).toBeTruthy();
          await page.waitForTimeout(350);
          if (!SHORT) await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          await page.keyboard.down('ArrowLeft');
          await page.waitForTimeout(300);
          await page.keyboard.up('ArrowLeft');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
          await page.keyboard.up('ArrowUp');
        },
      },
      // ② 基本: 隠れ家から走り出し、青い光の柱で「運び」の仕事を受けて、行き先へ向かう
      {
        seconds: 10,
        shortSeconds: 13,
        setup: async (page) => {
          await openFor(page, { seed: seed2, sound: true });
          await page.waitForTimeout(1500);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.locator('#b-start').click();
          // 段取り: 最初の「運び」の柱を、隠れ家の前の道の 55m 先に置く
          await stage(page, `(() => { const me = G.car, o = G.jobs.offers.find((q) => q.kind === 'deliver') || G.jobs.offers[0]; o.kind = 'deliver'; o.x = me.x + Math.cos(me.h) * 55 + Math.sin(me.h) * 0.6; o.z = me.z + Math.sin(me.h) * 55 - Math.cos(me.h) * 0.6; })()`);
          await page.waitForTimeout(400);
          await page.evaluate(botInstall, { kind: 'think', seed: seed2 } as BotCfg);
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
          await page.evaluate(() => { (window as any).__autoStep = null; });
          console.log(`  ②の出来事: ${(await gt<any[]>(page, 'events')).map((e) => `${e.t.toFixed(1)}s ${e.type}`).join(' / ')} 種${seed2}`);        },
      },
      // ③ 強奪: 現金輸送車に体当たりして扉を開け、現金を拾う。たちまち手配度が上がる
      {
        seconds: 6,
        shortSeconds: 8,
        setup: async (page) => {
          await openFor(page, { seed: 63, sound: true });
          await startP(page);
          await page.waitForTimeout(2000);
          await stage(page, `(() => {
            const z = 3 * P - LANE, x0 = 1.3 * P;
            for (const c of G.cars.slice()) if (c !== G.car && Math.abs(c.z - 3 * P) < 9 && c.x > x0 - 20 && c.x < x0 + 160) removeCar(c);
            const me = G.car; me.x = x0; me.z = z; me.h = 0; me.vx = 22; me.vz = 0;
            const van = mkCar('armored', x0 + 22, z, 0, 'van'); van.vx = 13; van.ai.cruise = 14; van.hits = 2; van.ai.flee = true; van.color = PAINT.armored[0]; G.cars.push(van);
            G.jobs.offers = []; G.jobs.active = { kind: 'heist', id: 999, van, phase: 'hunt', left: 60, timeMax: 85, cash: 52400, bag: null };
            cam.snap = true;
          })()`);
          await page.waitForTimeout(100);
        },
        play: async (page, clip) => {
          clip.mark();
          const t0 = await gt<number>(page, 'time');
          await page.evaluate(botInstall, { kind: 'greedy', seed: 63 } as BotCfg);
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
          await page.evaluate(() => { (window as any).__autoStep = null; });
          console.log(`  ③の出来事: ${(await gt<any[]>(page, 'events')).filter((e) => e.t >= t0).map((e) => `${(e.t - t0).toFixed(1)}s ${e.type}`).join(' / ')}`);
        },
      },
      // ④ 隠れ家: 手配を振り切って橙の柱へ。止まると手持ちが金庫へ入り、まとめた件数ぶん上乗せされる
      {
        seconds: 5,
        shortSeconds: 7,
        setup: async (page) => {
          await openFor(page, { seed: 64, sound: true });
          await startP(page);
          await page.waitForTimeout(2000);
          await stage(page, `(() => {
            const H = CITY.hideout, me = G.car;
            const hh = { n: Math.PI, s: 0, w: Math.PI / 2, e: -Math.PI / 2 }[H.side];
            me.h = hh; me.x = H.x - Math.cos(hh) * 55; me.z = H.z - Math.sin(hh) * 55; me.vx = Math.cos(hh) * 20; me.vz = Math.sin(hh) * 20;
            for (const c of G.cars.slice()) if (c !== G.car && Math.hypot(c.x - (H.x + me.x) / 2, c.z - (H.z + me.z) / 2) < 34 && c.role !== 'parked') removeCar(c);
            G.carried = 86400; G.chain = 3; G.banked = 41200; G.jobsDone = 3;
            cam.snap = true;
          })()`);
          await page.waitForTimeout(100);
        },
        play: async (page, clip) => {
          clip.mark();
          const t0 = await gt<number>(page, 'time');
          await page.evaluate(botInstall, { kind: 'safe', seed: 64 } as BotCfg);
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
          await page.evaluate(() => { (window as any).__autoStep = null; });
          console.log(`  ④の出来事: ${(await gt<any[]>(page, 'events')).filter((e) => e.t >= t0).map((e) => `${(e.t - t0).toFixed(1)}s ${e.type}`).join(' / ')}`);
        },
      },
    ]);
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(5 * 60_000);
    const shot = (name: string) => page.screenshot({ path: path.join(REVIEW, `${info.project.name}-${name}.png`) });
    fs.mkdirSync(REVIEW, { recursive: true });
    await open(page, { seed: 81 });
    await page.evaluate(() => { (window as any).__lockQ = 1; });
    await page.waitForTimeout(2500);
    await shot('1title');
    await page.locator('#b-start').click();
    await page.waitForTimeout(3000);
    await shot('2start');
    await stage(page, STAGE_CHASE);
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1500);
    await shot('3chase');
    await page.waitForTimeout(1200);
    await shot('4boom');
    await page.keyboard.up('ArrowUp');
    await stage(page, `G.stars = 4; G.maxStars = 4; G.heli = { x: G.car.x - 20, z: G.car.z - 10, y: 46, sx: G.car.x, sz: G.car.z, sees: true, leave: false, h: 0, blades: 0 };`);
    await page.waitForTimeout(2500);
    await shot('5heli');
    await stage(page, `G.carried = 23400; endRun('busted');`);
    await expect(page.locator('#result')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(500);
    await shot('6result');
  });

  test('様子見(自動プレイ)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop' || !PEEK_ON, '調べるときだけ');
    test.setTimeout(600_000);
    const PEEK = { bots: ['think'] as BotCfg['kind'][], seeds: [41, 43], maxT: 180, log: true, logDt: 3 };
    for (const kind of PEEK.bots) for (const seed of PEEK.seeds) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const errors = await open(page, { seed });
      await start(page);
      await page.evaluate((dt) => { (window as any).__botLog = true; (window as any).__botLogDt = dt; }, PEEK.logDt);
      const bot = await runBot(page, { kind, seed, maxT: PEEK.maxT });
      const r = bot.result;
      console.log(`${kind} seed${seed}: 金庫${r.banked} 手持ち${r.carried} 仕事${r.jobsDone}(運${r.delivers}/強${r.heists}) 最高★${r.maxStars} 逃${r.evaded} 乗${r.jacks} 潰${r.policeWrecked} 終${r.cause || '-'} t${Math.round(r.t)}`);
      if (PEEK.log) console.log(bot.log.join('\n'));
      console.log((await gt<any[]>(page, 'events')).filter((e) => !['vanHit'].includes(e.type)).map((e) => `${Math.round(e.t)}:${e.type}${e.why ? '(' + e.why + ')' : ''}${e.stars !== undefined ? e.stars : ''}`).join(' '));
      if (errors.length) console.log('errors', errors.join('\n'));
      await ctx.close();
    }
  });

  test('様子見(逃走)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop' || !PEEK_ON, '調べるときだけ');
    test.setTimeout(600_000);
    for (const seed of [21, 22, 23, 24, 25, 26]) for (const noJack of [true, false]) {
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      await open(page, { seed }); await start(page);
      await runBot(page, { kind: 'rammer', seed, stopAtStars: 1, maxT: 120 });
      const t1 = await gt<number>(page, 'time');
      await page.evaluate(() => { (window as any).__botLog = true; (window as any).__botLogDt = 2; });
      const eb = await runBot(page, { kind: 'think', seed, untilEvent: 'clear', maxT: t1 + 150, noJack });
      const ev = await gt<any[]>(page, 'events'); const clr = ev.find((e) => e.type === 'clear'); const s = await gt<any>(page, 'stats');
      console.log(`seed${seed} ${noJack ? '乗りかえなし' : '乗りかえあり'}: ${clr ? `逃げ切り ${(clr.t - t1).toFixed(0)}秒` : 'だめ'} 最高★${s.maxStars} ${s.cause || ''}`);
      if (!clr && seed === 99) console.log(eb.log.join('\n') + '\n' + ev.filter((e) => e.t > t1 - 1).map((e) => `${Math.round(e.t)}:${e.type}${e.why ? '(' + e.why + ')' : ''}`).join(' '));
      await ctx.close();
    }
  });

  test('様子見(重さ)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile' || !PEEK_ON, '調べるときだけ');
    test.setTimeout(300_000);
    await open(page, { seed: 71 });
    await page.locator('#b-start').tap();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    await page.evaluate(() => (0, eval)(`G.stars = 4; G.maxStars = 4; G.lastKnown = { x: G.car.x, z: G.car.z }; G.seen = true; for (let k = 0; k < 4; k++) spawnPolice('chase');`));
    await page.evaluate(botInstall, { kind: 'think', seed: 71, noJack: true } as BotCfg);
    await page.waitForTimeout(8000);
    await page.evaluate(() => { const w = window as any; w.__autoStep = null; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    console.log(await page.evaluate(() => (0, eval)(`'上の三角形 ' + CH.reduce((s, c) => s + (c.up ? c.up.n : 0), 0) / 3 + ' / 地面 ' + CH.reduce((s, c) => s + (c.gr ? c.gr.n : 0), 0) / 3 + ' / 高架 ' + HWYM.n / 3 + ' / 遠く ' + FARM.n / 3 + ' / 見える塊 ' + visibleChunks().length + ' / 解像度 ' + rw + 'x' + rh`)));
    await page.keyboard.down('ArrowUp');
    for (const [label, code] of [['ふつう', ''], ['1px', 'window.__onePx = 1;'], ['街なし', 'window.__noCity = 1;'], ['地面なし', 'window.__noGround = 1;'], ['足し算なし', 'window.__noAdd = 1;'], ['空なし', 'window.__noSky = 1;'], ['車なし', 'window.__noCars = 1;']] as const) {
      await page.evaluate(() => { const w = window as any; w.__onePx = w.__noCity = w.__noGround = w.__noAdd = w.__noSky = w.__noCars = 0; });
      if (code) await page.evaluate((c) => (0, eval)(c), code);
      await page.evaluate(() => { (window as any).__lockQ = 8; (window as any).__prof = { n: 0, step: 0, render: 0, ui: 0 }; });
      await page.waitForTimeout(3000);
      const pr = await page.evaluate(() => { const p = (window as any).__prof; (window as any).__prof = null; return p; });
      console.log(`${label}: ${pr.n}コマ/3秒 step ${(pr.step / pr.n).toFixed(1)}ms render ${(pr.render / pr.n).toFixed(1)}ms ui ${(pr.ui / pr.n).toFixed(1)}ms`);
    }
    await page.keyboard.up('ArrowUp');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });

  test('様子見', async ({ page }, info) => {
    test.skip(!PEEK_ON, '調べるときだけ');
    test.setTimeout(120_000);
    const errors = await open(page, { seed: 3 });
    fs.mkdirSync(REVIEW, { recursive: true });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(REVIEW, `${info.project.name}-0title.png`) });
    await page.evaluate(() => { (window as any).__lockQ = 2; });
    await start(page);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(REVIEW, `${info.project.name}-1start.png`) });
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(4000);
    await page.keyboard.up('ArrowUp');
    await page.screenshot({ path: path.join(REVIEW, `${info.project.name}-2drive.png`) });
    console.log(JSON.stringify(await gt(page, 'player')), 'q', await gt(page, 'quality'), 'refl', await gt(page, 'refl'));
    console.log(errors.join('\n'));
  });
});
