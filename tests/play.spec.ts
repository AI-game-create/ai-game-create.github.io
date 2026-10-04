import { test, expect, Page, Browser } from '@playwright/test';
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
//  対象: 荒海の救命艇(2026-10-08)
//  嵐の海で漂流者に近づき、速度を落とすと引き上げられる。灯台の船着き場まで連れて帰ると救助。
//  水平線から押し寄せる大波は、舳先を向けて勢いよく越えれば無事、横腹や後ろで受けると浸水する。
//  浸水が満杯になると、乗せていた人ごと沈む(エンドレス)。
//
//  ・人の操作のテストは、本物のキー / マウス / 指で行う
//  ・長い勝負を何回も遊ばせるテストは、ページの中に自動プレイヤーを仕込み、ゲームの時間を速回しにする
//    (window.__simSpeed。同じ1/60秒の刻みを1コマで何回も進めるだけ)。
//    自動プレイヤーは1/60秒ごとに gameTest(読み取り専用)を読んで、キーを押したり離したりする
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-08-storm-lifeboat';
const target = latestGame();
const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const isMobile = (page: Page) => page.evaluate(() => 'ontouchstart' in window);

type Boat = { x: number; z: number; h: number; v: number; lever: number; rud: number; water: number; holes: number; aboard: number; y: number; pitch: number; roll: number; haul: number; air: number };
type Surv = { id: number; cid: number; x: number; z: number; cold: number; cold0: number; flare: boolean };
type Roll = { id: number; dx: number; dz: number; pos: number; H: number; c: number; s: number; eta: number };
type Stats = { t: number; saved: number; lost: number; lostAboard: number; picked: number; bowWaves: number; hits: Record<string, number>; holes: number; cause: string; day: number; sea: number; best: { saved: number; t: number }; plays: number };
type Ev = { type: string; t: number; [k: string]: any };

// ---------------------------------------------------------------------------
//  ページの中で動く自動プレイヤー
// ---------------------------------------------------------------------------
//  smart: 漂流者を選んで近づき、減速して引き上げ、home 人乗せたら(または浸水が waterLimit をこえたら)帰る。大波には舳先を向けて加速する
//  dumb : 1.5秒ごとに でたらめな舵とスロットル
//  pilot: window.__pilot = { x, z, lever } の場所へ向かう(face: 'bow' / 'beam' なら、いちばん近い大波に 舳先 / 横腹 を向ける)
type Bot = { kind: 'smart' | 'dumb' | 'pilot' | 'none'; seed: number; speed: number; home?: number; waterLimit?: number; sound?: boolean; plays?: number };

function installBot(cfg: Bot) {
  let s = cfg.seed >>> 0;
  Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // 保存データは はじめの1回だけ書く(再読み込みのたびに書くと、ゲームが残した記録を消してしまう)
  try { if (!localStorage.getItem('storm-lifeboat-v1')) localStorage.setItem('storm-lifeboat-v1', JSON.stringify({ sound: !!cfg.sound, plays: cfg.plays ?? 9 })); } catch { /* なし */ }
  const w = window as any;
  w.__simSpeed = cfg.speed;
  if (cfg.kind === 'none') return;
  let bs = (cfg.seed * 7919 + 13) >>> 0;
  const br = () => ((bs = (bs * 1664525 + 1013904223) >>> 0) / 4294967296);
  const down = new Set<string>();
  const key = (code: string, on: boolean) => {
    if (on === down.has(code)) return;
    if (on) down.add(code); else down.delete(code);
    w.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code }));
  };
  const TAU = Math.PI * 2;
  const ad = (a: number, b: number) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
  const steerTo = (b: any, want: number) => { const d = ad(b.h, want); key('ArrowRight', d > 0.05); key('ArrowLeft', d < -0.05); };
  const leverTo = (b: any, L: number) => { key('ArrowUp', b.lever < L - 0.03); key('ArrowDown', b.lever > L + 0.03); };
  let n = 0, dRud = 0, dLever = 0.5;
  w.__autoStep = () => {
    const g = w.gameTest;
    if (g.state() !== 'play') return;
    n++;
    const b = g.boat();
    if (cfg.kind === 'dumb') {
      if (n % 90 === 1) { dRud = Math.floor(br() * 3) - 1; dLever = br() * 1.2 - 0.1; }
      key('ArrowRight', dRud > 0); key('ArrowLeft', dRud < 0); leverTo(b, dLever);
      return;
    }
    if (cfg.kind === 'pilot') {
      const p = w.__pilot;
      if (!p) return;
      let want = p.h ?? Math.atan2(p.z - b.z, p.x - b.x);
      if (p.face) {
        const r = g.rollers().sort((a: any, c: any) => a.eta - c.eta)[0];
        if (r) want = p.face === 'bow' ? Math.atan2(-r.dz, -r.dx) : Math.atan2(r.dx, -r.dz);
      }
      steerTo(b, want); leverTo(b, p.lever);
      return;
    }
    if (n % 2) return;
    // ---- 考える自動プレイヤー ----
    const H = g.harbor(), surv = g.survivors(), rs = g.rollers();
    const home = cfg.home ?? 4, wl = cfg.waterLimit ?? 55;
    const goHome = b.aboard >= home || (b.aboard > 0 && (b.water > wl || b.holes >= 2 || surv.length === 0)) || (b.aboard === 0 && b.water > 75);
    let gx = 0, gz = 0, arrive = false, harbor = false;
    const inCone = b.x > 3 && b.z < -22 && b.z > -54;
    if (goHome) {
      if (inCone) { gx = H.x; gz = H.z; arrive = true; harbor = true; } else { gx = 16; gz = -50; }
    } else {
      let best: any = null, bc = 1e9;
      for (const sv of surv) {
        const d = Math.hypot(sv.x - b.x, sv.z - b.z), eta = d / 9 + 3;
        if (sv.cold < eta) continue;
        const c = d + Math.max(0, 40 - (sv.cold - eta)) * 2;
        if (c < bc) { bc = c; best = sv; }
      }
      if (best) { gx = best.x; gz = best.z; arrive = true; } else { gx = 30; gz = -60; }
    }
    // 船着き場から出るときは、桟橋にぶつからないよう いったん南へ出る
    if (!goHome && b.x > -3 && b.z > -50 && b.z < -14 && b.x < 30) { gx = 14; gz = -60; arrive = false; }
    const dist = Math.hypot(gx - b.x, gz - b.z);
    let want = Math.atan2(gz - b.z, gx - b.x);
    // 島をよける(進む線が島に近いときは、島のまわりを回る)
    {
      const ex = gx - b.x, ez = gz - b.z, L2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, -(b.x * ex + b.z * ez) / L2));
      const px = b.x + ex * t, pz = b.z + ez * t, rb = Math.hypot(b.x, b.z);
      if (Math.hypot(px, pz) < 44 && rb > 36 && !harbor) {
        const ba = Math.atan2(b.z, b.x), ga = Math.atan2(gz, gx), sg = ad(ba, ga) > 0 ? 1 : -1;
        const wa = ba + sg * 0.75, wx = Math.cos(wa) * 54, wz = Math.sin(wa) * 54;
        want = Math.atan2(wz - b.z, wx - b.x);
      }
    }
    // 岩と漂流物をよける
    for (const o of [...g.rocks(), ...g.debris()]) {
      const dx = o.x - b.x, dz = o.z - b.z, d = Math.hypot(dx, dz);
      if (d > 32 || d < 1) continue;
      const f = Math.cos(want) * dx + Math.sin(want) * dz, lat = -Math.sin(want) * dx + Math.cos(want) * dz;
      if (f > 0 && Math.abs(lat) < o.r + 5) want += (lat > 0 ? -1 : 1) * 0.7 * (1 - d / 40);
    }
    let lever = 1;
    if (arrive) lever = harbor ? (dist < 14 ? 0.12 : 0.5) : dist < 9 ? 0.12 : dist < 26 ? 0.3 : 1;
    // 大波: 来る前に舳先を向けて加速する(島の近くは波が小さいので気にしない)
    const nr = rs.filter((r: any) => r.H > 1.6 && r.eta > -0.3).sort((a: any, c: any) => a.eta - c.eta)[0];
    if (nr && nr.eta < 8 && Math.hypot(b.x, b.z) > 42) { want = Math.atan2(-nr.dz, -nr.dx); lever = 1; }
    steerTo(b, want); leverTo(b, lever);
  };
}

type Result = { t: number; saved: number; lost: number; lostAboard: number; picked: number; bowWaves: number; hits: Record<string, number>; holes: number; cause: string; ev: Ev[]; rollerLog: number[][]; clusterLog: number[][]; rocks: string; overText: string };
async function play(browser: Browser, cfg: Bot, cap = 600): Promise<Result> {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 300 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(installBot, cfg);
  await page.goto(url());
  await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
  await page.locator('#b-start').click();
  await expect.poll(async () => {
    const st = await gt<string>(page, 'state');
    return st === 'over' || st === 'sink' || (await gt<Stats>(page, 'stats')).t >= cap;
  }, { timeout: 8 * 60_000, intervals: [400] }).toBeTruthy();
  let overText = '';
  if ((await gt<string>(page, 'state')) !== 'play') {
    await expect(page.locator('#over')).toBeVisible({ timeout: 8000 });
    overText = (await page.locator('#log').innerText()).replace(/\s+/g, ' ');
  }
  const s = await gt<Stats>(page, 'stats');
  const r: Result = {
    t: s.t, saved: s.saved, lost: s.lost, lostAboard: s.lostAboard, picked: s.picked, bowWaves: s.bowWaves, hits: s.hits, holes: s.holes, cause: s.cause,
    ev: await gt<Ev[]>(page, 'events'), rollerLog: await gt<number[][]>(page, 'rollerLog'), clusterLog: await gt<number[][]>(page, 'clusterLog'),
    rocks: JSON.stringify((await gt<{ x: number; z: number }[]>(page, 'rocks')).map((o) => [Math.round(o.x), Math.round(o.z)])), overText,
  };
  expect(errors, `遊んでいる間に エラーが出ました: ${errors.join(' / ')}`).toEqual([]);
  await ctx.close();
  return r;
}
const line = (name: string, r: Result) =>
  `  ${name}: ${r.cause ? `${r.t.toFixed(0)}秒で沈没(${r.cause})` : `${r.t.toFixed(0)}秒もちこたえた`}・救助${r.saved}・引き上げ${r.picked}・消えた${r.lost}・沈んだ${r.lostAboard}・舳先で越えた${r.bowWaves}・大波 ${Object.entries(r.hits).map(([k, v]) => `${k}${v}`).join(' ')}・穴${r.holes}`;

// ---------------------------------------------------------------------------
//  人の操作のテスト用
// ---------------------------------------------------------------------------
async function open(page: Page, opt: { seed?: number; plays?: number; sound?: boolean; speed?: number; kind?: Bot['kind'] } = {}) {
  await page.addInitScript(installBot, { kind: opt.kind ?? 'none', seed: opt.seed ?? 5, speed: opt.speed ?? 1, plays: opt.plays ?? 0, sound: opt.sound ?? false } as Bot);
  await page.goto(url());
  await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
}
async function start(page: Page) {
  if (await isMobile(page)) await page.locator('#b-start').tap(); else await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
}
const evs = (page: Page) => gt<Ev[]>(page, 'events');
const pilot = (page: Page, p: Record<string, unknown> | null) => page.evaluate((q) => { (window as any).__pilot = q; }, p);

test.describe('プレイテスト', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  test('このファイルが今日のゲーム用に書かれている', () => {
    expect(target!.name, 'tests/play.spec.ts が前のゲーム用のままです。今日のゲームに合わせて書き直してください').toBe(EXPECTED);
  });

  test('テスト用の窓口 window.gameTest があり、3D(WebGL2・HDR)で描いている', async ({ page }) => {
    await page.goto(url());
    const ok = await page.evaluate(() => {
      const g = (window as any).gameTest;
      return !!g && ['state', 'score', 'webgl', 'hdr', 'boat', 'survivors', 'rollers', 'debris', 'rocks', 'harbor', 'seaH', 'stats', 'events', 'rollerLog', 'clusterLog', 'toScreen', 'cam', 'particles', 'quality', 'sound', 'flash'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
    expect(await gt<boolean>(page, 'webgl'), 'WebGL2 が使えていません').toBeTruthy();
    console.log(`  HDR(浮動小数の描画先): ${await gt<boolean>(page, 'hdr')}`);
    await page.waitForTimeout(1500);
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '3Dの画面に何も描かれていないようです').toBeGreaterThan(40_000);
  });

  // 核の遊び(1): 速いまま そばを通っても引き上げられない。減速して近づくと引き上げる
  test('引き上げ: 10ノットで真上を通りすぎても引き上げられず、6ノット以下に減速して近づくと引き上げて乗員が増える', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, { kind: 'pilot', plays: 9, speed: 3 });
    await start(page);
    // 0) まず沖へ出て、全速になる
    await pilot(page, { x: 30, z: -110, lever: 1 });
    await expect.poll(async () => { const b = await gt<Boat>(page, 'boat'); return b.v > 9 && Math.hypot(b.x, b.z) > 75; }, { timeout: 60_000 }).toBeTruthy();
    // 1) 10ノットほど(引き上げには速すぎる)で、いちばん前にいる漂流者の真上を通りすぎる
    await pilot(page, { x: 30, z: -110, lever: 0.45 });
    await expect.poll(async () => (await gt<Boat>(page, 'boat')).v, { timeout: 30_000 }).toBeLessThan(5.6);
    const b0 = await gt<Boat>(page, 'boat');
    const s0 = (await gt<Surv[]>(page, 'survivors')).sort((a, c) => Math.abs(Math.atan2(a.z - b0.z, a.x - b0.x) - b0.h) - Math.abs(Math.atan2(c.z - b0.z, c.x - b0.x) - b0.h))[0];
    let closest = 99, vAt = 0;
    await expect.poll(async () => {
      const b = await gt<Boat>(page, 'boat'), sv = (await gt<Surv[]>(page, 'survivors')).find((q) => q.id === s0.id);
      if (!sv) return true;
      // 真上を通るよう、漂流者の少し先をねらう
      await pilot(page, { x: sv.x + Math.cos(b.h) * 2, z: sv.z + Math.sin(b.h) * 2, lever: 0.45 });
      const d = Math.hypot(sv.x - b.x, sv.z - b.z);
      if (d < closest) { closest = d; vAt = b.v; }
      return closest < 4 && d > closest + 8;
    }, { timeout: 60_000, intervals: [20] }).toBeTruthy();
    console.log(`  速すぎる: いちばん近づいたのは ${closest.toFixed(1)}m(${(vAt * 1.944).toFixed(0)}ノット)・引き上げ ${(await gt<Stats>(page, 'stats')).picked}人`);
    expect(vAt, '10ノットほどになっていません').toBeGreaterThan(4);
    expect((await gt<Stats>(page, 'stats')).picked, '6ノットより速いまま通りすぎただけで引き上げてしまいました').toBe(0);
    // 2) 減速して近づく
    const sv = (await gt<Surv[]>(page, 'survivors')).find((q) => q.id === s0.id) ?? (await gt<Surv[]>(page, 'survivors'))[0];
    await pilot(page, { x: sv.x, z: sv.z, lever: 0.6 });
    await expect.poll(async () => { const b = await gt<Boat>(page, 'boat'); const q = (await gt<Surv[]>(page, 'survivors')).find((x) => x.id === sv.id); if (q) await pilot(page, { x: q.x, z: q.z, lever: Math.hypot(q.x - b.x, q.z - b.z) < 22 ? 0.15 : 0.6 }); return (await gt<Stats>(page, 'stats')).picked; }, { timeout: 60_000, intervals: [100] }).toBeGreaterThanOrEqual(1);
    const pk = (await evs(page)).find((e) => e.type === 'pick')!;
    console.log(`  減速: ${pk.t}秒に引き上げた・乗員 ${(await gt<Boat>(page, 'boat')).aboard}`);
    expect((await gt<Boat>(page, 'boat')).aboard).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#seats s.on').first(), '乗員の表示が増えません').toBeAttached();
  });

  // 核の遊び(2): 同じ大波を、舳先で受けるか横腹で受けるかで、入る水がはっきり違う
  test('大波の受け方: 舳先を向けて勢いよく越えると浸水は少なく、横腹で受けると何倍も水が入る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(180_000);
    const run = async (face: 'bow' | 'beam') => {
      const ctx = await browser.newContext({ viewport: { width: 480, height: 300 } });
      const page = await ctx.newPage();
      await page.addInitScript(installBot, { kind: 'pilot', seed: 11, speed: 8, plays: 9 } as Bot);
      await page.goto(url());
      await start(page);
      // 沖へ出てから(島の近くは波が小さい)、大波に向き合う
      await pilot(page, { h: Math.PI * -0.5, lever: 1 });
      await expect.poll(async () => { const b = await gt<Boat>(page, 'boat'); return Math.hypot(b.x, b.z); }, { timeout: 60_000 }).toBeGreaterThan(95);
      await pilot(page, { face, lever: face === 'bow' ? 1 : 0.5 });
      await expect.poll(async () => (await evs(page)).filter((e) => e.type === 'roller').length, { timeout: 90_000, intervals: [100] }).toBeGreaterThanOrEqual(2);
      const r = (await evs(page)).filter((e) => e.type === 'roller');
      await ctx.close();
      return r;
    };
    const bow = await run('bow'), beam = await run('beam');
    const sum = (a: Ev[]) => a.reduce((s, e) => s + e.add, 0);
    console.log(`  舳先: ${bow.map((e) => `${e.kind} 高さ${e.H}m → +${e.add}%`).join(' / ')}`);
    console.log(`  横腹: ${beam.map((e) => `${e.kind} 高さ${e.H}m → +${e.add}%`).join(' / ')}`);
    expect(bow.every((e) => e.kind === 'bow'), '舳先を向けて加速しても、舳先で越えた扱いになりません').toBeTruthy();
    expect(beam.every((e) => e.kind === 'beam'), '横を向いて受けても、横腹で受けた扱いになりません').toBeTruthy();
    expect(sum(beam) / sum(bow), '舳先と横腹で、入る水があまり変わりません').toBeGreaterThanOrEqual(4);
  });

  test('救助と終わり: 船着き場で降ろすと救助が増える。浸水が満杯で沈み、航海日誌が出て、もう一度遊べる。記録は残る', async ({ page }) => {
    test.setTimeout(240_000);
    // 1人乗せたら帰る自動プレイヤーで、救助まで
    await page.addInitScript(installBot, { kind: 'smart', seed: 7, speed: 8, plays: 9, home: 1 } as Bot);
    await page.goto(url());
    await start(page);
    await expect.poll(() => gt<number>(page, 'score'), { timeout: 120_000, intervals: [200], message: '船着き場に連れて帰っても救助が増えません' }).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#saved')).toHaveText(/^[1-9]/);
    const dv = (await evs(page)).find((e) => e.type === 'deliver')!;
    const b = await gt<Boat>(page, 'boat'), H = await gt<{ x: number; z: number; r: number }>(page, 'harbor');
    console.log(`  ${dv.t}秒に1人目を救助(船着き場から ${Math.hypot(b.x - H.x, b.z - H.z).toFixed(1)}m)`);
    // 横腹で大波を受け続けて沈む
    await page.evaluate(() => { const w = window as any; w.__autoStep = null; });
    await page.evaluate(() => {
      const w = window as any, g = w.gameTest, down = new Set<string>();
      const key = (c: string, on: boolean) => { if (on === down.has(c)) return; on ? down.add(c) : down.delete(c); w.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code: c })); };
      w.__autoStep = () => {
        const bt = g.boat(), r = g.rollers().sort((a: any, c: any) => a.eta - c.eta)[0];
        let want = -Math.PI / 2;
        if (Math.hypot(bt.x, bt.z) > 100 && r) want = Math.atan2(r.dx, -r.dz);
        let d = (want - bt.h) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
        key('ArrowRight', d > 0.05); key('ArrowLeft', d < -0.05); key('ArrowUp', bt.lever < 0.6); key('ArrowDown', bt.lever > 0.66);
      };
    });
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 150_000, intervals: [300] }).toMatch(/sink|over/);
    await page.evaluate(() => { const w = window as any; w.__autoStep = null; w.__simSpeed = 1; });
    await expect(page.locator('#over')).toBeVisible({ timeout: 8000 });
    const s = await gt<Stats>(page, 'stats');
    await expect(page.locator('#o-saved')).toHaveText(`${s.saved} 人`);
    await expect(page.locator('#o-time')).toHaveText(`${Math.floor(s.t / 60)}:${String(Math.floor(s.t % 60)).padStart(2, '0')}`);
    console.log(`  ${s.t.toFixed(0)}秒で沈没: ${(await page.locator('#log').innerText()).replace(/\s+/g, ' ')}`);
    expect(s.cause, '沈んだ理由が出ません').not.toBe('');
    expect((await evs(page)).some((e) => e.type === 'roller' && e.kind === 'beam'), '横腹で受けていません').toBeTruthy();
    await page.waitForTimeout(1000);
    if (await isMobile(page)) await page.locator('#b-again').tap(); else await page.locator('#b-again').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    const s2 = await gt<Stats>(page, 'stats'), b2 = await gt<Boat>(page, 'boat');
    expect(s2.t).toBeLessThan(2); expect(s2.saved).toBe(0); expect(b2.water).toBe(0); expect(b2.aboard).toBe(0);
    expect(s2.best.saved, '記録が残っていません').toBeGreaterThanOrEqual(1);
    await page.reload();
    await expect(page.locator('#best'), '再読み込みすると記録が消えます').toContainText(`${s.saved}人`);
  });

  // ------------------------------------------------------------------------
  //  面白さの代わりになる数字
  // ------------------------------------------------------------------------
  test('腕の差: 考えて遊ぶ自動プレイヤーは、でたらめな自動プレイヤーの1.5倍以上 救助し、長くもちこたえる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(10 * 60_000);
    const smart: Result[] = [], dumb: Result[] = [];
    for (const seed of [21, 22, 23]) {
      const a = await play(browser, { kind: 'smart', seed, speed: 24 });
      const b = await play(browser, { kind: 'dumb', seed, speed: 24 });
      console.log(line(`考える 種${seed}`, a));
      console.log(line(`でたらめ 種${seed}`, b));
      smart.push(a); dumb.push(b);
    }
    const avg = (rs: Result[], f: (r: Result) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
    const sr = (avg(smart, (r) => r.saved) + 0.01) / (avg(dumb, (r) => r.saved) + 0.33), tr = avg(smart, (r) => r.t) / avg(dumb, (r) => r.t);
    console.log(`  1回の長さ: 考える ${avg(smart, (r) => r.t).toFixed(0)}秒 / でたらめ ${avg(dumb, (r) => r.t).toFixed(0)}秒`);
    console.log(`  腕の差: 救助 ${avg(smart, (r) => r.saved).toFixed(1)} / ${avg(dumb, (r) => r.saved).toFixed(1)}人(${sr.toFixed(1)}倍)・もちこたえた時間 ${tr.toFixed(1)}倍`);
    expect(sr, '救助した人数に腕の差が出ません').toBeGreaterThanOrEqual(1.5);
    expect(tr, 'もちこたえた時間に腕の差が出ません').toBeGreaterThanOrEqual(1.5);
    expect(smart.every((r) => r.saved >= 3), '上手に遊んでも ほとんど救助できません').toBeTruthy();
    expect(smart.some((r) => r.cause !== ''), '上手な自動プレイヤーが 一度も沈まないのは やさしすぎます').toBeTruthy();
  });

  test('毎回ちがう: 種を変えると、漂流者の場所・大波の時刻と向き・岩の配置がちがう', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(5 * 60_000);
    const rs: Result[] = [];
    for (const seed of [31, 32, 33]) {
      const r = await play(browser, { kind: 'smart', seed, speed: 24 }, 150);
      rs.push(r);
      console.log(`  種${seed}: 群れ ${r.clusterLog.slice(0, 3).map((c) => `(${c[0]},${c[1]})×${c[2]}`).join(' ')}・大波 ${r.rollerLog.slice(0, 4).map((x) => `${x[0]}秒/${x[2]}m`).join(' ')}・岩 ${r.rocks}`);
    }
    expect(new Set(rs.map((r) => JSON.stringify(r.clusterLog.slice(0, 3)))).size, '漂流者の場所が毎回同じです').toBe(3);
    expect(new Set(rs.map((r) => JSON.stringify(r.rollerLog.slice(0, 4)))).size, '大波が毎回同じです').toBe(3);
    expect(new Set(rs.map((r) => r.rocks)).size, '岩の配置が毎回同じです').toBe(3);
  });

  test('選択の重さ: 早めに帰る(3人)か、満員まで欲張る(8人)かで、沈んだときに失う人数と救助の数がはっきり変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(10 * 60_000);
    const care: Result[] = [], greed: Result[] = [];
    for (const seed of [3, 4, 5]) {
      const a = await play(browser, { kind: 'smart', seed, speed: 24, home: 3, waterLimit: 50 });
      const b = await play(browser, { kind: 'smart', seed, speed: 24, home: 8, waterLimit: 92 });
      console.log(line(`慎重 種${seed}`, a));
      console.log(line(`欲張り 種${seed}`, b));
      care.push(a); greed.push(b);
    }
    const sum = (rs: Result[], f: (r: Result) => number) => rs.reduce((s, r) => s + f(r), 0);
    const perTrip = (rs: Result[]) => sum(rs, (r) => r.picked) / Math.max(1, sum(rs, (r) => r.ev.filter((e, i, a) => e.type === 'deliver' && a[i - 1]?.type !== 'deliver').length));
    console.log(`  沈んだときに失った人: 慎重 ${sum(care, (r) => r.lostAboard)} / 欲張り ${sum(greed, (r) => r.lostAboard)}・救助 ${sum(care, (r) => r.saved)} / ${sum(greed, (r) => r.saved)}・1回の帰港で降ろした人数 ${perTrip(care).toFixed(1)} / ${perTrip(greed).toFixed(1)}・もちこたえた ${sum(care, (r) => r.t).toFixed(0)} / ${sum(greed, (r) => r.t).toFixed(0)}秒`);
    expect(sum(greed, (r) => r.lostAboard), '欲張っても、沈んだときに失う人数が変わりません').toBeGreaterThanOrEqual(sum(care, (r) => r.lostAboard) * 1.5 + 3);
    const sr = sum(care, (r) => r.saved) / Math.max(1, sum(greed, (r) => r.saved));
    expect(sr >= 1.3 || sr <= 1 / 1.3, '帰り方を変えても、救助の数がほとんど変わりません').toBeTruthy();
  });

  // ------------------------------------------------------------------------
  //  スマホ・重さ・動画・見直し
  // ------------------------------------------------------------------------
  test('スマホ: 画面に収まり、ボタンとレバーは指で扱える大きさで、表示どうしが重ならない。指で舵とスロットルが動く', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    await open(page, { plays: 0 });
    const v = page.viewportSize()!;
    const inside = (b: { x: number; y: number; width: number; height: number } | null) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5;
    const apart = (a: any, b: any) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    expect(inside(await page.locator('#b-start').boundingBox()), 'タイトルの「出航する」が画面の外です').toBeTruthy();
    await start(page);
    await page.waitForTimeout(600);
    const ids = ['#b-pause', '#b-snd', '#lever', '#inst', '#top-l'];
    const bx: Record<string, any> = {};
    for (const id of ids) { bx[id] = await page.locator(id).boundingBox(); expect(inside(bx[id]), `${id} がはみ出しています`).toBeTruthy(); }
    for (const id of ['#b-pause', '#b-snd']) expect(Math.min(bx[id].width, bx[id].height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    expect(bx['#lever'].width, 'レバーが細すぎます').toBeGreaterThanOrEqual(44);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(apart(bx[ids[i]], bx[ids[j]]), `${ids[i]} と ${ids[j]} が重なっています`).toBeTruthy();
    const hint = await page.locator('#hint').boundingBox();
    expect(apart(hint, bx['#lever']) && apart(hint, bx['#inst']), '説明の文字が計器やレバーに重なっています').toBeTruthy();
    // 艇は 上の表示にも 下の計器にも かくれない
    const b = await gt<Boat>(page, 'boat');
    const s = (await gt<{ x: number; y: number }>(page, 'toScreen', b.x, b.y + 1, b.z))!;
    expect(s.y).toBeGreaterThan(bx['#top-l'].y + bx['#top-l'].height);
    expect(s.y).toBeLessThan(bx['#inst'].y);
    // 指でレバーを上げ、画面をなぞって舵を切る
    const lv = bx['#lever'];
    await page.touchscreen.tap(lv.x + lv.width / 2, lv.y + 6);
    await expect.poll(async () => (await gt<Boat>(page, 'boat')).lever, { message: 'レバーを指で上げられません' }).toBeGreaterThan(0.85);
    const cdp = await page.context().newCDPSession(page);
    const tp = (type: string, x?: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: v.height * 0.45, id: 2 }] } as any);
    const h0 = (await gt<Boat>(page, 'boat')).h;
    await tp('touchStart', v.width * 0.3);
    for (let i = 1; i <= 6; i++) { await tp('touchMove', v.width * 0.3 + i * 15); await page.waitForTimeout(16); }
    await page.waitForTimeout(1200);
    await tp('touchEnd');
    await cdp.detach();
    const h1 = (await gt<Boat>(page, 'boat')).h;
    console.log(`  指で右へなぞった: 向き ${h0.toFixed(2)} → ${h1.toFixed(2)}・速さ ${((await gt<Boat>(page, 'boat')).v * 1.944).toFixed(0)}ノット`);
    expect(h1 - h0, '指でなぞっても右へ曲がりません').toBeGreaterThan(0.3);
  });

  test('スマホで重くない(CPU 4倍遅くても、大波と雨としぶきの中で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(4 * 60_000);
    await page.addInitScript(installBot, { kind: 'smart', seed: 41, speed: 10, plays: 9 } as Bot);
    await page.goto(url());
    await start(page);
    // 早回しで進め、大波が近づいてきた瞬間に ふつうの速さへ戻す(ページの中で見張るので、取りこぼさない)
    await page.evaluate(() => {
      const w = window as any;
      const id = setInterval(() => { const g = w.gameTest; if (g.stats().t > 75 && g.rollers().some((r: any) => r.eta < 6 && r.eta > 2)) { w.__simSpeed = 1; clearInterval(id); } }, 20);
    });
    await expect.poll(() => page.evaluate(() => (window as any).__simSpeed), { timeout: 3 * 60_000, intervals: [300] }).toBe(1);
    expect(await gt<string>(page, 'state'), '測る前に終わってしまいました').toBe('play');
    const pn = await gt<number>(page, 'particles');
    // 測っているあいだは gameTest を読まない(自動プレイヤーも止める。艇はそのまま進む)
    await page.evaluate(() => { (window as any).__autoStep = null; });
    const perf = await measureFps(page, 3000);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・粒 ${pn}・画質の段階 ${await gt<number>(page, 'quality')}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(5 * 60_000);
    await recordPlayVideo(browser, {
      dir: target!.dir,
      focus: '#gl',
      maxSeconds: 60,
      setup: async (page) => {
        await page.addInitScript(installBot, { kind: 'smart', seed: 51, speed: 10, plays: 9, sound: true } as Bot);
        await page.goto(url());
        await start(page);
        // 大波が育つ 1分すぎまで 早回し(夕日はまだ残っている)
        await expect.poll(async () => (await gt<Stats>(page, 'stats')).t, { timeout: 60_000, intervals: [300] }).toBeGreaterThan(62);
        await page.evaluate(() => { (window as any).__simSpeed = 1; });
      },
      play: async (page, clip: Clip) => {
        let marked = false, shot = false, markAt = 0;
        while (Date.now() < clip.until) {
          // 見せ場: 大きな波が目の前にそびえ、舳先から突っ込む瞬間
          if (!marked) {
            const [b, rs] = await Promise.all([gt<Boat>(page, 'boat'), gt<Roll[]>(page, 'rollers')]);
            const r = rs.find((x) => x.eta < 1.6 && x.eta > 0.4 && x.H > 3);
            if (r && Math.cos(b.h) * -r.dx + Math.sin(b.h) * -r.dz > 0.8) { marked = true; markAt = Date.now(); clip.mark(); }
          }
          // 投稿画像はふつうの動画のときだけ撮る(ショート用モードの縦長で上書きしない)
          if (marked && !shot && Date.now() - markAt > 1700) { shot = true; if (process.env.SHORT_VIDEO !== '1') await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') }); }
          await page.waitForTimeout(40);
        }
        const s = await gt<Stats>(page, 'stats');
        console.log(`  動画: mark ${marked}・${s.t.toFixed(0)}秒・救助${s.saved}・舳先で越えた${s.bowWaves}`);
        expect(marked, '動画の見せ場(大波を越える瞬間)が来ませんでした').toBeTruthy();
      },
    });
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(5 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    const lockQ = (q: number) => page.evaluate((x) => { (window as any).__lockQ = x; }, q);
    await page.addInitScript(installBot, { kind: 'none', seed: 61, speed: 1, plays: 0 } as Bot);
    await page.goto(url());
    await lockQ(1);
    await page.waitForTimeout(2500);
    await shot('1-title');
    await start(page);
    await page.waitForTimeout(2500);
    await shot('2-start');
    // 自動プレイヤーに遊ばせて、大波・夜・稲妻の場面
    await page.addInitScript(installBot, { kind: 'smart', seed: 62, speed: 12, plays: 9 } as Bot);
    await page.goto(url());
    await start(page);
    await expect.poll(async () => { const g = await gt<Stats>(page, 'stats'); const rs = await gt<Roll[]>(page, 'rollers'); return g.t > 80 && rs.some((r) => r.eta < 2.5 && r.eta > 1); }, { timeout: 120_000, intervals: [50] }).toBeTruthy();
    await page.evaluate(() => { (window as any).__simSpeed = 0.0001; });
    await lockQ(1);
    await page.waitForTimeout(1500);
    await shot('3-roller');
    await page.evaluate(() => { (window as any).__simSpeed = 12; });
    await page.evaluate(() => { delete (window as any).__lockQ; });
    await expect.poll(async () => (await gt<Stats>(page, 'stats')).t, { timeout: 120_000, intervals: [300] }).toBeGreaterThan(230);
    await expect.poll(() => gt<number>(page, 'flash'), { timeout: 120_000, intervals: [16] }).toBeGreaterThan(0.5);
    await page.evaluate(() => { (window as any).__simSpeed = 0.0001; });
    await lockQ(1);
    await page.waitForTimeout(1200);
    await shot('4-night-flash');
    await page.evaluate(() => { (window as any).__simSpeed = 0.0001; });
    await page.waitForTimeout(800);
    await shot('5-night');
    await page.evaluate(() => { const w = window as any; w.__simSpeed = 30; delete w.__lockQ; });
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 180_000, intervals: [300] }).toBe('over');
    await page.waitForTimeout(1600);
    await shot('6-over');
    if (info.project.name !== 'mobile') return;
    for (const [w, h, name] of [[844, 390, 'a-landscape'], [360, 640, 'b-small']] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(url());
      await page.waitForTimeout(1500);
      await shot(`${name}-title`);
      await start(page);
      await page.waitForTimeout(2500);
      await shot(`${name}-play`);
    }
  });
});
