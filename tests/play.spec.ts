import { test, expect, Page, Browser } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';
import { recordScenes } from './video';
import { measureFps } from './perf';

// ============================================================================
//  プレイテスト: 今日のゲームの「核の遊び」が本当に機能するかを、実際に操作して確かめる。
//  game.spec.ts は「エラーが出ないか」しか見ないので、遊べないゲームでも通ってしまう。
//  このファイルはゲームごとに中身が違うので、毎回、今日のゲームに合わせて書き直す。
//
//  対象: 夜鳴き廊下(2026-10-12・オーナーの注文の一人称ホラー)
//  雨の夜の廃旅館を懐中電灯ひとつで探る。怪異「女将」は音と光に寄ってくる。鳴く板・走る足音・息の音で気づかれる。
//  押し入れに隠れて息を止めてやりすごし、女将の部屋の鍵 → 鏡台の裏口の鍵 → 物置の裏口から逃げる。手帳の切れ端は4枚。
//
//  ・自動プレイヤーはページの中で動く(window.__autoStep が 1/60 秒ごとに呼ばれる)。本物のキー(KeyboardEvent)で操る
//  ・ゲームから読むのは、間取り・戸・拾うもの・鳴く板・自分と女将の位置だけ。道すじと判断はテストの側で考える
//  ・早送り(__simSpeed)と、描かずに遊びだけ進める(__noDraw)は、自動プレイを短い時間で回すためだけに使う
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-12-yanaki-rouka';
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
    if (!localStorage.getItem('yanaki-rouka-v1')) localStorage.setItem('yanaki-rouka-v1', JSON.stringify(Object.assign({ sound: !!cfg.sound }, cfg.save || {})));
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
//   think : 部屋を近い順に回って拾い、鍵がそろったら女将の部屋 → 裏口へ。鳴く板はよけ(よけられなければしゃがむ)、
//           鈴が近いと明かりを消し、近づいてきたら押し入れに隠れて、前を通るときだけ息を止める
//   runner: 明かりをつけたまま走りまわる(同じ順に回る)。板もよけず、隠れない
//   random: でたらめに部屋を選んで歩き、ときどき走ったり明かりを消したりする
//   goto  : cfg.to のマスまで歩くだけ(個別の確かめ用)
//  女将の位置は、鈴の音が聞こえる近さ(16m)のときだけ使う
// ---------------------------------------------------------------------------
type BotCfg = { kind: 'think' | 'runner' | 'random' | 'goto'; seed: number; to?: number[]; noHide?: boolean; noCreak?: boolean; lightAlways?: boolean; maxT?: number; order?: string[]; crouch?: boolean; keepNote?: boolean };
function botInstall(cfg: BotCfg) {
  const w = window as any, g = w.gameTest;
  const mp = g.map(), C = mp.C, rows: string[] = mp.rows, MW = mp.w, MH = mp.h;
  let sd = (cfg.seed >>> 0) || 1;
  const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const down: Record<string, boolean> = {};
  const key = (code: string, on: boolean) => { if (!!down[code] === on) return; down[code] = on; w.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code })); };
  const tap = (code: string) => { w.dispatchEvent(new KeyboardEvent('keydown', { code })); w.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const releaseAll = () => { for (const c of Object.keys(down)) key(c, false); };
  const reg = (i: number, j: number) => (i < 0 || j < 0 || i >= MW || j >= MH ? '#' : rows[j][i]);
  const walk = (r: string) => r !== '#' && r !== 'g';
  const along = (j: number) => j <= 6 || j >= 15;
  const creaks = new Set<string>(g.creaks());
  const cellOf = (x: number, z: number) => [Math.floor(x / C), Math.floor(z / C)];
  const B: any = (w.__bot = { cfg, done: false, err: '', t: 0, plan: null, goal: null, visited: new Set<string>(), stuck: 0, lastPos: [0, 0], log: [], logT: 0, hideCalm: 0, mode: 'go', wait: 0, ePress: 0, result: null, reached: false });
  const doorsNow = () => { const o: Record<string, any> = {}; for (const d of g.map().doors) o[d.id] = d; return o; };
  // 廊下のマスを通るとき、鳴く板を踏まずにすむか。板は廊下の向きに2枚。
  // 板と同じ向きに進むなら鳴かない側を選べる(両方鳴くときだけ踏む)。板を横切るなら、どちらか鳴けば踏む
  const crossing = (i: number, j: number, di: number) => (di !== 0) !== along(j);
  function creakCost(i: number, j: number, di: number) {
    if (cfg.kind !== 'think' || cfg.noCreak || reg(i, j) !== '.') return 0;
    const l0 = creaks.has(`${i},${j},0`), l1 = creaks.has(`${i},${j},1`);
    return (crossing(i, j, di) ? l0 || l1 : l0 && l1) ? 4 : 0;
  }
  // マスの道すじ(考える自動プレイヤーは、鳴く板を踏むマスを遠回りしてでもよける)
  function path(from: number[], to: number[], avoid?: number[]) {
    const N = MW * MH, prev = new Int32Array(N).fill(-1), dist = new Int32Array(N).fill(1e9), bk: number[][] = [];
    const s = from[1] * MW + from[0], gl = to[1] * MW + to[0];
    prev[s] = s; dist[s] = 0; bk[0] = [s];
    const st = g.player();
    for (let d = 0; d < bk.length; d++) {
      const q = bk[d];
      if (!q) continue;
      let found = false;
      for (let h = 0; h < q.length; h++) {
        const c = q[h], i = c % MW, j = (c / MW) | 0;
        if (dist[c] !== d) continue;
        if (c === gl) { found = true; break; }
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nj = j + dj, n = nj * MW + ni;
          if (ni < 0 || nj < 0 || ni >= MW || nj >= MH) continue;
          const r = reg(ni, nj);
          if (!walk(r) || (r === 'o' && n !== gl)) continue;
          const e = g.edge(i, j, ni, nj);
          if (!e || (e.type !== 'open' && e.type !== 'door')) continue;
          if (e.type === 'door' && (e.door === 'front' || e.door === 'back')) continue;
          if (e.type === 'door' && e.door === 'H' && !st.key1) continue;
          if (avoid && Math.hypot(ni - avoid[0], nj - avoid[1]) < 2.2 && n !== gl) continue;
          const nd = d + 1 + creakCost(ni, nj, di);
          if (nd >= dist[n]) continue;
          dist[n] = nd; prev[n] = c; (bk[nd] ||= []).push(n);
        }
      }
      if (found) break;
    }
    if (prev[gl] < 0) return null;
    const out: number[][] = [];
    for (let k = gl; k !== s; k = prev[k]) out.push([k % MW, (k / MW) | 0]);
    return out.reverse();
  }
  // 道すじを、歩く点と戸の点に変える
  function waypoints(cells: number[][], from: number[]) {
    const wp: any[] = [];
    let prev = from, lane = -1, last: any = null;
    // 板の上の、横の位置(-1 はまんなか)
    const setLane = (p: any, l: number) => {
      const [i, j] = p.cell;
      if (along(j)) p.z = (j + (l < 0 ? 0.5 : 0.25 + 0.5 * l)) * C; else p.x = (i + (l < 0 ? 0.5 : 0.25 + 0.5 * l)) * C;
    };
    for (const c of cells) {
      const e = g.edge(prev[0], prev[1], c[0], c[1]);
      if (e && e.type === 'door') {
        const ex = prev[0] === c[0] ? (c[0] + 0.5) * C : Math.max(prev[0], c[0]) * C, ez = prev[0] === c[0] ? Math.max(prev[1], c[1]) * C : (c[1] + 0.5) * C;
        const bx = ex - (c[0] - prev[0]) * 0.62, bz = ez - (c[1] - prev[1]) * 0.62;
        wp.push({ x: bx, z: bz, door: e.door, ex, ez });
        lane = -1; last = null;
      }
      const p: any = { x: (c[0] + 0.5) * C, z: (c[1] + 0.5) * C, crouch: false, cell: c };
      if (reg(c[0], c[1]) === '.' && cfg.kind === 'think' && !cfg.noCreak) {
        const q0 = !creaks.has(`${c[0]},${c[1]},0`), q1 = !creaks.has(`${c[0]},${c[1]},1`);
        if (crossing(c[0], c[1], c[0] - prev[0])) { p.crouch = !(q0 && q1); lane = -1; last = null; }
        else {
          // 板の上を進むときは、同じ側をたどる。鳴かない側が変わるときは、手前のマス(両側とも鳴かない)で先に寄せておく
          if (!q0 && !q1) { p.crouch = true; }
          else if (!(q0 && q1)) {
            const q = q0 ? 0 : 1;
            if (lane !== q) {
              if (last && along(last.cell[1]) === along(c[1]) && !creaks.has(`${last.cell[0]},${last.cell[1]},${q}`)) setLane(last, q);
              else if (lane !== -1) p.crouch = true;
            }
            lane = q;
          }
          setLane(p, p.crouch ? -1 : lane);
          last = p;
        }
      } else { lane = -1; last = null; }
      wp.push(p);
      prev = c;
    }
    return wp;
  }
  function goTo(cell: number[], extra?: any) {
    const st = g.player();
    const ps = path(st.cell, cell);
    if (!ps) return false;
    B.plan = waypoints(ps, st.cell);
    if (extra) B.plan.push(extra);
    B.goal = cell;
    return true;
  }
  const roomCell = (r: string) => { const b = mp.rooms[r]; return [Math.round((b.i0 + b.i1) / 2), Math.round((b.j0 + b.j1) / 2)]; };
  const roomOrder = ['k', 'F', 'G', 'A', 'B', 'C', 'b', 'I', '.'];
  function nextGoal() {
    const st = g.player(), items = g.items().filter((it: any) => !it.taken);
    if (cfg.kind === 'goto') {
      if (B.reached) { B.done = true; return; }
      B.reached = true;
      const to = cfg.to!;
      goTo([to[0], to[1]], to.length > 2 ? { x: to[2], z: to[3], cell: [to[0], to[1]] } : undefined);
      if (!B.plan) B.done = true;
      return;
    }
    const [ci, cj] = st.cell, here = reg(ci, cj) === 'o' ? null : reg(ci, cj);
    // いる部屋の拾うもの(見えているもの)
    const near = items.filter((it: any) => (it.room === here || (here === '.' && it.room === '.' && Math.hypot(it.x - st.x, it.z - st.z) < 6)) && (it.kind !== 'key2' || st.key1));
    if (near.length) { const it = near[0]; const c = cellOf(it.x, it.z); goTo(c, { x: it.x, z: it.z, item: it.id }); return; }
    if (st.key2) { goTo([22, 18], { x: 23.6 * C, z: 18.5 * C, exit: true }); return; }
    if (st.key1 && (cfg.kind !== 'think' || B.visited.size >= 8 || g.time() > 330)) { goTo([26, 13]); B.visited.add('H'); return; }
    let best: string | null = null, bl = 1e9;
    for (const r of cfg.order || roomOrder) {
      if (B.visited.has(r)) continue;
      const ps = path(st.cell, r === '.' ? [16, 5] : roomCell(r));
      if (ps && ps.length < bl) { bl = ps.length; best = r; }
    }
    if (cfg.kind === 'random') { const rs = roomOrder.filter((r) => r !== here); best = rs[Math.floor(rnd() * rs.length)]; }
    // 逃げたり隠れたりして見のがした部屋は、もう一度まわる
    if (!best && !st.key1 && B.visited.size && (B.round = (B.round || 0) + 1) < 3) { B.visited.clear(); nextGoal(); return; }
    if (!best) { if (st.key1) { goTo([26, 13]); return; } B.done = true; return; }
    B.visited.add(best);
    goTo(best === '.' ? [16, 5] : roomCell(best));
  }
  // 押し入れ
  function nearestCloset(avoid: number[]) {
    const st = g.player();
    let best: any = null, bl = 1e9;
    for (const d of g.map().doors) {
      if (d.kind !== 'closet') continue;
      const ps = path(st.cell, d.a, avoid);
      if (ps && ps.length < bl) { bl = ps.length; best = d; }
    }
    return best && bl < 9 ? best : null;
  }
  w.__autoStep = () => {
    try {
      const s0 = g.state();
      if (s0 === 'title') { (document.querySelector('#b-start') as HTMLButtonElement).click(); return; }
      if (s0 !== 'play') { releaseAll(); if (!B.done) { B.done = true; B.result = g.stats(); } return; }
      if (B.done) return;
      B.t += 1 / 60;
      const st = g.player();
      if (cfg.maxT && g.time() > cfg.maxT) { B.done = true; B.result = g.stats(); releaseAll(); return; }
      const mo = g.monster();
      const known = mo.active && mo.dist < 16;
      if (B.ePress > 0) B.ePress -= 1 / 60;
      // ---- 隠れている ----
      if (st.hidden) {
        releaseAll();
        const near = known && mo.dist < 3.6;
        key('Space', near && st.breath > 0.02);
        B.hideCalm = !known || (mo.dist > 10 && mo.state !== 'chase') ? B.hideCalm + 1 / 60 : 0;
        if (B.hideCalm > 2.5 && B.ePress <= 0) { tap('KeyE'); B.ePress = 0.6; B.plan = null; }
        return;
      }
      // ---- 明かり ----
      if (cfg.kind === 'think' && !cfg.lightAlways) {
        // 近くにいるときは消す(追われているときも、明かりで居場所を教えない)
        const wantOff = known && mo.dist < 11;
        if (st.light === wantOff && st.battery > 0 && B.ePress <= 0) { tap('KeyF'); B.ePress = 0.2; }
      }
      if (cfg.kind === 'random' && rnd() < 0.002) tap('KeyF');
      // ---- 危ないとき: 追われたら逃げて、見えなくなってから隠れる。近づいてきたら隠れる(なければ離れる) ----
      B.thinkT = (B.thinkT || 0) - 1 / 60;
      // 裏口の鍵があって出口が近ければ、隠れずに出口へ走る
      const nearExit = st.key2 && Math.hypot(st.x - 23.6 * C, st.z - 18.5 * C) < 4.5;
      if (nearExit && B.mode !== 'exit') { const ps = path(st.cell, [22, 18]); if (ps) { B.plan = waypoints(ps, st.cell); B.plan.push({ x: 23.6 * C, z: 18.5 * C, exit: true }); B.mode = 'exit'; } }
      if (cfg.kind === 'think' && !cfg.noHide && known && B.thinkT <= 0 && !nearExit) {
        B.thinkT = 0.2;
        const mc = cellOf(mo.x, mo.z);
        const tryHide = (maxLen: number) => {
          const cl = nearestCloset(mc);
          if (!cl) return false;
          const ps = path(st.cell, cl.a, mc);
          if (!ps || ps.length > maxLen) return false;
          B.plan = waypoints(ps, st.cell);
          B.plan.push({ hide: cl.id, ex: (cl.a[0] + cl.b[0] + 1) * C / 2, ez: (cl.a[1] + cl.b[1] + 1) * C / 2 });
          B.mode = 'hide';
          return true;
        };
        const flee = () => {
          // 女将から遠く、見通しの切れるマスへ
          let best: number[] | null = null, bs = -1e9;
          for (let j = st.cell[1] - 6; j <= st.cell[1] + 6; j++) for (let i = st.cell[0] - 6; i <= st.cell[0] + 6; i++) {
            const r = reg(i, j);
            if (!walk(r) || r === 'o') continue;
            const dm = Math.hypot(i - mc[0], j - mc[1]);
            // 追われているときは、行き止まりの部屋より、ぐるりと回れる廊下へ
            const sc = dm - Math.hypot(i - st.cell[0], j - st.cell[1]) * 0.35 + (g.los((i + 0.5) * C, (j + 0.5) * C, mo.x, mo.z) ? -3 : 0) + (mo.state === 'chase' ? (r === '.' ? 2.5 : -2) : 0);
            if (sc > bs) { const ps = path(st.cell, [i, j], mc); if (ps && ps.length <= 9) { bs = sc; best = [i, j]; } }
          }
          if (best) { const ps = path(st.cell, best, mc)!; B.plan = waypoints(ps, st.cell); B.mode = 'flee'; }
        };
        if (mo.state === 'chase') {
          B.unseen = mo.sees ? 0 : (B.unseen || 0) + 0.2;
          if (B.mode === 'go') flee();
          else if (B.mode === 'flee' && B.unseen >= 0.6) tryHide(5);
          if (B.mode === 'flee' && (!B.plan || !B.plan.length)) flee();
        } else if (mo.dist < 7.5 && mo.state !== 'leave' && B.mode === 'go') {
          if (!tryHide(6)) flee();
        }
      }
      if (!B.plan || !B.plan.length) { B.mode = 'go'; nextGoal(); if (B.done) { releaseAll(); return; } if (!B.plan || !B.plan.length) { B.plan = null; return; } }
      const wp = B.plan[0];
      let tx = wp.x ?? wp.ex, tz = wp.z ?? wp.ez;
      // 戸・拾う・隠れる・出る
      const faceTo = (x: number, z: number) => { const a = Math.atan2(z - st.z, x - st.x); let d = a - st.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; key('ArrowRight', d > 0.08); key('ArrowLeft', d < -0.08); return Math.abs(d); };
      if (wp.hide && Math.hypot(st.x - (wp.ex), st.z - (wp.ez)) < 1.3) {
        key('KeyW', false); key('ShiftLeft', false);
        // 見られているうちは入らない(入るところを見られたら終わり)
        if (mo.sees) { B.plan = null; B.mode = 'go'; return; }
        const ad = faceTo(wp.ex, wp.ez), t = g.target();
        if (ad < 0.3 && t && t.kind === 'hide' && B.ePress <= 0) { tap('KeyE'); B.ePress = 0.5; B.plan.shift(); B.mode = 'go'; }
        return;
      }
      if (wp.item) {
        const d = Math.hypot(st.x - wp.x, st.z - wp.z);
        if (d < 1.0) {
          key('KeyW', false); key('ShiftLeft', false);
          const ad = faceTo(wp.x, wp.z), t = g.target();
          if (t && t.kind === 'item' && B.ePress <= 0) { tap('KeyE'); B.ePress = 0.4; }
          if (!g.items().find((it: any) => it.id === wp.item && !it.taken)) { B.plan.shift(); if (g.note().open && !cfg.keepNote) tap('KeyE'); }
          else if (ad < 0.2 && (!t || t.kind !== 'item')) { /* 少し近づく */ key('KeyW', d > 0.45); }
          return;
        }
      }
      if (wp.exit && Math.hypot(st.x - wp.x, st.z - wp.z) < 1.2) {
        const ad = faceTo(24 * C, 18.5 * C);
        const t = g.target();
        key('KeyW', ad < 0.5 && (!t || t.id !== 'back'));
        if (t && t.id === 'back' && B.ePress <= 0) { tap('KeyE'); B.ePress = 0.5; }
        return;
      }
      if (wp.door) {
        const d = Math.hypot(st.x - wp.x, st.z - wp.z);
        const D = doorsNow()[wp.door];
        if (D && D.open < 0.85 && d < 0.6) {
          key('KeyW', false); key('ShiftLeft', false);
          const ad = faceTo(wp.ex, wp.ez), t = g.target();
          if (ad < 0.35 && t && t.id === wp.door && B.ePress <= 0 && D.open < 0.5) { tap('KeyE'); B.ePress = 0.9; }
          return;
        }
        if (D && D.open >= 0.85 && d < 0.6) { B.plan.shift(); return; }
      }
      // 歩く
      const dist = Math.hypot(tx - st.x, tz - st.z);
      if (dist < (wp.cell ? 0.32 : 0.25) && !wp.item && !wp.exit && !wp.hide) { B.plan.shift(); return; }
      const ad = faceTo(tx, tz);
      key('KeyW', ad < 0.6);
      const run = cfg.kind === 'runner' || (cfg.kind === 'think' && (B.mode === 'hide' || B.mode === 'flee') && mo.state === 'chase') || (cfg.kind === 'random' && rnd() < 0.3 && B.t % 4 < 2);
      key('ShiftLeft', run && st.stam > 0.1);
      // しゃがむのは、両側とも鳴く板のときと、女将のすぐ近くを忍ぶときだけ(逃げるときはしゃがまない)
      const wantCrouch = cfg.kind === 'goto' ? !!cfg.crouch : cfg.kind === 'think' && !cfg.noCreak && B.mode !== 'flee' && mo.state !== 'chase' && (!!wp.crouch || (known && mo.dist < 5.5 && B.mode === 'go'));
      if (wantCrouch !== st.crouch && B.ePress <= 0) { tap('KeyC'); B.ePress = 0.15; }
      // 引っかかったら道を引きなおす
      B.stuck = Math.hypot(st.x - B.lastPos[0], st.z - B.lastPos[1]) < 0.002 && ad < 0.6 ? B.stuck + 1 / 60 : 0;
      B.lastPos = [st.x, st.z];
      if (B.stuck > 2.5) { B.stuck = 0; B.plan = null; key('KeyW', false); tap('KeyS'); }
      if (w.__peekCreak) {
        const cn = g.stats().creakN;
        if (cn !== B.cn) { B.cn = cn; B.log.push(`CR ${(st.x / C).toFixed(2)},${(st.z / C).toFixed(2)} ${B.mode} wp${wp.x !== undefined ? (wp.x / C).toFixed(2) + ',' + (wp.z / C).toFixed(2) : '-'}${wp.door ? 'D' : ''}${wp.crouch ? 'c' : ''} next${B.plan[1] ? (B.plan[1].x / C).toFixed(2) + ',' + (B.plan[1].z / C).toFixed(2) : '-'}`); }
      }
      B.logT -= 1 / 60;
      if (B.logT <= 0) { B.logT = mo.active && mo.dist < 9 ? 0.7 : 5; B.log.push(`${Math.round(g.time())}s ${st.cell}/${st.region} ${mo.active ? mo.state[0] + Math.round(mo.dist) : '-'}${st.light ? 'L' : ''}${st.crouch ? 'c' : ''} p${g.score()} ${B.mode}${B.plan ? B.plan.length : '-'}${wp.door ? 'D' + wp.door : ''}`); }
    } catch (e) { B.err = String((e as Error).stack || e); }
  };
}
async function runBot(page: Page, cfg: BotCfg, opts: { speed?: number; noDraw?: boolean; timeout?: number } = {}) {
  await page.evaluate(([c, o]) => { (window as any).__simSpeed = o.speed ?? 20; (window as any).__noDraw = o.noDraw ?? true; }, [cfg, opts] as const);
  await page.evaluate(botInstall, cfg);
  await expect.poll(() => page.evaluate(() => (window as any).__bot.done || !!(window as any).__bot.err), { timeout: opts.timeout ?? 300_000, intervals: [500] }).toBeTruthy();
  const bot = await page.evaluate(() => { const b = (window as any).__bot; return { result: b.result || (window as any).gameTest.stats(), err: b.err, log: b.log }; });
  expect(bot.err, `自動プレイヤーが止まりました: ${bot.err}`).toBe('');
  return bot;
}

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(target!.name, 'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください').toBe(EXPECTED);
  });

  test('テスト用の窓口 window.gameTest があり、3D(WebGL2)で描いている', async ({ page }) => {
    const errors = await open(page, { seed: 1 });
    expect(await gt<boolean>(page, 'webgl'), 'WebGL2 が使えていません').toBe(true);
    await start(page);
    await page.waitForTimeout(1500);
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '画面がほとんど描かれていません').toBeGreaterThan(15_000);
    expect((await gt<any>(page, 'light')).on, 'はじめは懐中電灯がついているはず').toBe(true);
    expect(errors).toEqual([]);
  });

  test('歩く・見回す・明かり・しゃがむ: 人の速さで W で前へ、← → で向きが変わり、F で懐中電灯、C でしゃがむ', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーボードで確かめる');
    const errors = await open(page, { seed: 2 });
    await start(page);
    await page.evaluate(() => { (window as any).__noDraw = true; });
    const a = await gt<any>(page, 'player');
    await page.keyboard.down('KeyW'); await page.waitForTimeout(1200); await page.keyboard.up('KeyW');
    const b = await gt<any>(page, 'player');
    const fwd = (b.x - a.x) * Math.cos(a.yaw) + (b.z - a.z) * Math.sin(a.yaw);
    expect(fwd, 'W で前へ進みません').toBeGreaterThan(1.2);
    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(500); await page.keyboard.up('ArrowRight');
    expect((await gt<any>(page, 'player')).yaw - b.yaw, '→ で向きが変わりません').toBeGreaterThan(0.5);
    await page.keyboard.press('KeyF');
    await page.waitForTimeout(100);
    expect((await gt<any>(page, 'player')).light, 'F で懐中電灯が消えません').toBe(false);
    await page.keyboard.press('KeyF');
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(700);
    const c = await gt<any>(page, 'player');
    expect(c.light).toBe(true);
    expect(c.crouch, 'C でしゃがみません').toBe(true);
    expect(c.eye, 'しゃがんでも目の高さが変わりません').toBeLessThan(1.2);
    expect(errors).toEqual([]);
  });

  // 鳴く板と、鳴かない板を探す(南の廊下)
  async function boards(page: Page) {
    return page.evaluate(() => {
      const g = (window as any).gameTest, set = new Set(g.creaks()), C = 1.2;
      let creak: number[] | null = null, quiet: number[] | null = null;
      for (let i = 8; i <= 12 && !(creak && quiet); i++) for (const j of [15, 16]) for (const l of [0, 1]) {
        const k = `${i},${j},${l}`, x = (i + 0.5) * C, z = (j + 0.25 + 0.5 * l) * C;
        const other = `${i},${j},${1 - l}`;
        if (set.has(k) && !creak) creak = [i, j, x, z];
        if (!set.has(k) && !set.has(other) && !quiet) quiet = [i, j, x, z];
      }
      return { creak, quiet };
    });
  }
  test('鳴く板: 色の薄い板を踏むと鳥のように鳴き、遠くまで聞こえる。しゃがんで渡れば小さく、ふつうの板は鳴らない', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(150_000);
    const run = async (seed: number, which: 'creak' | 'quiet', crouch: boolean) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed });
      await start(page);
      const bd = await boards(page);
      const to = bd[which];
      if (!to) { await ctx.close(); return null; }
      await runBot(page, { kind: 'goto', seed, to, crouch }, { speed: 4 });
      const ns = (await gt<any[]>(page, 'noises')).filter((n) => n.kind === 'creak' && Math.hypot(n.x - to[2], n.z - to[3]) < 1.0);
      await ctx.close();
      return ns.length ? Math.max(...ns.map((n) => n.r)) : 0;
    };
    let seed = 3, walk = null, quiet = null, low = null;
    for (; seed < 12 && (walk === null || quiet === null); seed++) { walk = await run(seed, 'creak', false); quiet = await run(seed, 'quiet', false); }
    low = await run(seed - 1, 'creak', true);
    console.log(`  鳴く板を歩いて踏む → 聞こえる範囲 ${walk}m / しゃがんで → ${low}m / ふつうの板 → ${quiet}m`);
    expect(walk, '鳴く板を踏んでも鳴きません').toBeGreaterThanOrEqual(10);
    expect(low!, 'しゃがんでも音の大きさが変わりません').toBeLessThan(walk! / 2);
    expect(low!, 'しゃがむと鳴かなくなります(小さく鳴るはず)').toBeGreaterThan(0);
    expect(quiet, 'ふつうの板が鳴いています').toBe(0);
  });

  test('押し入れ: 調べると中に隠れ、すき間から外が見える。Space で息を止め、7秒でむせる。もう一度調べると出られる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(120_000);
    const errors = await open(page, { seed: 4 });
    await start(page);
    // 帳場の押し入れの前まで
    await runBot(page, { kind: 'goto', seed: 4, to: [6, 19] }, { speed: 4 });
    await page.evaluate(() => { const w = window as any; w.__simSpeed = 1; w.__autoStep = null; });
    // 押し入れのほうを向く
    for (let k = 0; k < 40; k++) {
      const t = await gt<any>(page, 'target');
      if (t && t.kind === 'hide') break;
      await page.keyboard.down('ArrowRight'); await page.waitForTimeout(60); await page.keyboard.up('ArrowRight');
    }
    expect((await gt<any>(page, 'target'))?.kind, '押し入れの前で「隠れる」が出ません').toBe('hide');
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(800);
    const h = await gt<any>(page, 'player');
    expect(h.hidden, '押し入れに隠れられません').toBe('ok');
    expect(h.eye).toBeLessThan(1.3);
    await page.keyboard.down('Space');
    await page.waitForTimeout(2000);
    const b1 = await gt<any>(page, 'player');
    expect(b1.holding, 'Space で息を止められません').toBe(true);
    expect(b1.breath).toBeLessThan(0.85);
    await page.waitForTimeout(6000);
    await page.keyboard.up('Space');
    const ev = await gt<any[]>(page, 'events');
    expect(ev.some((e) => e.type === 'gasp'), '7秒より長く止めてもむせません').toBe(true);
    expect((await gt<any[]>(page, 'noises')).some((n) => n.kind === 'gasp' && n.r >= 5), 'むせた音が外に聞こえません').toBe(true);
    await page.waitForTimeout(500);
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
    expect((await gt<any>(page, 'player')).hidden, '押し入れから出られません').toBe(null);
    expect(errors).toEqual([]);
  });

  test('鍵: 女将の部屋は鍵がないと開かない。鍵を見つけると開けられ、鏡台の鍵を取ると灯りが消えて、女将が本気で探しはじめる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(240_000);
    // 鍵なしで女将の部屋の戸
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await open(page, { seed: 5 });
    await start(page);
    await runBot(page, { kind: 'goto', seed: 5, to: [23, 14] }, { speed: 6 });
    await page.evaluate(() => { const w = window as any; w.__simSpeed = 1; w.__autoStep = null; });
    for (let k = 0; k < 60; k++) {
      const t = await gt<any>(page, 'target');
      if (t && t.id === 'H') break;
      await page.keyboard.down('ArrowRight'); await page.waitForTimeout(50); await page.keyboard.up('ArrowRight');
    }
    expect((await gt<any>(page, 'target'))?.id).toBe('H');
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(800);
    const dH = (await gt<any>(page, 'map')).doors.find((d: any) => d.id === 'H');
    expect(dH.locked, '鍵がないのに女将の部屋が開きました').toBe(true);
    expect(dH.open).toBeLessThan(0.1);
    await expect(page.locator('#msg')).toContainText('鍵');
    await ctx.close();
    // 考える自動プレイヤーで、鍵の順番を確かめる(裏口の鍵まで届いた夜で)
    let ev: any[] = [], bot: any = null, p2: Page | null = null, ctx2: any = null;
    for (const seed of [41, 42, 11, 44, 5]) {
      ctx2 = await browser.newContext();
      p2 = await ctx2.newPage();
      await open(p2!, { seed });
      await start(p2!);
      bot = await runBot(p2!, { kind: 'think', seed, maxT: 600 });
      ev = await gt<any[]>(p2!, 'events');
      if (ev.some((e) => e.type === 'pick' && e.kind === 'key2')) break;
      await ctx2.close();
    }
    const tk1 = ev.find((e) => e.type === 'pick' && e.kind === 'key1')?.t, tun = ev.find((e) => e.type === 'unlock')?.t, tk2 = ev.find((e) => e.type === 'pick' && e.kind === 'key2')?.t;
    console.log(`  女将の部屋の鍵 ${tk1}秒 → 開けた ${tun}秒 → 裏口の鍵 ${tk2}秒 → ${bot.result.escaped ? '脱出' : '捕まった'}`);
    expect(tk1 && tun && tk2, '鍵を2つそろえられません').toBeTruthy();
    expect(tun!).toBeGreaterThan(tk1!);
    expect(tk2!).toBeGreaterThan(tun!);
    const after = ev.filter((e) => e.t >= tk2!);
    expect(after.some((e) => e.type === 'scare' && e.kind === 'mirror'), '鏡台の鍵を取っても何も起きません').toBe(true);
    expect((await gt<any>(p2!, 'director')).lantern, '鏡台の鍵を取っても帳場の灯りが消えません').toBe(false);
    await ctx2.close();
  });

  test('脱出と結果: 裏口から逃げると結果が出て、切れ端の数が分かる。もう一度遊べて、再読み込みしても記録が残る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(240_000);
    // 脱出できた夜で確かめる(女将の動きしだいで捕まる夜もあるので、いくつかの種で)
    let errors: string[] = [], bot: any = null;
    for (const seed of [42, 41, 11, 44, 5]) {
      if (seed !== 42) { await page.evaluate(() => localStorage.clear()); }
      errors = await open(page, { seed });
      await start(page);
      bot = await runBot(page, { kind: 'think', seed, maxT: 600 });
      console.log(`  1プレイの長さ(考える自動プレイヤー・種${seed}): ${Math.floor(bot.result.t / 60)}分${Math.round(bot.result.t % 60)}秒・切れ端 ${bot.result.notes}/4・${bot.result.escaped ? '脱出' : '捕まった'}`);
      if (bot.result.escaped) break;
      await page.evaluate(() => { (window as any).__autoStep = null; });
    }
    expect(bot.result.escaped, '考える自動プレイヤーが、どの夜も脱出できません').toBe(true);
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('over');
    await expect(page.locator('#res-h')).toHaveText('脱出');
    await expect(page.locator('#res-lines')).toContainText(`${bot.result.notes} / 4`);
    if (bot.result.notes >= 4) await expect(page.locator('#res-end')).toContainText('兄');
    await page.evaluate(() => { const w = window as any; w.__autoStep = null; w.__simSpeed = 1; w.__noDraw = false; });
    await page.locator('#b-again').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    const p = await gt<any>(page, 'player');
    expect(p.notes).toBe(0);
    expect(p.region, 'もう一度遊ぶと玄関から始まるはず').toBe('e');
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    const sv = await gt<any>(page, 'save');
    expect(sv.escapes, '再読み込みすると記録が消えます').toBeGreaterThanOrEqual(1);
    await expect(page.locator('#rec')).toContainText('脱出 1');
    expect(errors).toEqual([]);
  });

  test('見つかる: 明かりをつけたまま走りまわると、女将に見つかって捕まる。捕まった場所と理由が出る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(180_000);
    const errors = await open(page, { seed: 6 });
    await start(page);
    const bot = await runBot(page, { kind: 'runner', seed: 6, maxT: 600 });
    expect(bot.result.escaped).toBe(false);
    expect(bot.result.cause, '捕まらずに終わりました').not.toBe('');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('over');
    await expect(page.locator('#res-h')).toHaveText('見つかった');
    await expect(page.locator('#res-end')).toContainText('捕まった');
    expect((await page.locator('#res-tip').textContent())!.length, '捕まった理由の助言がありません').toBeGreaterThan(5);
    const ev = await gt<any[]>(page, 'events');
    expect(ev.some((e) => e.type === 'hear' || e.type === 'chase'), '女将が聞きつけたり見つけたりしていません').toBe(true);
    expect(errors).toEqual([]);
  });

  // ------------------------------------------------------------------------
  //  面白さの代わりになる数字
  // ------------------------------------------------------------------------
  async function session(browser: Browser, cfg: BotCfg) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = await open(page, { seed: cfg.seed });
    await start(page);
    const bot = await runBot(page, { maxT: 600, ...cfg }, { timeout: 8 * 60_000 });
    const ev = await gt<any[]>(page, 'events');
    const items = await gt<any[]>(page, 'items');
    await ctx.close();
    expect(errors, `${cfg.kind}: JSエラー`).toEqual([]);
    // 遠くまで聞こえる鳴き方(しゃがまずに踏んだ板)の数
    const loudN = ev.filter((e) => e.type === 'creak' && !e.crouch).length;
    return { ...bot.result, loudN, ev, items, rooms: [...new Set(ev.filter((e) => e.type === 'pick').map((e) => e.room))] };
  }
  const line = (r: any) => `進み${String(r.progress).padStart(2)} 切れ端${r.notes} 鍵${r.key1 ? '○' : '×'}${r.key2 ? '○' : '×'} ${r.escaped ? '脱出' : '捕まった(' + r.cause + ')'} ${Math.round(r.t)}秒 板${r.creakN}(大きく${r.loudN}) 見つかる${r.seenN} 隠れる${r.hideN}`;

  test('腕の差: 考える自動プレイヤーは、「走りまわる」「でたらめ」の1.5倍以上先まで進み、裏口から逃げられる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(9 * 60_000);
    const seeds = [11, 12, 13, 14, 15, 16];
    const kinds = ['think', 'runner', 'random'] as const;
    const jobs = seeds.flatMap((seed) => kinds.map((kind) => ({ kind, seed })));
    const res: any[] = [];
    for (let i = 0; i < jobs.length; i += 6) res.push(...(await Promise.all(jobs.slice(i, i + 6).map((c) => session(browser, c)))));
    res.forEach((r, i) => console.log(`  種${jobs[i].seed} ${jobs[i].kind.padEnd(6)} ${line(r)}`));
    const avg = (k: string) => { const xs = res.filter((_, i) => jobs[i].kind === k); return xs.reduce((a, r) => a + r.progress, 0) / xs.length; };
    console.log(`  平均の進み具合: 考える ${avg('think').toFixed(1)} / 走りまわる ${avg('runner').toFixed(1)} / でたらめ ${avg('random').toFixed(1)}(倍率 ${(avg('think') / Math.max(0.1, avg('runner'))).toFixed(2)})`);
    expect(avg('think'), '考えて遊んでも、走りまわるの1.5倍に届きません').toBeGreaterThanOrEqual(avg('runner') * 1.5);
    expect(avg('think'), '考えて遊んでも、でたらめの1.5倍に届きません').toBeGreaterThanOrEqual(avg('random') * 1.5);
    expect(res.filter((r, i) => jobs[i].kind === 'think' && r.escaped).length, '考える自動プレイヤーが一度も脱出できません').toBeGreaterThanOrEqual(1);
    expect(res.filter((r, i) => jobs[i].kind === 'runner' && r.escaped).length, '走りまわっても脱出できてしまいます').toBe(0);
  });

  test('毎回ちがう: 遊ぶたびに、鍵のある部屋・切れ端と電池の場所・鳴く板の並び・女将が出てくる時刻が変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    const sig: string[] = [], creak: string[] = [], rooms: string[] = [], dorm: number[] = [];
    for (const seed of [31, 32, 33, 34]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed });
      const items = await gt<any[]>(page, 'items');
      sig.push(JSON.stringify(items.map((i) => [i.kind, i.room, Math.round(i.x * 10), Math.round(i.z * 10)])));
      creak.push((await gt<string[]>(page, 'creaks')).sort().join('|'));
      const st = await gt<any>(page, 'stats');
      rooms.push(st.key1Room);
      dorm.push(Math.round((await gt<any>(page, 'monster')).dormantT));
      console.log(`  種${seed}: 鍵は${st.key1Room}・切れ端 ${items.filter((i) => i.kind === 'note').map((i) => i.room).join('')}・電池 ${items.filter((i) => i.kind === 'battery').map((i) => i.room).join('')}・鳴く板 ${creak.at(-1)!.split('|').length}枚・女将は${dorm.at(-1)}秒後`);
      await ctx.close();
    }
    expect(new Set(sig).size, '拾うものの場所が毎回同じです').toBe(sig.length);
    expect(new Set(creak).size, '鳴く板の並びが毎回同じです').toBe(creak.length);
    expect(new Set(rooms).size, '鍵のある部屋がいつも同じです').toBeGreaterThanOrEqual(2);
    expect(new Set(dorm).size).toBeGreaterThanOrEqual(3);
  });

  test('選択の重さ: 隠れるか・板をよけるか・明かりを消すかで、見つかる回数と進み具合がはっきり変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(9 * 60_000);
    // 1回ごとのぶれが大きい(捕まるかどうかで進み具合が大きく変わる)ので、種を多めにとる
    const seeds = [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52];
    const variants: [string, Partial<BotCfg>][] = [['考える', {}], ['隠れない', { noHide: true }], ['板も明かりも気にしない', { noCreak: true, lightAlways: true }]];
    const jobs = seeds.flatMap((seed) => variants.map(([n, v]) => ({ n, cfg: { kind: 'think', seed, ...v } as BotCfg })));
    const res: any[] = [];
    for (let i = 0; i < jobs.length; i += 6) res.push(...(await Promise.all(jobs.slice(i, i + 6).map((j) => session(browser, j.cfg)))));
    res.forEach((r, i) => console.log(`  種${jobs[i].cfg.seed} ${jobs[i].n.padEnd(12)} ${line(r)}`));
    const avg = (n: string, k: string) => { const xs = res.filter((_, i) => jobs[i].n === n); return xs.reduce((a, r) => a + r[k], 0) / xs.length; };
    for (const [n] of variants) console.log(`  ${n}: 進み ${avg(n, 'progress').toFixed(1)}・板 ${avg(n, 'creakN').toFixed(1)}(遠くまで聞こえる ${avg(n, 'loudN').toFixed(1)})・見つかる ${avg(n, 'seenN').toFixed(1)}`);
    expect(avg('考える', 'progress'), '隠れても隠れなくても進み具合が同じです').toBeGreaterThan(avg('隠れない', 'progress') + 1.5);
    // 板をよける(よけられなければしゃがむ)と、遠くまで聞こえる鳴き方がはっきり減る
    expect(avg('板も明かりも気にしない', 'loudN'), '板をよけてもよけなくても、遠くまで鳴らす数が同じです').toBeGreaterThan(avg('考える', 'loudN') * 2);
    expect(avg('考える', 'progress'), '板と明かりに気をつけても進み具合が変わりません').toBeGreaterThan(avg('板も明かりも気にしない', 'progress'));
  });

  test('こわい出来事: 一晩のうちに、気配(扉・天井の足音・まり・人影・テレビなど)が何度も起き、見ていないあいだに人形がこちらを向く', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(180_000);
    await open(page, { seed: 7 });
    await start(page);
    const doll0 = (await gt<any>(page, 'director')).doll;
    await runBot(page, { kind: 'think', seed: 7, maxT: 600 });
    const d = await gt<any>(page, 'director');
    const ev = await gt<any[]>(page, 'events');
    const kinds = [...new Set(d.scares)];
    console.log(`  起きた出来事: ${kinds.join('・')}・稲妻 ${ev.filter((e) => e.type === 'thunder').length}回(${Math.round(await gt<number>(page, 'time'))}秒遊んだ)`);
    expect(kinds.length, '気配の出来事が少なすぎます').toBeGreaterThanOrEqual(3);
    expect(ev.filter((e) => e.type === 'thunder').length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(d.doll - doll0), '人形の向きが変わりません').toBeGreaterThan(0.05);
  });

  // ------------------------------------------------------------------------
  //  スマホ・重さ・動画・見直し
  // ------------------------------------------------------------------------
  test('スマホ: 左の指で歩き、右の指で見回し、「調べる」で戸を開け、「明かり」「しゃがむ」が使える。ボタンは指で押せる大きさで、はみ出さず重ならない', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    test.setTimeout(120_000);
    const errors = await open(page, { seed: 9 });
    const v = page.viewportSize()!;
    await start(page);
    const inside = (b: { x: number; y: number; width: number; height: number } | null) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5;
    const apart = (a: any, b: any) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    const ids = ['#stat', '#b-snd', '#b-pause', '#t-act', '#t-light', '#t-crouch'];
    const bx: Record<string, any> = {};
    for (const id of ids) { bx[id] = await page.locator(id).boundingBox(); expect(inside(bx[id]), `${id} がはみ出しています`).toBeTruthy(); }
    for (const id of ['#b-snd', '#b-pause', '#t-act', '#t-light', '#t-crouch']) expect(Math.min(bx[id].width, bx[id].height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(apart(bx[ids[i]], bx[ids[j]]), `${ids[i]} と ${ids[j]} が重なっています`).toBeTruthy();
    const cdp = await page.context().newCDPSession(page);
    const touch = async (pts: { x: number; y: number; id: number }[], type: string) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts } as any);
    // 右の指で見回す
    const p0 = await gt<any>(page, 'player');
    await touch([{ x: v.width * 0.75, y: v.height * 0.4, id: 1 }], 'touchStart');
    for (let k = 1; k <= 8; k++) { await touch([{ x: v.width * 0.75 + k * 12, y: v.height * 0.4, id: 1 }], 'touchMove'); await page.waitForTimeout(16); }
    await touch([], 'touchEnd');
    const p1 = await gt<any>(page, 'player');
    expect(p1.yaw - p0.yaw, '右の指でなぞっても見回せません').toBeGreaterThan(0.2);
    // 左の指で前へ
    await touch([{ x: v.width * 0.22, y: v.height * 0.75, id: 2 }], 'touchStart');
    for (let k = 1; k <= 5; k++) { await touch([{ x: v.width * 0.22, y: v.height * 0.75 - k * 10, id: 2 }], 'touchMove'); await page.waitForTimeout(16); }
    await page.waitForTimeout(1200);
    await touch([], 'touchEnd');
    const p2 = await gt<any>(page, 'player');
    expect(Math.hypot(p2.x - p1.x, p2.z - p1.z), '左の指で歩けません').toBeGreaterThan(0.8);
    await cdp.detach();
    await page.locator('#t-light').tap();
    expect((await gt<any>(page, 'player')).light, '「明かり」で懐中電灯が消えません').toBe(false);
    await page.locator('#t-light').tap();
    await page.locator('#t-crouch').tap();
    expect((await gt<any>(page, 'player')).crouch, '「しゃがむ」が効きません').toBe(true);
    await page.locator('#t-crouch').tap();
    // 帳場の戸の前まで歩いて、「調べる」で開け閉め
    await runBot(page, { kind: 'goto', seed: 9, to: [8, 16] }, { speed: 4, noDraw: false });
    await page.evaluate(() => { const w = window as any; w.__simSpeed = 1; w.__autoStep = null; });
    const d0 = (await gt<any>(page, 'map')).doors.find((d: any) => d.id === 'k').open;
    for (let k = 0; k < 60; k++) { const t = await gt<any>(page, 'target'); if (t && t.id === 'k') break; await page.keyboard.down('ArrowRight'); await page.waitForTimeout(50); await page.keyboard.up('ArrowRight'); }
    await page.locator('#t-act').tap();
    await page.waitForTimeout(700);
    const d1 = (await gt<any>(page, 'map')).doors.find((d: any) => d.id === 'k').open;
    expect(Math.abs(d1 - d0), '「調べる」で戸が動きません').toBeGreaterThan(0.5);
    expect(errors).toEqual([]);
  });

  test('スマホで重くない(CPU 4倍遅くても、懐中電灯で中庭の窓を照らす廊下で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(3 * 60_000);
    await open(page, { seed: 51 });
    await start(page);
    await runBot(page, { kind: 'goto', seed: 51, to: [7, 12] }, { speed: 4, noDraw: false });
    await page.evaluate(() => { const w = window as any; w.__simSpeed = 1; w.__autoStep = null; });
    // 中庭のほうを向く(測っている間は gameTest を読まない)
    const yaw = (await gt<any>(page, 'player')).yaw;
    let d = 0 - yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    await page.keyboard.down(d > 0 ? 'ArrowRight' : 'ArrowLeft'); await page.waitForTimeout(Math.abs(d) / 2.2 * 1000); await page.keyboard.up(d > 0 ? 'ArrowRight' : 'ArrowLeft');
    await page.waitForTimeout(2500);
    const perf = await measureFps(page, 3000);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・画質の段階 ${await gt<number>(page, 'quality')}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  // 動画と見直しのスクショで、場面の手前まで一気に進めるための段取り(遊びの確かめには使わない)
  const stage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);
  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(8 * 60_000);
    const SHORT = process.env.SHORT_VIDEO === '1';
    const openFor = async (page: Page, cfg: Cfg) => {
      await page.addInitScript(installInit, cfg);
      await page.goto(url());
      await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    };
    await recordScenes(browser, target!.dir, [
      // ① つかみ: 懐中電灯の光の中を、女将がこちらへ迫ってくる(そのまま捕まる)
      {
        seconds: 4,
        shortSeconds: 6,
        setup: async (page) => {
          await openFor(page, { seed: 61, sound: true });
          await page.locator('#b-start').click();
          await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('play');
          await page.waitForTimeout(2500);
          // 北の廊下の西の端に立ち、東を向く。廊下の奥(11m 先)に女将
          await stage(page, `P.x = 6.7 * C; P.z = 5.75 * C; P.y = 0; P.yaw = 0; P.pitch = 0.02; P.light = true; G.thunderT = 99; G.nextScare = 99;
            M.active = true; M.state = 'patrol'; M.x = 16.2 * C; M.z = 5.6 * C; M.yaw = Math.PI; M.path = [[15,5],[14,5],[13,5],[12,5],[11,5],[10,5],[9,5],[8,5],[7,5]]; M.speed = 1.0; M.wait = 9;`);
          await page.waitForTimeout(400);
        },
        play: async (page, clip) => {
          await expect.poll(async () => (await gt<any>(page, 'monster')).dist, { timeout: 15_000, intervals: [50] }).toBeLessThan(5.5);
          clip.mark();
          await expect.poll(() => gt<string>(page, 'state'), { timeout: 10_000, intervals: [50] }).not.toBe('play');
          await page.waitForTimeout(700);
          if (!SHORT) await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
      // ② 基本: 玄関から入ると戸が閉まる。暗い廊下を懐中電灯で照らして帳場へ。兄の手帳の切れ端に、遊び方が書いてある
      {
        seconds: 10,
        shortSeconds: 13,
        setup: async (page) => {
          await openFor(page, { seed: 62, sound: true });
          await page.waitForTimeout(1200);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.locator('#b-start').click();
          await page.evaluate(botInstall, { kind: 'think', seed: 62, keepNote: true } as BotCfg);
          await expect.poll(async () => (await gt<any>(page, 'note')).open, { timeout: 20_000, intervals: [100] }).toBeTruthy();
          // 切れ端を読むあいだは止まる
          await page.evaluate(() => { (window as any).__autoStep = null; for (const c of ['KeyW', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'KeyC']) window.dispatchEvent(new KeyboardEvent('keyup', { code: c })); });
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
      // ③ 押し入れのすき間から: 鈴の音とともに女将が前を通りすぎる。息を止めてやりすごす
      {
        seconds: 6,
        shortSeconds: 8,
        setup: async (page) => {
          await openFor(page, { seed: 63, sound: true });
          await page.locator('#b-start').click();
          await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('play');
          await page.waitForTimeout(2500);
          await stage(page, `G.thunderT = 99; G.nextScare = 99; DOORS.A.open = DOORS.A.target = 1; P.x = 7.5 * C; P.z = 2.5 * C; P.y = 0; P.stam = 1; enterCloset(DOORS.oA);`);
          await page.waitForTimeout(1500);
        },
        play: async (page, clip) => {
          clip.mark();
          await stage(page, `M.active = true; M.state = 'patrol'; M.x = 8.5 * C; M.z = 4.6 * C; M.yaw = -Math.PI / 2; M.path = [[8,3],[7,3],[6,3],[6,2],[7,2],[8,2],[9,2],[10,2]]; M.speed = 0.9; M.wait = 9; M.patrolN = 0; M.bellT = 0.2;`);
          await page.waitForTimeout(1600);
          await page.keyboard.down('Space');
          await page.waitForTimeout(1000);
          await stage(page, `G.thunderT = 0;`);
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
          await page.keyboard.up('Space');
        },
      },
    ]);
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(5 * 60_000);
    const shot = (name: string) => page.screenshot({ path: path.join(REVIEW, `${info.project.name}-${name}.png`) });
    const errors = await open(page, { seed: 121 });
    await page.evaluate(() => { (window as any).__lockQ = 1; });
    await page.waitForTimeout(2500);
    await shot('1-title');
    await start(page);
    await page.waitForTimeout(1800);
    await shot('2-start');
    await stage(page, 'G.thunderT = 99; G.nextScare = 99; M.dormantT = 999;');
    const at = async (name: string, x: number, z: number, yaw: number, pitch = 0, code = '') => {
      await stage(page, `P.x = ${x} * C; P.z = ${z} * C; P.yaw = ${yaw}; P.pitch = ${pitch}; P.y = 0; ${code}`);
      await page.waitForTimeout(1500);
      await shot(name);
    };
    await at('3-corridor', 6.7, 5.6, 0.0);
    await at('4-garden', 7.2, 9.5, -0.2);
    await at('5-room', 8.5, 4.4, -Math.PI / 2 - 0.4, -0.1, 'DOORS.A.open = DOORS.A.target = 1;');
    // 女将を見る2枚は、遊びの時間を止めて撮る(見つかって捕まらないように)
    await at('6-okami', 6.7, 5.75, 0.0, 0.02, "M.active = true; M.state = 'patrol'; M.x = 13.5 * C; M.z = 5.6 * C; M.yaw = Math.PI; M.path = []; M.wait = 99; window.__simSpeed = 1e-6;");
    await at('7-dark', 6.7, 5.75, 0.0, 0.02, 'P.light = false;');
    await stage(page, 'M.active = false; M.state = "dormant"; P.light = true; window.__simSpeed = 1;');
    await at('8-mirror', 26.8, 12.6, 0.3, -0.15, 'DOORS.H.open = DOORS.H.target = 1; DOORS.H.locked = false;');
    await stage(page, 'P.x = 7.5 * C; P.z = 2.5 * C; enterCloset(DOORS.oA);');
    await page.waitForTimeout(1500);
    await shot('9-closet');
    await stage(page, "openNote(1);");
    await page.waitForTimeout(600);
    await shot('a-note');
    await stage(page, "closeNote(); exitCloset(); M.active = true; M.x = P.x + 0.5; M.z = P.z; caught();");
    await page.waitForTimeout(700);
    await shot('b-caught');
    await page.waitForTimeout(2500);
    await shot('c-result');
    expect(errors).toEqual([]);
    if (info.project.name === 'mobile') {
      for (const [w, hh, name] of [[844, 390, 'd-landscape'], [360, 640, 'e-small']] as const) {
        await page.setViewportSize({ width: w, height: hh });
        await page.goto(url());
        await page.waitForTimeout(1500);
        await shot(`${name}-title`);
        await start(page);
        await page.waitForTimeout(2000);
        await shot(`${name}-play`);
      }
      return;
    }
    // 投稿用の動画のコマを9枚ずつ並べて見る
    for (const f of fs.readdirSync(target!.dir).filter((x) => /^play-\d+\.webm$/.test(x))) {
      const src = pathToFileURL(path.join(target!.dir, f)).href;
      await page.setContent('<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(3,1fr);gap:2px"></body>');
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
      await page.screenshot({ path: path.join(REVIEW, `video-${f}.png`), fullPage: true });
    }
  });

  test('様子見(自動プレイ)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop' || !fs.existsSync(path.join(__dirname, '..', 'peek.flag')), 'peek.flag があるときだけ');
    test.setTimeout(9 * 60_000);
    const one = async (name: string, cfg: BotCfg) => {
      const ctx = await browser.newContext();
      const p2 = await ctx.newPage();
      const e2 = await open(p2, { seed: cfg.seed });
      await start(p2);
      await p2.evaluate(() => { (window as any).__peekCreak = true; });
      const bot = await runBot(p2, { maxT: 600, ...cfg }, { timeout: 8 * 60_000 });
      bot.log = bot.log.filter((l: string) => !l.startsWith('CR'));
      const all = await gt<any[]>(p2, 'events');
      const cs = new Set(await gt<string[]>(p2, 'creaks'));
      const cr = all.filter((e) => e.type === 'creak').map((e) => { const [i, j, l] = e.board.split(','); return `${e.board}${e.crouch ? 'c' : ''}${cs.has(`${i},${j},${1 - +l}`) ? 'B' : ''}@${Math.round(e.t)}`; }).join(' ');
      const evs = 'CREAK ' + cr + '\n    ' + all.filter((e) => !['door', 'light', 'creak'].includes(e.type)).map((e) => `${e.type}${e.kind ? ':' + e.kind : ''}${e.why ? ':' + e.why : ''}${e.on !== undefined ? ':' + e.on : ''}@${Math.round(e.t)}`).join(' ');
      await ctx.close();
      const r = bot.result || {};
      return `${name.padEnd(10)} 進み${r.progress} 切${r.notes} 鍵${r.key1 ? 1 : 0}${r.key2 ? 1 : 0} ${r.escaped ? '脱出' : r.cause ? '捕:' + r.cause : '時間切れ'} t${Math.round(r.t)} 板${r.creakN} 見${r.seenN} 隠${r.hideN}\n    ${evs.slice(0, 2000)}\n    ${bot.log.join(' | ').slice(-1400)}${e2.length ? '\n  ERR ' + e2.join(' ').slice(0, 500) : ''}`;
    };
    const jobs: [string, BotCfg][] = [];
    for (const seed of [14, 14, 14]) jobs.push([`runner${seed}`, { kind: 'runner', seed }]);
    const out: string[] = [];
    for (let i = 0; i < jobs.length; i += 6) out.push(...(await Promise.all(jobs.slice(i, i + 6).map(([n, c]) => one(n, c)))));
    console.log(out.join('\n'));
  });

  test('様子見(いろいろな場所)', async ({ page }, info) => {
    test.skip(!fs.existsSync(path.join(__dirname, '..', 'peek3.flag')), 'peek3.flag があるときだけ');
    test.setTimeout(240_000);
    const errors = await open(page, { seed: 3 });
    await page.evaluate(() => { (window as any).__lockQ = 1; });
    await start(page);
    await page.waitForTimeout(1500);
    // 見るためだけに、立つ場所を動かす(遊びの結果には使わない)
    const at = async (name: string, x: number, z: number, yaw: number, pitch = 0, f?: string) => {
      await page.evaluate(([x, z, yaw, pitch, f]) => { const w = window as any; const p = (0, eval)('P'); p.x = x; p.z = z; p.yaw = yaw; p.pitch = pitch; p.y = 0; if (f) (0, eval)(f as string); }, [x, z, yaw, pitch, f ?? ''] as const);
      await page.waitForTimeout(1600);
      await page.screenshot({ path: path.join(REVIEW, `${info.project.name}-v-${name}.png`) });
    };
    const C = 1.2;
    await at('corridor-garden', 7 * C, 9 * C, Math.PI / 2 - 0.3);
    await at('corridor-long', 6.6 * C, 5.6 * C, 0);
    await at('room-A', 8.5 * C, 4.6 * C, -Math.PI / 2 - 0.3, -0.1, 'DOORS.A.open=1;DOORS.A.target=1');
    await at('bath', 24.5 * C, 7.5 * C, -0.3, -0.05, 'DOORS.b.open=1;DOORS.b.target=1');
    await at('okami-room', 25 * C, 14.5 * C, 0.2, -0.05, 'DOORS.H.open=1;DOORS.H.target=1;DOORS.H.locked=false');
    await page.evaluate(() => { (window as any).__simSpeed = 1e-6; });
    await at('okami-near', 15 * C, 5.6 * C, 0, 0, 'M.active=true;M.state="patrol";M.x=18*1.2;M.z=5.6*1.2;M.yaw=Math.PI;M.path=[];M.wait=99;');
    await at('okami-far', 6.6 * C, 5.6 * C, 0, 0, 'M.active=true;M.state="patrol";M.x=14*1.2;M.z=5.8*1.2;M.yaw=Math.PI;M.path=[];M.wait=99;');
    await at('okami-face', 15 * C, 5.6 * C, 0, 0.05, 'M.active=true;M.state="patrol";M.x=16.1*1.2;M.z=5.6*1.2;M.yaw=Math.PI;M.path=[];M.wait=99;');
    await at('okami-chase', 15 * C, 5.6 * C, 0, 0.05, 'M.active=true;M.state="chase";M.chaseT=2;M.x=16.6*1.2;M.z=5.6*1.2;M.yaw=Math.PI;M.path=[];M.wait=99;');
    await page.evaluate(() => { (window as any).__simSpeed = 1; (0, eval)('M.active=false;M.state="dormant";M.dormantT=999;P.light=true;'); });
    await at('closet', 6.5 * C, 2.6 * C, -Math.PI / 2, 0, 'M.active=false;');
    await page.evaluate(() => (0, eval)('DOORS.A.open = DOORS.A.target = 1; P.x = 7.5 * C; P.z = 2.5 * C; enterCloset(DOORS.oA);'));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(REVIEW, `${info.project.name}-v-in-closet.png`) });
    await page.evaluate(() => (0, eval)("M.active = true; M.state = 'patrol'; M.x = 7.5 * C; M.z = 3.6 * C; M.yaw = -Math.PI / 2; M.path = []; M.wait = 99; window.__simSpeed = 1e-6;"));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(REVIEW, `${info.project.name}-v-in-closet-okami.png`) });
    await page.evaluate(() => (0, eval)("window.__simSpeed = 1; M.active = false; M.state = 'dormant'; exitCloset();"));
    await at('entrance', 14.9 * C, 18.0 * C, Math.PI / 2, 0.05);
    await at('chouba', 9.5 * C, 18.2 * C, Math.PI, 0.05);
    console.log('errors', errors.join('\n'));
  });

  test('様子見', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop' || !fs.existsSync(path.join(__dirname, '..', 'peek2.flag')), 'peek2.flag があるときだけ');
    test.setTimeout(240_000);
    const errors = await open(page, { seed: 1 });
    await page.evaluate(() => { (window as any).__lockQ = 1; });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(REVIEW, 'p-title.png') });
    await start(page);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(REVIEW, 'p-start.png') });
    console.log(JSON.stringify(await gt(page, 'player')));
    console.log(JSON.stringify(await gt(page, 'monster')));
    console.log(JSON.stringify(await gt(page, 'items')));
    await page.keyboard.down('KeyW'); await page.waitForTimeout(2200); await page.keyboard.up('KeyW');
    await page.screenshot({ path: path.join(REVIEW, 'p-walk.png') });
    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(700); await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(REVIEW, 'p-turn.png') });
    console.log(JSON.stringify(await gt(page, 'player')));
    console.log('errors', errors.join('\n'));
  });
});
