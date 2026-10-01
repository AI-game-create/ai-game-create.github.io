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
//  対象: おちばはき日記(2026-10-02)
//  ゲーム側の window.gameTest(読み取り専用)から状態を読む。
//  操作はすべて画面の上で行う(絵をなぞって ほうきで はく、ボタンを押す)。
// ============================================================================

const EXPECTED = '2026-10-02-ochiba-nikki';
const target = latestGame();
const SKEY = 'ochiba-nikki-v1';

type Leaf = { x: number; y: number; wx: number; wy: number; z: number; inPile: boolean; wet: boolean; speed: number };
type Pile = { x: number; y: number; r: number };
type World = { x: number; y: number; w: number; h: number; W: number; H: number };
type Cat = { x: number; y: number; mode: string; appeared: number; dove: number; shooed: number } | null;
type Result = { day: number; score: number; quota: number; total: number; stars: number; clear: boolean; yakiimo: number; bestBurst: number };

const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------------------
//  手(マウスとタッチを同じ形で扱う)。stroke は「押して、なぞって、離す」
// ---------------------------------------------------------------------------
type Pt = { x: number; y: number };
type Hand = {
  touch: boolean;
  tap: (x: number, y: number) => Promise<void>;
  // 人の手の速さ(px/秒)で、点から点へなぞる。onStep は数コマごとに呼ばれる
  stroke: (a: Pt, b: Pt, speed: number, onStep?: () => Promise<void>) => Promise<void>;
};
function mouseHand(page: Page): Hand {
  return {
    touch: false,
    tap: async (x, y) => { await page.mouse.click(x, y); await page.waitForTimeout(120); },
    stroke: async (a, b, speed, onStep) => {
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.waitForTimeout(30);
      const len = dist(a, b), n = Math.max(2, Math.ceil(len / (speed * 0.016)));
      for (let i = 1; i <= n; i++) {
        await page.mouse.move(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
        await page.waitForTimeout(16);
        if (onStep && i % 4 === 0) await onStep();
      }
      await page.waitForTimeout(60);
      await page.mouse.up();
    },
  };
}
function touchHand(page: Page, cdp: CDPSession): Hand {
  const send = (type: string, p?: Pt) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] } as any);
  return {
    touch: true,
    tap: async (x, y) => { await send('touchStart', { x, y }); await page.waitForTimeout(60); await send('touchEnd'); await page.waitForTimeout(150); },
    stroke: async (a, b, speed, onStep) => {
      await send('touchStart', a);
      await page.waitForTimeout(30);
      const len = dist(a, b), n = Math.max(2, Math.ceil(len / (speed * 0.016)));
      for (let i = 1; i <= n; i++) {
        await send('touchMove', { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
        await page.waitForTimeout(16);
        if (onStep && i % 4 === 0) await onStep();
      }
      await page.waitForTimeout(60);
      await send('touchEnd');
    },
  };
}
const isMobile = (page: Page) => page.viewportSize()!.width < 500;
async function handOf(page: Page): Promise<Hand> {
  return isMobile(page) ? touchHand(page, await page.context().newCDPSession(page)) : mouseHand(page);
}

// ---------------------------------------------------------------------------
//  ゲームの開き方
// ---------------------------------------------------------------------------
async function openCover(page: Page, clearedUpTo = 0, sound = false) {
  await page.goto(url());
  const stars: Record<number, number> = {};
  for (let i = 1; i <= clearedUpTo; i++) stars[i] = 1;
  await page.evaluate(([k, s, snd]) => localStorage.setItem(k as string, JSON.stringify({ best: {}, stars: s, sound: snd, seen: true })), [SKEY, stars, sound] as const);
  await page.reload();
  await expect.poll(() => gt<string>(page, 'state')).toBe('title');
}
async function openDay(page: Page, n: number, opts: { cleared?: number; sound?: boolean } = {}) {
  await openCover(page, opts.cleared ?? n - 1, opts.sound ?? false);
  await page.locator(`.day[data-n="${n}"]`).click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('intro');
  expect(await gt<number>(page, 'day')).toBe(n);
}
async function startDay(page: Page) {
  await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
}

// ---------------------------------------------------------------------------
//  自動プレイヤー: 人と同じく「落ち葉のかたまりのうしろから、山へ向かってなぞる」をくり返す
// ---------------------------------------------------------------------------
// human: 人らしく、なぞる前に一呼吸おき(見て決める時間)、ねらいが少しずれる
type AutoOpt = { speed?: number; onStep?: () => Promise<void>; stopWhen?: () => Promise<boolean>; shoo?: boolean; human?: boolean };
let seed = 7;
const jitter = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
async function autoplay(page: Page, hand: Hand, opt: AutoOpt = {}) {
  const speed = opt.speed ?? 650;
  let strokes = 0;
  while (true) {
    if (opt.human && strokes > 0) await page.waitForTimeout(450);
    if ((await gt<string>(page, 'state')) !== 'play') break;
    if (opt.stopWhen && (await opt.stopWhen())) break;
    const [leaves, P, Wd, cat] = await Promise.all([
      gt<Leaf[]>(page, 'leaves'), gt<Pile>(page, 'pile'), gt<World>(page, 'world'), gt<Cat>(page, 'cat'),
    ]);
    const inset = (p: Pt) => ({ x: Math.min(Math.max(p.x, Wd.x + 6), Wd.x + Wd.w - 6), y: Math.min(Math.max(p.y, Wd.y + 6), Wd.y + Wd.h - 6) });
    const S = await gt<number>(page, 'scale');
    // ねこが山に近づいていたら、先においはらう
    if (opt.shoo !== false && cat && (cat.mode === 'eye' || (cat.mode === 'walk' && dist(cat, P) < P.r + 160 * S))) {
      const ux = (cat.x - P.x) / (dist(cat, P) || 1), uy = (cat.y - P.y) / (dist(cat, P) || 1);
      // 山から見てねこの向こう側を、ねこを横切るようになぞる
      const a = inset({ x: cat.x - uy * 70 * S, y: cat.y + ux * 70 * S });
      const b = inset({ x: cat.x + uy * 70 * S, y: cat.y - ux * 70 * S });
      await hand.stroke(a, b, speed, opt.onStep);
      strokes++;
      continue;
    }
    const loose = leaves.filter((l) => !l.inPile && l.z < 2);
    if (!loose.length) { await page.waitForTimeout(150); continue; }
    // かたまりの大きさと、山までの近さで選ぶ
    let best = loose[0], bs = -1e9;
    for (const l of loose) {
      let c = 0;
      for (const m of loose) if (Math.abs(m.x - l.x) < 45 * S && Math.abs(m.y - l.y) < 45 * S) c++;
      const s = c - dist(l, P) / (160 * S);
      if (s > bs) { bs = s; best = l; }
    }
    const d = dist(best, P) || 1;
    const ux = (best.x - P.x) / d, uy = (best.y - P.y) / d;
    const e = opt.human ? 36 * S : 0;
    const a = inset({ x: best.x + ux * 32 * S + jitter() * e, y: best.y + uy * 32 * S + jitter() * e });
    const b = { x: P.x + ux * P.r * 0.15 + jitter() * e, y: P.y + uy * P.r * 0.15 + jitter() * e };
    // ぬれた葉が道にあれば、ゆっくりはく
    const wetOnPath = loose.some((l) => l.wet && dist(l, best) < 60 * S);
    await hand.stroke(a, b, wetOnPath ? 260 : speed, opt.onStep);
    // 指を離したあとも葉はすべって山に入るので、もう一度見る
    if (opt.onStep) { await page.waitForTimeout(120); await opt.onStep(); }
    strokes++;
  }
  return strokes;
}
// 1日を最後まで自動で遊び、結果を返す
async function playDay(page: Page, hand: Hand, opt: AutoOpt = {}) {
  const t0 = Date.now();
  const strokes = await autoplay(page, hand, opt);
  await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('result');
  const r = (await gt<Result>(page, 'result'))!;
  return { ...r, secs: (Date.now() - t0) / 1000, strokes };
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
      return !!g && ['state', 'day', 'score', 'timeLeft', 'quota', 'total', 'scale', 'leaves', 'pile', 'world', 'broom', 'cat', 'wind',
        'puddles', 'bushes', 'burst', 'bestBurst', 'result', 'progress', 'days', 'quality', 'sound'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(3 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    await openCover(page, 0);
    await shot('1-title');
    await page.locator('.day[data-n="1"]').click();
    await page.waitForTimeout(1500);
    await shot('2-intro');
    await startDay(page);
    await page.waitForTimeout(1200);
    await shot('3-start');
    const hand = await handOf(page);
    let n = 0;
    await autoplay(page, hand, { stopWhen: async () => ++n > 6 });
    await shot('4-playing');
    await openDay(page, 7, { cleared: 7 });
    await startDay(page);
    const hand2 = await handOf(page);
    let m = 0;
    await autoplay(page, hand2, { stopWhen: async () => (await gt<string>(page, 'wind').then((w: any) => w.phase === 'blow')) || ++m > 30 });
    await page.waitForTimeout(500);
    await shot('5-busy');
    await autoplay(page, hand2);
    await page.waitForTimeout(1600);
    await shot('6-end');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('result');
    await page.waitForTimeout(2000);
    await shot('7-result');
  });

  // 核の遊び: 人がふつうに操作する大きさ・速さで1回なぞると、なぞった道すじの落ち葉が山に入る
  test('人の手の速さでひとなぞりすると、ほうきの幅の落ち葉が山に入る', async ({ page }) => {
    await openDay(page, 1);
    await startDay(page);
    const hand = await handOf(page);
    const S = await gt<number>(page, 'scale');
    const hw = (await gt<{ hw: number }>(page, 'broom')).hw;
    let tried = 0, got = 0, expected = 0;
    for (let round = 0; round < 3; round++) {
      const [leaves, P] = await Promise.all([gt<Leaf[]>(page, 'leaves'), gt<Pile>(page, 'pile')]);
      // 山から遠すぎない、かたまりのある葉をえらぶ
      const loose = leaves.map((l, i) => ({ ...l, i })).filter((l) => !l.inPile && l.z === 0);
      loose.sort((a, b) => dist(a, P) - dist(b, P));
      const pick = loose.find((l) => dist(l, P) > P.r + 40 * S && loose.filter((m) => dist(m, l) < 40 * S).length >= 2) ?? loose[0];
      const d = dist(pick, P);
      const ux = (pick.x - P.x) / d, uy = (pick.y - P.y) / d;
      const a = { x: pick.x + ux * 30 * S, y: pick.y + uy * 30 * S };
      const b = { x: P.x + ux * P.r * 0.1, y: P.y + uy * P.r * 0.1 };
      // なぞる道すじ(ほうきの幅の真ん中6割)にある葉
      const len = dist(a, b);
      const onPath = loose.filter((l) => {
        const rx = l.x - a.x, ry = l.y - a.y;
        const along = (rx * -ux + ry * -uy), lat = Math.abs(rx * -uy - ry * -ux);
        return along > 0 && along < len - P.r && lat < hw * 0.6;
      });
      if (round === 0) expect(await gt<number>(page, 'score'), 'はく前から山に葉があります').toBe(0);
      await hand.stroke(a, b, 600);
      await page.waitForTimeout(800);
      const after = await gt<Leaf[]>(page, 'leaves');
      const inNow = onPath.filter((l) => after[l.i].inPile).length;
      tried++; expected += onPath.length; got = await gt<number>(page, 'score');
      console.log(`  ${round + 1}回目: 道すじの葉 ${onPath.length}まい → 山に入ったのは ${inNow}まい(山の数 ${got})`);
      expect(onPath.length, '道すじに葉がありません(テストの選び方がまずい)').toBeGreaterThan(0);
      expect(inNow, 'なぞった道すじの葉が、山に入りません').toBeGreaterThanOrEqual(Math.ceil(onPath.length * 0.8));
    }
    expect(got, '3回なぞっても山の数が増えません').toBeGreaterThanOrEqual(expected * 0.8);
    // 山の上のふきだしと、マス目の「あつめた」が、本当の数と合っている
    const txt = (await page.locator('#txt').innerText()).replace(/\s/g, '');
    const zen = String(got).replace(/[0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expect(txt, 'マス目の「あつめた」が、山の数と合っていません').toContain(`あつめた${zen}まい`);
  });

  test('1日目: 何もしないと「もういちど」になり、はけば つぎの日がひらく(記録は再読み込みしても残る)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', '長いので desktop で確かめる');
    test.setTimeout(4 * 60_000);
    await openDay(page, 1, { cleared: 0 });
    // 2日目はまだ選べない
    await page.locator('#b-close').click();
    await expect(page.locator('.day[data-n="2"]')).toBeDisabled();
    await page.locator('.day[data-n="1"]').click();
    // 絵にさわるだけで始まる(はじめるボタンを探さなくてよい)
    const Wd = await gt<World>(page, 'world');
    await page.mouse.click(Wd.x + 20, Wd.y + Wd.h - 20);
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 60_000 }).toBe('result');
    let r = (await gt<Result>(page, 'result'))!;
    expect(r.clear, '何もしないのにクリアになりました').toBeFalsy();
    await expect(page.locator('#b-next'), '目標に届かないのに「つぎの日へ」が出ています').toHaveCount(0);
    await expect(page.locator('#teacher')).toContainText('もういちど');
    await page.locator('#b-retry').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('intro');
    await page.keyboard.press('Enter');
    await expect.poll(() => gt<string>(page, 'state'), { message: 'Enter で始まりません' }).toBe('play');
    const p = await playDay(page, mouseHand(page));
    console.log(`  1日目(マウス): ${p.score}/${p.total}まい(めあて${p.quota})・${p.strokes}回なぞった・最大${p.bestBurst}まい連続・${p.secs.toFixed(1)}秒`);
    r = (await gt<Result>(page, 'result'))!;
    expect(r.clear).toBeTruthy();
    expect(r.yakiimo, 'やきいもの数が、集めた葉と合っていません').toBe(Math.floor(r.score / 8));
    await expect(page.locator('#teacher')).toBeVisible();
    // 再読み込みしても、はなまると次の日が残っている
    await page.reload();
    await expect.poll(() => gt<string>(page, 'state')).toBe('title');
    expect((await gt<{ stars: Record<string, number> }>(page, 'progress')).stars['1'], '記録が保存されていません').toBeGreaterThan(0);
    await expect(page.locator('.day[data-n="1"] .mk')).toContainText('◎');
    await expect(page.locator('.day[data-n="2"]')).toBeEnabled();
    await page.locator('.day[data-n="2"]').click();
    expect(await gt<number>(page, 'day')).toBe(2);
  });

  test('風: 予告のあとで ふき、山の外の葉は流され、山の中の葉は ほとんど動かない', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で確かめる');
    test.setTimeout(2 * 60_000);
    await openDay(page, 3);
    await startDay(page);
    const hand = mouseHand(page);
    // 予告(ひゅう…)が出るまでは、ふつうに山へ集めておく
    await autoplay(page, hand, { stopWhen: async () => (await gt<{ phase: string }>(page, 'wind')).phase !== 'idle' });
    await expect.poll(async () => (await gt<{ phase: string }>(page, 'wind')).phase, { timeout: 10_000 }).toBe('warn');
    await expect.poll(async () => (await gt<{ phase: string }>(page, 'wind')).phase, { timeout: 3000, message: '予告のあとで風がふきません' }).toBe('blow');
    const w = await gt<{ dx: number; dy: number }>(page, 'wind');
    const before = await gt<Leaf[]>(page, 'leaves');
    await expect.poll(async () => (await gt<{ phase: string }>(page, 'wind')).phase, { timeout: 4000 }).toBe('idle');
    await page.waitForTimeout(500);
    const after = await gt<Leaf[]>(page, 'leaves');
    const S = await gt<number>(page, 'scale');
    const moved = (l: Leaf, i: number) => ((after[i].wx - l.wx) * w.dx + (after[i].wy - l.wy) * w.dy);
    const out = before.map((l, i) => ({ l, i })).filter(({ l }) => !l.inPile && l.z === 0 && !l.wet);
    const inn = before.map((l, i) => ({ l, i })).filter(({ l }) => l.inPile);
    const avgOut = out.reduce((s, { l, i }) => s + moved(l, i), 0) / out.length;
    const avgIn = inn.length ? inn.reduce((s, { l, i }) => s + Math.hypot(after[i].wx - l.wx, after[i].wy - l.wy), 0) / inn.length : 0;
    console.log(`  風で流れた距離: 山の外 平均${avgOut.toFixed(0)} / 山の中 平均${avgIn.toFixed(0)}(にわの単位。山の中 ${inn.length}まい)`);
    expect(avgOut, '風がふいても、葉が風下へ流れません').toBeGreaterThan(30);
    expect(inn.length, '風の前に山に葉が入っていません').toBeGreaterThan(5);
    expect(avgIn, '山の中の葉まで風で流されています').toBeLessThan(avgOut * 0.35);
    void S;
  });

  test('ねこ: ほうっておくと山にとびこんで、山の葉が散らばる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で確かめる');
    test.setTimeout(2 * 60_000);
    await openDay(page, 4);
    await startDay(page);
    const hand = mouseHand(page);
    // 山ができて、ねこが来たら、はくのをやめて見ている(うっかり なでて追いはらわないように)
    await autoplay(page, hand, {
      shoo: false,
      stopWhen: async () => {
        const c = (await gt<Cat>(page, 'cat'))!;
        return (c.mode === 'walk' || c.mode === 'eye') && (await gt<number>(page, 'score')) >= 10;
      },
    });
    await expect.poll(async () => (await gt<Cat>(page, 'cat'))!.mode, { timeout: 10_000, message: 'ねこが山の前で止まりません' }).toBe('eye');
    const beforeDive = await gt<number>(page, 'score');
    expect(beforeDive, 'ねこが来る前に山ができていません').toBeGreaterThanOrEqual(10);
    await expect.poll(async () => (await gt<Cat>(page, 'cat'))!.dove, { timeout: 4000, message: 'ねこが山にとびこみません' }).toBe(1);
    await page.waitForTimeout(700);
    const afterDive = await gt<number>(page, 'score');
    console.log(`  ねこがとびこむ前 ${beforeDive}まい → あと ${afterDive}まい`);
    expect(afterDive, 'ねこがとびこんでも、山がくずれません').toBeLessThanOrEqual(beforeDive * 0.5);
  });

  test('ねこ: 近づいてくる所を ほうきで なでると にげて、また あとで来る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で確かめる');
    test.setTimeout(90_000);
    await openDay(page, 4);
    await startDay(page);
    const hand = mouseHand(page);
    // ねこが にわに入ってくるのを待つ(はかずに待つ)
    await expect.poll(async () => {
      const k = (await gt<Cat>(page, 'cat'))!, Wd = await gt<World>(page, 'world');
      return k.mode === 'walk' && k.x > Wd.x + 30 && k.x < Wd.x + Wd.w - 30 && k.y > Wd.y + 30 && k.y < Wd.y + Wd.h - 30;
    }, { timeout: 20_000, message: 'ねこが来ません' }).toBeTruthy();
    const k = (await gt<Cat>(page, 'cat'))!;
    const S = await gt<number>(page, 'scale');
    // にわの外(絵の外)から押しても はけないので、なぞる点は にわの中にとる
    const Wd = await gt<World>(page, 'world');
    const inside = (p: Pt) => ({ x: Math.min(Math.max(p.x, Wd.x + 8), Wd.x + Wd.w - 8), y: Math.min(Math.max(p.y, Wd.y + 8), Wd.y + Wd.h - 8) });
    const sy = k.y - Wd.y < Wd.h / 2 ? 1 : -1; // ねこが上のほうにいれば下へ、下のほうにいれば上へ なぞる
    await hand.stroke(inside({ x: k.x - 60 * S, y: k.y - 50 * S * sy }), inside({ x: k.x + 60 * S, y: k.y + 50 * S * sy }), 700);
    await expect.poll(async () => (await gt<Cat>(page, 'cat'))!.shooed, { message: 'ほうきで なでても、ねこが にげません' }).toBe(1);
    expect((await gt<Cat>(page, 'cat'))!.mode).toBe('flee');
    // にげたねこは にわの外へ出て、しばらくすると また来る(とびこまずに)
    await expect.poll(async () => (await gt<Cat>(page, 'cat'))!.mode, { timeout: 5000 }).toBe('off');
    expect((await gt<Cat>(page, 'cat'))!.dove, 'にげたはずのねこが、とびこみました').toBe(0);
    await expect.poll(async () => (await gt<Cat>(page, 'cat'))!.appeared, { timeout: 15_000, message: 'にげたねこが二度と来ません' }).toBe(2);
  });

  test('水たまり: ぬれた葉は、速くはくと すべって動かず、ゆっくりはくと動く', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で確かめる');
    await openDay(page, 5);
    await startDay(page);
    const hand = mouseHand(page);
    const S = await gt<number>(page, 'scale');
    const P = await gt<Pile>(page, 'pile');
    const leaves = await gt<Leaf[]>(page, 'leaves');
    const i = leaves.findIndex((l) => l.wet && l.z === 0);
    expect(i, '水たまりに ぬれた葉がありません').toBeGreaterThanOrEqual(0);
    const L = leaves[i];
    const d = dist(L, P), ux = (P.x - L.x) / d, uy = (P.y - L.y) / d;
    const a = { x: L.x - ux * 40 * S, y: L.y - uy * 40 * S }, b = { x: L.x + ux * 90 * S, y: L.y + uy * 90 * S };
    await hand.stroke(a, b, 1400);
    await page.waitForTimeout(400);
    const fast = (await gt<Leaf[]>(page, 'leaves'))[i];
    const fastMove = Math.hypot(fast.x - L.x, fast.y - L.y);
    await hand.stroke(a, b, 220);
    await page.waitForTimeout(400);
    const slow = (await gt<Leaf[]>(page, 'leaves'))[i];
    const slowMove = Math.hypot(slow.x - fast.x, slow.y - fast.y);
    console.log(`  ぬれた葉: 速くはく ${fastMove.toFixed(0)}px / ゆっくりはく ${slowMove.toFixed(0)}px`);
    expect(fastMove, '速くはいても、ぬれた葉が動きました').toBeLessThan(10 * S);
    expect(slowMove, 'ゆっくりはいても、ぬれた葉が動きません').toBeGreaterThan(60 * S);
  });

  test('キーボードだけで、ほうきを動かして山に集められる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーボードは desktop で確かめる');
    test.setTimeout(90_000);
    await openDay(page, 1);
    await page.keyboard.press('Enter');
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    const S = await gt<number>(page, 'scale');
    const speed = 360 * S; // 画面の上での速さ(px/秒)
    // 8方向のキーで、点から点へ(押しっぱなしの長さで距離を決める)
    const go = async (to: Pt, lift = false) => {
      if (lift) await page.keyboard.down('Space');
      for (let k = 0; k < 3; k++) {
        const B = await gt<{ x: number; y: number }>(page, 'broom');
        const dx = to.x - B.x, dy = to.y - B.y, d = Math.hypot(dx, dy);
        if (d < 12 * S) break;
        const ks: string[] = [];
        if (dx > d * 0.38) ks.push('ArrowRight'); else if (dx < -d * 0.38) ks.push('ArrowLeft');
        if (dy > d * 0.38) ks.push('ArrowDown'); else if (dy < -d * 0.38) ks.push('ArrowUp');
        for (const key of ks) await page.keyboard.down(key);
        await page.waitForTimeout(Math.min(2500, (d / speed) * 1000 * (ks.length === 2 ? Math.max(Math.abs(dx), Math.abs(dy)) / d * Math.SQRT2 : 1)));
        for (const key of ks) await page.keyboard.up(key);
      }
      if (lift) await page.keyboard.up('Space');
    };
    const B0 = await gt<{ x: number; y: number; down: boolean }>(page, 'broom');
    for (let n = 0; n < 6; n++) {
      const [leaves, P] = await Promise.all([gt<Leaf[]>(page, 'leaves'), gt<Pile>(page, 'pile')]);
      const loose = leaves.filter((l) => !l.inPile && l.z === 0).sort((a, b) => dist(a, P) - dist(b, P));
      if (!loose.length) break;
      const L = loose[0];
      const d = dist(L, P), ux = (L.x - P.x) / d, uy = (L.y - P.y) / d;
      // スペースで ほうきを上げて葉のうしろへ回りこみ、下ろして山へ押す
      const behind = { x: L.x + ux * 40 * S, y: L.y + uy * 40 * S };
      await go(behind, true);
      const B = await gt<Pt>(page, 'broom');
      await go(P);
      expect(dist(B, behind), 'スペースを押しながら矢印キーで、ほうきを動かせません').toBeLessThan(30 * S);
      if (n === 0) await expect.poll(async () => (await gt<{ down: boolean }>(page, 'broom')).down, { message: 'キーを離しても ほうきが下りたままです' }).toBeFalsy();
    }
    const B1 = await gt<{ x: number; y: number }>(page, 'broom');
    expect(dist(B0, B1), '矢印キーで ほうきが動きません').toBeGreaterThan(20);
    const got = await gt<number>(page, 'score');
    console.log(`  キーボードで集めた葉: ${got}まい`);
    expect(got, 'キーボードで山に集められません').toBeGreaterThanOrEqual(5);
  });

  test('スマホの指で1日目を遊びきれて、画面に収まり、指で押せる大きさがある', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    test.setTimeout(3 * 60_000);
    await openCover(page, 7);
    const vp = page.viewportSize()!;
    const inside = (b: { x: number; y: number; width: number; height: number } | null) =>
      !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width + 0.5 && b.y + b.height <= vp.height + 0.5;
    // 表紙: 日づけのシールが画面に収まり、指で押せる大きさ
    for (const n of [1, 9]) {
      const b = await page.locator(`.day[data-n="${n}"]`).boundingBox();
      expect(inside(b), `表紙の ${n}番目のシールが画面からはみ出しています`).toBeTruthy();
      expect(Math.min(b!.width, b!.height), `表紙の ${n}番目のシールが小さすぎます`).toBeGreaterThanOrEqual(44);
    }
    await page.locator('.day[data-n="8"]').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('intro');
    // 一番長い日の文が、マス目からはみ出さない
    await page.waitForTimeout(2500);
    const masu = (await page.locator('#masu').boundingBox())!;
    const spans = await page.locator('#txt span').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
    for (const s of spans) expect(s.y + s.h <= masu.y + masu.height + 1 && s.x + s.w <= masu.x + masu.width + 1, 'マス目から文字がはみ出しています').toBeTruthy();
    for (const id of ['#b-start', '#b-close', '#snd']) {
      const b = await page.locator(id).boundingBox();
      expect(inside(b), `${id} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(b!.width, b!.height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    }
    // 絵(にわ)が全部見えていて、葉は指で見分けられる大きさ
    const Wd = await gt<World>(page, 'world');
    expect(Wd.x >= 0 && Wd.y >= 0 && Wd.x + Wd.w <= vp.width && Wd.y + Wd.h <= vp.height, 'にわが画面からはみ出しています').toBeTruthy();
    expect(Wd.h, 'スマホで にわが小さすぎます').toBeGreaterThan(vp.height * 0.5);
    const S = await gt<number>(page, 'scale');
    expect(20 * S, '葉が小さすぎて見えません').toBeGreaterThanOrEqual(13);
    // 指で1日目を遊ぶ
    await page.goto(url());
    await openDay(page, 1);
    const hand = await handOf(page);
    await hand.tap(Wd.x + 20, Wd.y + Wd.h - 20);
    await expect.poll(() => gt<string>(page, 'state'), { message: '絵にさわっても始まりません' }).toBe('play');
    const r = await playDay(page, hand);
    console.log(`  スマホで1日目: ${r.score}/${r.total}まい(めあて${r.quota})・${r.strokes}回なぞった・${r.secs.toFixed(1)}秒`);
    expect(r.clear, 'スマホの指で1日目がクリアできません').toBeTruthy();
    await page.waitForTimeout(1200);
    for (const id of ['#b-next', '#b-retry', '#b-close']) {
      const b = await page.locator(id).boundingBox();
      expect(inside(b), `${id} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(b!.width, b!.height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    }
    await page.locator('#b-next').tap();
    await expect.poll(() => gt<number>(page, 'day')).toBe(2);
  });

  // 人より少しだけ雑な手(なぞる前に一呼吸おき、ねらいが少しずれる)でも、毎日の めあてに届くか
  for (const [from, to] of [[1, 4], [5, 8]]) {
    test(`むずかしさ: ${from}〜${to}日目を自動で遊んで、めあてに届く`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'desktop で測る');
      test.setTimeout(6 * 60_000);
      const log: string[] = [];
      // 音をオンにして遊ぶ(音の処理の失敗でゲームが止まる不具合を見のがさない)
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      for (let n = from; n <= to; n++) {
        await openDay(page, n, { sound: true });
        // その日に出るはずの水たまり・うえこみの数(5日目: 水たまり3 / 6日目: うえこみ3 / 8日目: 水たまり2・うえこみ2)
        const want: Record<number, [number, number]> = { 5: [3, 0], 6: [0, 3], 8: [2, 2] };
        const [wp, wb] = want[n] ?? [0, 0];
        expect((await gt<unknown[]>(page, 'puddles')).length, `${n}日目の水たまりの数が違います`).toBe(wp);
        expect((await gt<unknown[]>(page, 'bushes')).length, `${n}日目のうえこみの数が違います`).toBe(wb);
        await startDay(page);
        const hand = mouseHand(page);
        let shot = false;
        const r = await playDay(page, hand, {
          speed: 750,
          human: true,
          onStep: async () => {
            // 投稿画像: さいごの日に、いっきに10まい以上 山に入った瞬間
            if (shot || n !== 8) return;
            if ((await gt<number>(page, 'burst')) >= 10) {
              shot = true;
              await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
              console.log('  見せ場のスクショを撮りました(いっきに10まい以上)');
            }
          },
        });
        const bushes = await gt<{ x: number; y: number; r: number }[]>(page, 'bushes');
        const leaves = await gt<Leaf[]>(page, 'leaves');
        for (const b of bushes) for (const l of leaves) if (l.z < 1) expect(dist(l, b), 'うえこみの中に葉が入りこんでいます').toBeGreaterThan(b.r - 3);
        log.push(`${n}日目 ${r.score}/${r.total}=${Math.round((r.score / r.total) * 100)}%(めあて${r.quota}) 最大${r.bestBurst}連続 ${r.strokes}回 ${r.secs.toFixed(0)}秒`);
        expect(r.score, `${n}日目: 自動で遊んでも めあてに届きません`).toBeGreaterThanOrEqual(r.quota);
        expect(errors, `${n}日目: 遊んでいる間にエラーが出ました`).toEqual([]);
      }
      console.log(`  ${log.join(' / ')}`);
    });
  }

  test('スマホで重くない(CPU 4倍遅くても、風の中ではいている間 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(2 * 60_000);
    await openDay(page, 8);
    await startDay(page);
    const hand = await handOf(page);
    // 風が来るまで集めて、葉が山に積もって舞っている、一番にぎやかな場面にする
    await autoplay(page, hand, { stopWhen: async () => (await gt<{ phase: string }>(page, 'wind')).phase === 'warn' });
    const [P, Wd] = await Promise.all([gt<Pile>(page, 'pile'), gt<World>(page, 'world')]);
    // 測っているあいだは gameTest を読まない。座標は先に読んでおき、指でなぞり続ける
    const pts = [0, 1, 2, 3].map((k) => ({ x: Wd.x + Wd.w * (0.15 + 0.7 * (k % 2)), y: Wd.y + Wd.h * (0.2 + 0.6 * Math.floor(k / 2)) }));
    const busy = (async () => {
      const end = Date.now() + 3300;
      let k = 0;
      while (Date.now() < end) { await hand.stroke(pts[k++ % 4], P, 900); }
    })();
    const [perf] = await Promise.all([measureFps(page, 3000), busy]);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・演出の段階 ${await gt<number>(page, 'quality')}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(3 * 60_000);
    // さいごの日(葉がいちばん多い)。いっきに10まい以上 山に入る瞬間から始める
    await recordPlayVideo(browser, {
      dir: target!.dir,
      focus: '#pic',
      setup: async (page) => {
        await openDay(page, 8, { sound: true }); // 動画には音を入れるので、音はオンで始める
        await startDay(page);
      },
      play: async (page, clip: Clip) => {
        const hand = mouseHand(page);
        let marked = false;
        const strokes = await autoplay(page, hand, {
          speed: 750,
          onStep: async () => {
            if (!marked && (await gt<number>(page, 'burst')) >= 10) { marked = true; clip.mark(); }
          },
          stopWhen: async () => Date.now() > clip.until,
        });
        console.log(`  動画の日: ${strokes}回なぞった・最大${await gt<number>(page, 'bestBurst')}まい連続・山${await gt<number>(page, 'score')}まい`);
      },
    });
  });
});
