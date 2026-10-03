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
//  対象: ぱたぱたドミノ夜(2026-10-06)
//  夜の机のマットを なぞって ドミノをならべ、タップで たおす。たおれた波が そばの しかけ
//  (ベル・かぼちゃ・花火・ボール坂)を動かす。おだいをクリアすると ドミノとしかけが ふえる。
//  ゲーム側の window.gameTest(読み取り専用)から、ドミノの位置や たおれた順を読む。
//  操作はすべて本物の入力で行う(マウス / 指 / キー)。
// ============================================================================

const EXPECTED = '2026-10-06-patapata-domino';
const target = latestGame();
const SKEY = 'patapata-domino-v1';
const SP = 0.5;

type Dom = { id: number; x: number; z: number; yaw: number; yaw0: number; st: number; th: number; stroke: number; fo: number };
type Item = { id: number; k: string; x: number; z: number; yaw: number; on: boolean; lit: number; ball: { x: number; z: number; ph: string; sp: number } | null };
type Run = { n: number; bells: number; pumps: number; fires: number; balls: number; ballHits: number; branches: number; t0: number; dur: number; rec: boolean };
type Ev = { type: string; t: number; [k: string]: unknown };
type XY = { x: number; y: number };

const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const isMobile = (page: Page) => page.viewportSize()!.width < 500;
const doms = (page: Page) => gt<Dom[]>(page, 'dominoes');
const items = (page: Page) => gt<Item[]>(page, 'items');
const events = (page: Page) => gt<Ev[]>(page, 'events');
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------------------
//  コースを作る(保存データに書いて読みこませる)。点の列を 0.5 間かくで ならべる。ゲームと同じ並べ方
// ---------------------------------------------------------------------------
type Saved = [number, number, number, number, number];
function hsl(h: number, s: number, l: number) {
  const f = (n: number) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
function lay(pts: [number, number][], stroke: number, opt: { skipFirst?: boolean; hue?: number } = {}): Saved[] {
  const out: Saved[] = [];
  let last = pts[0];
  const col = (k: number) => hsl(((opt.hue ?? 0) + k * 0.031) % 1, 0.78, 0.6);
  let k = 0;
  const first: Saved | null = opt.skipFirst ? null : [Math.round(last[0] * 1000), Math.round(last[1] * 1000), 0, col(0), stroke];
  if (first) out.push(first);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    let dx = p[0] - last[0], dz = p[1] - last[1], l = Math.hypot(dx, dz);
    while (l >= SP) {
      dx /= l; dz /= l;
      const nx = last[0] + dx * SP, nz = last[1] + dz * SP, yaw = Math.atan2(dx, dz);
      if (first && out.length === 1) first[2] = Math.round(yaw * 1000);
      k++;
      out.push([Math.round(nx * 1000), Math.round(nz * 1000), Math.round(yaw * 1000), col(k), stroke]);
      last = [nx, nz];
      dx = p[0] - last[0]; dz = p[1] - last[1]; l = Math.hypot(dx, dz);
    }
  }
  return out;
}
const seg = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [[x0, z0], [x1, z1]];
// 行ったり来たりの列(はしは 半円で まがる)
function serp(x0: number, x1: number, z0: number, rows: number, gap: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let r = 0; r < rows; r++) {
    const z = z0 + r * gap, a = r % 2 ? x1 : x0, b = r % 2 ? x0 : x1;
    pts.push([a, z], [b, z]);
    if (r < rows - 1) for (let i = 1; i < 16; i++) { const t = (i / 16) * Math.PI; pts.push([b + Math.sin(t) * (gap / 2) * (r % 2 ? -1 : 1), z + gap / 2 - Math.cos(t) * (gap / 2)]); }
  }
  return pts;
}
const at = (s: Saved) => [s[0] / 1000, s[1] / 1000] as [number, number];
const fwd = (s: Saved) => [Math.sin(s[2] / 1000), Math.cos(s[2] / 1000)] as [number, number];

// ゲームを開く。course を渡すと、そのコースと記録で始める(渡さなければ はじめての人と同じ)
async function open(page: Page, course?: Record<string, unknown> | null, sound = false) {
  await page.goto(url());
  // ゲームは ページを閉じるときに 今のコースを保存するので、そのあとで 書きなおす
  await page.evaluate(([k, v]) => {
    const put = () => { localStorage.clear(); if (v) localStorage.setItem(k as string, JSON.stringify(v)); };
    put(); addEventListener('pagehide', put);
  }, [SKEY, course ? { v: 1, seen: true, drew: true, sound, stock: 3000, mi: 11, ...course } : null] as const);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
  await settle(page);
}
// カメラが止まるまで待つ
async function settle(page: Page) {
  let prev = '';
  for (let i = 0; i < 40; i++) {
    const c = await gt<{ tx: number; tz: number; dist: number; yaw: number }>(page, 'cam');
    const k = [c.tx, c.tz, c.dist, c.yaw].map((v) => v.toFixed(2)).join();
    if (k === prev) return;
    prev = k;
    await page.waitForTimeout(120);
  }
}
async function runCount(page: Page) { return (await events(page)).filter((e) => e.type === 'runend').length; }
async function waitRunEnd(page: Page, before: number, timeout = 60_000) {
  await expect.poll(() => runCount(page), { timeout, intervals: [200], message: 'たおれ終わりません' }).toBeGreaterThan(before);
  return (await gt<Run>(page, 'lastRun'))!;
}

// ---------------------------------------------------------------------------
//  手: マウス / 指。なぞる・タップ
// ---------------------------------------------------------------------------
type Hand = { name: string; tap: (p: XY) => Promise<void>; draw: (pts: XY[], speed?: number) => Promise<void> };
// 線の上を 人の手の速さ(speed px/秒)で なぞる。本当の時間で進める(イベントを送るのが おそくても 速さは かわらない)
async function trace(page: Page, pts: XY[], speed: number, move: (p: XY) => Promise<void>) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  const at = (s: number): XY => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const k = cum[i] > cum[i - 1] ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 1;
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k };
  };
  const t0 = Date.now();
  while (true) {
    const s = Math.min(total, ((Date.now() - t0) / 1000) * speed);
    await move(at(s));
    if (s >= total) break;
    await page.waitForTimeout(12);
  }
}
function mouseHand(page: Page): Hand {
  return {
    name: 'マウス',
    async tap(p) { await page.mouse.click(p.x, p.y); },
    async draw(pts, speed = 500) {
      await page.mouse.move(pts[0].x, pts[0].y);
      await page.mouse.down();
      await trace(page, pts, speed, (p) => page.mouse.move(p.x, p.y));
      await page.mouse.up();
    },
  };
}
async function touchHand(page: Page, cdp?: CDPSession): Promise<Hand> {
  const c = cdp ?? (await page.context().newCDPSession(page));
  const t = (type: string, p?: XY) => c.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] } as any);
  return {
    name: '指',
    async tap(p) { await t('touchStart', p); await page.waitForTimeout(60); await t('touchEnd'); },
    async draw(pts, speed = 500) {
      await t('touchStart', pts[0]);
      await trace(page, pts, speed, (p) => t('touchMove', p));
      await t('touchEnd');
    },
  };
}
const deviceHand = (page: Page) => (isMobile(page) ? touchHand(page) : Promise.resolve(mouseHand(page)));
const scr = async (page: Page, x: number, z: number, y = 0) => (await gt<XY | null>(page, 'toScreen', x, y, z))!;
const vp = (page: Page) => page.viewportSize()!;
// 画面の割合 → px
const S = (page: Page, fx: number, fy: number): XY => ({ x: vp(page).width * fx, y: vp(page).height * fy });
async function tapDomino(page: Page, hand: Hand, d: Dom) { await hand.tap(await scr(page, d.x, d.z, 0.5)); }
function circlePts(c: XY, r: number, a0: number, a1: number, n = 48): XY[] {
  const out: XY[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); }
  return out;
}
// 空いているマットの場所へ カメラを移す(キーで)
async function panTo(page: Page, x: number, z: number) {
  // キーでは細かく合わせにくいので、矢印キーで大まかに → 足りない分は ✋ のドラッグ
  const c = await gt<{ tx: number; tz: number; dist: number; yaw: number }>(page, 'cam');
  const dx = x - c.tx, dz = z - c.tz;
  // カメラは yaw=0 で 画面の上 = -z、右 = +x
  const sp = c.dist * 0.9;
  if (Math.abs(dx) > 0.5) { const k = dx > 0 ? 'ArrowRight' : 'ArrowLeft'; await page.keyboard.down(k); await page.waitForTimeout((Math.abs(dx) / sp) * 1000); await page.keyboard.up(k); }
  if (Math.abs(dz) > 0.5) { const k = dz < 0 ? 'ArrowUp' : 'ArrowDown'; await page.keyboard.down(k); await page.waitForTimeout((Math.abs(dz) / sp) * 1000); await page.keyboard.up(k); }
  await settle(page);
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
      return !!g && ['state', 'score', 'webgl', 'count', 'dominoes', 'falling', 'run', 'lastRun', 'items', 'rockets', 'cam', 'toScreen', 'toWorld',
        'stock', 'left', 'unlocked', 'mission', 'stats', 'events', 'tool', 'start', 'particles', 'quality', 'sound', 'stop'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
    expect(await gt<boolean>(page, 'webgl'), 'WebGL が使えていません').toBeTruthy();
    await page.waitForTimeout(1500);
    const png = await page.locator('#gl').screenshot();
    expect(png.length, '3Dの画面に何も描かれていないようです').toBeGreaterThan(30_000);
  });

  // 核の遊び(1): はじめて開くと おてほんの列があり、さわると 順番に たおれて ベルが鳴る
  test('おてほん: 最初のドミノを タップすると 列が順番に たおれ、さいごに ベルが鳴る。たてなおすと ぜんぶ立つ', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page);
    await page.waitForTimeout(1500); // ドミノが ぽこぽこ 出てくるまで
    const ds = await doms(page);
    console.log(`  おてほん: ドミノ ${ds.length}こ・しかけ ${(await items(page)).map((i) => i.k).join(',')}`);
    expect(ds.length).toBeGreaterThanOrEqual(25);
    await expect(page.locator('#hint .bub'), '最初のドミノに「タップで たおす」が出ていません').toBeVisible();
    {
      const hb = (await page.locator('#hint .ring').boundingBox())!, s0 = await scr(page, ds[0].x, ds[0].z, 0.6);
      expect(Math.hypot(hb.x + hb.width / 2 - s0.x, hb.y + hb.height / 2 - s0.y), '「タップで たおす」が 最初のドミノの所に ありません').toBeLessThan(30);
    }
    const hand = await deviceHand(page);
    const r0 = await runCount(page);
    const t0 = Date.now();
    await tapDomino(page, hand, ds[0]);
    await expect.poll(() => gt<string>(page, 'state'), { message: 'タップしても たおれません' }).toBe('falling');
    const run = await waitRunEnd(page, r0);
    const sec = (Date.now() - t0) / 1000;
    const after = await doms(page);
    expect(after.every((d) => d.st === 2), `たおれのこりが あります: ${after.filter((d) => d.st !== 2).length}こ`).toBeTruthy();
    // 並んだ順に たおれた
    const fo = after.map((d) => d.fo);
    expect(fo, 'ならんだ順に たおれていません').toEqual([...fo].sort((a, b) => a - b));
    expect(run.n).toBe(ds.length);
    expect(run.bells, 'さいごの ベルが鳴りません').toBe(1);
    console.log(`  ${run.n}こが ${run.dur.toFixed(2)}秒で たおれた(1秒に ${(run.n / run.dur).toFixed(1)}こ)・タップから終わりまで ${sec.toFixed(1)}秒`);
    expect(run.n / run.dur, 'たおれるのが おそすぎます').toBeGreaterThan(8);
    expect(run.n / run.dur, 'たおれるのが 速すぎて 目で追えません').toBeLessThan(30);
    // おだい1 クリア → つぎは「なぞって30こ」
    expect((await gt<{ i: number }>(page, 'mission')).i).toBe(1);
    await expect(page.locator('#res'), 'けっかが出ません').toBeVisible({ timeout: 4000 });
    await expect(page.locator('#res-n')).toHaveText(String(ds.length));
    // たてなおす(ボタン)
    await page.locator('#b-reset2').click();
    await expect.poll(async () => (await doms(page)).every((d) => d.st === 0), { timeout: 5000, message: 'たてなおしても 立ちません' }).toBeTruthy();
    const back = await doms(page);
    for (let i = 0; i < back.length; i++) expect(Math.abs(wrap(back[i].yaw - ds[i].yaw)), 'たてなおしたら 向きが かわりました').toBeLessThan(0.01);
    expect((await items(page))[0].on).toBeFalsy();
    // もう一度 たおせる(Space キー / ▶ボタン)
    const r1 = await runCount(page);
    if (isMobile(page)) await page.locator('#b-go').tap(); else await page.keyboard.press('Space');
    const run2 = await waitRunEnd(page, r1);
    expect(run2.n, 'たてなおしたあと もう一度 たおせません').toBe(ds.length);
  });

  // 核の遊び(2): 人の速さ・大きさで なぞると、線にそって 0.5 間かくで ならぶ
  test('なぞる: 人の速さで まっすぐ・円を なぞると、線にそって すきまなく ならび、ぜんぶ たおれる', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, { dom: [], items: [] });
    const hand = await deviceHand(page);
    const short = Math.min(vp(page).width, vp(page).height);
    // まっすぐ(画面の右下 → 左上 に ななめ)
    const a = S(page, 0.2, 0.62), b = S(page, 0.8, 0.42);
    await hand.draw([a, b], 500);
    await page.waitForTimeout(400);
    let ds = await doms(page);
    const wa = (await gt<{ x: number; z: number }>(page, 'toWorld', a.x, a.y))!, wb = (await gt<{ x: number; z: number }>(page, 'toWorld', b.x, b.y))!;
    const L = Math.hypot(wb.x - wa.x, wb.z - wa.z);
    const dir = Math.atan2(wb.x - wa.x, wb.z - wa.z);
    console.log(`  ${hand.name}で まっすぐ ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(0)}px(${L.toFixed(1)}m)→ ${ds.length}こ`);
    expect(ds.length, 'なぞった長さに ドミノの数が あいません').toBeGreaterThanOrEqual(Math.floor(L / SP) - 2);
    expect(ds.length).toBeLessThanOrEqual(Math.floor(L / SP) + 1);
    for (let i = 1; i < ds.length; i++) {
      const g = Math.hypot(ds[i].x - ds[i - 1].x, ds[i].z - ds[i - 1].z);
      expect(g, `${i}こ目の間かくが ${g.toFixed(2)}m`).toBeGreaterThan(0.45);
      expect(g).toBeLessThan(0.56);
    }
    // 線の上に、線の向きで
    for (const d of ds.slice(2)) {
      const off = Math.abs((d.x - wa.x) * Math.cos(dir) - (d.z - wa.z) * Math.sin(dir));
      expect(off, '線から はずれた所に 置かれました').toBeLessThan(0.35);
      expect(Math.abs(wrap(d.yaw - dir)), 'ドミノが 線の向きを 向いていません').toBeLessThan(0.25);
    }
    let r0 = await runCount(page);
    await tapDomino(page, hand, ds[0]);
    let run = await waitRunEnd(page, r0);
    expect(run.n, `まっすぐの列が とちゅうで止まりました(${run.n}/${ds.length})`).toBe(ds.length);
    // 円(短辺の 15% と 25%)を 3/4 周 なぞる
    for (const [rf, cy] of [[0.15, 0.3], [0.25, 0.6]] as const) {
      await open(page, { dom: [], items: [] }); // まっさらな マットで
      const h2 = await deviceHand(page);
      const before = 0;
      const c = S(page, isMobile(page) ? 0.5 : (rf < 0.2 ? 0.3 : 0.68), isMobile(page) ? cy : 0.5);
      await h2.draw(circlePts(c, short * rf, 0.2, 0.2 + Math.PI * 1.5), 450);
      await page.waitForTimeout(300);
      ds = (await doms(page)).slice(before);
      const r = Math.round(short * rf);
      expect(ds.length, `半径${r}pxの円で ドミノが ならびません`).toBeGreaterThan(8);
      r0 = await runCount(page);
      await tapDomino(page, h2, ds[0]);
      run = await waitRunEnd(page, r0);
      const fell = (await doms(page)).slice(before).filter((d) => d.st === 2).length;
      console.log(`  半径${r}px の円を なぞる → ${ds.length}こ・たおれた ${fell}こ`);
      expect(fell, `半径${r}pxの円が とちゅうで止まりました`).toBe(ds.length);
    }
  });

  // 「自分のミスだ」と分かる: すきまが広いと止まり、止まった所に ? が出る
  test('すきま: 列の すきまが広いと そこで止まり、止まった所に「?」が出る。すきまを うめると 最後まで たおれる', async ({ page }) => {
    test.setTimeout(90_000);
    const A = lay(seg(-4.5, 2, -1, 2), 1), B = lay(seg(0.6, 2, 4.5, 2), 1); // 同じ線の とちゅうに 1.6m の すきま
    await open(page, { dom: [...A, ...B], items: [] });
    const hand = await deviceHand(page);
    const ds = await doms(page);
    let r0 = await runCount(page);
    await tapDomino(page, hand, ds[0]);
    const run = await waitRunEnd(page, r0);
    console.log(`  すきま 1.6m: ${run.n}/${ds.length}こ たおれた`);
    expect(run.n, 'すきまを こえて たおれました').toBe(A.length);
    const stop = await gt<{ x: number; z: number } | null>(page, 'stop');
    expect(stop, '止まった所が わかりません').not.toBeNull();
    expect(Math.abs(stop!.x - (-0.2)), '止まった所の しるしが すきまに ありません').toBeLessThan(0.6);
    await expect(page.locator('#stopm .q')).toBeVisible();
    {
      const q = (await page.locator('#stopm .q').boundingBox())!, s = await scr(page, -0.2, 2, 0.8);
      expect(Math.hypot(q.x + q.width / 2 - s.x, q.y + q.height / 2 - s.y), '「?」が すきまの所に ありません').toBeLessThan(30);
    }
    // すきまを なぞって うめる(止まったドミノから 次の列へ)
    await page.keyboard.press('r');
    await page.waitForTimeout(1600);
    await hand.draw([await scr(page, -1, 2), await scr(page, 0.7, 2)], 300);
    await page.waitForTimeout(300);
    const n2 = (await doms(page)).length;
    console.log(`  すきまに ${n2 - ds.length}こ 足した`);
    expect(n2 - ds.length).toBeGreaterThanOrEqual(2);
    r0 = await runCount(page);
    await tapDomino(page, hand, (await doms(page))[0]);
    const run2 = await waitRunEnd(page, r0);
    expect(run2.n, 'すきまを うめても 最後まで たおれません').toBe(n2);
  });

  // わかれ道: 列のとちゅうの ドミノから なぞりはじめると、そこから 2本に わかれる
  test('わかれ道: 列のとちゅうから 横へ なぞると、そこで 2本に わかれて 両方 たおれる', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, { dom: lay(seg(-4.5, 3, 4.5, 3), 1), items: [] });
    const hand = await deviceHand(page);
    const main = await doms(page);
    const mid = main[Math.floor(main.length / 2)];
    // とちゅうの ドミノから 真横(画面の上)へ なぞる。人は 直角に なぞる
    const p0 = await scr(page, mid.x, mid.z), p1 = await scr(page, mid.x, mid.z - 4.5);
    await hand.draw([p0, p1], 400);
    await page.waitForTimeout(300);
    const all = await doms(page);
    const br = all.filter((d) => !main.some((m) => m.id === d.id));
    console.log(`  わかれ道: ${br.length}こ(最初の1こは 本線から ${(Math.abs(wrap(br[0].yaw - mid.yaw0)) * 180 / Math.PI).toFixed(0)}度)`);
    expect(br.length).toBeGreaterThanOrEqual(6);
    const r0 = await runCount(page);
    await tapDomino(page, hand, main[0]);
    const run = await waitRunEnd(page, r0);
    const after = await doms(page);
    console.log(`  たおれた ${run.n}/${after.length}・わかれ ${run.branches}`);
    expect(run.branches, '2本に わかれていません').toBeGreaterThanOrEqual(1);
    expect(after.every((d) => d.st === 2), '本線か わかれ道が とちゅうで止まりました').toBeTruthy();
  });

  // しかけ: 列のそばに置くと、波が通ったときに動く
  test('しかけ: 列のそばの ベル・かぼちゃ・花火が 波で動き、ボール坂の ボールが はなれた列を たおす', async ({ page }) => {
    test.setTimeout(120_000);
    const A = lay(seg(-4.5, 0, 4.5, 0), 1);
    const B = lay(seg(3.4, 5, 3.4, 8), 2); // ボールの通り道に ならぶ 列
    const its = [
      ['bell', -3.6, -0.9, 0, 0], ['bell', -2.4, 0.9, 0, 1], ['pump', -1.2, -1.0, 0, 0], ['pump', 0.2, 1.0, 0, 0],
      ['fire', 1.6, -0.9, 0, 0], ['ramp', 3.4, 1.0, 0, 0], ['pump', 12, 6, 0, 0],
    ].map(([k, x, z, y, n]) => [k, (x as number) * 1000, (z as number) * 1000, (y as number) * 1000, n]);
    // ボール坂は +z(手前)へ。B の列は x=3.4, z=5〜8 を 手前へ(+z)
    await open(page, { dom: [...A, ...B], items: its, unl: { bell: true, pump: true, fire: true, ramp: true } });
    const hand = await deviceHand(page);
    const ds = await doms(page);
    // 置いたしかけ(タップで): かぼちゃを えらんで、何もない所に置く
    await page.locator('#t-item').click();
    await page.locator('#tray [data-k="pump"]').click();
    expect(await gt<string>(page, 'tool')).toBe('item');
    const n0 = (await items(page)).length;
    await hand.tap(await scr(page, -2.5, -4));
    await expect.poll(async () => (await items(page)).length, { message: 'タップで しかけが 置けません' }).toBe(n0 + 1);
    // ドミノの上には置けない
    await hand.tap(await scr(page, ds[3].x, ds[3].z));
    await page.waitForTimeout(200);
    expect((await items(page)).length, 'ドミノの上に しかけが 置けました').toBe(n0 + 1);
    await page.locator('#t-draw').click();
    const r0 = await runCount(page);
    await tapDomino(page, hand, ds[0]);
    await expect.poll(async () => (await events(page)).some((e) => e.type === 'boom'), { timeout: 20_000, message: '花火が 上がりません' }).toBeTruthy();
    const run = await waitRunEnd(page, r0);
    const it = await items(page);
    console.log(`  ベル ${run.bells}・かぼちゃ ${run.pumps}・花火 ${run.fires}・ボールで たおした ${run.ballHits}・ぜんぶで ${run.n}こ`);
    expect(run.bells, 'そばの ベルが鳴りません').toBe(2);
    expect(run.pumps, 'そばの かぼちゃが ともりません').toBe(2);
    expect(it.filter((i) => i.k === 'pump' && i.on).length).toBe(2);
    expect(it.find((i) => i.x === 12)!.on, 'はなれた かぼちゃまで ともりました').toBeFalsy();
    expect(run.fires).toBe(1);
    expect(run.ballHits, 'ボールが 列に当たりません').toBeGreaterThanOrEqual(1);
    const after = await doms(page);
    expect(after.slice(A.length).every((d) => d.st === 2), 'ボールで はなれた列が たおれません').toBeTruthy();
    expect(run.n).toBe(ds.length);
    // たてなおすと しかけも もどる
    await page.keyboard.press('r');
    await expect.poll(async () => (await items(page)).every((i) => !i.on && (!i.ball || i.ball.ph === 'rest')), { timeout: 5000, message: 'しかけが もとに もどりません' }).toBeTruthy();
  });

  test('けす・もどす・保存: 🧽でなぞると消え、↶で もどり、再読み込みしても コースと記録が残る', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, { dom: [], items: [], best: 0 });
    const hand = await deviceHand(page);
    await hand.draw([S(page, 0.2, 0.55), S(page, 0.8, 0.55)], 500);
    await page.waitForTimeout(300);
    const n1 = (await doms(page)).length;
    await hand.draw([S(page, 0.2, 0.35), S(page, 0.7, 0.35)], 500);
    await page.waitForTimeout(300);
    const n2 = (await doms(page)).length;
    expect(n2).toBeGreaterThan(n1);
    // ↶ で 2本目が消える
    await page.locator('#b-undo').click();
    expect((await doms(page)).length, '↶ で ひとつ前に もどりません').toBe(n1);
    // 🧽 で 線の まんなかを なぞる
    await page.locator('#t-erase').click();
    const ds = await doms(page);
    const m = ds[Math.floor(ds.length / 2)];
    const c = await scr(page, m.x, m.z);
    await hand.draw([{ x: c.x, y: c.y - 60 }, { x: c.x, y: c.y + 60 }], 300);
    await page.waitForTimeout(200);
    const n3 = (await doms(page)).length;
    console.log(`  ならべた ${n1}こ → 🧽で ${n1 - n3}こ けした`);
    expect(n1 - n3, '🧽で なぞっても 消えません').toBeGreaterThanOrEqual(1);
    expect(n1 - n3, '🧽で 消えすぎます').toBeLessThanOrEqual(4);
    await page.locator('#b-undo').click();
    expect((await doms(page)).length, '消したのが ↶ で もどりません').toBe(n1);
    // たおして 記録を作る
    await page.locator('#t-draw').click();
    const r0 = await runCount(page);
    await tapDomino(page, hand, (await doms(page))[0]);
    const run = await waitRunEnd(page, r0);
    expect(run.n).toBe(n1);
    await page.waitForTimeout(600);
    const before = await doms(page);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!(window as any).gameTest)).toBeTruthy();
    const after = await doms(page);
    expect(after.length, 'ならべたドミノが 保存されていません').toBe(before.length);
    for (let i = 0; i < after.length; i++) expect(Math.hypot(after[i].x - before[i].x, after[i].z - before[i].z)).toBeLessThan(0.01);
    expect(after.every((d) => d.st === 0), '読みなおしたら 立っている').toBeTruthy();
    expect((await gt<{ best: number }>(page, 'stats')).best, '記録が 保存されていません').toBe(n1);
    await expect(page.locator('#cnt-b')).toContainText(String(n1));
  });

  test('ドミノの数: 持っている数より多くは ならばず、知らせが出る', async ({ page }) => {
    await open(page, { dom: lay(seg(-3, 4, 3, 4), 1), items: [], stock: 20 });
    expect(await gt<number>(page, 'left')).toBe(20 - 13);
    const hand = await deviceHand(page);
    await hand.draw([S(page, 0.15, 0.3), S(page, 0.85, 0.3)], 500);
    await page.waitForTimeout(300);
    expect((await doms(page)).length, '持っている数より 多く ならびました').toBe(20);
    await expect(page.locator('#toasts')).toContainText('たりない');
    await expect(page.locator('#stock')).toHaveText('あと0');
  });

  test('おだい: いっきに60こ たおすと ベルが つかえるようになり、ドミノが ふえる', async ({ page }) => {
    test.setTimeout(90_000);
    const A = lay(serp(-4, 4, -8, 6, 3), 1);
    await open(page, { dom: A, items: [], mi: 2, stock: 250 });
    expect(A.length).toBeGreaterThan(60);
    expect((await gt<{ text: string }>(page, 'mission')).text).toContain('60');
    await expect(page.locator('#t-item-lk')).toBeVisible();
    const hand = await deviceHand(page);
    const r0 = await runCount(page);
    await tapDomino(page, hand, (await doms(page))[0]);
    // とちゅう(60こ目)で クリアになる
    await expect.poll(async () => (await gt<{ bell: boolean }>(page, 'unlocked')).bell, { timeout: 20_000, message: 'ベルが つかえるように なりません' }).toBeTruthy();
    const mid = await gt<Run | null>(page, 'run');
    console.log(`  クリアした瞬間: ${mid ? mid.n : '終わったあと'}こ目`);
    await expect(page.locator('#toasts')).toContainText('ベル');
    await waitRunEnd(page, r0);
    expect(await gt<number>(page, 'stock')).toBe(350);
    expect((await gt<{ i: number }>(page, 'mission')).i).toBe(3);
    await expect(page.locator('#t-item-lk')).toBeHidden();
    await page.locator('#t-item').click();
    await expect(page.locator('#tray [data-k="bell"]')).not.toHaveClass(/lock/);
    await expect(page.locator('#tray [data-k="pump"]')).toHaveClass(/lock/);
  });

  // はじめから おだいを 順に、画面の操作だけで クリアしていく(音あり)。長さも はかる
  test('おだいを 順に: はじめから 画面の操作だけで ボール坂のおだいまで クリアできる(音あり)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で遊ぶ');
    test.setTimeout(9 * 60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await open(page); // はじめての人と同じ(音は オン)
    expect(await gt<boolean>(page, 'sound')).toBeTruthy();
    const hand = mouseHand(page);
    const t0 = Date.now();
    const log: string[] = [];
    const mi = async () => (await gt<{ i: number; text: string }>(page, 'mission'));
    const lap = async (what: string) => { log.push(`${((Date.now() - t0) / 1000).toFixed(0)}秒: ${what} → つぎ「${(await mi()).text}」`); console.log(`  ${log[log.length - 1]}`); };
    const fall = async (d: Dom) => { const r0 = await runCount(page); await tapDomino(page, hand, d); return waitRunEnd(page, r0, 90_000); };
    const reset = async () => { await page.keyboard.press('r'); await expect.poll(async () => gt<string>(page, 'state'), { timeout: 8000 }).toBe('idle'); };
    const pick = async (k: string) => { await page.locator('#t-item').click(); await page.locator(`#tray [data-k="${k}"]`).click(); };
    // 1) おてほんを たおす
    await page.waitForTimeout(1500);
    await fall((await doms(page))[0]);
    await lap('おてほんを たおした');
    expect((await mi()).i).toBe(1);
    // 2) なぞって 30こ(空いている 右の ほうへ 行って、大きな四角を なぞる)
    await reset();
    await panTo(page, 14, -2);
    const box = [S(page, 0.18, 0.25), S(page, 0.82, 0.25), S(page, 0.82, 0.78), S(page, 0.18, 0.78), S(page, 0.18, 0.4)];
    const nb = (await doms(page)).length;
    await hand.draw(box, 600);
    await page.waitForTimeout(400);
    const loop = (await doms(page)).slice(nb);
    await lap(`四角を なぞった(${loop.length}こ)`);
    expect((await mi()).i).toBe(2);
    // 3) いっきに 60こ
    let r = await fall(loop[0]);
    await lap(`四角を たおした(${r.n}こ)`);
    expect(r.n).toBeGreaterThanOrEqual(60);
    expect((await mi()).i).toBe(3);
    // 4) ベルを 3つ、四角の 外がわに 置く
    await reset();
    await pick('bell');
    const sideOf = (i: number, out = 1.0) => {
      const d = loop[i], cx = loop.reduce((s, q) => s + q.x, 0) / loop.length, cz = loop.reduce((s, q) => s + q.z, 0) / loop.length;
      const nx = -Math.cos(d.yaw0), nz = Math.sin(d.yaw0); // 進む向きの 横
      const sgn = (d.x + nx - cx) ** 2 + (d.z + nz - cz) ** 2 > (d.x - cx) ** 2 + (d.z - cz) ** 2 ? 1 : -1;
      return [d.x + nx * out * sgn, d.z + nz * out * sgn] as const;
    };
    for (const i of [8, 20, 32]) { const p = sideOf(i); await hand.tap(await scr(page, p[0], p[1])); await page.waitForTimeout(150); }
    expect((await items(page)).filter((x) => x.k === 'bell').length, 'ベルが 置けません').toBe(4);
    await page.locator('#t-draw').click();
    r = await fall(loop[0]);
    await lap(`ベル ${r.bells}こ 鳴った`);
    expect(r.bells).toBeGreaterThanOrEqual(3);
    expect((await mi()).i).toBe(4);
    // 5) わかれ道: 四角の とちゅうから 内がわへ なぞる
    await reset();
    {
      const d = loop[Math.floor(loop.length * 0.6)];
      const cx = loop.reduce((s, q) => s + q.x, 0) / loop.length, cz = loop.reduce((s, q) => s + q.z, 0) / loop.length;
      const p0 = await scr(page, d.x, d.z), p1 = await scr(page, d.x + (cx - d.x) * 0.6, d.z + (cz - d.z) * 0.6);
      const n0 = (await doms(page)).length;
      await hand.draw([p0, p1], 450);
      const nb = (await doms(page)).slice(n0);
      console.log(`  わかれ道を なぞった: ${nb.length}こ・元 (${d.x.toFixed(2)},${d.z.toFixed(2)}) 向き${(d.yaw0 * 57.3).toFixed(0)}・最初 ${nb[0] ? `(${nb[0].x.toFixed(2)},${nb[0].z.toFixed(2)}) 向き${(nb[0].yaw0 * 57.3).toFixed(0)}` : 'なし'}`);
    }
    r = await fall(loop[0]);
    await lap(`わかれ道 ${r.branches}`);
    expect((await mi()).i).toBe(5);
    // 6) かぼちゃ 5つ
    await reset();
    await pick('pump');
    for (const i of [4, 14, 24, 36, 44, 50]) { const p = sideOf(i, 1.05); await hand.tap(await scr(page, p[0], p[1])); await page.waitForTimeout(150); }
    await page.locator('#t-draw').click();
    r = await fall(loop[0]);
    await lap(`かぼちゃ ${r.pumps}こ`);
    expect(r.pumps).toBeGreaterThanOrEqual(5);
    expect((await mi()).i).toBe(6);
    // 7) 花火 3つ
    await reset();
    await pick('fire');
    for (const i of [11, 27, 40]) { const p = sideOf(i, 0.9); await hand.tap(await scr(page, p[0], p[1])); await page.waitForTimeout(150); }
    await page.locator('#t-draw').click();
    r = await fall(loop[0]);
    await lap(`花火 ${r.fires}こ`);
    expect(r.fires).toBeGreaterThanOrEqual(3);
    expect((await mi()).i).toBe(7);
    // 8) ボール坂: 四角の 内がわに 内向きに置き、その先に 列を なぞる
    await reset();
    await pick('ramp');
    {
      const p = sideOf(14, -1.3), q = sideOf(14, -4);
      const a = await scr(page, p[0], p[1]), b = await scr(page, q[0], q[1]);
      await hand.draw([a, { x: a.x + (b.x - a.x) * 0.3, y: a.y + (b.y - a.y) * 0.3 }], 200); // ドラッグした向きへ ボールが ころがる
      await page.locator('#t-draw').click();
      // ボールの行き先に 横切る列
      const dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz);
      const ux = dx / l, uz = dz / l;
      const c0 = [p[0] + ux * 5.5 - uz * 2, p[1] + uz * 5.5 + ux * 2], c1 = [p[0] + ux * 5.5 + uz * 2, p[1] + uz * 5.5 - ux * 2];
      await hand.draw([await scr(page, c0[0], c0[1]), await scr(page, c1[0], c1[1])], 400);
    }
    expect((await items(page)).filter((x) => x.k === 'ramp').length, 'ボール坂が 置けません').toBe(1);
    r = await fall(loop[0]);
    await lap(`ボールで ${r.ballHits}こ`);
    expect(r.ballHits).toBeGreaterThanOrEqual(1);
    expect((await mi()).i).toBe(8);
    console.log(`  はじめから ボール坂の おだいまで: ${((Date.now() - t0) / 60000).toFixed(1)}分・ドミノ ${await gt<number>(page, 'count')}/${await gt<number>(page, 'stock')}`);
    expect(errors, '遊んでいる間に エラーが出ました').toEqual([]);
  });

  test('夜祭り: 1000こ いっきに たおすと 花火が上がり、そのあとも あそべる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop で確かめる');
    test.setTimeout(3 * 60_000);
    // 1本の長い 行ったり来たり(1000こ以上)
    const A = lay(serp(-24, 24, -26, 12, 4.6), 1);
    expect(A.length).toBeGreaterThan(1000);
    await open(page, { dom: A, items: [['pump', 0, -25000, 0, 0], ['pump', 5000, 16400, 0, 0]], mi: 10, stock: 1550, unl: { bell: true, pump: true, fire: true, ramp: true } });
    const r0 = await runCount(page);
    await page.keyboard.press('Space');
    const run = await waitRunEnd(page, r0, 150_000);
    console.log(`  ${run.n}こ を ${run.dur.toFixed(1)}秒で(1秒に ${(run.n / run.dur).toFixed(1)}こ)`);
    expect(run.n).toBe(A.length);
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 8000, message: '夜祭りに なりません' }).toBe('finale');
    await expect.poll(async () => (await events(page)).filter((e) => e.type === 'boom').length, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 20_000 }).toBe('idle');
    expect((await gt<{ fin: boolean }>(page, 'stats')).fin).toBeTruthy();
    expect(await gt<number>(page, 'stock')).toBe(2000);
    await expect(page.locator('#mis-t')).toContainText('じゆうに');
    await page.keyboard.press('r');
    await expect.poll(async () => (await doms(page)).every((d) => d.st === 0), { timeout: 8000 }).toBeTruthy();
  });

  test('カメラ: ✋ドラッグ・ホイール・キー・2本指で 見る場所を動かせ、たおれる所を おいかける', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, { dom: lay(seg(-2, 0, 28, 0), 1), items: [] });
    const c0 = await gt<{ tx: number; tz: number; dist: number; yaw: number }>(page, 'cam');
    if (isMobile(page)) {
      // 2本指: ひろげると 近づき、ひねると まわる
      const cdp = await page.context().newCDPSession(page);
      const c = S(page, 0.5, 0.5);
      const tp = (r: number, a: number) => [{ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r, id: 1 }, { x: c.x - Math.cos(a) * r, y: c.y - Math.sin(a) * r, id: 2 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(60, 0) } as any);
      for (let i = 1; i <= 15; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(60 + i * 5, i * 0.03) } as any); await page.waitForTimeout(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any);
      const c1 = await gt<{ dist: number; yaw: number }>(page, 'cam');
      console.log(`  2本指: きょり ${c0.dist.toFixed(1)}→${c1.dist.toFixed(1)}・向き ${wrap(c1.yaw - c0.yaw).toFixed(2)}`);
      expect(c1.dist, 'ピンチで 近づきません').toBeLessThan(c0.dist * 0.8);
      expect(Math.abs(wrap(c1.yaw - c0.yaw)), 'ひねっても まわりません').toBeGreaterThan(0.3);
      expect(Math.abs(wrap(c1.yaw - c0.yaw)), 'ひねった以上に まわります').toBeLessThan(0.6);
      expect((await doms(page)).length, '2本指で ドミノが ならびました').toBe(lay(seg(-2, 0, 28, 0), 1).length);
    } else {
      await page.locator('#t-pan').click();
      await mouseHand(page).draw([S(page, 0.6, 0.5), S(page, 0.4, 0.5)], 600);
      const c1 = await gt<{ tx: number }>(page, 'cam');
      expect(c1.tx - c0.tx, '✋で ドラッグしても 動きません').toBeGreaterThan(2);
      await page.mouse.move(640, 360); await page.mouse.wheel(0, 400); await page.waitForTimeout(600);
      expect((await gt<{ dist: number }>(page, 'cam')).dist, 'ホイールで 遠ざかりません').toBeGreaterThan(c0.dist * 1.2);
      await page.keyboard.down('q'); await page.waitForTimeout(400); await page.keyboard.up('q'); await page.waitForTimeout(500);
      expect(Math.abs((await gt<{ yaw: number }>(page, 'cam')).yaw - c0.yaw), 'Q で まわりません').toBeGreaterThan(0.4);
      await page.locator('#t-draw').click();
    }
    // おいかける: 長い列を たおすと、カメラが 先頭について行く
    if (isMobile(page)) await page.locator('#b-go').tap(); else await page.keyboard.press('Space');
    await page.waitForTimeout(2600);
    const f = await doms(page);
    const front = f.filter((d) => d.st === 1);
    const c2 = await gt<{ tx: number; tz: number }>(page, 'cam');
    const fx = front.length ? front.reduce((s, d) => s + d.x, 0) / front.length : 99;
    console.log(`  2.6秒後: たおれている先頭 x=${fx.toFixed(1)}・カメラ x=${c2.tx.toFixed(1)}`);
    expect(Math.abs(c2.tx - fx), 'カメラが たおれている所を おいかけていません').toBeLessThan(3);
  });

  test('スマホ: 画面に収まり、ボタンは指で押せる大きさで、表示どうしが重ならない', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホで確かめる');
    test.setTimeout(60_000);
    await open(page);
    const v = vp(page);
    const inside = (b: { x: number; y: number; width: number; height: number } | null) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5;
    const apart = (a: any, b: any) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    const ids = ['#t-draw', '#t-pan', '#t-item', '#t-erase', '#b-undo', '#b-go', '#b-cam', '#snd', '#b-help'];
    const boxes: Record<string, any> = {};
    for (const id of ids) {
      const b = await page.locator(id).boundingBox();
      boxes[id] = b;
      expect(inside(b), `${id} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(b!.width, b!.height), `${id} が小さすぎます`).toBeGreaterThanOrEqual(44);
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(apart(boxes[ids[i]], boxes[ids[j]]), `${ids[i]} と ${ids[j]} が重なっています`).toBeTruthy();
    const cnt = await page.locator('#cnt').boundingBox(), mis = await page.locator('#mis').boundingBox();
    expect(apart(cnt, mis), '数取器と おだいが 重なっています').toBeTruthy();
    expect(apart(mis, boxes['#b-help']), 'おだいと ？ が 重なっています').toBeTruthy();
    expect(inside(mis), 'おだいが はみ出しています').toBeTruthy();
    // おてほんの列が 上の表示にも 下のボタンにも かくれない
    const ds = await doms(page);
    for (const d of [ds[0], ds[ds.length - 1]]) {
      const s = await scr(page, d.x, d.z, 0.5);
      expect(s.y, 'おてほんの列が 上の表示に かくれます').toBeGreaterThan(mis!.y + mis!.height);
      expect(s.y, 'おてほんの列が 下のボタンに かくれます').toBeLessThan(boxes['#t-draw'].y);
    }
    // しかけの トレイも はみ出さない
    await page.locator('#t-item').tap();
    const tr = await page.locator('#tray').boundingBox();
    expect(inside(tr), 'しかけの トレイが はみ出しています').toBeTruthy();
    for (const b of await page.locator('#tray .tb').all()) expect(Math.min((await b.boundingBox())!.width, (await b.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
    await page.locator('#t-item').tap();
    // あそびかた
    await page.locator('#b-help').tap();
    await expect(page.locator('#help')).toBeVisible();
    const hc = await page.locator('#help .card').boundingBox();
    expect(hc!.width, 'あそびかたが はみ出しています').toBeLessThanOrEqual(v.width);
    await page.locator('#b-hclose').tap();
    await expect(page.locator('#help')).toBeHidden();
  });

  test('スマホで重くない(CPU 4倍遅くても、たくさんの列が いっせいに たおれ、花火が上がる中で 30fps 以上)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの設定で測る');
    test.setTimeout(2 * 60_000);
    const { dom, items: its } = comb();
    await open(page, { dom, items: its, unl: { bell: true, pump: true, fire: true, ramp: true } });
    console.log(`  ドミノ ${dom.length}こ・しかけ ${its.length}こ`);
    await page.locator('#b-go').tap();
    await expect.poll(() => gt<number>(page, 'falling'), { timeout: 15_000 }).toBeGreaterThan(30);
    await expect.poll(() => gt<number>(page, 'rockets'), { timeout: 15_000 }).toBeGreaterThan(0);
    const fall0 = await gt<number>(page, 'falling');
    // 測っているあいだは gameTest を読まない
    const perf = await measureFps(page, 3000);
    console.log(`  重さ: 平均${perf.fps}fps / p95 ${perf.p95}ms(mobile・CPU 4倍遅い)・たおれている ${fall0}こ・つぶ ${await gt<number>(page, 'particles')}・画質の段階 ${await gt<number>(page, 'quality')}`);
    expect(perf.fps, 'スマホで重すぎます').toBeGreaterThanOrEqual(30);
    expect(perf.p95, 'スマホでカクつきます').toBeLessThanOrEqual(50);
  });

  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(3 * 60_000);
    const { dom, items: its } = comb();
    await recordPlayVideo(browser, {
      dir: target!.dir,
      focus: '#gl',
      setup: async (page) => {
        await open(page, { dom, items: its, unl: { bell: true, pump: true, fire: true, ramp: true } }, true); // 動画には音を入れる
        await page.waitForTimeout(500);
      },
      play: async (page, clip: Clip) => {
        await page.keyboard.press('Space');
        let marked = false, shot = false, markAt = 0;
        while (Date.now() < clip.until) {
          const r = await gt<Run | null>(page, 'run');
          // 見せ場: 何本もの列が いっせいに たおれ、かぼちゃが ともりはじめた瞬間
          if (!marked && r && r.pumps >= 1 && r.branches >= 4) { marked = true; markAt = Date.now(); clip.mark(); console.log(`  見せ場: ${r.n}こ目・わかれ ${r.branches}・かぼちゃ ${r.pumps}`); }
          if (marked && !shot && Date.now() - markAt > 2500) { shot = true; await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') }); }
          await page.waitForTimeout(100);
        }
        const r = await gt<Run | null>(page, 'lastRun');
        console.log(`  動画: mark ${marked}・${r ? r.n : '-'}こ`);
      },
    });
  });

  test('見直し用のスクショ', async ({ page }, info) => {
    test.setTimeout(3 * 60_000);
    const dir = path.join(__dirname, '..', 'test-results', 'review');
    const shot = (name: string) => page.screenshot({ path: path.join(dir, `${info.project.name}-${name}.png`) });
    await open(page);
    await page.waitForTimeout(1600);
    await shot('1-first');
    const hand = await deviceHand(page);
    await tapDomino(page, hand, (await doms(page))[0]);
    await page.waitForTimeout(1200);
    await shot('2-falling');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 15_000 }).toBe('idle');
    await page.waitForTimeout(1500);
    await shot('3-result');
    // にぎやかな場面
    const { dom, items: its } = comb();
    await open(page, { dom, items: its, unl: { bell: true, pump: true, fire: true, ramp: true } });
    await shot('4-course');
    if (isMobile(page)) await page.locator('#b-go').tap(); else await page.keyboard.press('Space');
    await page.waitForTimeout(3500);
    await shot('5-busy');
    await page.waitForTimeout(3000);
    await shot('6-busy2');
    await expect.poll(() => gt<string>(page, 'state'), { timeout: 60_000 }).toBe('idle');
    await page.waitForTimeout(1500);
    await shot('7-end');
    await page.locator('#t-item').click();
    await shot('8-tray');
    await page.locator('#t-item').click();
    await page.locator('#b-help').click();
    await shot('9-help');
    await page.locator('#b-hclose').click();
    if (info.project.name !== 'mobile') return;
    for (const [w, h, name] of [[844, 390, 'a-landscape'], [360, 640, 'b-small']] as const) {
      await page.setViewportSize({ width: w, height: h });
      await open(page);
      await page.waitForTimeout(1500);
      await shot(`${name}-first`);
    }
  });
});

// にぎやかなコース: 横の本線から 45度で わかれる 10本の列。列のそばに かぼちゃ・花火・ベル
function comb() {
  const dom: Saved[] = [];
  const its: (string | number)[][] = [];
  const head = lay(seg(-18, -14, 18, -14), 1);
  dom.push(...head);
  let st = 2, note = 0;
  for (let k = 0; k < 10; k++) {
    const h = head[4 + k * 7];
    const [x, z] = at(h);
    void fwd;
    // 本線(+x)から 45度 → 手前(+z)へ、すこし うねる
    const pts: [number, number][] = [[x, z], [x + 0.354, z + 0.354]];
    for (let i = 1; i <= 26; i++) pts.push([x + 0.354 + Math.sin(i * 0.35 + k) * 0.9 * Math.min(1, i / 4), z + 0.354 + i * 1.0]);
    const br = lay(pts, st++, { skipFirst: true, hue: k * 0.1 });
    dom.push(...br);
    for (const j of [10, 26, 40]) {
      if (j >= br.length) continue;
      const [bx, bz] = at(br[j]);
      const side = (j / 2) % 2 ? 1 : -1;
      const kind = j === 10 ? 'pump' : j === 26 ? (k % 2 ? 'fire' : 'pump') : (k % 3 === 0 ? 'bell' : 'pump');
      its.push([kind, Math.round((bx + side * 0.95) * 1000), Math.round(bz * 1000), 0, kind === 'bell' ? note++ : 0]);
    }
  }
  return { dom, items: its };
}
