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
//  対象: なきまね虫の合唱団(2026-10-04。もとは10-03の土曜枠で作り、3Dの大作に枠をゆずった)
//  ボクのお手本(上の段)のすぐあとに、同じリズムで同じ虫を鳴かせる(下の段)リズムゲーム。
//  ゲーム側の window.gameTest(読み取り専用)から、お手本の時刻と判定を読む。
//  操作はすべて本物の入力で行う(キー / マウス / 指)。
// ============================================================================

const EXPECTED = '2026-10-04-nakimane-chorus';
const target = latestGame();
const SKEY = 'nakimane-chorus-v1';

type Note = { t: number; l: number; b: number; ph: number; j: string | null; dt: number };
type Phrase = { i: number; beats: number; bd: number; bpm: number; callT: number; respT: number; endT: number; preview: boolean; hits: number; total: number };
type Pad = { x: number; y: number; r: number; w: number };
type Result = { night: number; endless: boolean; pct: number; rank: string | null; perfect: number; good: number; miss: number; stray: number; maxCombo: number; cleared: number; sung: number; dawn: boolean; clear: boolean; celebrations: number; notes: number };

const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const HIT = (j: string | null) => j === 'perfect' || j === 'good';
const keyOf = (n: Note) => `${n.ph}:${n.b}:${n.l}`;

// ---------------------------------------------------------------------------
//  手: キー / マウス / 指。press(lane) で その虫を1回鳴かせる
// ---------------------------------------------------------------------------
type Hand = { name: string; press: (lane: number) => Promise<void> };
const LANE_KEYS: Record<number, string[]> = { 1: ['Space'], 2: ['f', 'j'], 3: ['d', 'f', 'j'], 4: ['d', 'f', 'j', 'k'] };
const ARROW_KEYS: Record<number, string[]> = { 1: ['ArrowUp'], 2: ['ArrowLeft', 'ArrowRight'], 3: ['ArrowLeft', 'ArrowDown', 'ArrowRight'], 4: ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'] };
async function keyHand(page: Page, arrows = false): Promise<Hand> {
  const n = await gt<number>(page, 'lanes');
  const keys = (arrows ? ARROW_KEYS : LANE_KEYS)[n];
  return { name: arrows ? '矢印キー' : 'キー', press: async (l) => { await page.keyboard.press(keys[l]); } };
}
async function mouseHand(page: Page): Promise<Hand> {
  const pads = await gt<Pad[]>(page, 'pads');
  return { name: 'マウス', press: async (l) => { await page.mouse.click(pads[l].x, pads[l].y); } };
}
async function touchHand(page: Page, cdp?: CDPSession): Promise<Hand> {
  const c = cdp ?? (await page.context().newCDPSession(page));
  const pads = await gt<Pad[]>(page, 'pads');
  return {
    name: '指',
    press: async (l) => {
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pads[l].x, y: pads[l].y }] } as any);
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any);
    },
  };
}
const isMobile = (page: Page) => page.viewportSize()!.width < 500;
async function deviceHand(page: Page) { return isMobile(page) ? touchHand(page) : mouseHand(page); }

// ---------------------------------------------------------------------------
//  ゲームの開き方
// ---------------------------------------------------------------------------
async function openTitle(page: Page, cleared = 0, sound = false, extra: Record<string, unknown> = {}) {
  await page.goto(url());
  const best: Record<number, number> = {};
  for (let i = 1; i <= cleared; i++) best[i] = 70;
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), [SKEY, { best, sound, calib: 0, ...extra }] as const);
  await page.reload();
  await expect.poll(() => gt<string>(page, 'state')).toBe('title');
}
async function openNight(page: Page, n: number, opts: { cleared?: number; sound?: boolean } = {}) {
  await openTitle(page, opts.cleared ?? n - 1, opts.sound ?? false);
  await page.locator(`.tk[data-n="${n}"]`).click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('intro');
  expect(await gt<number>(page, 'night')).toBe(n);
}
async function start(page: Page) {
  await page.locator('#b-start').click();
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
}

// ---------------------------------------------------------------------------
//  自動プレイヤー: つぎの「きみの番」の音の時刻をよみ、その時刻にあわせて押す
//   offset: わざとずらす量(秒) / jitter: 人の手のゆらぎ(秒・標準偏差) / skip: 押しわすれる割合
//   laneOf: 押す虫を変える(ちがう虫を押すテスト用)
// ---------------------------------------------------------------------------
let seed = 12345;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 0.7071; }; // おおよそ標準偏差1
type AutoOpt = {
  offset?: number | ((n: Note) => number); jitter?: number; skip?: number; laneOf?: (n: Note) => number;
  stopWhen?: (n: Note | null) => boolean | Promise<boolean>; onPress?: (n: Note, aimed: number) => Promise<void>;
  onTick?: () => Promise<void>; // 0.15秒おきくらいに呼ばれる(見せ場を見つける用)
};
async function autoplay(page: Page, hand: Hand, opt: AutoOpt = {}) {
  const done = new Set<string>();
  let presses = 0;
  while (true) {
    const t1 = Date.now();
    const snap = await page.evaluate(() => {
      const g = (window as any).gameTest;
      return { s: g.state() as string, now: g.songTime() as number, resp: g.resp() as Note[] };
    });
    const mid = (t1 + Date.now()) / 2;
    if (snap.s !== 'play') break;
    const next = snap.resp.find((n) => !n.j && !done.has(keyOf(n)) && n.t > snap.now - 0.06) ?? null;
    if (opt.stopWhen && (await opt.stopWhen(next))) break;
    if (!next) { if (opt.onTick) await opt.onTick(); await page.waitForTimeout(80); continue; }
    const off = typeof opt.offset === 'function' ? opt.offset(next) : opt.offset ?? 0;
    const aim = next.t + off + (opt.jitter ? gauss() * opt.jitter : 0);
    const wait = (aim - snap.now) * 1000 - (Date.now() - mid) - 4;
    if (wait > 350) { // 近くなってから もう一度よむ
      if (opt.onTick) await opt.onTick();
      await page.waitForTimeout(opt.onTick ? Math.min(wait - 250, 150) : wait - 250);
      continue;
    }
    done.add(keyOf(next));
    if (opt.skip && rnd() < opt.skip) continue;
    if (wait > 0) await page.waitForTimeout(wait);
    await hand.press(opt.laneOf ? opt.laneOf(next) : next.l);
    presses++;
    if (opt.onPress) await opt.onPress(next, aim);
  }
  return presses;
}
async function playNight(page: Page, hand: Hand, opt: AutoOpt = {}) {
  const t0 = Date.now();
  await autoplay(page, hand, opt);
  await expect.poll(() => gt<string>(page, 'state'), { timeout: 20_000 }).toBe('result');
  const r = (await gt<Result>(page, 'result'))!;
  return { ...r, secs: (Date.now() - t0) / 1000 };
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
      return !!g && ['state', 'night', 'score', 'songTime', 'lanes', 'pads', 'phrases', 'view', 'call', 'resp', 'stats', 'celebrations',
        'lanterns', 'cleared', 'sung', 'result', 'progress', 'rows', 'quality', 'sound', 'calib'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(3 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    await openTitle(page, 3);
    await shot('1-title');
    await page.locator('.tk[data-n="1"]').click();
    await page.waitForTimeout(400);
    await shot('2-intro');
    await start(page);
    await page.waitForTimeout(1500);
    await shot('3-start');
    const hand = await deviceHand(page);
    await autoplay(page, hand, { jitter: 0.02, stopWhen: async () => (await gt<number>(page, 'view')) >= 1 });
    await page.waitForTimeout(500);
    await shot('4-call');
    // にぎやかな場面: 4ひきの夜で、そろった瞬間
    await openNight(page, 7, { cleared: 6 });
    await start(page);
    const hand2 = await deviceHand(page);
    let snapped = false;
    await autoplay(page, hand2, {
      jitter: 0.02,
      onTick: async () => {
        if (!snapped && (await gt<number>(page, 'celebrations')) >= 1) { snapped = true; await page.waitForTimeout(120); await shot('5-busy'); }
      },
      stopWhen: () => snapped,
    });
    await autoplay(page, hand2, { jitter: 0.02, stopWhen: (n) => !!n && n.ph >= 3 });
    await page.waitForTimeout(700);
    await shot('6-reading');
    await autoplay(page, hand2, { jitter: 0.03 });
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 20_000 }).toBe('result');
    await page.waitForTimeout(1500);
    await shot('7-result');
    // おまけ: 夜明けに近づくと空が明るくなる
    await openNight(page, 8, { cleared: 7 });
    await start(page);
    const hand3 = await deviceHand(page);
    await autoplay(page, hand3, { jitter: 0.02, stopWhen: (n) => !!n && n.ph >= 6 });
    await shot('8-dawn');
    await autoplay(page, hand3, { stopWhen: () => false, skip: 1 });
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 60_000 }).toBe('result');
    await page.waitForTimeout(1500);
    await shot('9-dawn-result');
    // スマホを横にしたとき / 小さいスマホ
    if (info.project.name !== 'mobile') return;
    for (const [w, h, name] of [[844, 390, 'a-landscape'], [360, 640, 'b-small']] as const) {
      await page.setViewportSize({ width: w, height: h });
      await openNight(page, 5, { cleared: 4 });
      await shot(`${name}-intro`);
      await start(page);
      const hd = await touchHand(page);
      await autoplay(page, hd, { jitter: 0.02, stopWhen: (n) => !!n && n.ph >= 2 });
      await page.waitForTimeout(300);
      await shot(`${name}-play`);
    }
  });

  // 核の遊び: お手本と同じ時刻に同じ虫を鳴かせると当たり。時刻がずれると当たらない
  test('お手本のすぐあとに、同じリズムで鳴くと当たり、ずれると当たらない', async ({ page }) => {
    test.setTimeout(2 * 60_000);
    await openNight(page, 1);
    await start(page);
    const hand = await deviceHand(page);
    expect(await gt<number>(page, 'score'), '鳴く前から月がのぼっています').toBe(0);
    // 1〜3曲目は、人の手くらいのゆらぎ(±25ms)で、ちょうどの時刻に押す
    const tried: { n: Note; got: string | null }[] = [];
    await autoplay(page, hand, {
      jitter: 0.025,
      stopWhen: (n) => !!n && n.ph >= 3,
      onPress: async (n) => {
        await page.waitForTimeout(60);
        const now = (await gt<Note[]>(page, 'resp')).find((m) => keyOf(m) === keyOf(n))!;
        tried.push({ n, got: now.j });
      },
    });
    const hits = tried.filter((x) => HIT(x.got)).length;
    console.log(`  ちょうどの時刻に押した: ${tried.length}回 → 当たり ${hits}回(${tried.map((x) => x.got).join(',')})`);
    expect(tried.length, 'お手本の音がありません').toBeGreaterThanOrEqual(6);
    expect(hits, '時刻ぴったりに押しても、当たりになりません').toBe(tried.length);
    expect(await gt<number>(page, 'score'), '当たっても月がのぼりません').toBeGreaterThan(0);
    // 4曲目は0.3秒おそく、5曲目は0.3秒はやく押す(人が聞いて「ずれた」と分かる量)
    const off: { n: Note; got: string | null }[] = [];
    await autoplay(page, hand, {
      offset: (n) => (n.ph === 3 ? 0.3 : -0.3),
      stopWhen: (n) => !!n && n.ph >= 5,
      onPress: async (n) => { off.push({ n, got: null }); },
    });
    await page.waitForTimeout(600);
    const after = await gt<Note[]>(page, 'resp');
    for (const o of off) o.got = after.find((m) => keyOf(m) === keyOf(o.n))!.j;
    console.log(`  0.3秒ずらして押した: ${off.length}回 → ${off.map((x) => x.got).join(',')}`);
    expect(off.length).toBeGreaterThanOrEqual(4);
    expect(off.filter((x) => HIT(x.got)).length, '0.3秒ずれて押しても当たりになります').toBe(0);
  });

  test('ちがう虫を鳴かせると当たらず、れんぞくが切れる', async ({ page }) => {
    test.setTimeout(90_000);
    await openNight(page, 2);
    await start(page);
    const hand = await deviceHand(page);
    // 1曲目は正しい虫で(れんぞくをためる)
    await autoplay(page, hand, { jitter: 0.02, stopWhen: (n) => !!n && n.ph >= 1 });
    const before = await gt<{ combo: number; stray: number }>(page, 'stats');
    expect(before.combo, '正しく鳴いても、れんぞくがたまりません').toBeGreaterThanOrEqual(2);
    // 2曲目は、ちょうどの時刻に「となりの虫」を押す
    const wrong: Note[] = [];
    await autoplay(page, hand, { laneOf: (n) => 1 - n.l, stopWhen: (n) => !!n && n.ph >= 2, onPress: async (n) => { wrong.push(n); } });
    await page.waitForTimeout(500);
    const resp = await gt<Note[]>(page, 'resp');
    const st = await gt<{ combo: number; stray: number }>(page, 'stats');
    console.log(`  ちがう虫を ${wrong.length}回 押した → 当たり ${wrong.filter((n) => HIT(resp.find((m) => keyOf(m) === keyOf(n))!.j)).length}回・あれ? ${st.stray - before.stray}回`);
    expect(wrong.length).toBeGreaterThanOrEqual(3);
    for (const n of wrong) expect(HIT(resp.find((m) => keyOf(m) === keyOf(n))!.j), 'ちがう虫を鳴かせたのに当たりになりました').toBeFalsy();
    expect(st.stray - before.stray, 'ちがう虫を鳴かせても「あれ?」になりません').toBe(wrong.length);
    expect(st.combo, 'ちがう虫を鳴かせても、れんぞくが切れません').toBe(0);
  });

  test('第1夜: 鳴かないと三日月で「もういちど」、鳴けば次の夜がひらき、再読み込みしても残る', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', '長いので desktop で確かめる');
    test.setTimeout(4 * 60_000);
    await openTitle(page, 0);
    await expect(page.locator('.tk[data-n="2"]'), 'まだ遊んでいない第2夜が選べます').toBeDisabled();
    await expect(page.locator('.tk[data-n="8"]')).toBeDisabled();
    await page.locator('.tk[data-n="1"]').click();
    await start(page);
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 90_000 }).toBe('result');
    let r = (await gt<Result>(page, 'result'))!;
    expect(r.clear, '何もしないのにクリアになりました').toBeFalsy();
    expect(r.miss, '鳴かなかった音が「おしい」に数えられていません').toBe(r.notes);
    await expect(page.locator('#rank')).toContainText('みかづき');
    await expect(page.locator('#b-next'), '月がのぼっていないのに「つぎの夜へ」が出ています').toBeHidden();
    // もういちど → キーボードで遊びきる
    await page.locator('#b-retry').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    const p = await playNight(page, await keyHand(page), { jitter: 0.03 });
    console.log(`  第1夜(スペース): 月 ${p.pct.toFixed(0)}%・ぴったり${p.perfect} いいね${p.good} おしい${p.miss}・${p.secs.toFixed(1)}秒`);
    r = (await gt<Result>(page, 'result'))!;
    expect(r.clear, 'ちゃんと鳴いてもクリアになりません').toBeTruthy();
    expect(r.pct).toBeGreaterThanOrEqual(90);
    await expect(page.locator('#b-next')).toBeVisible();
    await expect(page.locator('#pct'), '0%の記録をこえたのに「じこベスト更新」が出ません').toContainText('じこベスト更新');
    await page.reload();
    await expect.poll(() => gt<string>(page, 'state')).toBe('title');
    const prog = await gt<{ best: Record<string, number>; unlocked: boolean[] }>(page, 'progress');
    expect(prog.best['1'], '記録が保存されていません').toBeGreaterThanOrEqual(90);
    await expect(page.locator('.tk[data-n="2"]'), '第1夜をクリアしても第2夜がひらきません').toBeEnabled();
    await expect(page.locator('.tk[data-n="1"] .st')).toContainText('%');
    await page.locator('.tk[data-n="2"]').click();
    expect(await gt<number>(page, 'night')).toBe(2);
    expect(await gt<number>(page, 'lanes'), '第2夜は2ひきになるはず').toBe(2);
  });

  test('キーボード: D F J K でも 矢印キーでも、4ひき それぞれ鳴かせられる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーボードは desktop で確かめる');
    test.setTimeout(2 * 60_000);
    await openNight(page, 5);
    await page.keyboard.press('Enter');
    await expect.poll(() => gt<string>(page, 'state'), { message: 'Enter で始まりません' }).toBe('play');
    for (const arrows of [false, true]) {
      const hand = await keyHand(page, arrows);
      const hitLanes = new Set<number>();
      const from = (await gt<number>(page, 'view'));
      await autoplay(page, hand, {
        jitter: 0.02,
        stopWhen: (n) => !!n && n.ph >= from + 4 && hitLanes.size === 4,
        onPress: async (n) => {
          await page.waitForTimeout(40);
          if (HIT((await gt<Note[]>(page, 'resp')).find((m) => keyOf(m) === keyOf(n))!.j)) hitLanes.add(n.l);
        },
      });
      console.log(`  ${hand.name}で当てた虫: ${[...hitLanes].sort().join(',')}`);
      expect(hitLanes.size, `${hand.name}で鳴かせられない虫がいます`).toBe(4);
    }
  });

  test('ひとやすみ: 止めている間は曲が進まず、つづけると続きから遊べる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で確かめる');
    test.setTimeout(90_000);
    await openNight(page, 2);
    await start(page);
    const hand = await mouseHand(page);
    await autoplay(page, hand, { jitter: 0.02, stopWhen: (n) => !!n && n.ph >= 1 });
    await page.locator('#b-pause').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('pause');
    const a = await gt<number>(page, 'songTime');
    const missA = (await gt<{ miss: number }>(page, 'stats')).miss;
    await page.waitForTimeout(3000);
    expect(await gt<number>(page, 'songTime'), '止めているのに曲が進んでいます').toBeCloseTo(a, 3);
    await page.locator('#b-resume').click();
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    const missB = (await gt<{ miss: number }>(page, 'stats')).miss;
    expect(missB, '止めている間に「おしい」が増えました').toBe(missA);
    // 3拍のカウントのあとで続きから。続けて当てられる
    await expect.poll(() => gt<number>(page, 'songTime'), { timeout: 5000, message: 'つづけても曲が進みません' }).toBeGreaterThan(a + 0.2);
    let hits = 0, n = 0;
    await autoplay(page, hand, {
      jitter: 0.02, stopWhen: () => n >= 5,
      onPress: async (x) => { n++; await page.waitForTimeout(40); if (HIT((await gt<Note[]>(page, 'resp')).find((m) => keyOf(m) === keyOf(x))!.j)) hits++; },
    });
    expect(hits, 'つづけたあとで当たりになりません').toBeGreaterThanOrEqual(4);
  });

  test('おまけ「よあけまで」: 第7夜のあとでひらき、テンポが上がり、ちょうちんが消えるとおひらき', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で確かめる');
    test.setTimeout(3 * 60_000);
    await openTitle(page, 6);
    await expect(page.locator('.tk[data-n="8"]'), '第7夜の前に「よあけまで」がひらいています').toBeDisabled();
    await openNight(page, 8, { cleared: 7 });
    await start(page);
    const hand = await mouseHand(page);
    // 4曲は ちゃんと鳴く
    await autoplay(page, hand, { jitter: 0.02, stopWhen: (n) => !!n && n.ph >= 4 });
    await expect.poll(() => gt<number>(page, 'sung'), { timeout: 8000 }).toBe(4); // 4曲目の「きみの番」が終わるまで待つ
    const ph = await gt<Phrase[]>(page, 'phrases');
    console.log(`  テンポ: ${ph.map((p) => p.bpm).join(' → ')}`);
    expect(ph[4].bpm, 'よあけまで: テンポが上がりません').toBeGreaterThan(ph[0].bpm);
    expect(await gt<number>(page, 'cleared'), 'ちゃんと鳴いた曲が数えられていません').toBe(4);
    expect(await gt<number>(page, 'lanterns')).toBe(3);
    // あとは鳴かない → 3曲でちょうちんが全部消えて、おひらき
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 60_000 }).toBe('result');
    const r = (await gt<Result>(page, 'result'))!;
    console.log(`  よあけまで: ${r.sung}曲(うち ちゃんと鳴いた ${r.cleared}曲)`);
    expect(r.sung, '3曲鳴かなかったのに、おひらきになりません(または早すぎます)').toBe(7);
    expect(r.dawn).toBeFalsy();
    await expect(page.locator('#rank')).toContainText('おひらき');
    await page.reload();
    expect((await gt<{ dawn: number }>(page, 'progress')).dawn, 'よあけまでの記録が保存されていません').toBe(7);
  });

  test('スマホ: 画面に収まり、指で押せる大きさで、指で第1夜と第5夜を遊びきれる', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    test.setTimeout(4 * 60_000);
    await openTitle(page, 7);
    const vp = page.viewportSize()!;
    const inside = (b: { x: number; y: number; width: number; height: number } | null) =>
      !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width + 0.5 && b.y + b.height <= vp.height + 0.5;
    for (let n = 1; n <= 8; n++) {
      const b = await page.locator(`.tk[data-n="${n}"]`).boundingBox();
      expect(inside(b), `夜のチケット ${n} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(b!.width, b!.height), `夜のチケット ${n} が小さすぎます`).toBeGreaterThanOrEqual(44);
    }
    for (const id of ['#snd']) {
      const b = await page.locator(id).boundingBox();
      expect(inside(b), `${id} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(b!.width, b!.height)).toBeGreaterThanOrEqual(44);
    }
    for (const n of [1, 5]) {
      await page.locator(`.tk[data-n="${n}"]`).tap();
      await expect.poll(() => gt<string>(page, 'state')).toBe('intro');
      for (const id of ['#b-start', '#b-back']) {
        const b = await page.locator(id).boundingBox();
        expect(inside(b), `${id} が画面からはみ出しています`).toBeTruthy();
        expect(Math.min(b!.width, b!.height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
      }
      await page.locator('#b-start').tap();
      await expect.poll(() => gt<string>(page, 'state')).toBe('play');
      // 虫(押す所)が画面に収まり、指で押せる大きさで、楽譜の下の段とかさならない
      const pads = await gt<Pad[]>(page, 'pads');
      const rows = await gt<{ a: { y: number; x0: number; x1: number }; b: { y: number; x0: number; x1: number }; nr: number }>(page, 'rows');
      for (const p of pads) {
        expect(p.x - p.r >= 0 && p.x + p.r <= vp.width && p.y + p.r <= vp.height, '虫が画面からはみ出しています').toBeTruthy();
        expect(p.r * 2, '虫が小さくて押しにくいです').toBeGreaterThanOrEqual(56);
        expect(p.w, '虫どうしが近すぎます').toBeGreaterThanOrEqual(60);
        expect(p.y - p.r, '虫が楽譜にかさなっています').toBeGreaterThan(rows.b.y + rows.nr * 2);
      }
      expect(rows.a.x0 >= 0 && rows.a.x1 <= vp.width, '楽譜が画面からはみ出しています').toBeTruthy();
      expect(rows.nr * 2, 'お手本の音が小さくて見えません').toBeGreaterThanOrEqual(18);
      const b = await page.locator('#b-pause').boundingBox();
      expect(inside(b) && Math.min(b!.width, b!.height) >= 44, 'ひとやすみボタンが押しにくいです').toBeTruthy();
      const r = await playNight(page, await touchHand(page), { jitter: 0.03 });
      console.log(`  スマホで第${n}夜: 月 ${r.pct.toFixed(0)}%・ぴったり${r.perfect} いいね${r.good} おしい${r.miss}・${r.secs.toFixed(0)}秒`);
      expect(r.clear, `スマホの指で第${n}夜がクリアできません`).toBeTruthy();
      await page.waitForTimeout(800);
      for (const id of ['#b-next', '#b-retry', '#b-menu']) {
        const bb = await page.locator(id).boundingBox();
        expect(inside(bb), `${id} が画面からはみ出しています`).toBeTruthy();
        expect(Math.min(bb!.width, bb!.height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
      }
      await page.locator('#b-menu').tap();
      await expect.poll(() => gt<string>(page, 'state')).toBe('title');
    }
  });

  // 人の手くらいのゆらぎ(標準偏差40ms)と、ときどきの押しわすれ(3%)で、毎晩クリアできるか
  for (const [from, to] of [[1, 4], [5, 7]]) {
    test(`むずかしさ: 第${from}〜${to}夜を音ありで遊んで、毎晩 半月までのぼれる`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'desktop で測る');
      test.setTimeout(8 * 60_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const log: string[] = [];
      for (let n = from; n <= to; n++) {
        await openNight(page, n, { sound: true });
        await start(page);
        const hand = await keyHand(page);
        let shot = false;
        const r = await playNight(page, hand, {
          jitter: 0.04, skip: 0.03,
          onTick: async () => {
            // 投稿画像: 大合唱の夜で、そろった瞬間
            if (shot || n !== 7 || (await gt<number>(page, 'celebrations')) < 2) return;
            shot = true;
            await page.waitForTimeout(100);
            await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
            console.log('  見せ場のスクショを撮りました(大合唱の夜で そろった瞬間)');
          },
        });
        const ph = await gt<Phrase[]>(page, 'phrases');
        log.push(`第${n}夜 ${r.pct.toFixed(0)}%(${r.rank}) 音${r.notes} BPM${ph[0].bpm} そろった${r.celebrations}/${ph.length} ${r.secs.toFixed(0)}秒`);
        expect(r.clear, `第${n}夜: 人くらいの手で遊んでも 半月までのぼれません`).toBeTruthy();
        expect(errors, `第${n}夜: 遊んでいる間にエラーが出ました`).toEqual([]);
      }
      console.log(`  ${log.join(' / ')}`);
    });
  }

  test('お手本の作り方: どの夜も、読める間かく・その夜の虫だけ・だんだん音が増える', async ({ page }) => {
    const rows: string[] = [];
    let prevDensity = 0;
    for (let n = 1; n <= 7; n++) {
      await openNight(page, n);
      await start(page);
      const [call, ph, lanes, resp] = await Promise.all([gt<Note[]>(page, 'call'), gt<Phrase[]>(page, 'phrases'), gt<number>(page, 'lanes'), gt<Note[]>(page, 'resp')]);
      // きみの番は、お手本と同じ虫・同じリズム(お手本の長さぶん あと)になっている
      expect(resp.length, `第${n}夜: お手本ときみの番の音の数がちがいます`).toBe(call.length);
      for (let i = 0; i < call.length; i++) {
        const c = call[i], r = resp[i], p = ph[c.ph];
        expect(r.l, `第${n}夜: きみの番の虫が お手本とちがいます`).toBe(c.l);
        expect(r.t - c.t, `第${n}夜: きみの番のリズムが お手本とずれています`).toBeCloseTo(p.respT - p.callT, 6);
      }
      const sec = ph[ph.length - 1].endT - ph[0].callT;
      const density = call.length / (sec / 2); // きみの番1秒あたりの音
      let minGap = 9;
      for (let i = 1; i < call.length; i++) if (call[i].ph === call[i - 1].ph) minGap = Math.min(minGap, call[i].t - call[i - 1].t);
      rows.push(`第${n}夜 音${call.length} 1秒に${density.toFixed(2)}こ 最短${(minGap * 1000).toFixed(0)}ms`);
      for (const c of call) expect(c.l, `第${n}夜に いないはずの虫が出ます`).toBeLessThan(lanes);
      expect(minGap, `第${n}夜: 音の間が短すぎて押せません`).toBeGreaterThanOrEqual(0.12);
      for (const p of ph) expect(p.total, `第${n}夜: 音のないお手本があります`).toBeGreaterThanOrEqual(2);
      // すべての虫が出てくる
      for (let l = 0; l < lanes; l++) expect(call.some((c) => c.l === l), `第${n}夜: 出てこない虫がいます`).toBeTruthy();
      if (n >= 3) expect(density, `第${n}夜: 前の夜より音が少なくなっています`).toBeGreaterThanOrEqual(prevDensity * 0.9);
      prevDensity = density;
    }
    console.log(`  ${rows.join(' / ')}`);
  });

  test('スマホで重くない(CPU 4倍遅くても、大合唱の夜に鳴いている間 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(2 * 60_000);
    await openNight(page, 7, { cleared: 6 });
    await start(page);
    const cdp = await page.context().newCDPSession(page);
    const hand = await touchHand(page, cdp);
    // 1曲目をそろえて、つぶが舞っている場面にする
    await autoplay(page, hand, { jitter: 0.02, stopWhen: async () => (await gt<number>(page, 'celebrations')) >= 1 });
    // 測っているあいだは gameTest を読まない。虫を順にタップし続ける
    const busy = (async () => {
      const end = Date.now() + 3300;
      let k = 0;
      while (Date.now() < end) { await hand.press(k++ % 4); await page.waitForTimeout(110); }
    })();
    const [perf] = await Promise.all([measureFps(page, 3000), busy]);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・演出の段階 ${await gt<number>(page, 'quality')}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(3 * 60_000);
    // 大合唱の夜。4ひきが そろって鳴いた瞬間から始める
    await recordPlayVideo(browser, {
      dir: target!.dir,
      setup: async (page) => {
        await openNight(page, 7, { cleared: 6, sound: true }); // 動画には音を入れるので、音はオンで始める
        await start(page);
      },
      play: async (page, clip: Clip) => {
        const hand = await mouseHand(page);
        let marked = false;
        await autoplay(page, hand, {
          jitter: 0.015,
          onTick: async () => {
            if (!marked && (await gt<number>(page, 'celebrations')) >= 1) { marked = true; clip.mark(); }
          },
          stopWhen: () => Date.now() > clip.until,
        });
        console.log(`  動画の夜: そろった ${await gt<number>(page, 'celebrations')}回・月 ${await gt<number>(page, 'score')}%`);
      },
    });
  });
});
