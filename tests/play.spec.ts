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
//  対象: 沈没船の底へ(2026-10-10・土曜の3D大作)
//  一人称で海底の沈没船を探る。空気は深いほど速く減る。遺品を網袋に入れて浮上用のロープまで戻ると売れる。
//  空気が尽きると気を失い、袋の中身はその場に落ちる。代金で装備を買うと、歪んだ扉(バール)・鉄格子(カッター)の先へ行ける。
//
//  ・自動プレイヤーはページの中で動く(window.__autoStep が 1/60 秒ごとに呼ばれる)。本物のキー(KeyboardEvent)で泳ぐ
//  ・ゲームから読むのは、見取り図(部屋と通路の点)・遺品の場所・自分の位置と空気だけ。道すじと空気の見積もりはテストの側で計算する
//  ・早送り(__simSpeed)と、描かずに遊びだけ進める(__noDraw)は、自動プレイを短い時間で回すためだけに使う
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-10-chinbotsusen';
const SKEY = 'chinbotsusen-v1';
const target = latestGame();
const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const isMobile = (page: Page) => page.evaluate(() => 'ontouchstart' in window);

type Cfg = { seed: number; sound?: boolean; save?: Record<string, unknown> };
function installInit(cfg: Cfg) {
  let s = cfg.seed >>> 0;
  Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // 保存データは はじめの1回だけ書く(再読み込みのたびに書くと、ゲームが残した記録を消してしまう)
  try {
    if (!localStorage.getItem('chinbotsusen-v1')) localStorage.setItem('chinbotsusen-v1', JSON.stringify(Object.assign({ v: 1, sound: !!cfg.sound }, cfg.save || {})));
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
async function startDive(page: Page) {
  if (await isMobile(page)) await page.locator('#b-start').tap(); else await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('descend');
  await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('dive');
}

// ---------------------------------------------------------------------------
//  自動プレイヤー(ページの中で動く)
//   think : 見取り図の道すじと空気の見積もりで、値打ち÷空気 の高い順に回る計画を立て、余裕を残して戻る。装備は決めた順に買う
//   greedy: いちばん近い遺品を次々に拾う。袋がいっぱいか、空気が3割を切ったら戻り始める(帰りの空気を見積もらない)。装備は安い順
//   random: でたらめな向きに泳ぎ、目の前に遺品があれば拾う。戻らない
//   goto  : 決めた点(cfg.to)まで泳いで、cfg.look の方を向いて止まる(見直し用のスクショ・動画)
// ---------------------------------------------------------------------------
type BotCfg = { kind: 'think' | 'greedy' | 'random' | 'goto'; seed: number; dives: number; buy?: string[]; to?: string[]; look?: number[]; pick?: boolean; noReturn?: boolean };
function botInstall(cfg: BotCfg) {
  const w = window as any, g = w.gameTest;
  let s = (cfg.seed >>> 0) || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const down: Record<string, boolean> = {};
  const key = (code: string, on: boolean) => { if (!!down[code] === on) return; down[code] = on; w.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code })); };
  const tap = (code: string) => { w.dispatchEvent(new KeyboardEvent('keydown', { code })); w.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const releaseAll = () => { for (const c of Object.keys(down)) key(c, false); };
  const nav = g.nav();
  const N: Record<string, any> = {};
  const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  for (const n of nav.nodes) N[n.id] = { ...n, adj: [] };
  for (const [a, b, gate] of nav.edges) { const d = dist(N[a], N[b]); N[a].adj.push({ n: b, d, gate }); N[b].adj.push({ n: a, d, gate }); }
  const gateInfo: Record<string, any> = {};
  for (const x of g.gates()) gateInfo[x.id] = x;
  const ata = (y: number) => 1 + Math.max(0, -y) / 10;
  const B = (w.__bot = { cfg, dives: 0, done: false, log: [] as any[], plan: null as any[] | null, path: [] as any[], goalPos: null as any, best: 1e9, bestT: 0, unstick: 0, unstickN: 0, randT: 0, randDir: [1, 0, 0], phase: '', act: null as any, t: 0, actT: 0, skip: new Set<string>(), boatT: 0, rooms: new Set<string>(), err: '' });
  let gear: any = {}, opened: any = {};
  const refresh = () => { const sv = g.save(); gear = sv.gear; opened = sv.opened; return sv; };
  refresh();
  const canEdge = (e: any) => !e.gate || opened[e.gate] || gear[gateInfo[e.gate].need] > 0;
  function dijkstra(from: string) {
    const cost: Record<string, number> = { [from]: 0 }, prev: Record<string, string> = {}, done = new Set<string>();
    const q = [from];
    while (q.length) {
      q.sort((a, b) => cost[a] - cost[b]);
      const id = q.shift()!; if (done.has(id)) continue; done.add(id);
      for (const e of N[id].adj) { if (!canEdge(e)) continue; const c = cost[id] + e.d * ata((N[id].y + N[e.n].y) / 2); if (cost[e.n] == null || c < cost[e.n]) { cost[e.n] = c; prev[e.n] = id; q.push(e.n); } }
    }
    return { cost, prev };
  }
  const pathOf = (dj: any, to: string) => { const out = [to]; let c = to; while (dj.prev[c]) { c = dj.prev[c]; out.unshift(c); } return out; };
  // 網袋の重さ L のときの 1m あたりの空気(重いほど遅く、息も上がる)
  const airPerM = (L = 0) => ((g.sac() * 1.32) / g.gear('fins')) * (1 + L) * (1 + 0.25 * L);
  // いまいる場所から入れる点(同じ部屋の点か、外なら外の点で いちばん近いもの)
  function startNode(p: any) {
    const r = g.roomAt(p.x, p.y, p.z);
    let best = '', bd = 1e9;
    for (const id in N) { const n = N[id]; const room = n.room === 'out' ? null : n.room.split(':')[1]; if ((r || null) !== room) continue; const d = dist(n, p); if (d < bd) { bd = d; best = id; } }
    if (!best) for (const id in N) { const d = dist(N[id], p); if (d < bd) { bd = d; best = id; } }
    return best;
  }
  const value = (i: any) => (i.k === 'key' ? (opened.safe ? 0 : 900) : i.k === 'log' ? 12 : i.value);
  function candidates() {
    const items = g.items().filter((i: any) => i.st === 'world' && !i.hidden && !B.skip.has(i.id));
    const sv = refresh();
    const out = items.map((i: any) => ({ ...i, v: value(i) }));
    if (!opened.safe && sv.items.key && !B.skip.has('safe')) { const sg = gateInfo.safe; out.push({ id: 'safe', gate: true, node: 's_strong', x: sg.x, y: sg.y, z: sg.z, free: true, v: 1400 }); }
    return out.filter((i: any) => i.v > 0);
  }
  function planThink() {
    const p = g.player(), cap = g.gear('bag'), budget = p.air - 34;
    const dl = dijkstra('line');
    let cur = startNode(p), spent = 0, bag = p.bag.length, load = g.load();
    const route: any[] = [], pool = candidates();
    for (let k = 0; k < 12; k++) {
      const dc = dijkstra(cur);
      let best: any = null, bs = 0;
      for (const i of pool) {
        if (route.includes(i)) continue;
        if (!i.free && bag >= cap) continue;
        if (dc.cost[i.node] == null || dl.cost[i.node] == null) continue;
        const ap = dist(i, N[i.node]) * 2.2 * ata(i.y);
        const w = i.w || 0;
        const go = (dc.cost[i.node] + ap) * airPerM(load) + 5;
        const back = dl.cost[i.node] * airPerM(load + w), curBack = (dl.cost[cur] ?? 0) * airPerM(load);
        if (spent + go + back > budget) continue;
        const sc = i.v / (go + back - curBack + 6);
        if (sc > bs) { bs = sc; best = { i, go }; }
      }
      if (!best) break;
      route.push(best.i); spent += best.go; cur = best.i.node; if (!best.i.free) bag++; load += best.i.w || 0;
    }
    return route;
  }
  function planGreedy() {
    const p = g.player();
    const dc = dijkstra(startNode(p));
    let best: any = null, bc = 1e9;
    for (const i of candidates()) { if (!i.free && p.bag.length >= g.gear('bag')) continue; const c = dc.cost[i.node]; if (c == null) continue; const cc = c + dist(i, N[i.node]); if (cc < bc) { bc = cc; best = i; } }
    return best ? [best] : [];
  }
  // 道すじを作る(閉じた扉の手前では「開ける」をはさむ)
  function routeTo(nodeId: string, final: any) {
    const p = g.player();
    const st = startNode(p);
    const dj = dijkstra(st);
    if (dj.cost[nodeId] == null) return false;
    const ids = pathOf(dj, nodeId);
    B.path = [];
    for (let k = 0; k < ids.length; k++) {
      const n = N[ids[k]];
      if (k > 0) { const e = N[ids[k - 1]].adj.find((x: any) => x.n === ids[k]); if (e && e.gate && !opened[e.gate]) B.path.push({ kind: 'gate', id: e.gate, x: gateInfo[e.gate].x, y: gateInfo[e.gate].y, z: gateInfo[e.gate].z }); }
      B.path.push({ kind: 'node', id: n.id, x: n.x, y: n.y, z: n.z });
    }
    if (final) B.path.push(final);
    B.best = 1e9; B.bestT = B.t; B.unstickN = 0;
    return true;
  }
  function steer(tx: number, ty: number, tz: number, p: any, slow = false) {
    const dx = tx - p.x, dy = ty - p.y, dz = tz - p.z, h = Math.hypot(dx, dz), d = Math.hypot(dx, dy, dz);
    // 下にある目標へは、近づくまでほぼ水平に泳ぐ(手すりや甲板の縁に下から突っこまない)
    const yawT = h > 0.3 ? Math.atan2(dz, dx) : p.yaw, pitT = Math.atan2(dy, Math.max(h, 0.3)) * (dy < 0 && h > 2.5 ? 0.35 : 1);
    let ey = yawT - p.yaw; ey = (((ey + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const ep = Math.max(-1.35, Math.min(1.35, pitT)) - p.pitch;
    key('ArrowLeft', ey < -0.05); key('ArrowRight', ey > 0.05);
    key('ArrowUp', ep > 0.05); key('ArrowDown', ep < -0.05);
    const ok = Math.abs(ey) < (h < 1.5 ? 1.2 : 0.55) && Math.abs(ep) < 0.7;
    key('KeyS', false); key('KeyA', false); key('KeyD', false);   // 引っかかりから抜ける動きの名残を離す
    key('KeyW', ok && d > (slow ? 0.6 : 0.3) && !(slow && p.speed > 0.9 && d < 1.6));
    key('Space', dy > 0.8 && h < 1.2); key('ShiftLeft', dy < -0.8 && h < 1.2);
    return d;
  }
  function unstuck(p: any, d: number) {
    if (d < B.best - 0.3) { B.best = d; B.bestT = B.t; }
    if (B.t - B.bestT > 2.6) {
      B.unstick = 0.8; B.unstickN++; B.bestT = B.t; B.best = d;
      B.us = [rnd() < 0.5 ? 'KeyA' : 'KeyD', rnd() < 0.5 ? 'Space' : 'ShiftLeft'];
    }
    if (B.unstick > 0) {
      B.unstick -= 1 / 60;
      releaseAll(); key('KeyS', true); key(B.us[0], true); key(B.us[1], true);
      return true;
    }
    return false;
  }
  function follow(p: any) {
    // 道の点をたどる。最後の点が遺品・扉なら、目の前に来たら E
    while (B.path.length) {
      const w0 = B.path[0];
      if (w0.kind === 'gate' && opened[w0.id]) { B.path.shift(); continue; }
      break;
    }
    const w0 = B.path[0];
    if (!w0) return 'arrived';
    const d = Math.hypot(w0.x - p.x, w0.y - p.y, w0.z - p.z);
    if (unstuck(p, d)) { if (B.unstickN > 5) return 'stuck'; return 'moving'; }
    if (w0.kind === 'node') {
      const last = B.path.length === 1;
      steer(w0.x, w0.y, w0.z, p, last);
      if (d < (last ? 0.8 : 1.15)) { B.path.shift(); B.best = 1e9; B.bestT = B.t; B.unstickN = 0; }
      return 'moving';
    }
    // 遺品・扉・ロープ
    steer(w0.x, w0.y + (w0.kind === 'item' ? 0.35 : 0), w0.z, p, true);
    const t = g.target();
    const want = w0.kind === 'line' ? 'line' : w0.id;
    if (t && t.id === want && (w0.kind !== 'line' || t.kind === 'line')) {
      if (!t.ok) return 'blocked';
      if (cfg.kind === 'goto' && !cfg.pick && w0.kind === 'item') return 'acting';
      if (B.t - B.actT > 0.4) { B.actT = B.t; tap('KeyE'); }
      if (w0.kind === 'gate') { refresh(); if (opened[w0.id]) { B.path.shift(); B.best = 1e9; B.bestT = B.t; } }
      return 'acting';
    }
    return 'moving';
  }
  function logDive() {
    const l = g.last(), sv = g.save();
    B.log.push({ n: B.dives, kind: l?.kind, earned: l?.earned ?? 0, items: l?.items ?? [], dropped: l?.dropped ?? [], money: sv.money, earnedTotal: sv.earned, rooms: Object.keys(sv.rooms).length, gear: { ...sv.gear } });
  }
  function shop() {
    const list = g.shop() as any[];
    const money = g.money();
    const click = (k: string) => { const b = document.querySelector(`#shop button[data-k="${k}"]`) as HTMLButtonElement | null; if (b && !b.disabled) b.click(); };
    if (cfg.kind === 'think' || cfg.kind === 'goto') {
      // 買う順番の表: 同じ装備が2回出てきたら、2回目は1段上
      const want: Record<string, number> = {};
      for (const k of cfg.buy || []) {
        want[k] = (want[k] || 0) + 1;
        const it = (g.shop() as any[]).find((x) => x.k === k)!;
        if (it.lv >= want[k] || it.cost == null) continue;
        if (it.cost > g.money()) break;
        click(k);
      }
    } else if (cfg.kind === 'greedy') {
      for (let n = 0; n < 6; n++) { const c = (g.shop() as any[]).filter((x) => x.cost != null && x.cost <= g.money()).sort((a, b) => a.cost - b.cost)[0]; if (!c) break; click(c.k); }
    }
    void money;
  }
  w.__autoStep = () => {
    try {
      const st = g.state();
      B.t += 1 / 60;
      if (B.done) { releaseAll(); return; }
      if (st === 'title') { if (B.t > 0.3) { B.t = 0; (document.querySelector('#b-start') as HTMLButtonElement).click(); } return; }
      if (st === 'boat') {
        releaseAll();
        if (B.phase !== 'boat') { B.phase = 'boat'; B.dives++; logDive(); B.boatT = B.t; }
        if (B.dives >= cfg.dives) { B.done = true; return; }
        if (B.t - B.boatT > 0.2) {
          const end = document.querySelector('#end-ok') as HTMLButtonElement | null;
          if (end && !document.querySelector('#ending')!.classList.contains('hidden')) end.click();
          shop(); B.plan = null; B.path = []; B.skip.clear(); B.phase = '';
          (document.querySelector('#b-go') as HTMLButtonElement).click();
        }
        return;
      }
      if (st !== 'dive') { releaseAll(); return; }
      const p = g.player();
      const r = g.roomAt(p.x, p.y, p.z); if (r) B.rooms.add(r);
      if (cfg.kind === 'goto') {
        if (!B.plan) { B.plan = []; refresh(); routeTo(cfg.to![0], null); }
        const res = follow(p);
        if (res === 'arrived' || res === 'stuck') {
          releaseAll();
          if (cfg.look) { const lk = cfg.look; const dx = lk[0] - p.x, dy = lk[1] - p.y, dz = lk[2] - p.z; const yawT = Math.atan2(dz, dx), pitT = Math.atan2(dy, Math.hypot(dx, dz)); let ey = yawT - p.yaw; ey = (((ey + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; key('ArrowLeft', ey < -0.03); key('ArrowRight', ey > 0.03); key('ArrowUp', pitT - p.pitch > 0.03); key('ArrowDown', pitT - p.pitch < -0.03); }
          if (cfg.to!.length > 1 && res === 'arrived') { cfg.to!.shift(); routeTo(cfg.to![0], null); }
          else B.arrived = true;
        }
        return;
      }
      if (cfg.kind === 'random') {
        B.randT -= 1 / 60;
        const t = g.target();
        if (t && t.ok && t.kind === 'item' && B.t - B.actT > 0.5) { B.actT = B.t; tap('KeyE'); }
        if (B.randT <= 0 || (p.speed < 0.25 && B.t - B.bestT > 1.5)) { B.randT = 2 + rnd() * 3; const a = rnd() * Math.PI * 2, pt = (rnd() - 0.5) * 1.0; B.randDir = [Math.cos(a) * Math.cos(pt), Math.sin(pt), Math.sin(a) * Math.cos(pt)]; B.bestT = B.t; }
        if (p.speed > 0.4) B.bestT = B.t;
        steer(p.x + B.randDir[0] * 10, p.y + B.randDir[1] * 10, p.z + B.randDir[2] * 10, p);
        return;
      }
      // think / greedy
      const est = g.est() ?? 0;
      const cap = g.gear('bag');
      if (B.phase !== 'return' && !cfg.noReturn) {
        const low = cfg.kind === 'think' ? p.air - est < 22 + p.airMax * 0.04 : p.air < p.airMax * 0.3;
        if (low) { B.phase = 'return'; routeTo('line', { kind: 'line', id: 'line', x: g.line().x, y: p.y, z: g.line().z }); }
      }
      if (B.phase === '' || (B.phase === 'go' && !B.act)) {
        if (!B.plan || !B.plan.length) B.plan = cfg.kind === 'think' ? planThink() : (p.bag.length >= cap && !candidates().some((i: any) => i.free) ? [] : planGreedy());
        const nx = B.plan.shift();
        if (!nx) { if (!cfg.noReturn) { B.phase = 'return'; routeTo('line', { kind: 'line', id: 'line', x: g.line().x, y: p.y, z: g.line().z }); } return; }
        B.act = nx; B.phase = 'go'; B.actStart = B.t;
        if (!routeTo(nx.node, { kind: nx.gate ? 'gate' : 'item', id: nx.id, x: nx.x, y: nx.y, z: nx.z })) { B.skip.add(nx.id); B.act = null; }
        return;
      }
      if (B.phase === 'go') {
        const res = follow(p);
        const it = B.act.gate ? null : (g.items() as any[]).find((x) => x.id === B.act.id);
        const doneIt = B.act.gate ? (refresh(), !!opened.safe) : !it || it.st !== 'world';
        if (doneIt || res === 'stuck' || res === 'blocked' || B.t - B.actStart > 70) {
          if (!doneIt) B.skip.add(B.act.id);
          const wasGate = !!B.act.gate;
          B.act = null; if (cfg.kind === 'greedy' || (doneIt && wasGate)) B.plan = null;
          if (B.plan && B.plan.length === 0) B.plan = null;
          releaseAll();
        }
        return;
      }
      if (B.phase === 'return') {
        const lp = g.line();
        if (B.path.length) { const last = B.path[B.path.length - 1]; if (last.kind === 'line') last.y = Math.max(-28, Math.min(-6, p.y)); }
        const res = follow(p);
        if (res === 'stuck') routeTo('line', { kind: 'line', id: 'line', x: lp.x, y: p.y, z: lp.z });
      }
    } catch (e) { B.err = String(e); }
  };
}
async function runBot(page: Page, cfg: BotCfg, opts: { speed?: number; noDraw?: boolean; timeout?: number } = {}) {
  await page.evaluate(([c, o]) => { (window as any).__simSpeed = o.speed ?? 24; (window as any).__noDraw = o.noDraw ?? true; }, [cfg, opts] as const);
  await page.evaluate(botInstall, cfg);
  await expect.poll(() => page.evaluate(() => (window as any).__bot.done || !!(window as any).__bot.err), { timeout: opts.timeout ?? 240_000, intervals: [500] }).toBeTruthy();
  const bot = await page.evaluate(() => { const b = (window as any).__bot; return { log: b.log, err: b.err, rooms: [...b.rooms] }; });
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
    const ok = await page.evaluate(() => {
      const g = (window as any).gameTest;
      return !!g && ['state', 'score', 'webgl', 'player', 'items', 'gates', 'pockets', 'nav', 'line', 'rooms', 'target', 'est', 'save', 'shop', 'events', 'toScreen', 'quality', 'particles', 'sound'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
    expect(await gt<boolean>(page, 'webgl'), 'WebGL が使えていません').toBeTruthy();
    await startDive(page);
    await page.waitForTimeout(1500);
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '3Dの画面に何も描かれていないようです').toBeGreaterThan(40_000);
    expect(errors).toEqual([]);
  });

  // ------------------------------------------------------------------------
  //  核の遊び
  // ------------------------------------------------------------------------
  test('泳ぐ: 人の速さで W を押すと前へ進み、矢印キー・ドラッグで向きが変わる。Space / Shift で上下する', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーとマウスで確かめる');
    const errors = await open(page, { seed: 2 });
    await startDive(page);
    const p0 = await gt<any>(page, 'player');
    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(400); await page.keyboard.up('ArrowRight');
    const p1 = await gt<any>(page, 'player');
    expect(p1.yaw - p0.yaw, '→ キーで右を向きません').toBeGreaterThan(0.3);
    const box = (await page.locator('#gl').boundingBox())!;
    await page.mouse.move(box.width / 2, box.height / 2); await page.mouse.down(); await page.mouse.move(box.width / 2 - 150, box.height / 2 + 60, { steps: 10 }); await page.mouse.up();
    const p2 = await gt<any>(page, 'player');
    expect(p1.yaw - p2.yaw, '左へドラッグしても左を向きません').toBeGreaterThan(0.4);
    expect(p2.pitch, '下へドラッグしても下を向きません').toBeLessThan(p1.pitch - 0.1);
    // 水平に戻してから、2秒 W
    await page.keyboard.down('ArrowUp'); await page.waitForTimeout((Math.abs(p2.pitch) / 1.4) * 1000); await page.keyboard.up('ArrowUp');
    const a = await gt<any>(page, 'player');
    await page.keyboard.down('KeyW'); await page.waitForTimeout(2000); await page.keyboard.up('KeyW');
    const b = await gt<any>(page, 'player');
    const moved = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), fwd = ((b.x - a.x) * Math.cos(a.yaw) + (b.z - a.z) * Math.sin(a.yaw));
    console.log(`  2秒で ${moved.toFixed(2)}m(向いている方へ ${fwd.toFixed(2)}m)`);
    expect(fwd, 'W で前に進みません').toBeGreaterThan(1.6);
    expect(moved, '速すぎます(水の中なので、ふつうのフィンで 2m/秒 くらいまで)').toBeLessThan(4.2);
    await page.keyboard.down('Space'); await page.waitForTimeout(1200); await page.keyboard.up('Space');
    const c = await gt<any>(page, 'player');
    expect(c.y - b.y, 'Space で上がりません').toBeGreaterThan(0.5);
    await page.keyboard.down('ShiftLeft'); await page.waitForTimeout(1200); await page.keyboard.up('ShiftLeft');
    const d = await gt<any>(page, 'player');
    expect(c.y - d.y, 'Shift で下がりません').toBeGreaterThan(0.5);
    expect(errors).toEqual([]);
  });

  test('空気: 深いほど速く減る(水深10mごとに1気圧ぶん)。泳ぐと少し速く減る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(120_000);
    await open(page, { seed: 3, save: { gear: { tank: 2, fins: 2, bag: 0, light: 0, crowbar: 0, cutter: 0 } } });
    await startDive(page);
    const rate = async () => {
      const a = await gt<any>(page, 'player'), t0 = (await gt<any>(page, 'dive')).t;
      await page.waitForTimeout(1500);
      const b = await gt<any>(page, 'player'), t1 = (await gt<any>(page, 'dive')).t;
      return { r: (a.air - b.air) / (t1 - t0), ata: 1 + (a.depth + b.depth) / 20 };
    };
    await page.evaluate(() => { (window as any).__simSpeed = 3; });
    const shallow = await rate();
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['s_engB'] } as BotCfg);
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    await page.waitForTimeout(600);
    const deep = await rate();
    // 泳いでいるとき
    await page.evaluate(() => { const b = (window as any).__bot; b.done = true; });
    await page.keyboard.down('KeyS');
    const swim = await rate();
    await page.keyboard.up('KeyS');
    console.log(`  空気の減り: 浅い所 ${shallow.r.toFixed(2)} bar/秒(${shallow.ata.toFixed(2)}気圧)・深い所 ${deep.r.toFixed(2)}(${deep.ata.toFixed(2)}気圧)・泳ぎながら ${swim.r.toFixed(2)}`);
    expect(deep.r / shallow.r, '深い所の空気の減りが、気圧の比になっていません').toBeGreaterThan((deep.ata / shallow.ata) * 0.9);
    expect(deep.r / shallow.r).toBeLessThan((deep.ata / shallow.ata) * 1.1);
    expect(deep.ata / shallow.ata, '深い所が浅すぎます').toBeGreaterThan(1.3);
    expect(swim.r, '泳いでも空気の減りが変わりません').toBeGreaterThan(deep.r * 1.15);
  });

  test('重さ: 重い遺品(船鐘)を網袋に入れると、泳ぎが遅くなり、ダイブコンピューターの「戻る」が増える', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(150_000);
    const errors = await open(page, { seed: 5 });
    await startDive(page);
    const bell = (await gt<any[]>(page, 'items')).find((i) => i.id === 'bell');
    await page.evaluate(() => { (window as any).__simSpeed = 3; });
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['b_fore'], look: [bell.x, bell.y, bell.z] } as BotCfg);
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    await page.waitForTimeout(800);
    await page.evaluate(() => { (window as any).__bot.done = true; (window as any).__simSpeed = 1; });
    // 速さ: 船鐘の方へ 1.2 秒 W(空の網袋)
    const swimSpeed = async () => { await page.keyboard.down('KeyW'); await page.waitForTimeout(1200); const s = (await gt<any>(page, 'player')).speed; await page.keyboard.up('KeyW'); return s; };
    const v0 = await swimSpeed();
    // 船鐘が目の前に来るまで近づいて、E
    for (let i = 0; i < 40 && (await gt<any>(page, 'target'))?.id !== 'bell'; i++) { await page.keyboard.down('KeyW'); await page.waitForTimeout(150); await page.keyboard.up('KeyW'); }
    const tg = await gt<any>(page, 'target');
    expect(tg?.id, '船鐘の前に来られません').toBe('bell');
    expect(tg.msg, '拾う前に「重い」と分かりません').toContain('重い');
    await page.waitForTimeout(400);
    const e0 = (await gt<number>(page, 'est'))!;
    await page.keyboard.press('KeyE');
    await expect.poll(() => gt<number>(page, 'load')).toBeGreaterThan(0.3);
    await page.waitForTimeout(400);
    const e1 = (await gt<number>(page, 'est'))!;
    await expect(page.locator('#bag')).toContainText('重い');
    await page.keyboard.down('KeyS'); await page.waitForTimeout(1500); await page.keyboard.up('KeyS'); await page.waitForTimeout(800);
    const v1 = await swimSpeed();
    console.log(`  泳ぐ速さ ${v0.toFixed(2)} → ${v1.toFixed(2)} m/秒・戻る ${e0.toFixed(1)} → ${e1.toFixed(1)} bar`);
    expect(v1, '重い遺品を持っても、泳ぐ速さが変わりません').toBeLessThan(v0 * 0.8);
    expect(e1, '重い遺品を持っても、帰りの空気の見積もりが増えません').toBeGreaterThan(e0 * 1.4);
    expect(errors).toEqual([]);
  });

  test('拾って戻る: ライトに照らされた遺品を E で網袋に入れ、ロープで浮上すると売れて、お金になる。もう一度潜れる', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await open(page, { seed: 4 });
    await startDive(page);
    const bot = await runBot(page, { kind: 'think', seed: 4, dives: 1, buy: [] });
    const l = bot.log[0];
    console.log(`  1本目: ${l.kind}・売った額 ${l.earned}円(${l.items.join('・')})・見つけた部屋 ${l.rooms}`);
    expect(l.kind, '浮上できませんでした').toBe('surface');
    expect(l.items.length, '何も持ち帰れていません').toBeGreaterThan(0);
    expect(l.earned).toBeGreaterThan(0);
    // 売った代金 + はじめて入った部屋の調査報酬 + 日当
    expect(await gt<number>(page, 'money')).toBe(l.earned + 50 + 80 * l.rooms);
    const items = await gt<any[]>(page, 'items');
    for (const id of l.items) expect(items.find((i) => i.id === id).st, '売った遺品が、まだ海の中に残っています').toBe('banked');
    await expect(page.locator('#boat')).toBeVisible();
    await expect(page.locator('#b-res')).toContainText('売った代金');
    expect((await gt<any[]>(page, 'events')).filter((e) => e.type === 'pick' && e.k !== 'log' && e.k !== 'key').length, '拾った数と売った数が合いません').toBe(l.items.length);
    if (await isMobile(page)) await page.locator('#b-go').tap(); else await page.locator('#b-go').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('descend');
    expect(errors).toEqual([]);
  });

  test('気を失う: 空気が尽きると、網袋の中身はその場に落ちる。次の潜水で、落とした所に残っていて拾い直せる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(180_000);
    const errors = await open(page, { seed: 5 });
    await startDive(page);
    const bot = await runBot(page, { kind: 'think', seed: 5, dives: 1, buy: [], noReturn: true });
    const l = bot.log[0];
    console.log(`  ${l.kind}・落としたもの ${l.dropped.join('・')}`);
    expect(l.kind, '空気が尽きても気を失いません').toBe('blackout');
    expect(l.dropped.length, '袋の中身が落ちていません').toBeGreaterThan(0);
    expect(l.earned, '気を失ったのに売れています').toBe(0);
    expect(await gt<number>(page, 'money'), '気を失ったのに売れています').toBe(50 + 80 * l.rooms);
    await expect(page.locator('#b-res')).toContainText('気を失い');
    const items = await gt<any[]>(page, 'items');
    for (const id of l.dropped) { const it = items.find((i) => i.id === id); expect(it.st).toBe('world'); expect(it.dropped).toBeTruthy(); }
    // 再読み込みしても、落とした場所に残る
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    const again = await gt<any[]>(page, 'items');
    for (const id of l.dropped) { const a = items.find((i) => i.id === id), b = again.find((i) => i.id === id); expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), '落とした遺品の場所が、再読み込みで変わりました').toBeLessThan(0.05); }
    // 拾いに行く
    await startDive(page);
    const bot2 = await runBot(page, { kind: 'think', seed: 6, dives: 1, buy: [] });
    const got = bot2.log[0].items.filter((id: string) => l.dropped.includes(id));
    console.log(`  次の潜水で拾い直した: ${got.join('・') || 'なし'}(${bot2.log[0].kind})`);
    expect(got.length, '落とした遺品を拾い直せません').toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('扉: バールが無いと歪んだ扉は開かず、通れない。買うと開けて船長室に入れる。鍵がないと金庫は開かない', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(180_000);
    const errors = await open(page, { seed: 8, save: { money: 2000, gear: { tank: 2, fins: 2, bag: 0, light: 0, crowbar: 0, cutter: 0 } } });
    await startDive(page);
    await page.evaluate(() => { (window as any).__simSpeed = 6; });
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['b_cabD'], look: [0, 0, 0] } as BotCfg);
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    // 扉の方を向いて E
    const gate = (await gt<any[]>(page, 'gates')).find((g) => g.id === 'cabin');
    await page.evaluate((gp) => { const b = (window as any).__bot; b.cfg.look = [gp.x, gp.y, gp.z]; }, gate);
    await page.waitForTimeout(800);
    const t = await gt<any>(page, 'target');
    expect(t && t.id, '扉の前に来ても、扉が調べられません').toBe('cabin');
    expect(t.ok, 'バールが無いのに開けられます').toBeFalsy();
    expect(t.msg).toContain('バール');
    await page.keyboard.press('KeyE');
    expect((await gt<any[]>(page, 'gates')).find((g) => g.id === 'cabin').open).toBeFalsy();
    // 押し通ろうとしても入れない
    await page.evaluate(() => { (window as any).__bot.done = true; });
    const cab = (await gt<any>(page, 'nav')).nodes.find((n: any) => n.id === 'b_cabin');
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['b_cabin'] } as BotCfg);
    await page.waitForTimeout(4000);
    const p = await gt<any>(page, 'player');
    expect(p.room, 'バールが無いのに船長室に入れました').not.toBe('cabin');
    void cab;
    // 浮上して、バールを買う
    await page.evaluate(() => { const b = (window as any).__bot; b.cfg.to = ['line']; b.plan = null; b.arrived = false; });
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    await page.evaluate(() => { (window as any).__bot.done = true; });
    await page.keyboard.press('KeyE');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 20_000 }).toBe('boat');
    const m0 = await gt<number>(page, 'money');
    await page.locator('#shop button[data-k="crowbar"]').click();
    expect((await gt<any>(page, 'save')).gear.crowbar).toBe(1);
    expect(await gt<number>(page, 'money'), 'バールの代金が引かれていません').toBe(m0 - 500);
    await page.locator('#b-go').click();
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('dive');
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['b_cabin'] } as BotCfg);
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    expect((await gt<any[]>(page, 'gates')).find((g) => g.id === 'cabin').open, 'バールがあっても扉が開きません').toBeTruthy();
    expect((await gt<any>(page, 'player')).room, '扉を開けても船長室に入れません').toBe('cabin');
    expect((await gt<any[]>(page, 'events')).some((e) => e.type === 'open' && e.id === 'cabin')).toBeTruthy();
    expect(errors).toEqual([]);
  });

  test('空気だまり: 天井の空気だまりに頭を入れると空気が満タンまで戻る。同じ潜水では2度目は戻らない', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(150_000);
    await open(page, { seed: 9 });
    await startDive(page);
    await page.evaluate(() => { (window as any).__simSpeed = 6; });
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['b_mess'] } as BotCfg);
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    const before = await gt<any>(page, 'player');
    await page.evaluate(() => { const b = (window as any).__bot; b.cfg.to = ['b_messP']; b.plan = null; b.arrived = false; (window as any).__simSpeed = 1; });
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    await page.evaluate(() => { (window as any).__bot.done = true; });
    await page.waitForTimeout(200);
    await page.keyboard.down('Space');
    await page.waitForTimeout(2500);
    const inP = await gt<any>(page, 'player');
    console.log(`  空気だまりの前 ${before.air.toFixed(0)} → 中 ${inP.air.toFixed(0)} / ${inP.airMax}(${inP.pocket})`);
    expect(inP.pocket, '空気だまりに頭が入りません').toBe('mess');
    expect(inP.air, '空気だまりで空気が戻りません').toBeGreaterThan(inP.airMax - 5);
    expect((await gt<any>(page, 'save')).pockets.mess, '空気だまりを見つけたことが残りません').toBeTruthy();
    // 出て、しばらく泳いでから、もう一度
    await page.keyboard.up('Space');
    await page.keyboard.down('ShiftLeft'); await page.waitForTimeout(1200); await page.keyboard.up('ShiftLeft');
    expect((await gt<any>(page, 'player')).pocket).toBeNull();
    await page.waitForTimeout(2500);
    await page.keyboard.down('Space');
    await page.waitForTimeout(600);
    const a2 = await gt<any>(page, 'player');
    await page.waitForTimeout(2000);
    const b2 = await gt<any>(page, 'player');
    await page.keyboard.up('Space');
    console.log(`  2度目: ${a2.air.toFixed(1)} → ${b2.air.toFixed(1)}(${b2.pocket})`);
    expect(b2.pocket, '2度目に空気だまりへ頭が入りません').toBe('mess');
    expect(b2.air, '同じ潜水で2度目も空気が戻ります').toBeLessThan(a2.air + 0.5);
  });

  test('泥: 船倉の床の近くを勢いよく泳ぐと泥が舞い、視界が悪くなる。しばらくすると沈む', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(120_000);
    await open(page, { seed: 10 });
    await startDive(page);
    await page.evaluate(() => { (window as any).__simSpeed = 6; });
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['b_hold1'] } as BotCfg);
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    await page.evaluate(() => { (window as any).__bot.done = true; (window as any).__simSpeed = 1; });
    const fog0 = await gt<number>(page, 'fogK');
    // 床すれすれまで下りて、前後に泳ぐ
    await page.keyboard.down('ShiftLeft'); await page.waitForTimeout(1800); await page.keyboard.up('ShiftLeft');
    for (let i = 0; i < 3; i++) { await page.keyboard.down('KeyW'); await page.waitForTimeout(1300); await page.keyboard.up('KeyW'); await page.keyboard.down('KeyS'); await page.waitForTimeout(1300); await page.keyboard.up('KeyS'); }
    const silt = await gt<number>(page, 'silt'), fog1 = await gt<number>(page, 'fogK');
    console.log(`  泥 ${silt.toFixed(2)}・濁り ${fog0.toFixed(3)} → ${fog1.toFixed(3)}・粒 ${await gt<number>(page, 'particles')}`);
    expect(silt, '床の近くを泳いでも泥が舞いません').toBeGreaterThan(0.3);
    expect(fog1, '泥が舞っても視界が変わりません').toBeGreaterThan(fog0 * 5);
    await page.evaluate(() => { (window as any).__simSpeed = 20; });
    await page.waitForTimeout(3000);
    expect(await gt<number>(page, 'silt'), '泥がいつまでも沈みません').toBeLessThan(silt * 0.6);
  });

  test('保存: 潜ったあとで再読み込みしても、お金・装備・回収した遺品・見つけた部屋が残る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(150_000);
    await open(page, { seed: 11 });
    await startDive(page);
    await runBot(page, { kind: 'think', seed: 11, dives: 2, buy: ['bag', 'crowbar'] });
    const s0 = await gt<any>(page, 'save');
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    const s1 = await gt<any>(page, 'save');
    console.log(`  潜水 ${s1.dives}本・${s1.money}円・装備 ${JSON.stringify(s1.gear)}・部屋 ${Object.keys(s1.rooms).length}`);
    expect([s1.money, s1.dives, s1.earned]).toEqual([s0.money, s0.dives, s0.earned]);
    expect(s1.gear).toEqual(s0.gear);
    expect(s1.rooms).toEqual(s0.rooms);
    expect(s1.spots, '遺品の置き場所が再読み込みで変わりました').toEqual(s0.spots);
    const items = await gt<any[]>(page, 'items');
    for (const [id, v] of Object.entries(s0.items as Record<string, any>)) if (v.st === 'banked') expect(items.find((i) => i.id === id).st).toBe('banked');
    await expect(page.locator('#b-start')).toHaveText('続きから潜る');
    await expect(page.locator('#rec')).toContainText(`潜水 ${s1.dives} 本`);
  });

  test('金庫: 鍵とカッターがあれば、金庫室の鉄格子を焼き切り、金庫を開けて金の延べ棒を持ち帰れる。持ち帰ると調査報告が出る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(180_000);
    const errors = await open(page, { seed: 12, save: { money: 0, dives: 6, gear: { tank: 2, fins: 1, bag: 1, light: 0, crowbar: 1, cutter: 1 }, items: { key: { st: 'banked' } } } });
    await startDive(page);
    const bot = await runBot(page, { kind: 'think', seed: 12, dives: 1, buy: [] });
    const l = bot.log[0];
    console.log(`  ${l.kind}・${l.items.join('・')}・${l.earned}円`);
    expect(l.items, '金の延べ棒を持ち帰れません').toContain('gold');
    const sv = await gt<any>(page, 'save');
    expect(sv.opened.strong && sv.opened.safe, '鉄格子か金庫が開いていません').toBeTruthy();
    expect((await gt<any[]>(page, 'items')).find((i) => i.id === 'log6').hidden, '金庫を開けても、中の手紙(日誌6)が出てきません').toBeFalsy();
    expect(sv.done).toBeTruthy();
    await expect(page.locator('#ending')).toBeVisible();
    await expect(page.locator('#end-card')).toContainText('海図');
    expect(errors).toEqual([]);
  });

  test('スマホ: 左の指で泳ぎ、右の指で見回し、▲▼で上下、近づくと出る「拾う」ボタンで拾える。ボタンは指で押せる大きさで、表示が重ならない', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    test.setTimeout(150_000);
    const errors = await open(page, { seed: 13 });
    const v = page.viewportSize()!;
    await startDive(page);
    const inside = (b: { x: number; y: number; width: number; height: number } | null) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5;
    const apart = (a: any, b: any) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    const ids = ['#comp', '#bag', '#b-snd', '#b-pause', '#b-up', '#b-dn'];
    const bx: Record<string, any> = {};
    for (const id of ids) { bx[id] = await page.locator(id).boundingBox(); expect(inside(bx[id]), `${id} がはみ出しています`).toBeTruthy(); }
    for (const id of ['#b-snd', '#b-pause', '#b-up', '#b-dn']) expect(Math.min(bx[id].width, bx[id].height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(apart(bx[ids[i]], bx[ids[j]]), `${ids[i]} と ${ids[j]} が重なっています`).toBeTruthy();
    const cdp = await page.context().newCDPSession(page);
    const touch = async (pts: { x: number; y: number; id: number }[], type: string) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts } as any);
    // 右の指で見回す
    const p0 = await gt<any>(page, 'player');
    await touch([{ x: v.width * 0.75, y: v.height * 0.4, id: 1 }], 'touchStart');
    for (let k = 1; k <= 8; k++) { await touch([{ x: v.width * 0.75 - k * 12, y: v.height * 0.4, id: 1 }], 'touchMove'); await page.waitForTimeout(16); }
    await touch([], 'touchEnd');
    const p1 = await gt<any>(page, 'player');
    expect(p0.yaw - p1.yaw, '右の指でなぞっても見回せません').toBeGreaterThan(0.3);
    // 左の指で前へ(指を置いたまま)
    await touch([{ x: v.width * 0.22, y: v.height * 0.75, id: 2 }], 'touchStart');
    for (let k = 1; k <= 5; k++) { await touch([{ x: v.width * 0.22, y: v.height * 0.75 - k * 10, id: 2 }], 'touchMove'); await page.waitForTimeout(16); }
    await page.waitForTimeout(1500);
    await touch([], 'touchEnd');
    const p2 = await gt<any>(page, 'player');
    const fwd = (p2.x - p1.x) * Math.cos(p1.yaw) + (p2.z - p1.z) * Math.sin(p1.yaw);
    expect(fwd, '左の指で前へ泳げません').toBeGreaterThan(1.0);
    // ▲ を押している間は上がる
    const y0 = (await gt<any>(page, 'player')).y;
    const up = (await page.locator('#b-up').boundingBox())!;
    await touch([{ x: up.x + up.width / 2, y: up.y + up.height / 2, id: 3 }], 'touchStart');
    await page.waitForTimeout(1200);
    await touch([], 'touchEnd');
    expect((await gt<any>(page, 'player')).y - y0, '▲ で上がりません').toBeGreaterThan(0.5);
    // 遺品の前まで行き、「拾う」ボタン
    const items = (await gt<any[]>(page, 'items')).filter((i) => i.st === 'world' && !i.hidden && i.k !== 'log' && i.k !== 'key');
    await page.evaluate(() => { (window as any).__simSpeed = 5; });
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['b_h1', 'b_fore'] } as BotCfg);
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    const bell = items.find((i) => i.id === 'bell');
    await page.evaluate((b) => { const bt = (window as any).__bot; bt.cfg.to = []; bt.path = [{ kind: 'item', id: 'bell', x: b.x, y: b.y + 0.3, z: b.z }]; bt.arrived = false; bt.plan = []; }, bell);
    await expect.poll(async () => (await gt<any>(page, 'target'))?.id, { timeout: 30_000 }).toBe('bell');
    await page.evaluate(() => { (window as any).__bot.done = true; (window as any).__simSpeed = 1; });
    const act = page.locator('#b-act');
    await expect(act).toBeVisible();
    await expect(act).toHaveText('拾う');
    const ab = (await act.boundingBox())!;
    expect(Math.min(ab.width, ab.height)).toBeGreaterThanOrEqual(44);
    expect(inside(ab)).toBeTruthy();
    await act.tap();
    await expect.poll(async () => (await gt<any>(page, 'player')).bag).toContain('bell');
    await cdp.detach();
    expect(errors).toEqual([]);
  });

  test('見取り図: 部屋と通路の点を、本物のキーで泳いで全部たどれる(扉は道具で開ける)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(6 * 60_000);
    const errors = await open(page, { seed: 7, save: { gear: { tank: 2, fins: 2, bag: 1, light: 0, crowbar: 1, cutter: 1 }, items: { key: { st: 'banked' } } } });
    await startDive(page);
    const nav = await gt<{ nodes: { id: string }[]; edges: [string, string, string | null][] }>(page, 'nav');
    // 辺を全部通る順番(深さ優先でたどって戻る)
    const adj: Record<string, string[]> = {};
    for (const [a, b] of nav.edges) { (adj[a] ??= []).push(b); (adj[b] ??= []).push(a); }
    const tour: string[] = [], used = new Set<string>();
    const dfs = (n: string) => { for (const m of adj[n]) { const k = [n, m].sort().join('|'); if (used.has(k)) continue; used.add(k); tour.push(m); dfs(m); tour.push(n); } };
    dfs('line');
    await page.evaluate(() => { (window as any).__simSpeed = 12; (window as any).__noDraw = true; });
    await page.evaluate(botInstall, { kind: 'goto', seed: 3, dives: 99, to: [tour[0]] } as BotCfg);
    const fails: string[] = [];
    const go = async (to: string) => {
      await page.evaluate((to) => { const b = (window as any).__bot; b.cfg.to = [to]; b.plan = null; b.arrived = false; }, to);
      await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 30_000, intervals: [100] }).toBeTruthy();
      return page.evaluate((to) => { const g = (window as any).gameTest, p = g.player(), n = g.nav().nodes.find((x: any) => x.id === to); return { d: Math.hypot(p.x - n.x, p.y - n.y, p.z - n.z), p: [p.x, p.y, p.z].map((v: number) => +v.toFixed(1)), air: p.air }; }, to);
    };
    let from = 'line', dives = 1;
    for (const to of tour) {
      // 空気が少なくなったら、いったん浮上して潜りなおす(はじめの点まで戻ってから続ける)
      if ((await gt<any>(page, 'player')).air < 90) {
        await go('line');
        const n0 = (await gt<any>(page, 'save')).dives;
        await page.evaluate(() => { const w = window as any; w.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })); w.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' })); });
        await expect.poll(async () => (await gt<any>(page, 'save')).dives > n0 && (await gt<string>(page, 'state')) === 'dive', { timeout: 20_000 }).toBeTruthy();
        dives++;
        if (from !== 'line') await go(from);
      }
      const r = await go(to);
      if (r.d > 1.6) fails.push(`${from}→${to}(${r.d.toFixed(1)}m 手前で止まった ${JSON.stringify(r.p)})`);
      from = to;
    }
    console.log(`  潜水 ${dives} 本`);
    console.log(`  たどった区間 ${tour.length}・通れなかった ${fails.length}`);
    for (const f of fails) console.log(`   × ${f}`);
    expect(fails, '通れない道すじがあります').toEqual([]);
    expect(errors).toEqual([]);
  });

  // ------------------------------------------------------------------------
  //  面白さの代わりになる数字
  // ------------------------------------------------------------------------
  const BUY_PLAN = ['bag', 'crowbar', 'cutter', 'tank', 'fins', 'tank', 'light', 'fins'];
  async function session(browser: Browser, cfg: BotCfg, seed: number, save?: Record<string, unknown>, speed = 30) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = await open(page, { seed, save });
    const bot = await runBot(page, cfg, { speed, timeout: 300_000 });
    const sv = await gt<any>(page, 'save');
    const items = (await gt<any[]>(page, 'items')).filter((i) => i.st === 'banked' && !i.free).map((i) => i.id);
    await ctx.close();
    expect(errors, `${cfg.kind}: JSエラー`).toEqual([]);
    return { earned: sv.earned as number, rooms: Object.keys(sv.rooms), blackouts: sv.blackouts as number, done: !!sv.done, items, log: bot.log, gear: sv.gear };
  }
  test('腕の差: 考える自動プレイヤーは、同じ潜水回数で「よくばり」「でたらめ」の1.5倍以上を回収し、より多くの部屋に入る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(9 * 60_000);
    const DIVES = 7;
    const res: Record<string, { earned: number; rooms: number; black: number; done: number; n: number }> = {};
    const add = (k: string, r: any) => { res[k] ??= { earned: 0, rooms: 0, black: 0, done: 0, n: 0 }; const x = res[k]; x.earned += r.earned; x.rooms += r.rooms.length; x.black += r.blackouts; x.done += r.done ? 1 : 0; x.n++; };
    for (const seed of [21, 22]) {
      const th = await session(browser, { kind: 'think', seed, dives: DIVES, buy: BUY_PLAN }, seed);
      const gr = await session(browser, { kind: 'greedy', seed, dives: DIVES }, seed);
      add('考える', th); add('よくばり', gr);
      console.log(`  種${seed} 考える: ${th.earned}円・部屋${th.rooms.length}・気絶${th.blackouts}・金庫${th.done ? '開けた' : 'まだ'}・装備${JSON.stringify(th.gear)}`);
      console.log(`         潜水ごと ${th.log.map((l: any) => `${l.kind === 'surface' ? '' : '×'}${l.earned}`).join(' / ')}`);
      console.log(`  種${seed} よくばり: ${gr.earned}円・部屋${gr.rooms.length}・気絶${gr.blackouts}・金庫${gr.done ? '開けた' : 'まだ'}・装備${JSON.stringify(gr.gear)}`);
      console.log(`         潜水ごと ${gr.log.map((l: any) => `${l.kind === 'surface' ? '' : '×'}${l.earned}`).join(' / ')}`);
    }
    const rd = await session(browser, { kind: 'random', seed: 23, dives: 4 }, 23);
    add('でたらめ', rd);
    console.log(`  でたらめ(4本): ${rd.earned}円・部屋${rd.rooms.length}・気絶${rd.blackouts}`);
    const avg = (k: string) => res[k].earned / res[k].n, rooms = (k: string) => res[k].rooms / res[k].n;
    console.log(`  平均の回収額: 考える ${avg('考える').toFixed(0)}円・よくばり ${avg('よくばり').toFixed(0)}円・でたらめ ${avg('でたらめ').toFixed(0)}円(倍率 ${(avg('考える') / Math.max(1, avg('よくばり'))).toFixed(2)})`);
    expect(avg('考える'), '考えて遊んでも、よくばりの1.5倍に届きません').toBeGreaterThanOrEqual(avg('よくばり') * 1.5);
    expect(avg('考える')).toBeGreaterThanOrEqual(avg('でたらめ') * 1.5);
    expect(rooms('考える'), '考えて遊んでも、入れる部屋が増えません').toBeGreaterThan(rooms('よくばり'));
    expect(res['考える'].black, '考える自動プレイヤーが気を失っています(帰りの空気の見積もりが合っていません)').toBeLessThanOrEqual(1);
  });

  test('毎回ちがう: 遊び始めるたびに、遺品の置き場所と海底の古銭の場所が変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    const sig: string[] = [];
    for (const seed of [31, 32, 33, 34]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed });
      const items = (await gt<any[]>(page, 'items')).filter((i) => !i.free);
      const where = items.map((i) => `${i.k}@${i.room ?? '外'}`).sort();
      sig.push(JSON.stringify(items.map((i) => [i.id, Math.round(i.x), Math.round(i.y), Math.round(i.z)])));
      const byRoom: Record<string, number> = {};
      for (const i of items) byRoom[i.room ?? '外'] = (byRoom[i.room ?? '外'] || 0) + 1;
      console.log(`  種${seed}: ${Object.entries(byRoom).map(([k, v]) => `${k}${v}`).join(' ')}`);
      void where;
      await ctx.close();
    }
    expect(new Set(sig).size, '遺品の置き場所が毎回同じです').toBe(sig.length);
  });

  test('選択の重さ: 先にバールを買うか、先にカッターを買うかで、入れる部屋と持ち帰れる遺品がはっきり変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(6 * 60_000);
    const pre = { money: 1200, dives: 3, gear: { tank: 1, fins: 0, bag: 1, light: 0, crowbar: 0, cutter: 0 } };
    const A = await session(browser, { kind: 'think', seed: 41, dives: 3, buy: ['crowbar', 'tank', 'fins'] }, 41, pre);
    const B = await session(browser, { kind: 'think', seed: 41, dives: 3, buy: ['cutter', 'tank', 'fins'] }, 41, pre);
    console.log(`  バールが先: 部屋 ${A.rooms.join('・')} / 遺品 ${A.items.join('・')}(${A.earned}円)`);
    console.log(`  カッターが先: 部屋 ${B.rooms.join('・')} / 遺品 ${B.items.join('・')}(${B.earned}円)`);
    expect(A.rooms.some((r) => r === 'cabin' || r === 'store'), 'バールを買っても、船長室にも倉庫にも入っていません').toBeTruthy();
    expect(A.rooms.some((r) => r === 'strong' || r === 'shaft'), 'バールしか無いのに、金庫室か軸路に入れています').toBeFalsy();
    expect(B.rooms.some((r) => r === 'strong' || r === 'shaft'), 'カッターを買っても、金庫室にも軸路にも入っていません').toBeTruthy();
    expect(B.rooms.some((r) => r === 'cabin' || r === 'store'), 'カッターしか無いのに、船長室か倉庫に入れています').toBeFalsy();
    const onlyA = A.items.filter((i) => !B.items.includes(i)), onlyB = B.items.filter((i) => !A.items.includes(i));
    expect(onlyA.length + onlyB.length, '買う順番を変えても、持ち帰れる遺品がほとんど変わりません').toBeGreaterThanOrEqual(3);
  });

  // ------------------------------------------------------------------------
  //  重さ・動画・見直し
  // ------------------------------------------------------------------------
  test('スマホで重くない(CPU 4倍遅くても、魚の群れと光の筋が見える甲板の上で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(3 * 60_000);
    await open(page, { seed: 51 });
    await startDive(page);
    await page.evaluate(() => { (window as any).__simSpeed = 4; });
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['b_mid'] } as BotCfg);
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    // 船首の方(魚の群れ)を向いて、前へ泳ぎながら測る
    const fore = (await gt<any>(page, 'nav')).nodes.find((n: any) => n.id === 'b_fore');
    await page.evaluate((f) => { const b = (window as any).__bot; b.cfg.look = [f.x, f.y, f.z]; (window as any).__simSpeed = 1; }, fore);
    await page.waitForTimeout(2500);
    await page.evaluate(() => { (window as any).__bot.done = true; });
    const fish = await gt<number>(page, 'fish');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3000);
    const perf = await measureFps(page, 3000);
    await page.keyboard.up('KeyW');
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・見えている魚 ${fish}・画質の段階 ${await gt<number>(page, 'quality')}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(8 * 60_000);
    const SHORT = process.env.SHORT_VIDEO === '1';
    const openFor = async (page: Page, cfg: Cfg) => {
      await page.addInitScript(installInit, cfg);
      await page.goto(url());
      await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    };
    const gotoFast = async (page: Page, to: string[], speed = 6) => {
      await page.evaluate(([to, speed]) => { const w = window as any; w.__simSpeed = speed; const b = w.__bot; if (b && !b.done) { b.cfg.to = to; b.plan = null; b.arrived = false; } }, [to, speed] as const);
      await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 90_000 }).toBeTruthy();
      await page.evaluate(() => { (window as any).__simSpeed = 1; });
    };
    let pick: any = null;
    await recordScenes(browser, target!.dir, [
      // ① つかみ: 真っ暗な機関室で、水中カッターが金庫室の鉄格子を焼き切る(火花と泡)。格子が倒れて、奥に銀の延べ棒が光る
      {
        seconds: 4,
        shortSeconds: 5,
        setup: async (page) => {
          await openFor(page, { seed: 61, sound: true, save: { dives: 5, money: 0, gear: { tank: 2, fins: 2, bag: 1, light: 1, crowbar: 0, cutter: 1 } } });
          await page.locator('#b-start').click();
          await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('dive');
          await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['s_strD'] } as BotCfg);
          await gotoFast(page, ['s_strD'], 8);
          const grate = (await gt<any[]>(page, 'gates')).find((g) => g.id === 'strong');
          await page.evaluate((s) => { const b = (window as any).__bot; b.cfg.look = [s.x, s.y + 0.2, s.z]; }, grate);
          await page.waitForTimeout(1200);
          // 格子全体が見えるよう、少し下がる
          await page.keyboard.down('KeyS'); await page.waitForTimeout(700); await page.keyboard.up('KeyS');
          await page.waitForTimeout(800);
        },
        play: async (page, clip) => {
          const grate = (await gt<any[]>(page, 'gates')).find((g) => g.id === 'strong');
          await page.evaluate((s) => { const b = (window as any).__bot; b.cfg.pick = true; b.path = [{ kind: 'gate', id: 'strong', x: s.x, y: s.y, z: s.z }]; b.plan = []; b.arrived = false; }, grate);
          await expect.poll(async () => (await gt<any[]>(page, 'gates')).find((g) => g.id === 'strong').open, { timeout: 10_000 }).toBeTruthy();
          clip.mark();
          await page.evaluate(() => { (window as any).__bot.done = true; });
          // 火花のさかりを、動画が使えないときの投稿画像にする
          await page.waitForTimeout(900);
          if (!SHORT) await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          // 格子が倒れたら、焼き切った口から金庫室へ
          await page.waitForTimeout(Math.max(0, Math.min(1500, clip.until - Date.now() - 300)));
          await page.keyboard.down('KeyW');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
          await page.keyboard.up('KeyW');
        },
      },
      // ② 基本: 甲板のハッチから暗い船倉へ。ライトに光った遺品を拾う
      {
        seconds: 10,
        shortSeconds: 13,
        setup: async (page) => {
          await openFor(page, { seed: 62, sound: true });
          await page.locator('#b-start').click();
          await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('dive');
          const items = (await gt<any[]>(page, 'items')).filter((i) => (i.room === 'hold1' || i.room === 'hold2') && !i.free);
          pick = items.find((i) => i.room === 'hold1') ?? items[0];
          expect(pick, '動画: 船倉に遺品がありません').toBeTruthy();
          await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: [pick.room === 'hold1' ? 'b_h1' : 'b_h2'] } as BotCfg);
          await gotoFast(page, [pick.room === 'hold1' ? 'b_h1' : 'b_h2']);
          await page.waitForTimeout(800);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.evaluate((it) => { const b = (window as any).__bot; b.cfg.pick = true; b.cfg.to = [it.node]; b.plan = null; b.arrived = false; b.after = it; }, pick);
          await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 20_000 }).toBeTruthy();
          await page.evaluate((it) => { const b = (window as any).__bot; b.path = [{ kind: 'item', id: it.id, x: it.x, y: it.y, z: it.z }]; b.plan = []; b.arrived = false; }, pick);
          await expect.poll(async () => (await gt<any>(page, 'player')).bag.length, { timeout: 15_000 }).toBeGreaterThan(0);
          await page.waitForTimeout(400);
          // 見回す
          await page.evaluate(() => { (window as any).__bot.done = true; });
          await page.keyboard.down('ArrowLeft');
          await page.waitForTimeout(Math.max(0, Math.min(1600, clip.until - Date.now() - 600)));
          await page.keyboard.up('ArrowLeft');
          await page.keyboard.down('Space');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
          await page.keyboard.up('Space');
        },
      },
      // ③ 金庫室の金庫を開けると、金の延べ棒
      {
        seconds: 6,
        shortSeconds: 8,
        setup: async (page) => {
          await openFor(page, { seed: 63, sound: true, save: { dives: 7, money: 0, gear: { tank: 2, fins: 2, bag: 1, light: 1, crowbar: 1, cutter: 1 }, items: { key: { st: 'banked' } }, opened: { strong: true, store: true, cabin: true } } });
          await page.locator('#b-start').click();
          await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('dive');
          // 金庫室の入り口から、奥の金庫を照らす
          await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['s_strD'] } as BotCfg);
          await gotoFast(page, ['s_strD'], 8);
          const safe = (await gt<any[]>(page, 'gates')).find((g) => g.id === 'safe');
          await page.evaluate((s) => { const b = (window as any).__bot; b.cfg.look = [s.x, s.y, s.z]; }, safe);
          await page.waitForTimeout(1500);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.waitForTimeout(500);
          const safe = (await gt<any[]>(page, 'gates')).find((g) => g.id === 'safe');
          await page.evaluate((s) => { const b = (window as any).__bot; b.cfg.pick = true; b.path = [{ kind: 'gate', id: 'safe', x: s.x, y: s.y, z: s.z }]; b.plan = []; b.arrived = false; }, safe);
          await expect.poll(async () => (await gt<any[]>(page, 'gates')).find((g) => g.id === 'safe').open, { timeout: 10_000 }).toBeTruthy();
          await page.waitForTimeout(1500);
          const gold = (await gt<any[]>(page, 'items')).find((i) => i.id === 'gold');
          await page.evaluate((it) => { const b = (window as any).__bot; b.path = [{ kind: 'item', id: it.id, x: it.x, y: it.y, z: it.z }]; b.plan = []; b.arrived = false; }, gold);
          await expect.poll(async () => (await gt<any>(page, 'player')).bag, { timeout: 10_000 }).toContain('gold');
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
    ]);
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(4 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    const errors = await open(page, { seed: 121, save: { gear: { tank: 2, fins: 2, bag: 1, light: 1, crowbar: 1, cutter: 1 } } });
    // 画質を固定して撮る(テスト用のブラウザは3Dを CPU で描くので、自動で画質が最低まで下がるため)
    await page.evaluate(() => { (window as any).__lockQ = 1; });
    await page.waitForTimeout(2500);
    await shot('1-title');
    await startDive(page);
    await page.waitForTimeout(800);
    await shot('2-start');
    const spots: [string, string[], number[] | undefined][] = [
      ['3-deck', ['b_h1'], undefined], ['4-hold1', ['b_hold1'], undefined], ['5-mess', ['b_castleF', 'b_mess'], undefined], ['6-bridge', ['b_bridge'], undefined],
      ['7-break', ['b_brk'], undefined], ['8-engine', ['s_eng', 's_engB'], undefined], ['9-strong', ['s_strD', 's_strong'], undefined], ['a-prop', ['s_sternO'], undefined],
    ];
    await page.evaluate(botInstall, { kind: 'goto', seed: 1, dives: 99, to: ['b_h1'] } as BotCfg);
    for (const [name, to, look] of spots) {
      await page.evaluate(([to, look]) => { const b = (window as any).__bot; b.cfg.to = to; b.cfg.look = look; b.plan = null; b.arrived = false; }, [to, look] as const);
      await page.evaluate(() => { (window as any).__simSpeed = 6; });
      await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
      await page.evaluate(() => { (window as any).__simSpeed = 1; });
      await page.waitForTimeout(900);
      await shot(name);
      const p = await gt<any>(page, 'player');
      console.log(`  ${name}: 水深${p.depth.toFixed(1)}m 空気${p.air.toFixed(0)} 部屋${p.room} fps段階${await gt<number>(page, 'quality')}`);
    }
    expect(errors).toEqual([]);
    // 船の上(潜水の合間)の画面
    await page.evaluate(() => { const b = (window as any).__bot; b.cfg.to = ['line']; b.plan = null; b.arrived = false; (window as any).__simSpeed = 6; });
    await expect.poll(() => page.evaluate(() => !!(window as any).__bot.arrived), { timeout: 60_000 }).toBeTruthy();
    await page.evaluate(() => { const w = window as any; w.__bot.done = true; w.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })); w.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' })); });
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 20_000 }).toBe('boat');
    await page.waitForTimeout(500);
    await shot('b-boat');
    if (info.project.name === 'mobile') {
      for (const [w, hh, name] of [[844, 390, 'c-landscape'], [360, 640, 'd-small']] as const) {
        await page.setViewportSize({ width: w, height: hh });
        await page.goto(url());
        await page.evaluate(() => { (window as any).__lockQ = 2; });
        await page.waitForTimeout(1500);
        await shot(`${name}-title`);
        await startDive(page);
        await page.waitForTimeout(1500);
        await shot(`${name}-dive`);
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
      await page.screenshot({ path: path.join(dir, `video-${f}.png`), fullPage: true });
    }
  });
});
