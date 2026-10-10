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
//  対象: 凍原の犬ぞり便(2026-10-11)
//  6頭の犬ぞりで、嵐が来る前に峠の向こうの村へ荷を6箱届ける。ペースは4段(止まれ・トロット・駆け足・全力)。
//  犬の体力・自分の体温・嵐までの時間をやりくりする。そりは先頭の犬の通ったあとを通る。
//  分かれ道: 湖(近道。氷が後ろから割れてくる)/ 岸(遠回り)、峠(近道。きつい上り・急な下り)/ 川(遠回り)
//
//  ・自動プレイヤーはページの中で動く(window.__autoStep が 1/60 秒ごとに呼ばれる)。本物のキー(KeyboardEvent)で操る
//  ・ゲームから読むのは、そりの状態・道の情報・障害物の場所だけ。よけ方とペースの決め方はテストの側で考える
//  ・早送り(__simSpeed)と、描かずに遊びだけ進める(__noDraw)は、自動プレイを短い時間で回すためだけに使う
//  ・Math.random は種つきの乱数に差しかえる(ゲームは変えない)
// ============================================================================

const EXPECTED = '2026-10-11-inuzori-bin';
const SKEY = 'inuzori-bin-v1';
const target = latestGame();
const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const isMobile = (page: Page) => page.evaluate(() => 'ontouchstart' in window);

type Cfg = { seed: number; sound?: boolean; save?: Record<string, unknown> };
function installInit(cfg: Cfg) {
  let s = cfg.seed >>> 0;
  Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try {
    if (!localStorage.getItem('inuzori-bin-v1')) localStorage.setItem('inuzori-bin-v1', JSON.stringify(Object.assign({ sound: !!cfg.sound }, cfg.save || {})));
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
  if (await isMobile(page)) await page.locator('#b-start').tap(); else await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
}

// ---------------------------------------------------------------------------
//  自動プレイヤー(ページの中で動く)
//   think : 先の障害物を見てよける。平地は駆け足、上りはトロット、下りはブレーキ、割れる氷と吹雪は全力。
//           体力が残っていれば近道(湖・峠)、少なければ遠回り。小屋で休み、体力が落ちたら干し魚
//   full  : いつも全力。近道を行く。よけ方は think と同じ(判断だけを比べるため)
//   steady: いつも駆け足。近道を行く
//   random: ペースを数秒ごとにでたらめに変え、分かれ道もでたらめ。よけ方は同じ
//   hold  : 決めたペース(cfg.pace)のまま、障害物をよける(個別の確かめ用)
// ---------------------------------------------------------------------------
type BotCfg = { kind: 'think' | 'full' | 'steady' | 'random' | 'hold' | 'casual'; seed: number; b1?: 'L' | 'S' | 'auto'; b2?: 'P' | 'V' | 'auto'; rest?: boolean; fish?: boolean; pace?: number; avoid?: boolean; stopAt?: number; crackPace?: number; descPace?: number };
function botInstall(cfg: BotCfg) {
  const w = window as any, g = w.gameTest;
  let sd = (cfg.seed >>> 0) || 1;
  const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const down: Record<string, boolean> = {};
  const key = (code: string, on: boolean) => { if (!!down[code] === on) return; down[code] = on; w.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code })); };
  const tap = (code: string) => { w.dispatchEvent(new KeyboardEvent('keydown', { code })); w.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const releaseAll = () => { for (const c of Object.keys(down)) key(c, false); };
  const B = (w.__bot = { cfg, done: false, err: '', t: 0, randT: 0, randP: 2, rested: false, restStart: -1, choice: {} as Record<string, string>, result: null as any, log: [] as any[], logT: 0, paceT: 0 });
  const route = g.route(), forks = route.forkSides;
  function wantPace(p: number, st: any) { if (B.t - B.paceT < 0.12) return; if (p > st.pace) { tap('ArrowUp'); B.paceT = B.t; } else if (p < st.pace) { tap('ArrowDown'); B.paceT = B.t; } }
  function planU(st: any, obs: any[]) {
    const look = 9 + st.v * 2.4;
    let best = 0, bc = 1e9;
    for (let u = -2.2; u <= 2.21; u += 0.2) {
      let c = 0.12 * Math.abs(u) + 0.04 * Math.abs(u - st.uLead);
      for (const o of obs) {
        const ds = o.s - st.sLead;
        if (ds < -o.rs - 1 || ds > look + o.rs) continue;
        const reach = o.kind === 'drift' ? 0.4 : 0.85;
        if (Math.abs(u - o.u) < o.ru + reach) c += (o.kind === 'drift' ? 6 : o.kind === 'thin' && st.v > 6.6 ? 2 : 60) * (1.2 - Math.max(0, ds) / (look + 4));
      }
      if (c < bc) { bc = c; best = u; }
    }
    return best;
  }
  function choose(n: number, st: any) {
    const f = forks[n - 1];
    let want: string;
    const b = n === 1 ? cfg.b1 : cfg.b2;
    if (b && b !== 'auto') want = b;
    else if (cfg.kind === 'think') want = n === 1 ? (st.E >= 55 ? 'L' : 'S') : (st.E >= 55 && st.W < 0.3 && st.warmth > 60 ? 'P' : 'V');
    else if (cfg.kind === 'random') want = B.choice['r' + n] ?? (B.choice['r' + n] = rnd() < 0.5 ? f.left : f.right);
    else want = n === 1 ? 'L' : 'P';
    B.choice['f' + n] = want;
    return want === f.right ? 1.5 : -1.5;
  }
  w.__autoStep = () => {
    try {
      const st0 = g.state();
      if (st0 === 'title') { (document.querySelector('#b-start') as HTMLButtonElement).click(); return; }
      if (st0 === 'over') { releaseAll(); if (!B.done) { B.done = true; B.result = { ...g.stats(), score: g.score() }; } return; }
      if (st0 !== 'play') { releaseAll(); return; }
      B.t += 1 / 60;
      const st = g.sled(), r = g.route(), obs = g.obstacles();
      if (cfg.stopAt && st.s >= cfg.stopAt) { releaseAll(); if (!B.done) { B.done = true; w.__simSpeed = 1; w.__noDraw = false; } return; }
      let uT = cfg.avoid === false ? 0 : planU(st, obs);
      if (!st.b1 && r.forks[0] - st.sLead < 45) uT = choose(1, st);
      else if (st.b1 && !st.b2 && r.forks[1] - st.sLead < 45) uT = choose(2, st);
      const e = uT - st.uLead;
      key('ArrowRight', e > 0.15); key('ArrowLeft', e < -0.15);
      // ペース
      const ahead = g.at(st.s + 14), ahead2 = g.at(st.s + 28 + st.v * 2);
      const climbing = st.grade > 0.045 || ahead.g > 0.07;
      const desc = st.grade < -0.045 || ahead.g < -0.06 || ahead2.g < -0.09;
      const crack = g.crack();
      let p = 2;
      if (cfg.kind === 'full') p = 3;
      else if (cfg.kind === 'steady') p = 2;
      else if (cfg.kind === 'hold') p = cfg.pace ?? 2;
      else if (cfg.kind === 'random') { B.randT -= 1 / 60; if (B.randT <= 0) { B.randT = 3 + rnd() * 5; B.randP = 1 + Math.floor(rnd() * 3); } p = B.randP; }
      else if (cfg.kind === 'casual') {
        // ヒントに書いてあることだけ守る(下りはブレーキ・割れたら全力・疲れたら魚・小屋で休む)
        p = desc ? 1 : crack.on ? 3 : 2;
      } else {
        p = 2;
        if (climbing) p = st.E > 45 ? 2 : 1;
        if (desc) p = 1;
        const thinAhead = obs.some((o: any) => o.kind === 'thin' && !o.hit && o.s - st.s < 30 && o.s - st.s > -2);
        if (thinAhead) p = Math.max(p, 2);
        if (st.W > 0.12 && st.E > 45 && !climbing && !desc) p = 3;
        if (st.E > 88 && !climbing && !desc) p = 3;
        if (st.E < 22) p = Math.min(p, 1);
        if (crack.on) p = 3;
      }
      // 個別の確かめ用: 割れ目に追われているとき・下りのときだけペースを決め打ちにする
      if (crack.on && cfg.crackPace != null) p = cfg.crackPace;
      if (desc && cfg.descPace != null) p = cfg.descPace;
      if (cfg.kind === 'think' || cfg.kind === 'casual') {
        if (cfg.fish !== false && st.E < 36 && st.fish > 0 && !st.eating && st.crashT <= 0) tap('KeyF');
        // 小屋で休む
        if (cfg.rest !== false && st.b1 && !B.rested) {
          const d = r.hutS - st.s;
          if (d < 8 && d > -10 && (st.E < 80 || st.warmth < 85)) {
            p = 0;
            if (st.resting) { if (B.restStart < 0) B.restStart = B.t; if ((st.E > 95 && st.warmth > 92) || B.t - B.restStart > 16) B.rested = true; }
          }
          if (d < -10) B.rested = true;
        }
      }
      wantPace(p, st);
      B.logT -= 1 / 60;
      if (B.logT <= 0) { B.logT = 10; B.log.push({ t: +st.t.toFixed(0), s: Math.round(st.s), seg: st.seg, v: +st.v.toFixed(1), p: st.pace, E: Math.round(st.E), w: Math.round(st.warmth), c: st.crates }); }
    } catch (e) { B.err = String((e as Error).stack || e); }
  };
}
async function runBot(page: Page, cfg: BotCfg, opts: { speed?: number; noDraw?: boolean; timeout?: number } = {}) {
  await page.evaluate(([c, o]) => { (window as any).__simSpeed = o.speed ?? 30; (window as any).__noDraw = o.noDraw ?? true; }, [cfg, opts] as const);
  await page.evaluate(botInstall, cfg);
  await expect.poll(() => page.evaluate(() => (window as any).__bot.done || !!(window as any).__bot.err), { timeout: opts.timeout ?? 240_000, intervals: [500] }).toBeTruthy();
  const bot = await page.evaluate(() => { const b = (window as any).__bot; return { result: b.result, err: b.err, choice: b.choice, log: b.log }; });
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
    await page.waitForTimeout(1200);
    // 描いた画面が一色ではない(夕日の森が映っている)
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '画面がほとんど描かれていません').toBeGreaterThan(20_000);
    expect(errors).toEqual([]);
  });

  test('走る・舵: 人の速さで ↑ を押すと犬が走り出し、← → で先頭の犬が寄り、そりは犬の通ったあとを遅れて通る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーボードで確かめる');
    const errors = await open(page, { seed: 2 });
    await start(page);
    expect((await gt<any>(page, 'sled')).v).toBe(0);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(3500);
    const a = await gt<any>(page, 'sled');
    expect(a.pace, '↑ 2回で駆け足になりません').toBe(2);
    expect(a.v, '駆け足なのに速くなりません').toBeGreaterThan(6.5);
    // 右へ 0.6 秒
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(600);
    await page.keyboard.up('ArrowRight');
    const b = await gt<any>(page, 'sled');
    expect(b.uLead, '→ で先頭の犬が右へ寄りません').toBeGreaterThan(0.9);
    expect(Math.abs(b.u), 'そりが犬より先に動いています(犬の通ったあとを通るはず)').toBeLessThan(b.uLead * 0.6);
    // 1秒ほどで、そりも同じ所を通る
    await page.waitForTimeout(500);
    const c = await gt<any>(page, 'sled');
    expect(c.u, 'そりが犬の通ったあとを通りません').toBeGreaterThan(0.5);
    // ↓ で止まれ
    for (let k = 0; k < 2; k++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); }
    await page.waitForTimeout(2500);
    expect((await gt<any>(page, 'sled')).v, '↓ で止まりません').toBeLessThan(0.5);
    expect(errors).toEqual([]);
  });

  test('よける: 岩や倒木をよけると荷は無事。よけずに駆け足で突っこむと激突して荷が落ちる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(150_000);
    const run = async (avoid: boolean) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const errors = await open(page, { seed: 3 });
      await start(page);
      await runBot(page, { kind: 'hold', seed: 3, pace: 2, avoid, stopAt: 560 }, { speed: 6 });
      const st = await gt<any>(page, 'sled'), evs = await gt<any[]>(page, 'events');
      await ctx.close();
      expect(errors).toEqual([]);
      return { crates: st.crates, crashes: evs.filter((e) => e.type === 'crash').length };
    };
    const yes = await run(true), no = await run(false);
    console.log(`  森の 560m: よけた → 荷${yes.crates}・激突${yes.crashes} / よけない → 荷${no.crates}・激突${no.crashes}`);
    expect(yes.crashes, 'よけても激突しています').toBe(0);
    expect(yes.crates).toBe(6);
    expect(no.crashes, 'まっすぐ走っても何にもぶつかりません').toBeGreaterThanOrEqual(2);
    expect(no.crates, '激突しても荷が落ちません').toBeLessThan(6);
  });

  test('下り坂: 全力のまま下ると、そりが犬に追突して荷が落ちる。ペースを落とせば無事', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(150_000);
    const run = async (descPace: number) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed: 4 });
      await start(page);
      const r = (await gt<any>(page, 'routes')).LP;
      // 湖へ下りる坂まで
      await runBot(page, { kind: 'think', seed: 4, b1: 'L', descPace, stopAt: r.lakeIn + 25 }, { speed: 8 });
      const evs = await gt<any[]>(page, 'events');
      await ctx.close();
      return evs.filter((e) => e.type === 'crash' && e.kind === 'overrun').length;
    };
    const full = await run(3), brake = await run(1);
    console.log(`  湖へ下る坂: 全力のまま → 追突${full}回 / トロットに落とす → 追突${brake}回`);
    expect(full, '全力で下っても追突しません').toBeGreaterThanOrEqual(1);
    expect(brake, 'ペースを落としても追突します').toBe(0);
  });

  test('湖: 氷が後ろから割れてくる。全力なら逃げきれ、駆け足のままだと追いつかれて落ちる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(150_000);
    const run = async (crackPace?: number) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed: 5 });
      await start(page);
      const r = (await gt<any>(page, 'routes')).LP;
      await runBot(page, { kind: 'think', seed: 5, b1: 'L', crackPace, stopAt: r.lakeOut + 20 }, { speed: 8 });
      const evs = await gt<any[]>(page, 'events'), st = await gt<any>(page, 'sled');
      await ctx.close();
      return { crack: evs.some((e) => e.type === 'crack'), escape: evs.some((e) => e.type === 'escape'), fall: evs.some((e) => e.type === 'crash' && e.kind === 'fall'), crates: st.crates, warmth: Math.round(st.warmth) };
    };
    const full = await run(), canter = await run(2);
    console.log(`  全力で逃げる: ${JSON.stringify(full)} / 駆け足のまま: ${JSON.stringify(canter)}`);
    expect(full.crack, '湖で氷が割れはじめません').toBeTruthy();
    expect(full.escape, '全力でも逃げきれません').toBeTruthy();
    expect(canter.fall, '駆け足でも割れ目に追いつかれません(逃げる意味がない)').toBeTruthy();
    expect(canter.crates, '割れた氷に落ちても荷が減りません').toBeLessThan(full.crates);
    expect(canter.warmth, '水に落ちても体が冷えません').toBeLessThan(full.warmth);
  });

  test('小屋: 小屋の前で止まると休めて、体力と体温が戻る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(150_000);
    const errors = await open(page, { seed: 6 });
    await start(page);
    const r0 = await gt<any>(page, 'route');
    // 岸を回って小屋の手前まで(stopAt で早送りが止まる)
    await runBot(page, { kind: 'hold', seed: 6, pace: 2, b1: 'S', stopAt: r0.segStart.S + 30 }, { speed: 10 });
    const r = await gt<any>(page, 'route');
    await page.evaluate(() => { (window as any).__bot.done = true; });
    await runBot(page, { kind: 'hold', seed: 6, pace: 2, b1: 'S', stopAt: r.hutS - 5 }, { speed: 10 });
    for (let k = 0; k < 2; k++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(120); }
    await expect.poll(async () => (await gt<any>(page, 'sled')).resting, { timeout: 8000, message: '小屋の前で止まっても休めません' }).toBeTruthy();
    const a = await gt<any>(page, 'sled');
    await page.waitForTimeout(3000);
    const b = await gt<any>(page, 'sled');
    console.log(`  小屋で3秒: 体力 ${a.E.toFixed(0)} → ${b.E.toFixed(0)}・体温 ${a.temp.toFixed(1)} → ${b.temp.toFixed(1)}℃`);
    expect(b.warmth, '休んでも体温が戻りません').toBeGreaterThan(a.warmth + 5);
    expect(b.E >= Math.min(100, a.E + 10), '休んでも体力が戻りません').toBeTruthy();
    expect(errors).toEqual([]);
  });

  test('配達: 村に着くと配達伝票が出て、点と道が分かる。もう一度走れて、再読み込みしても記録が残る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(4 * 60_000);
    const errors = await open(page, { seed: 7 });
    await start(page);
    const bot = await runBot(page, { kind: 'think', seed: 7 });
    console.log(`  1プレイの長さ: ${Math.floor(bot.result.t / 60)}分${Math.round(bot.result.t % 60)}秒(${bot.result.route}・配達点 ${bot.result.score})`);
    expect(bot.result.cause, '考えて走っても遭難しました').toBe('');
    await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#stamp')).toHaveText('配達済');
    await expect(page.locator('#res-score')).toContainText(`配達点 ${bot.result.score}`);
    await expect(page.locator('#res-lines')).toContainText('村');
    await page.evaluate(() => { (window as any).__autoStep = null; (window as any).__simSpeed = 1; (window as any).__noDraw = false; });
    await page.locator('#b-again').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    const s = await gt<any>(page, 'sled');
    expect(s.s, 'もう一度走ると、はじめの場所に戻りません').toBeLessThan(20);
    expect(s.crates).toBe(6);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    const sv = await gt<any>(page, 'save');
    expect(sv.arrived, '再読み込みすると記録が消えます').toBeGreaterThanOrEqual(1);
    expect(sv.best[bot.result.route]?.score).toBe(bot.result.score);
    await expect(page.locator('#rec')).toContainText(String(bot.result.score));
    expect(errors).toEqual([]);
  });

  test('遭難: いつも全力で走ると、犬が疲れきり、嵐の中で凍えて遭難する(配達点 0)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(4 * 60_000);
    const errors = await open(page, { seed: 8 });
    await start(page);
    const bot = await runBot(page, { kind: 'full', seed: 8 });
    expect(bot.result.cause).toBe('cold');
    await expect(page.locator('#stamp')).toHaveText('遭難');
    await expect(page.locator('#res-score')).toContainText('配達点 0');
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
    const bot = await runBot(page, cfg, { timeout: 8 * 60_000 });
    const evs = await gt<any[]>(page, 'events');
    const obs = await gt<any[]>(page, 'allObstacles');
    await ctx.close();
    expect(errors, `${cfg.kind}: JSエラー`).toEqual([]);
    return { ...bot.result, evs, obs, choice: bot.choice };
  }
  const line = (r: any) => `${String(r.score).padStart(4)}点 ${r.route} ${Math.round(r.t)}秒 荷${r.crates} 衝突${r.crashes} 体温${Math.round(r.warmth)}${r.cause ? ' 遭難' : ''}`;

  test('腕の差: 考える自動プレイヤーは、「いつも全力」「でたらめ」の1.5倍以上の配達点をとる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '自動プレイは desktop で');
    test.setTimeout(9 * 60_000);
    const seeds = [11, 12, 13];
    const kinds = ['think', 'full', 'random', 'casual'] as const;
    const jobs = seeds.flatMap((seed) => kinds.map((kind) => ({ kind, seed })));
    const res: any[] = [];
    for (let i = 0; i < jobs.length; i += 6) res.push(...(await Promise.all(jobs.slice(i, i + 6).map((c) => session(browser, c)))));
    const avg = (k: string) => { const xs = res.filter((r, i) => jobs[i].kind === k); return xs.reduce((a, r) => a + r.score, 0) / xs.length; };
    res.forEach((r, i) => console.log(`  種${jobs[i].seed} ${jobs[i].kind.padEnd(6)} ${line(r)}`));
    console.log(`  平均: 考える ${avg('think').toFixed(0)} / いつも全力 ${avg('full').toFixed(0)} / でたらめ ${avg('random').toFixed(0)} / ヒントどおり ${avg('casual').toFixed(0)}`);
    expect(avg('think'), '考えて遊んでも、いつも全力の1.5倍に届きません').toBeGreaterThanOrEqual(Math.max(1, avg('full')) * 1.5);
    expect(avg('think'), '考えて遊んでも、でたらめの1.5倍に届きません').toBeGreaterThanOrEqual(Math.max(1, avg('random')) * 1.5);
    expect(avg('think'), '考える自動プレイヤーが、ヒントどおりより低い点です').toBeGreaterThan(avg('casual'));
    expect(res.filter((r, i) => jobs[i].kind === 'think' && r.cause).length, '考える自動プレイヤーが遭難しています').toBe(0);
  });

  test('毎回ちがう: 遊ぶたびに、岩・倒木・薄い氷・吹きだまりの場所、氷の割れはじめ、嵐の来る時刻が変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(3 * 60_000);
    const sigs: string[] = [], storms: number[] = [], cracks: number[] = [];
    for (const seed of [31, 32, 33, 34]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await open(page, { seed });
      await start(page);
      const obs = await gt<any[]>(page, 'allObstacles');
      sigs.push(JSON.stringify(obs.map((o) => [o.seg, o.kind, Math.round(o.ls), Math.sign(o.u)])));
      const c = await gt<any>(page, 'crack');
      cracks.push(Math.round(c.start));
      storms.push(Math.round((await page.evaluate(() => (window as any).gameTest.stats().stormAt))));
      const by: Record<string, number> = {};
      for (const o of obs) by[o.kind] = (by[o.kind] || 0) + 1;
      console.log(`  種${seed}: ${JSON.stringify(by)}・氷の割れはじめ ${cracks.at(-1)}m・嵐 ${Math.floor(storms.at(-1)! / 60)}分${storms.at(-1)! % 60}秒`);
      await ctx.close();
    }
    expect(new Set(sigs).size, '障害物の並びが毎回同じです').toBe(sigs.length);
    expect(new Set(storms).size, '嵐の来る時刻が毎回同じです').toBeGreaterThanOrEqual(3);
    expect(new Set(cracks).size, '氷の割れはじめが毎回同じです').toBeGreaterThanOrEqual(3);
  });

  test('選択の重さ: 道(湖/岸 × 峠/川)と小屋で休むかで、着く時刻・体温・配達点がはっきり変わる', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で');
    test.setTimeout(8 * 60_000);
    const jobs: BotCfg[] = [
      { kind: 'think', seed: 41, b1: 'L', b2: 'P' }, { kind: 'think', seed: 41, b1: 'L', b2: 'V' },
      { kind: 'think', seed: 41, b1: 'S', b2: 'P' }, { kind: 'think', seed: 41, b1: 'S', b2: 'V' },
      { kind: 'think', seed: 41, b1: 'L', b2: 'V', rest: false },
    ];
    const res = await Promise.all(jobs.map((c) => session(browser, c)));
    const names = ['湖→峠', '湖→川', '岸→峠', '岸→川', '湖→川(休まない)'];
    res.forEach((r, i) => console.log(`  ${names[i].padEnd(10)} ${line(r)}`));
    for (let i = 0; i < 4; i++) expect(res[i].route, '選んだ道を通っていません').toBe(`${jobs[i].b1}${jobs[i].b2}`);
    const ts = res.slice(0, 4).map((r) => r.t);
    expect(Math.max(...ts) - Math.min(...ts), '道を変えても着く時刻がほとんど変わりません').toBeGreaterThan(30);
    const sc = res.slice(0, 4).map((r) => r.score);
    expect(Math.max(...sc) - Math.min(...sc), '道を変えても配達点がほとんど変わりません').toBeGreaterThan(80);
    expect(Math.abs(res[1].warmth - res[4].warmth), '小屋で休んでも休まなくても、着いたときの体温が同じです').toBeGreaterThan(10);
  });

  // ------------------------------------------------------------------------
  //  スマホ・重さ・動画・見直し
  // ------------------------------------------------------------------------
  test('スマホ: ▲▼でペース、画面を左右になぞって舵、干魚で体力。ボタンは指で押せる大きさで、はみ出さず重ならない', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    test.setTimeout(120_000);
    const errors = await open(page, { seed: 9 });
    const v = page.viewportSize()!;
    await start(page);
    const inside = (b: { x: number; y: number; width: number; height: number } | null) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5;
    const apart = (a: any, b: any) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    const ids = ['#panel', '#mapw', '#b-snd', '#b-pause', '#b-up', '#b-dn', '#b-fish'];
    const bx: Record<string, any> = {};
    for (const id of ids) { bx[id] = await page.locator(id).boundingBox(); expect(inside(bx[id]), `${id} がはみ出しています`).toBeTruthy(); }
    for (const id of ['#b-snd', '#b-pause', '#b-up', '#b-dn', '#b-fish']) expect(Math.min(bx[id].width, bx[id].height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(apart(bx[ids[i]], bx[ids[j]]), `${ids[i]} と ${ids[j]} が重なっています`).toBeTruthy();
    await page.locator('#b-up').tap();
    await page.waitForTimeout(150);
    await page.locator('#b-up').tap();
    await page.waitForTimeout(2500);
    expect((await gt<any>(page, 'sled')).pace, '▲ でペースが上がりません').toBe(2);
    // 画面の真ん中を右へなぞる(指を置いたまま)
    const cdp = await page.context().newCDPSession(page);
    const touch = async (pts: { x: number; y: number; id: number }[], type: string) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts } as any);
    const u0 = (await gt<any>(page, 'sled')).uLead;
    await touch([{ x: v.width * 0.5, y: v.height * 0.45, id: 1 }], 'touchStart');
    for (let k = 1; k <= 6; k++) { await touch([{ x: v.width * 0.5 + k * 10, y: v.height * 0.45, id: 1 }], 'touchMove'); await page.waitForTimeout(16); }
    await page.waitForTimeout(500);
    await touch([], 'touchEnd');
    expect((await gt<any>(page, 'sled')).uLead - u0, 'なぞっても犬が寄りません').toBeGreaterThan(0.6);
    await cdp.detach();
    await page.locator('#b-fish').tap();
    await expect.poll(async () => (await gt<any>(page, 'sled')).fish, { message: '干魚ボタンで魚をやれません' }).toBe(1);
    await page.locator('#b-dn').tap();
    expect((await gt<any>(page, 'sled')).pace, '▼ でペースが下がりません').toBe(1);
    expect(errors).toEqual([]);
  });

  test('スマホで重くない(CPU 4倍遅くても、吹雪の夜の森を走りながら 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(4 * 60_000);
    await open(page, { seed: 51 });
    await start(page);
    // 嵐が来るまで早送りで走る(描かずに)
    const st0 = await page.evaluate(() => (window as any).gameTest.stats().stormAt);
    await page.evaluate(botInstall, { kind: 'think', seed: 51 } as BotCfg);
    await page.evaluate(() => { (window as any).__simSpeed = 30; (window as any).__noDraw = true; });
    await expect.poll(async () => (await gt<any>(page, 'sled')).t, { timeout: 120_000 }).toBeGreaterThan(st0 + 45);
    await page.evaluate(() => { const w = window as any; w.__simSpeed = 1; w.__noDraw = false; w.__autoStep = null; });
    const s = await gt<any>(page, 'sled');
    // 測っている間は gameTest を読まない。駆け足のまま走るだけ
    if (s.pace < 2) { await page.locator('#b-up').tap(); }
    await page.waitForTimeout(2500);
    const perf = await measureFps(page, 3000);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い・吹雪 ${s.W.toFixed(2)})・画質の段階 ${await gt<number>(page, 'quality')}`);
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
    // 早送りで s まで進めて、ふつうの速さに戻す(自動プレイヤーはそのまま走り続ける)
    const fastTo = async (page: Page, cfg: BotCfg, s: number) => {
      await page.locator('#b-start').click();
      await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('play');
      await page.evaluate(botInstall, cfg);
      await page.evaluate(() => { (window as any).__simSpeed = 12; (window as any).__noDraw = true; });
      await expect.poll(async () => (await gt<any>(page, 'sled')).s, { timeout: 120_000, intervals: [100] }).toBeGreaterThan(s);
      await page.evaluate(() => { (window as any).__simSpeed = 1; (window as any).__noDraw = false; });
    };
    await recordScenes(browser, target!.dir, [
      // ① つかみ: 夜の湖。後ろから氷が割れて水しぶきが追ってくる中を、全力で駆けぬける
      {
        seconds: 4,
        shortSeconds: 6,
        setup: async (page) => {
          await openFor(page, { seed: 61, sound: true });
          await page.locator('#b-start').waitFor();
          const r = await page.evaluate(() => { const g = (window as any).gameTest; return { L: g.routes().LP.segStart.L, c: g.crack().start }; });
          await fastTo(page, { kind: 'think', seed: 61, b1: 'L' }, r.L + r.c - 50);
          await page.waitForTimeout(1800);
        },
        play: async (page, clip) => {
          await expect.poll(async () => (await gt<any>(page, 'crack')).on, { timeout: 15_000 }).toBeTruthy();
          clip.mark();
          await page.waitForTimeout(1200);
          if (!SHORT) await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
      // ② 基本: 夕日の森を出発。↑ で走り出し、← → で岩や倒木をよける(そりは犬の通ったあとを通る)
      {
        seconds: 10,
        shortSeconds: 13,
        setup: async (page) => {
          await openFor(page, { seed: 62, sound: true });
          await page.waitForTimeout(1500);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.waitForTimeout(700);
          await page.locator('#b-start').click();
          await page.evaluate(botInstall, { kind: 'think', seed: 62 } as BotCfg);
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
      // ③ 吹雪の峠: 杭を頼りに、村の灯へ下る
      {
        seconds: 5,
        shortSeconds: 7,
        setup: async (page) => {
          await openFor(page, { seed: 63, sound: true });
          await page.locator('#b-start').waitFor();
          const r = await page.evaluate(() => (window as any).gameTest.routes().LP);
          await fastTo(page, { kind: 'think', seed: 63, b1: 'L', b2: 'P' }, r.segStart.C - 60);
          await page.waitForTimeout(1800);
        },
        play: async (page, clip) => {
          clip.mark();
          await page.waitForTimeout(Math.max(0, clip.until - Date.now()));
        },
      },
    ]);
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(5 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    const errors = await open(page, { seed: 121 });
    await page.evaluate(() => { (window as any).__lockQ = 1; });
    await page.waitForTimeout(2500);
    await shot('1-title');
    await start(page);
    await page.evaluate(botInstall, { kind: 'think', seed: 121 } as BotCfg);
    await page.waitForTimeout(3500);
    await shot('2-start');
    const LP = (await gt<any>(page, 'routes')).LP;
    // 考える自動プレイヤーは湖→峠を行く(この種では)。道の位置は湖→峠のもの
    const spots: [string, number][] = [['3-forest', 330], ['4-fork', LP.forks[0] - 30], ['5-lake', LP.segStart.L + 160], ['6-hut', LP.hutS - 30], ['7-pass', LP.forks[1] + 260], ['8-storm', LP.forks[1] + 480], ['9-village', 99999]];
    for (const [name, s] of spots) {
      if (s < 99999) {
        await page.evaluate(() => { (window as any).__simSpeed = 12; (window as any).__noDraw = true; });
        await expect.poll(async () => { const st = await gt<any>(page, 'sled'); return st.s > s || (await gt<string>(page, 'state')) !== 'play'; }, { timeout: 120_000, intervals: [100] }).toBeTruthy();
        await page.evaluate(() => { (window as any).__simSpeed = 1; (window as any).__noDraw = false; });
        await page.waitForTimeout(1200);
      } else {
        await page.evaluate(() => { (window as any).__simSpeed = 12; (window as any).__noDraw = true; });
        await expect.poll(() => gt<string>(page, 'state'), { timeout: 120_000 }).toBe('over');
        await page.evaluate(() => { (window as any).__simSpeed = 1; (window as any).__noDraw = false; });
        await page.waitForTimeout(600);
      }
      await shot(name);
      const st = await gt<any>(page, 'sled');
      console.log(`  ${name}: ${st.seg} s${Math.round(st.s)} t${Math.round(st.t)} 体力${Math.round(st.E)} 体温${st.temp.toFixed(1)} 画質${await gt<number>(page, 'quality')}`);
    }
    expect(errors).toEqual([]);
    if (info.project.name === 'mobile') {
      for (const [w, hh, name] of [[844, 390, 'c-landscape'], [360, 640, 'd-small']] as const) {
        await page.setViewportSize({ width: w, height: hh });
        await page.goto(url());
        await page.waitForTimeout(1500);
        await shot(`${name}-title`);
        await start(page);
        await page.locator('#b-up').tap();
        await page.waitForTimeout(2500);
        await shot(`${name}-run`);
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

  test('様子見(重さの内訳)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile' || !fs.existsSync(path.join(__dirname, '..', 'peek.flag')), 'peek.flag があるときだけ');
    test.setTimeout(4 * 60_000);
    await open(page, { seed: 51 });
    await start(page);
    const st0 = await page.evaluate(() => (window as any).gameTest.stats().stormAt);
    await page.evaluate(botInstall, { kind: 'think', seed: 51 } as BotCfg);
    await page.evaluate(() => { (window as any).__simSpeed = 30; (window as any).__noDraw = true; });
    await expect.poll(async () => (await gt<any>(page, 'sled')).t, { timeout: 120_000 }).toBeGreaterThan(st0 + 45);
    await page.evaluate(() => { const w = window as any; w.__simSpeed = 1; w.__noDraw = false; w.__autoStep = null; });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const w = window as any; w.__prof = {};
      for (const n of ['render', 'updVisual', 'updHud', 'drawMap', 'packParticles', 'updLighting', 'updCam', 'pickLights', 'updAudio', 'step', 'buildDraw', 'ropeLines', 'updPool']) {
        const f = w[n]; if (typeof f !== 'function') continue;
        w[n] = function (...a: unknown[]) { const t = performance.now(); const r = f.apply(this, a); w.__prof[n] = (w.__prof[n] || 0) + performance.now() - t; return r; };
      }
    });
    const perf = await measureFps(page, 3000);
    const prof = await page.evaluate(() => (window as any).__prof);
    const frames = perf.fps * 3;
    console.log(`  fps ${perf.fps} p95 ${perf.p95}`, Object.entries(prof).map(([k, v]) => `${k} ${((v as number) / frames).toFixed(2)}ms`).join(' / '));
  });

  test('様子見', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop' || !fs.existsSync(path.join(__dirname, '..', 'peek.flag')), 'peek.flag があるときだけ');
    test.setTimeout(9 * 60_000);
    const one = async (name: string, cfg: BotCfg) => {
      const ctx = await browser.newContext();
      const p2 = await ctx.newPage();
      const e2 = await open(p2, { seed: cfg.seed });
      await start(p2);
      const bot = await runBot(p2, cfg, { timeout: 8 * 60_000 });
      const evs = (await gt<any[]>(p2, 'events')).filter((e) => e.type !== 'pace').map((e) => `${e.type}${e.kind ? ':' + e.kind : ''}${e.b ?? ''}@${Math.round(e.t)}`).join(' ');
      await ctx.close();
      const r = bot.result;
      return `${name.padEnd(14)} 点${String(r.score).padStart(4)} ${r.route} t${Math.round(r.t)} 荷${r.crates} 衝突${r.crashes} けが${r.injured} 休${Math.round(r.restT)} 魚${r.fed} 体温${Math.round(r.warmth)} 嵐${Math.round(r.stormAt)} ${r.cause}\n      ${evs}${e2.length ? '\n  ERR ' + e2.join(' ') : ''}`;
    };
    const jobs: [string, BotCfg][] = [];
    for (const seed of [5, 6, 7]) {
      jobs.push([`think${seed}`, { kind: 'think', seed }], [`casual${seed}`, { kind: 'casual', seed }], [`casualSV${seed}`, { kind: 'casual', seed, b1: 'S', b2: 'V' }], [`steady${seed}`, { kind: 'steady', seed }]);
    }
    const out: string[] = [];
    for (let i = 0; i < jobs.length; i += 6) out.push(...(await Promise.all(jobs.slice(i, i + 6).map(([n, c]) => one(n, c)))));
    console.log(out.join('\n'));
  });
});
