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
//  対象: 影焼きランタン(2026-10-07)
//  ランタンの光に入った影は熱をためて燃え、燃えた影は爆ぜて となりの影へ火を移す(連鎖)。
//  Space / ✺ボタンで「灯を開く」と、光が一気に広がって まとめて燃える。残り火を拾うと油と経験。
//  経験がたまると3枚のカードから強化を選ぶ。夜明け(10分)まで生きのびる。
//
//  ・人の操作のテストは、本物のキー / マウス / 指で行う
//  ・長い勝負を何回も遊ばせるテスト(腕の差・毎回ちがう・選択の重さ)は、ページの中に自動プレイヤーを仕込み、
//    ゲームの時間を速回しにする(window.__simSpeed。同じ1/60秒の刻みを1コマで何回も進めるだけ)。
//    自動プレイヤーは1/60秒ごとに gameTest(読み取り専用)を読んで、キーを押したり離したりする
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-07-kage-yaki-lantern';
const target = latestGame();
const SKEY = 'kage-yaki-lantern-v1';
const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const isMobile = (page: Page) => page.viewportSize()!.width < 500;

type Pl = { x: number; z: number; vx: number; vz: number; hp: number; maxHp: number; inv: number; oil: number; R: number; flareCd: number; flareCost: number; flareR: number; pickR: number; speed: number };
type En = { id: number; k: number; x: number; z: number; heat: number; max: number; r: number; st: number; born: number };
type Stats = { t: number; won: boolean; dawn: boolean; depth: number; kills: number; maxChain: number; lv: number; xp: number; xpNext: number; picks: string[]; up: Record<string, number>; cause: string; hits: number; flares: number; picked: number; born: number[]; killed: number[]; best: { t: number; kills: number; chain: number } };
type Ev = { type: string; t: number; [k: string]: any };

// ---------------------------------------------------------------------------
//  ページの中で動く自動プレイヤー
// ---------------------------------------------------------------------------
// idle: 立ちつくして何もしない(強化だけ左のカードを選ぶ)。初めての人が様子を見ているときの目安
type Bot = { kind: 'smart' | 'dumb' | 'idle' | 'none'; seed: number; speed: number; cards?: string[]; sound?: boolean; plays?: number };
const CHAIN_CARDS = ['chain', 'burst', 'spark', 'floor', 'heat', 'heart', 'mag', 'radius', 'oil', 'flare', 'speed', 'mend'];
const LIGHT_CARDS = ['radius', 'oil', 'heart', 'flare', 'speed', 'mag', 'heat', 'mend', 'burst', 'spark', 'floor', 'chain'];

function installBot(cfg: Bot) {
  let s = cfg.seed >>> 0;
  Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // 保存データは はじめの1回だけ書く(再読み込みのたびに書くと、ゲームが残した記録を消してしまう)
  try { if (!localStorage.getItem('kage-yaki-lantern-v1')) localStorage.setItem('kage-yaki-lantern-v1', JSON.stringify({ sound: !!cfg.sound, plays: cfg.plays ?? 9 })); } catch { /* なし */ }
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
  const tap = (code: string) => { w.dispatchEvent(new KeyboardEvent('keydown', { code })); w.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const steer = (vx: number, vz: number) => {
    const l = Math.hypot(vx, vz);
    if (l < 1e-3) { for (const c of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) key(c, false); return; }
    vx /= l; vz /= l;
    key('ArrowRight', vx > 0.38); key('ArrowLeft', vx < -0.38); key('ArrowDown', vz > 0.38); key('ArrowUp', vz < -0.38);
  };
  const PRI = cfg.cards ?? [];
  let n = 0, dir = 0, move = true;
  w.__autoStep = () => {
    const g = w.gameTest;
    const st = g.state();
    if (st === 'card') {
      const offer: string[] = g.cards();
      if (!offer || w.__holdCards) return;
      let i = 0, best = 1e9;
      // 雑な自動プレイヤーは いつも左のカード
      if (cfg.kind === 'smart') offer.forEach((id, j) => { const r = PRI.indexOf(id); const rr = r < 0 ? 99 : r; if (rr < best) { best = rr; i = j; } });
      tap('Digit' + (i + 1));
      return;
    }
    if (st !== 'play' || cfg.kind === 'idle') return;
    n++;
    if (cfg.kind === 'dumb') {
      // でたらめ: 1秒ごとに でたらめな向きへ歩く(4回に1回は立ち止まる)。ときどき でたらめに灯を開く
      if (n % 60 === 1) { dir = Math.floor(br() * 8); move = br() > 0.25; }
      const a = (dir / 8) * Math.PI * 2;
      steer(move ? Math.cos(a) : 0, move ? Math.sin(a) : 0);
      if (br() < 0.012) tap('Space');
      return;
    }
    if (n % 3) return;
    // 考える: 墓地のまんなかのまわりを 円を描いて逃げ、群れを引き連れる。
    // 光の中(灯を開いた時に届く所)に群れが たまったら灯を開く。安全な残り火を拾う。墓石をよける
    const p = g.player(), en = g.enemies(), em = g.embers();
    if (!w.__obs || n < 4) w.__obs = g.obstacles();
    const r = Math.hypot(p.x, p.z) || 1;
    let vx = -p.z / r, vz = p.x / r;
    vx += (p.x / r) * (12 - r) * 0.18; vz += (p.z / r) * (12 - r) * 0.18;
    let nearest = 99, inFlare = 0;
    for (const e of en) {
      const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz);
      if (d < nearest) nearest = d;
      if (d < p.flareR * 0.85) inFlare += e.k === 2 || e.k === 4 ? 4 : 1;
      if (d < 3.4 + e.r) { const k = (3.4 + e.r - d) / (d * d + 0.2) * 1.4 * (e.k === 4 ? 3 : 1); vx -= dx * k; vz -= dz * k; }
    }
    let bestE: any = null, bd = 7;
    for (const m of em) {
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d > bd || m.life < 0.8) continue;
      let safe = true;
      for (const e of en) if (Math.hypot(e.x - m.x, e.z - m.z) < 1.4 + e.r) { safe = false; break; }
      if (safe) { bd = d; bestE = m; }
    }
    if (bestE) { const d = Math.max(0.3, bd); vx += (bestE.x - p.x) / d * 1.6; vz += (bestE.z - p.z) / d * 1.6; }
    for (const o of w.__obs) {
      const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz) - o.r;
      if (d < 1.6) { vx += dx / (d + o.r) * (1.6 - d) * 2.5; vz += dz / (d + o.r) * (1.6 - d) * 2.5; }
    }
    steer(vx, vz);
    const ready = p.flareCd <= 0 && p.oil >= p.flareCost;
    if (ready && (inFlare >= 8 || (nearest < 1.25 && inFlare >= 2))) tap('Space');
  };
}

type Result = { t: number; won: boolean; kills: number; maxChain: number; lv: number; picks: string[]; cause: string; hits: number; flares: number; picked: number; giants: number; giantsBorn: number; chains: number[]; offers: string[][]; obs: string; ev: Ev[]; burn: Burn; overText: string; crowd: number[] };
type Burn = { src: Record<string, number>; spreadN: number; spreadSum: number };
async function play(browser: Browser, cfg: Bot, cap = 700): Promise<Result> {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(installBot, cfg);
  await page.goto(url());
  await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
  await page.locator('#b-start').click();
  const crowd: number[] = [];   // 1分ごとの、いちばん多かった影の数
  await expect.poll(async () => {
    const s = await gt<string>(page, 'state'); const t = (await gt<Stats>(page, 'stats')).t;
    const n = await page.evaluate(() => (window as any).gameTest.enemies().length);
    const m = Math.floor(t / 60); crowd[m] = Math.max(crowd[m] ?? 0, n);
    return s === 'over' || t >= cap;
  }, { timeout: 8 * 60_000, intervals: [400] }).toBeTruthy();
  const s = await gt<Stats>(page, 'stats');
  let overText = '';
  if ((await gt<string>(page, 'state')) === 'over') {
    await expect(page.locator('#over')).toBeVisible({ timeout: 5000 });
    overText = (await page.locator('#over .stone').innerText()).replace(/\s+/g, ' ');
  }
  const r: Result = {
    t: s.t, won: s.won, kills: s.kills, maxChain: s.maxChain, lv: s.lv, picks: s.picks, cause: s.cause, hits: s.hits, flares: s.flares, picked: s.picked, giants: s.killed[4], giantsBorn: s.born[4],
    chains: await gt<number[]>(page, 'chains'), offers: await gt<string[][]>(page, 'offerLog'),
    obs: JSON.stringify((await gt<{ x: number; z: number }[]>(page, 'obstacles')).map((o) => [o.x.toFixed(1), o.z.toFixed(1)])),
    ev: await gt<Ev[]>(page, 'events'), burn: await gt<Burn>(page, 'burnLog'), overText, crowd:Array.from(crowd, (c) => c ?? 0),
  };
  expect(errors, `遊んでいる間に エラーが出ました: ${errors.join(' / ')}`).toEqual([]);
  await ctx.close();
  return r;
}
const line = (name: string, r: Result) =>
  `  ${name}: ${r.won ? '夜明けまで生きのびた' : `${r.t.toFixed(0)}秒で${r.cause}に`}・${r.kills}体・最大連鎖${r.maxChain}・5以上の連鎖${r.chains.filter((c) => c >= 5).length}回・灯${r.lv}・被弾${r.hits}・灯を開いた${r.flares}回・残り火${r.picked}・大影 ${r.giants}/${r.giantsBorn}・強化 ${r.picks.join(',') || 'なし'}`;

// ---------------------------------------------------------------------------
//  人の操作のテスト用: 種つきの乱数で開く
// ---------------------------------------------------------------------------
async function open(page: Page, opt: { seed?: number; plays?: number; sound?: boolean; speed?: number } = {}) {
  await page.addInitScript(installBot, { kind: 'none', seed: opt.seed ?? 5, speed: opt.speed ?? 1, plays: opt.plays ?? 0, sound: opt.sound ?? false } as Bot);
  await page.goto(url());
  await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
}
async function start(page: Page) {
  if (isMobile(page)) await page.locator('#b-start').tap(); else await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
}
async function flare(page: Page) {
  if (isMobile(page)) await page.locator('#b-flare').tap(); else await page.keyboard.press('Space');
}
const evs = (page: Page) => gt<Ev[]>(page, 'events');
const nearestD = (p: Pl, en: En[]) => Math.min(99, ...en.map((e) => Math.hypot(e.x - p.x, e.z - p.z)));

// 指 / キーで、ある向き(x, z)へ ms ミリ秒 歩く
async function walk(page: Page, dx: number, dz: number, ms: number) {
  const l = Math.hypot(dx, dz) || 1;
  dx /= l; dz /= l;
  if (isMobile(page)) {
    const cdp = await page.context().newCDPSession(page);
    const v = page.viewportSize()!;
    const o = { x: v.width * 0.4, y: v.height * 0.62 };
    const t = (type: string, p?: { x: number; y: number }) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] } as any);
    await t('touchStart', o);
    for (let i = 1; i <= 6; i++) { await t('touchMove', { x: o.x + dx * 10 * i, y: o.y + dz * 10 * i }); await page.waitForTimeout(16); }
    await page.waitForTimeout(Math.max(0, ms - 100));
    await t('touchEnd');
    await cdp.detach();
    return;
  }
  const ks: string[] = [];
  if (dx > 0.38) ks.push('ArrowRight'); if (dx < -0.38) ks.push('ArrowLeft'); if (dz > 0.38) ks.push('ArrowDown'); if (dz < -0.38) ks.push('ArrowUp');
  for (const k of ks) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of ks) await page.keyboard.up(k);
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
      return !!g && ['state', 'score', 'webgl', 'player', 'enemies', 'embers', 'obstacles', 'stats', 'chains', 'cards', 'offerLog', 'events', 'toScreen', 'cam', 'particles', 'quality', 'sound', 'liveChain'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
    expect(await gt<boolean>(page, 'webgl'), 'WebGL が使えていません').toBeTruthy();
    await page.waitForTimeout(1200);
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '3Dの画面に何も描かれていないようです').toBeGreaterThan(20_000);
  });

  // 核の遊び(1): 光の中だけ熱がたまり、燃えた影の火が となりへ移る(連鎖)
  test('光と連鎖: 光の中の影だけが熱を帯び、灯を開かなくても 燃えた影の火が となりへ移って連鎖する', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, { plays: 0 });
    await start(page);
    await expect(page.locator('#hint'), '最初の説明が出ません').toContainText('光に入れると燃える');
    let checked = false, inside = 0, outside = 0;
    for (let i = 0; i < 200 && !checked; i++) {
      const [p, en] = await Promise.all([gt<Pl>(page, 'player'), gt<En[]>(page, 'enemies')]);
      for (const e of en) {
        const d = Math.hypot(e.x - p.x, e.z - p.z);
        if (e.st === 0 && d < p.R - 0.6 && e.heat > 0) inside++;
        if (e.st === 0 && d > p.R + 1.2) { outside++; expect(e.heat, `光の外(${d.toFixed(1)}m)の影に熱がたまっています`).toBe(0); }
      }
      if (inside >= 1 && outside >= 2) checked = true;
      await page.waitForTimeout(40);
    }
    expect(checked, '光の中と外の影を くらべられませんでした').toBeTruthy();
    // 光で燃えた1体の火が、かたまった群れに移っていく
    await expect.poll(async () => Math.max(0, ...(await evs(page)).filter((e) => e.type === 'chain' && e.src === 'light').map((e) => e.n)), { timeout: 20_000, message: '燃えた影の火が となりへ移りません' }).toBeGreaterThanOrEqual(4);
    const ch = (await evs(page)).filter((e) => e.type === 'chain');
    console.log(`  灯を開かずに待った: 連鎖 ${ch.map((e) => `×${e.n}(${e.t}秒)`).join(' ')}`);
    await expect(page.locator('.pop').first(), '連鎖の数が画面に出ません').toBeAttached();
  });

  // 核の遊び(2): 群れが来たところで灯を開くと、まとめて燃える。開いたあとは しばらく開けない
  test('灯を開く: 群れが光のふちに来たところで Space / ✺ボタンを押すと、まとめて燃える。油を使い、すぐには次を開けない', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, { plays: 9 });
    await start(page);
    let p = await gt<Pl>(page, 'player');
    await expect.poll(async () => { p = await gt<Pl>(page, 'player'); return nearestD(p, await gt<En[]>(page, 'enemies')); }, { timeout: 15_000, intervals: [30] }).toBeLessThan(p.R + 1.4);
    const before = await gt<Stats>(page, 'stats');
    const oil0 = (await gt<Pl>(page, 'player')).oil;
    await flare(page);
    await expect.poll(async () => (await gt<Stats>(page, 'stats')).kills, { timeout: 1500, message: '灯を開いても まとめて燃えません' }).toBeGreaterThanOrEqual(before.kills + 5);
    const after = await gt<Pl>(page, 'player');
    console.log(`  灯を開く前 燃えた${before.kills}体 → 1.5秒以内に ${(await gt<Stats>(page, 'stats')).kills}体・油 ${oil0.toFixed(1)} → ${after.oil.toFixed(1)}`);
    expect(oil0 - after.oil, '灯を開いても油が減りません').toBeGreaterThan(10);
    await flare(page);
    await page.waitForTimeout(200);
    expect((await gt<Stats>(page, 'stats')).flares, '開いた直後に もう一度開けました').toBe(1);
    await expect.poll(async () => (await evs(page)).filter((e) => e.type === 'chain' && e.src === 'flare').map((e) => e.n)[0] ?? 0, { timeout: 3000 }).toBeGreaterThanOrEqual(5);
  });

  // 核の遊び(3): 残り火を拾うと 油と経験。たまると強化を選べる
  test('残り火と強化: 燃えた跡の残り火を拾うと油と経験が増え、たまると3枚のカードから強化を1つ選べる', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, { plays: 9 });
    await start(page);
    let p = await gt<Pl>(page, 'player');
    await expect.poll(async () => { p = await gt<Pl>(page, 'player'); return nearestD(p, await gt<En[]>(page, 'enemies')); }, { timeout: 15_000, intervals: [30] }).toBeLessThan(p.R + 1.4);
    await flare(page);
    await expect.poll(async () => (await gt<unknown[]>(page, 'embers')).length, { timeout: 3000 }).toBeGreaterThanOrEqual(5);
    const oil0 = (await gt<Pl>(page, 'player')).oil;
    // いちばん近い残り火へ 歩いていく(人と同じく、見て、歩いて、また見る)
    for (let i = 0; i < 30 && (await gt<string>(page, 'state')) === 'play'; i++) {
      const [pl, em] = await Promise.all([gt<Pl>(page, 'player'), gt<{ x: number; z: number }[]>(page, 'embers')]);
      if (!em.length) break;
      em.sort((a, b) => Math.hypot(a.x - pl.x, a.z - pl.z) - Math.hypot(b.x - pl.x, b.z - pl.z));
      const m = em[0];
      await walk(page, m.x - pl.x, m.z - pl.z, Math.min(500, 120 + Math.hypot(m.x - pl.x, m.z - pl.z) / pl.speed * 1000));
    }
    const st = await gt<Stats>(page, 'stats');
    console.log(`  拾った残り火 ${st.picked}・油 ${oil0.toFixed(1)} → ${(await gt<Pl>(page, 'player')).oil.toFixed(1)}・灯 ${st.lv}`);
    expect(st.picked, '残り火が拾えません').toBeGreaterThanOrEqual(4);
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 3000, message: '経験がたまっても 強化が選べません' }).toBe('card');
    const cards = page.locator('#cards .card');
    await expect(cards).toHaveCount(3);
    const offer = (await gt<string[]>(page, 'cards'))!;
    if (isMobile(page)) {
      const v = page.viewportSize()!;
      for (const c of await cards.all()) {
        const b = (await c.boundingBox())!;
        expect(b.y + b.height, 'カードが画面からはみ出しています').toBeLessThanOrEqual(v.height + 0.5);
        expect(b.height, 'カードが小さすぎます').toBeGreaterThanOrEqual(44);
      }
      await page.waitForTimeout(400);
      await cards.nth(1).tap();
    } else {
      await page.waitForTimeout(400);
      await page.keyboard.press('2');
    }
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    const st2 = await gt<Stats>(page, 'stats');
    console.log(`  カード ${offer.join(' / ')} → ${st2.picks.join(',')}`);
    expect(st2.picks, '選んだカードと ちがう強化が入りました').toEqual([offer[1]]);
    if (offer[1] !== 'mend') expect(st2.up[offer[1]]).toBe(1);
  });

  test('命と終わり: 影にふれると灯芯が減り、3回で終わる。結果が出て、もう一度遊べる。記録は再読み込みしても残る', async ({ page }) => {
    test.setTimeout(90_000);
    // でたらめに歩く自動プレイヤーで、早回しで ふれられる
    await page.addInitScript(installBot, { kind: 'dumb', seed: 7, speed: 6, plays: 9 } as Bot);
    await page.goto(url());
    await start(page);
    await expect.poll(async () => (await evs(page)).filter((e) => e.type === 'hit').length, { timeout: 30_000, message: '影にふれても 何も起きません' }).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#hearts .wick.out').first(), '灯芯が消えません').toBeAttached();
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 60_000 }).toBe('over');
    const hits = (await evs(page)).filter((e) => e.type === 'hit').map((e) => e.hp);
    expect(hits, '3回ふれて終わっていません').toEqual([2, 1, 0]);
    await page.evaluate(() => { (window as any).__autoStep = null; (window as any).__simSpeed = 1; });
    await expect(page.locator('#over')).toBeVisible({ timeout: 4000 });
    const s = await gt<Stats>(page, 'stats');
    await expect(page.locator('#o-time')).toHaveText(`${Math.floor(s.t / 60)}:${String(Math.floor(s.t % 60)).padStart(2, '0')}`);
    await expect(page.locator('#o-cause')).toContainText('夜明けまで');
    await expect(page.locator('#o-kills')).toHaveText(String(s.kills));
    console.log(`  ${s.t.toFixed(0)}秒で終わり(${s.cause})・結果: ${(await page.locator('#over .stone').innerText()).replace(/\s+/g, ' ')}`);
    await page.waitForTimeout(1300);
    if (isMobile(page)) await page.locator('#b-again').tap(); else await page.locator('#b-again').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    const s2 = await gt<Stats>(page, 'stats'), p2 = await gt<Pl>(page, 'player');
    expect(s2.t).toBeLessThan(2);
    expect(s2.kills).toBe(0);
    expect(p2.hp).toBe(3);
    expect(s2.best.t, '記録が残っていません').toBeGreaterThan(5);
    await page.reload();
    await expect(page.locator('#best'), '再読み込みすると記録が消えます').toContainText(`${s.kills} 体`);
  });

  // ------------------------------------------------------------------------
  //  面白さの代わりになる数字
  // ------------------------------------------------------------------------
  test('腕の差: 考えて遊ぶ自動プレイヤーは、でたらめな自動プレイヤーの1.5倍以上 生きのび、1.5倍以上 燃やす', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(10 * 60_000);
    const smart: Result[] = [], dumb: Result[] = [];
    for (const seed of [21, 22, 23]) {
      const a = await play(browser, { kind: 'smart', seed, speed: 20, cards: CHAIN_CARDS });
      const b = await play(browser, { kind: 'dumb', seed, speed: 20 });
      console.log(line(`考える 種${seed}`, a));
      console.log(line(`でたらめ 種${seed}`, b));
      expect(a.t, `種${seed}: 考えて遊んでも でたらめより長く生きられません`).toBeGreaterThan(b.t);
      smart.push(a); dumb.push(b);
      // 夜明けまで生きのびたら、結果が「夜明け」になる
      if (a.won) {
        expect(a.ev.some((e) => e.type === 'dawn'), '夜明けが来ていません').toBeTruthy();
        expect(a.overText, '夜明けの結果が出ません').toContain('夜明け');
      }
    }
    const avg = (rs: Result[], f: (r: Result) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
    const tr = avg(smart, (r) => r.t) / avg(dumb, (r) => r.t), kr = avg(smart, (r) => r.kills) / avg(dumb, (r) => r.kills);
    console.log(`  1回の長さ: 考える ${avg(smart, (r) => r.t).toFixed(0)}秒 / でたらめ ${avg(dumb, (r) => r.t).toFixed(0)}秒`);
    console.log(`  腕の差: 生きのびた時間 ${tr.toFixed(1)}倍・燃やした数 ${kr.toFixed(1)}倍・最大連鎖 ${avg(smart, (r) => r.maxChain).toFixed(0)} / ${avg(dumb, (r) => r.maxChain).toFixed(0)}・夜明け ${smart.filter((r) => r.won).length}/3`);
    expect(tr, '生きのびる時間に腕の差が出ません').toBeGreaterThanOrEqual(1.5);
    expect(kr, '燃やした数に腕の差が出ません').toBeGreaterThanOrEqual(1.5);
    expect(smart.some((r) => r.won), '上手に遊んでも 夜明けまで届きません').toBeTruthy();
    expect(smart.some((r) => !r.won), '上手な自動プレイヤーが毎回 夜明けまで届くのは やさしすぎます').toBeTruthy();
  });

  // 初めての人は、まず光の中で様子を見る。説明どおり「光に入れると燃える」なら、立っているだけで すぐには終わらない
  test('初めての人: 光の中で立ちつくしても、1体ずつ来る影は焼けて、1分以上は生きのびる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(5 * 60_000);
    const rs = await Promise.all([21, 22, 23].map((seed) => play(browser, { kind: 'idle', seed, speed: 20 })));
    rs.forEach((r, i) => console.log(line(`立ちつくす 種${21 + i}`, r) + `・1分ごとの影の数 ${r.crowd.join(',')}`));
    for (const r of rs) expect(r.t, '光の中に立っているだけで、すぐに やられてしまいます').toBeGreaterThanOrEqual(60);
  });

  test('毎回ちがう: 種を変えると、墓地の配置・出てくるカード・展開がちがう', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(5 * 60_000);
    const rs: Result[] = [];
    for (const seed of [31, 32, 33]) {
      const r = await play(browser, { kind: 'smart', seed, speed: 20, cards: CHAIN_CARDS }, 150);
      rs.push(r);
      console.log(`  種${seed}: 墓石など${JSON.parse(r.obs).length}こ・最初のカード ${r.offers.slice(0, 3).map((o) => o.join('/')).join(' → ')}・150秒で${r.kills}体・連鎖 ${r.chains.filter((c) => c >= 3).slice(0, 8).join(',')}`);
    }
    expect(new Set(rs.map((r) => r.obs)).size, '墓地の配置が毎回同じです').toBe(3);
    expect(new Set(rs.map((r) => JSON.stringify(r.offers.slice(0, 3)))).size, '出てくるカードが毎回同じです').toBe(3);
    expect(new Set(rs.map((r) => JSON.stringify(r.chains.filter((c) => c >= 3).slice(0, 6)))).size, '連鎖の出方が毎回同じです').toBe(3);
  });

  // 最大連鎖は、強化がそろう前(1分半ごろ)の大きな群れで決まりやすいので、物差しにしない。
  // 「何で燃やしたか」(光から燃えひろがった連鎖か、灯を開いたか)と、灯を開く回数で、立ち回りの違いを見る
  test('選択の重さ: 連鎖の強化を選ぶか、光の強化を選ぶかで、燃やし方(燃えひろがりで焼くか・灯を開いて焼くか)がはっきり変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(10 * 60_000);
    const ch: Result[] = [], li: Result[] = [];
    for (const seed of [3, 4]) {
      const a = await play(browser, { kind: 'smart', seed, speed: 20, cards: CHAIN_CARDS });
      const b = await play(browser, { kind: 'smart', seed, speed: 20, cards: LIGHT_CARDS });
      console.log(line(`連鎖の強化 種${seed}`, a));
      console.log(line(`光の強化 種${seed}`, b));
      ch.push(a); li.push(b);
    }
    const sum = (rs: Result[], f: (r: Result) => number) => rs.reduce((s, r) => s + f(r), 0);
    const spreadShare = (rs: Result[]) => sum(rs, (r) => r.burn.src.light ?? 0) / sum(rs, (r) => (r.burn.src.light ?? 0) + (r.burn.src.flare ?? 0));
    const shareR = spreadShare(ch) / spreadShare(li);
    const spreadAvg = (rs: Result[]) => sum(rs, (r) => r.burn.spreadSum) / Math.max(1, sum(rs, (r) => r.burn.spreadN));
    const fpm = (rs: Result[]) => sum(rs, (r) => r.flares) / (sum(rs, (r) => r.t) / 60);
    const flareR = fpm(li) / fpm(ch);
    console.log(`  燃えひろがりで焼いた割合: 連鎖の強化 ${(spreadShare(ch) * 100).toFixed(0)}% / 光の強化 ${(spreadShare(li) * 100).toFixed(0)}%(${shareR.toFixed(1)}倍)・燃えひろがりの回数 ${sum(ch, (r) => r.burn.spreadN)} / ${sum(li, (r) => r.burn.spreadN)}・平均 ${spreadAvg(ch).toFixed(1)} / ${spreadAvg(li).toFixed(1)}体`);
    console.log(`  1分に灯を開く回数 ${flareR.toFixed(1)}倍(光の強化 / 連鎖の強化)・最大連鎖 ${sum(ch, (r) => r.maxChain)} / ${sum(li, (r) => r.maxChain)}`);
    expect(shareR, '連鎖の強化を選んでも、燃えひろがりで焼けるようになりません').toBeGreaterThanOrEqual(1.5);
    expect(flareR, '光の強化を選んでも、灯の開き方が変わりません').toBeGreaterThanOrEqual(1.5);
  });

  // ------------------------------------------------------------------------
  //  スマホ・重さ・動画・見直し
  // ------------------------------------------------------------------------
  test('スマホ: 画面に収まり、ボタンは指で押せる大きさで、表示どうしが重ならない', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    await open(page, { plays: 0 });
    const v = page.viewportSize()!;
    const inside = (b: { x: number; y: number; width: number; height: number } | null) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5;
    const apart = (a: any, b: any) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    expect(inside(await page.locator('#b-start').boundingBox()), 'タイトルの「灯をともす」が画面の外です').toBeTruthy();
    await start(page);
    await page.waitForTimeout(500);
    const ids = ['#b-flare', '#b-pause', '#b-snd', '#vit', '#clock'];
    const bx: Record<string, any> = {};
    for (const id of ids) { bx[id] = await page.locator(id).boundingBox(); expect(inside(bx[id]), `${id} がはみ出しています`).toBeTruthy(); }
    for (const id of ['#b-flare', '#b-pause', '#b-snd']) expect(Math.min(bx[id].width, bx[id].height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(apart(bx[ids[i]], bx[ids[j]]), `${ids[i]} と ${ids[j]} が重なっています`).toBeTruthy();
    const hint = await page.locator('#hint').boundingBox();
    expect(apart(hint, bx['#b-flare']), '説明の文字が ✺ボタンに重なっています').toBeTruthy();
    // 自分は 上の表示にも 下のボタンにも かくれない
    const p = await gt<Pl>(page, 'player');
    const s = (await gt<{ x: number; y: number }>(page, 'toScreen', p.x, 1, p.z))!;
    expect(s.y).toBeGreaterThan(bx['#clock'].y + bx['#clock'].height);
    expect(s.y).toBeLessThan(bx['#b-flare'].y);
    // 指で歩ける
    await walk(page, 1, 0, 700);
    expect((await gt<Pl>(page, 'player')).x, '指でなぞっても歩けません').toBeGreaterThan(p.x + 1.5);
  });

  test('スマホで重くない(CPU 4倍遅くても、影が群れて連鎖が はじける中で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(4 * 60_000);
    await page.addInitScript(installBot, { kind: 'smart', seed: 41, speed: 12, cards: CHAIN_CARDS, plays: 9 } as Bot);
    await page.goto(url());
    await start(page);
    // 早回しで進め、影が70体をこえて群れた瞬間に ふつうの速さへ戻す(ページの中で見張るので、取りこぼさない)
    await page.evaluate(() => {
      const w = window as any;
      const id = setInterval(() => { if (w.gameTest.enemies().length >= 70) { w.__simSpeed = 1; clearInterval(id); } }, 30);
    });
    await expect.poll(() => page.evaluate(() => (window as any).__simSpeed), { timeout: 3 * 60_000, intervals: [300] }).toBe(1);
    expect(await gt<string>(page, 'state'), '測る前に終わってしまいました').not.toBe('over');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 5000, intervals: [30] }).toBe('play');
    const n =(await gt<En[]>(page, 'enemies')).length, pn = await gt<number>(page, 'particles');
    // 測っているあいだは gameTest を読まない(自動プレイヤーも止め、灯を開くだけにする)
    await page.evaluate(() => { (window as any).__autoStep = null; });
    await page.locator('#b-flare').tap();
    const perf = await measureFps(page, 3000);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・影 ${n}体・粒 ${pn}・画質の段階 ${await gt<number>(page, 'quality')}`);
    expect(n, '影が少なすぎて 重さを測れません').toBeGreaterThan(60);
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
        await page.addInitScript(installBot, { kind: 'smart', seed: 51, speed: 12, cards: CHAIN_CARDS, plays: 9, sound: true } as Bot);
        await page.goto(url());
        await start(page);
        // 群れが育つ 1分半すぎまで 早回し
        await expect.poll(async () => (await gt<Stats>(page, 'stats')).t, { timeout: 60_000, intervals: [300] }).toBeGreaterThan(92);
        await page.evaluate(() => { (window as any).__simSpeed = 1; });
      },
      play: async (page, clip: Clip) => {
        let marked = false, shot = false, markAt = 0, best = 0;
        while (Date.now() < clip.until) {
          const n = await gt<number>(page, 'liveChain');
          best = Math.max(best, n);
          // 見せ場: 群れに火がついて 連鎖が広がりはじめた瞬間
          if (!marked && n >= 6) { marked = true; markAt = Date.now(); clip.mark(); }
          // 投稿画像はふつうの動画のときだけ撮る(ショート用モードの縦長で上書きしない)
          if (marked && !shot && Date.now() - markAt > 900) { shot = true; if (process.env.SHORT_VIDEO !== '1') await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') }); }
          await page.waitForTimeout(50);
        }
        const s = await gt<Stats>(page, 'stats');
        console.log(`  動画: mark ${marked}・いちばん大きい連鎖 ×${best}・${s.t.toFixed(0)}秒・${s.kills}体`);
        expect(marked, '動画の見せ場(連鎖)が来ませんでした').toBeTruthy();
      },
    });
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(4 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    await page.addInitScript(installBot, { kind: 'none', seed: 61, speed: 1, plays: 0 } as Bot);
    await page.goto(url());
    await page.waitForTimeout(1500);
    await shot('1-title');
    await start(page);
    await page.waitForTimeout(2500);
    await shot('2-start');
    await expect.poll(() => gt<number>(page, 'liveChain'), { timeout: 15_000, intervals: [30] }).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(250);
    await shot('3-first-chain');
    // 自動プレイヤーに 2分ほど遊ばせて、にぎやかな場面
    await page.addInitScript(installBot, { kind: 'smart', seed: 62, speed: 12, cards: CHAIN_CARDS, plays: 9 } as Bot);
    await page.goto(url());
    await start(page);
    await expect.poll(async () => (await gt<Stats>(page, 'stats')).t, { timeout: 90_000, intervals: [300] }).toBeGreaterThan(130);
    await page.evaluate(() => { (window as any).__simSpeed = 1; });
    await expect.poll(() => gt<number>(page, 'liveChain'), { timeout: 30_000, intervals: [30] }).toBeGreaterThanOrEqual(5);
    await page.waitForTimeout(300);
    await shot('4-busy');
    await page.evaluate(() => { (window as any).__holdCards = true; });
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 60_000, intervals: [100] }).toBe('card');
    await page.waitForTimeout(600);
    await shot('5-cards');
    await page.evaluate(() => { const w = window as any; w.__holdCards = false; w.__simSpeed = 30; });
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 120_000, intervals: [300] }).toBe('over');
    await page.waitForTimeout(1600);
    await shot('6-over');
    if (info.project.name !== 'mobile') return;
    for (const [w, h, name] of [[844, 390, 'a-landscape'], [360, 640, 'b-small']] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(url());
      await page.waitForTimeout(1200);
      await shot(`${name}-title`);
      await start(page);
      await page.waitForTimeout(2500);
      await shot(`${name}-play`);
    }
  });
});
