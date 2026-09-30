import { test, expect, Page, CDPSession } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestGame } from './latest';
import { recordPlayVideo } from './video';

// ============================================================================
//  プレイテスト: 今日のゲームの「核の遊び」が本当に機能するかを、実際に操作して確かめる。
//  game.spec.ts は「エラーが出ないか」しか見ないので、遊べないゲームでも通ってしまう。
//  このファイルはゲームごとに中身が違うので、毎回、今日のゲームに合わせて書き直す。
//
//  対象: たたんで、しまって。(2026-10-01)
//  ゲーム側の window.gameTest(読み取り専用)から状態を読む。
//  操作はすべて画面の上で行う(服をなぞってドラッグ、「折」の印をタップ、ボタンを押す)。
// ============================================================================

const EXPECTED = '2026-10-01-tatande-shimatte';
const target = latestGame();
const SKEY = 'tatande-shimatte-v1';

type Cell = [number, number];
type Piece = { id: number; cells: Cell[]; placed: { x: number; y: number } | null; folds: number; need: number; area: number };
type Rect = { x: number; y: number; w: number; h: number };
type Line = { i: number; axis: 'v' | 'h'; k: number; hx: number; hy: number; r: number };
type Layout = {
  btn: Record<string, Rect>;
  dr: { x: number; y: number; c: number; w: number; h: number };
  tp: { id: number; x: number; y: number; c: number } | null;
  tray: { id: number; x: number; y: number; c: number }[];
  lines: Line[];
  lift: number;
  menu: (Rect & { n: number })[];
  table: Rect;
};

const url = () => pathToFileURL(target!.html).href;
const gt = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).gameTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const layout = (page: Page) => gt<Layout>(page, 'layout');
const pieces = (page: Page) => gt<Piece[]>(page, 'pieces');

// ---------------------------------------------------------------------------
//  形の計算(ゲームとは別に、テスト側で独自に書く)
// ---------------------------------------------------------------------------
function norm(cells: Cell[]): Cell[] {
  const mx = Math.min(...cells.map((c) => c[0])), my = Math.min(...cells.map((c) => c[1]));
  const s = new Set(cells.map(([x, y]) => `${x - mx},${y - my}`));
  return [...s].map((k) => k.split(',').map(Number) as Cell).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
const key = (cells: Cell[]) => norm(cells).map((c) => c.join(',')).join(';');
const size = (cells: Cell[]) => ({ w: Math.max(...cells.map((c) => c[0])) + 1, h: Math.max(...cells.map((c) => c[1])) + 1 });
const rotate = (cells: Cell[]) => { const n = norm(cells), { h } = size(n); return norm(n.map(([x, y]) => [h - 1 - y, x] as Cell)); };
const mirror = (cells: Cell[]) => { const n = norm(cells), { w } = size(n); return norm(n.map(([x, y]) => [w - 1 - x, y] as Cell)); };
function sameShape(a: Cell[], b: Cell[]) {
  let c = norm(a);
  const kb = key(b);
  for (let f = 0; f < 2; f++) {
    for (let r = 0; r < 4; r++) { if (key(c) === kb) return true; c = rotate(c); }
    c = mirror(c);
  }
  return false;
}
// 画面に書いてあるルール: 幅の狭いほうを広いほうへ重ねる。同じ幅ならマスの少ないほう。それも同じなら左(上)を右(下)へ
function foldRule(cells: Cell[], axis: 'v' | 'h', k: number): Cell[] {
  const n = norm(cells), i = axis === 'v' ? 0 : 1, span = axis === 'v' ? size(n).w : size(n).h;
  const a = n.filter((c) => c[i] < k), b = n.filter((c) => c[i] >= k);
  const keepA = k > span - k || (k === span - k && a.length > b.length);
  const [keep, move] = keepA ? [a, b] : [b, a];
  return norm([...keep, ...move.map((c) => { const q: Cell = [c[0], c[1]]; q[i] = 2 * k - 1 - c[i]; return q; })]);
}
function isConnected(cells: Cell[]) {
  const s = new Set(cells.map((c) => c.join(',')));
  const seen = new Set([cells[0].join(',')]);
  const st = [cells[0]];
  while (st.length) {
    const [x, y] = st.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${y + dy}`;
      if (s.has(k) && !seen.has(k)) { seen.add(k); st.push([x + dx, y + dy]); }
    }
  }
  return seen.size === s.size;
}
// ちょうど n 回たたんで、目標の形にできるか(総当たり)
function reachable(from: Cell[], to: Cell[], n: number): boolean {
  if (n === 0) return sameShape(from, to);
  const f = norm(from), { w, h } = size(f);
  for (const [axis, span] of [['v', w], ['h', h]] as const) {
    for (let k = 1; k < span; k++) {
      const r = foldRule(f, axis, k);
      if (isConnected(r) && reachable(r, to, n - 1)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
//  操作(マウスとタッチを同じ形で扱う)
// ---------------------------------------------------------------------------
type Hand = {
  tap: (x: number, y: number) => Promise<void>;
  drag: (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
  touch: boolean;
};
function mouseHand(page: Page, pace = 1): Hand {
  return {
    touch: false,
    tap: async (x, y) => { await page.mouse.click(x, y); await page.waitForTimeout(140 * pace); },
    drag: async (x1, y1, x2, y2) => {
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.waitForTimeout(60 * pace);
      // 人の手の速さ: 1回のドラッグに0.3秒ほど
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
        await page.waitForTimeout(22 * pace);
      }
      await page.waitForTimeout(60 * pace);
      await page.mouse.up();
      await page.waitForTimeout(140 * pace);
    },
  };
}
function touchHand(page: Page, cdp: CDPSession): Hand {
  const send = (type: string, x?: number, y?: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: y! }] } as any);
  return {
    touch: true,
    tap: async (x, y) => { await send('touchStart', x, y); await page.waitForTimeout(60); await send('touchEnd'); await page.waitForTimeout(160); },
    drag: async (x1, y1, x2, y2) => {
      await send('touchStart', x1, y1);
      await page.waitForTimeout(80);
      const steps = 14;
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
        await page.waitForTimeout(25);
      }
      await page.waitForTimeout(80);
      await send('touchEnd');
      await page.waitForTimeout(160);
    },
  };
}
const center = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2] as const;
async function waitStill(page: Page) {
  await expect.poll(() => gt<boolean>(page, 'animating'), { timeout: 3000 }).toBe(false);
}

async function openMenu(page: Page, progress?: number[]) {
  await page.goto(url());
  if (progress) {
    await page.evaluate(([k, c]) => localStorage.setItem(k as string, JSON.stringify({ cleared: c, endless: 0, sound: false })), [SKEY, progress] as const);
    await page.reload();
  }
  await expect.poll(() => gt<string>(page, 'state')).toBe('menu');
}
async function openLevel(page: Page, hand: Hand, n: number) {
  const L = await layout(page);
  const d = L.menu.find((m) => m.n === n)!;
  await hand.tap(...center(d));
  await expect.poll(() => gt<string>(page, 'state')).toBe('play');
  expect(await gt<number>(page, 'level')).toBe(n);
}

// 服を1枚、画面の上で目標の場所にしまう(人と同じ手順: 台にのせる → たたむ → 向きを合わせる → ドラッグ)
async function putAway(page: Page, hand: Hand, sol: { id: number; cells: Cell[]; folds: number }, log?: { taps: number }) {
  const count = () => { if (log) log.taps++; };
  // 1. たたみ台にのせる
  if ((await gt<number>(page, 'selected')) !== sol.id) {
    const L = await layout(page);
    const it = L.tray.find((t) => t.id === sol.id);
    expect(it, `服${sol.id} がかごに見つかりません`).toBeTruthy();
    const p = (await pieces(page)).find((q) => q.id === sol.id)!;
    const [a, b] = p.cells[0];
    await hand.tap(it!.x + (a + 0.5) * it!.c, it!.y + (b + 0.5) * it!.c); count();
    await expect.poll(() => gt<number>(page, 'selected')).toBe(sol.id);
    await waitStill(page);
  }
  // 2. たたむ(どの線でたためばいいかは知らないので、人と同じく試して、違ったらひろげる)
  const want = norm(sol.cells);
  const me = async () => (await pieces(page)).find((q) => q.id === sol.id)!;
  const tryFold = async (depth: number): Promise<boolean> => {
    const p = await me();
    if (depth === sol.folds) return sameShape(p.cells, want);
    const n = (await layout(page)).lines.length;
    for (let i = 0; i < n; i++) {
      const l = (await layout(page)).lines[i];
      const before = p.area;
      await hand.tap(l.hx, l.hy); count();
      await waitStill(page);
      const q = await me();
      expect(q.folds, '「折」をタップしても、たたまれません').toBe(depth + 1);
      if (q.area === want.length * 2 ** (sol.folds - depth - 1) && q.area < before && (await tryFold(depth + 1))) return true;
      await hand.tap(...center((await layout(page)).btn.unfold)); count();
      await waitStill(page);
      expect(key((await me()).cells), 'ひろげても、たたむ前の形に戻りません').toBe(key(p.cells));
    }
    return false;
  };
  expect(await tryFold(0), `服${sol.id} を ${sol.folds}回たたんでも、しまう場所の形になりません`).toBeTruthy();
  // 3. 向きを合わせる
  for (let i = 0; i < 8 && key((await me()).cells) !== key(want); i++) {
    const L = await layout(page);
    await hand.tap(...center(i === 3 ? L.btn.flip : L.btn.rotate)); count();
    await waitStill(page);
  }
  const p = await me();
  expect(key(p.cells), `服${sol.id} の向きが合わせられません`).toBe(key(want));
  // 4. 服のマスをつまんで、引き出しの目標のマスへ運ぶ
  const L = await layout(page);
  const tp = L.tp!;
  const [a, b] = p.cells[0];
  const ox = Math.min(...sol.cells.map((c) => c[0])), oy = Math.min(...sol.cells.map((c) => c[1]));
  const lift = hand.touch ? L.lift : 0;
  await hand.drag(
    tp.x + (a + 0.5) * tp.c, tp.y + (b + 0.5) * tp.c,
    L.dr.x + (ox + a + 0.5) * L.dr.c, L.dr.y + (oy + b + 0.5) * L.dr.c + lift,
  ); count();
  const after = await me();
  expect(after.placed, `服${sol.id} を引き出しの目標の場所にドラッグしても、置かれません`).toEqual({ x: ox, y: oy });
}

async function solveLevel(page: Page, hand: Hand, opt: { beforeLast?: () => Promise<void>; each?: (i: number, n: number) => Promise<void> } = {}) {
  const t0 = Date.now();
  const log = { taps: 0 };
  const sol = await gt<{ id: number; cells: Cell[]; folds: number }[]>(page, 'solution');
  // 引き出しの奥(上)から順に入れる
  sol.sort((a, b) => Math.min(...a.cells.map((c) => c[1] * 100 + c[0])) - Math.min(...b.cells.map((c) => c[1] * 100 + c[0])));
  for (let i = 0; i < sol.length; i++) {
    if (i === sol.length - 1 && opt.beforeLast) await opt.beforeLast();
    await putAway(page, hand, sol[i], log);
    if (opt.each) await opt.each(i, sol.length);
  }
  await expect.poll(() => gt<string>(page, 'state'), { message: '全部しまったのにクリアになりません' }).toBe('clear');
  return { secs: (Date.now() - t0) / 1000, taps: log.taps, pieces: sol.length };
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
      return !!g && ['state', 'level', 'progress', 'pieces', 'selected', 'board', 'solution', 'layout', 'cursor', 'counter',
        'message', 'lastClear', 'animating', 'levels', 'levelData'].every((k) => typeof g[k] === 'function');
    });
    expect(ok, 'window.gameTest が無いか、関数が足りません').toBeTruthy();
  });

  // 面は「引き出しを服で分けてから、服をひろげる」順で作っている。
  // 本当に解けるかを、ゲームとは別に書いた計算で、全24面ぶん確かめる。
  test('全24面が、書いてあるルールどおりに解ける', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', '計算だけなので desktop で1回');
    await page.goto(url());
    const n = await gt<number>(page, 'levels');
    expect(n).toBe(24);
    const summary: string[] = [];
    let prevArea = 0;
    for (let i = 1; i <= n; i++) {
      const lv = await gt<{ W: number; H: number; blocked: Cell[]; pieces: { shape: Cell[]; sol: Cell[]; folds: number }[] } | null>(page, 'levelData', i);
      expect(lv, `${i}面が作れません`).not.toBeNull();
      const cover = new Map<string, number>();
      for (const b of lv!.blocked) cover.set(b.join(','), -1);
      lv!.pieces.forEach((p, j) => {
        for (const c of p.sol) {
          expect(c[0] >= 0 && c[1] >= 0 && c[0] < lv!.W && c[1] < lv!.H, `${i}面: 服${j} の答えが引き出しの外にあります`).toBeTruthy();
          expect(cover.has(c.join(',')), `${i}面: 答えのマス ${c} が重なっています`).toBeFalsy();
          cover.set(c.join(','), j);
        }
        expect(isConnected(p.sol), `${i}面: 服${j} の答えがつながっていません`).toBeTruthy();
        expect(p.shape.length, `${i}面: 服${j} の大きさが、たたむ回数と合いません`).toBe(p.sol.length * 2 ** p.folds);
        expect(reachable(p.shape, p.sol, p.folds), `${i}面: 服${j} は ${p.folds}回たたんでも答えの形になりません`).toBeTruthy();
      });
      expect(cover.size, `${i}面: 引き出しが埋まりきりません`).toBe(lv!.W * lv!.H);
      const folds = lv!.pieces.reduce((s, p) => s + p.folds, 0);
      if (i <= 2) expect(folds, `${i}面: まだ教えていない「たたむ」が要ります`).toBe(0);
      if (i === 3) expect(folds, '3面で「たたむ」が出てきません').toBeGreaterThan(0);
      if (i === 7) expect(lv!.pieces.some((p) => p.folds === 2), '7面で「2回たたむ服」が出てきません').toBeTruthy();
      const area = lv!.W * lv!.H;
      expect(area, `${i}面の引き出しが前の面より小さい`).toBeGreaterThanOrEqual(prevArea * 0.6);
      prevArea = area;
      summary.push(`${i}:${lv!.W}x${lv!.H}/${lv!.pieces.length}枚/折${folds}`);
    }
    console.log(`  全面: ${summary.join(' ')}`);
  });

  test('一の引き出しから順に、マウスで服をしまって進める(記録は再読み込みしても残る)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'マウスは desktop で確かめる');
    test.setTimeout(6 * 60_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMenu(page);
    const hand = mouseHand(page);
    const times: string[] = [];
    for (let n = 1; n <= 7; n++) {
      if (n === 1) await openLevel(page, hand, 1);
      else {
        const L = await layout(page);
        await hand.tap(...center(L.btn.next));
        await expect.poll(() => gt<string>(page, 'state')).toBe('play');
        expect(await gt<number>(page, 'level'), '「つぎの引き出しへ」で次の面に進みません').toBe(n);
      }
      const r = await solveLevel(page, hand, {
        beforeLast: async () => {
          // 最後の1枚を入れるまでは、クリアにならない
          expect(await gt<string>(page, 'state')).toBe('play');
          // 前板の数字は、引き出しの本当の空きマスと、かごと台に残った服の今のマス数
          const c = await gt<{ free: number; clothes: number }>(page, 'counter');
          const b = (await gt<{ cells: number[] }>(page, 'board'))!.cells;
          const left = (await pieces(page)).filter((q) => !q.placed);
          expect(c.free, '前板の「空き」が、引き出しの空きマスと合っていません').toBe(b.filter((v) => v === -1).length);
          expect(c.clothes, '前板の「服」が、残りの服のマス数と合っていません').toBe(left.reduce((s, q) => s + q.area, 0));
        },
      });
      times.push(`${n}面 ${r.secs.toFixed(1)}秒(${r.pieces}枚・${r.taps}操作)`);
      const b = (await gt<{ cells: number[] }>(page, 'board'))!.cells;
      expect(b.includes(-1), 'クリアなのに引き出しにすきまがあります').toBeFalsy();
      await page.waitForTimeout(1000);
      if (n === 6) await page.screenshot({ path: info.outputPath('clear.png') });
    }
    console.log(`  1面ずつの長さ(自動で解いたとき): ${times.join(' / ')}`);
    expect((await gt<{ cleared: number[] }>(page, 'progress')).cleared).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // 再読み込みしても、しまった引き出しは残り、次の引き出しがひらいている
    await page.reload();
    await expect.poll(() => gt<string>(page, 'state')).toBe('menu');
    expect((await gt<{ cleared: number[] }>(page, 'progress')).cleared, '記録が保存されていません').toEqual([1, 2, 3, 4, 5, 6, 7]);
    await openLevel(page, hand, 8);
    // まだひらいていない引き出しは選べない
    await page.reload();
    const L = await layout(page);
    await hand.tap(...center(L.menu.find((m) => m.n === 10)!));
    expect(await gt<string>(page, 'state'), '九をしまう前に十がひらきました').toBe('menu');
  });

  test('折り線でたたむと、書いてあるとおりに形が変わり、ひろげると元に戻る', async ({ page }) => {
    test.setTimeout(90_000);
    await openMenu(page, [1, 2, 3, 4, 5, 6, 7, 8]);
    const hand = isMobile(page) ? await touchOf(page) : mouseHand(page);
    await openLevel(page, hand, 9);
    const me = async () => (await pieces(page)).find((q) => q.id === sel)!;
    let sel = await gt<number>(page, 'selected');
    expect(sel, '始めたときに、たたみ台に服がのっていません').toBeGreaterThanOrEqual(0);
    const p0 = await me();
    expect(p0.need, '最初にのるのは、たたむ必要がある服のはず').toBeGreaterThan(0);
    const lines = (await layout(page)).lines;
    expect(lines.length, '折り線が出ていません').toBeGreaterThan(0);
    let shrank = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = (await layout(page)).lines[i];
      await hand.tap(l.hx, l.hy);
      expect(await gt<boolean>(page, 'animating'), 'たたむ動きがありません').toBeTruthy();
      await waitStill(page);
      const q = await me();
      const want = foldRule(p0.cells, l.axis, l.k);
      expect(key(q.cells), `${l.axis === 'v' ? '縦' : '横'}の線 ${l.k} でたたんだ形が、ルールと違います`).toBe(key(want));
      expect(q.area, 'たたんだら大きくなりました').toBeLessThanOrEqual(p0.area);
      const s0 = size(p0.cells), s1 = size(q.cells);
      expect(s1.w <= s0.w && s1.h <= s0.h, 'たたんだ服がもとの服からはみ出しています').toBeTruthy();
      if (q.area < p0.area) shrank++;
      await hand.tap(...center((await layout(page)).btn.unfold));
      await waitStill(page);
      expect(key((await me()).cells), 'ひろげても元の形に戻りません').toBe(key(p0.cells));
    }
    expect(shrank, '小さくなる折り線が1本もありません').toBeGreaterThan(0);
    // 台の服をタップすると回る
    const [a, b] = p0.cells[0];
    const tp = (await layout(page)).tp!;
    await hand.tap(tp.x + (a + 0.5) * tp.c, tp.y + (b + 0.5) * tp.c);
    await waitStill(page);
    expect(key((await me()).cells), '台の服をタップしても回りません').toBe(key(rotate(p0.cells)));
  });

  test('ほかの服と重なる所や、はみ出す所には置けない', async ({ page }) => {
    await openMenu(page, [1]);
    const hand = isMobile(page) ? await touchOf(page) : mouseHand(page);
    await openLevel(page, hand, 2);
    const sol = await gt<{ id: number; cells: Cell[]; folds: number }[]>(page, 'solution');
    await putAway(page, hand, sol[0]);
    await putAway(page, hand, sol[1]);
    // 置いた2枚目をつまみ上げて、1枚目の上に重ねようとする → 元の場所に戻る
    const L = await layout(page);
    const p = (await pieces(page)).find((q) => q.id === sol[1].id)!;
    const home = { ...p.placed! };
    const [a, b0] = p.cells[0];
    // 引き出しの中には収まるが、1枚目と重なる置き場所を探す(はみ出しで弾かれるのでは確かめにならない)
    const bd = (await gt<{ W: number; H: number }>(page, 'board'))!;
    const first = new Set(sol[0].cells.map((c) => c.join(',')));
    let spot: { x: number; y: number } | null = null;
    for (let y = 0; y < bd.H && !spot; y++) for (let x = 0; x < bd.W && !spot; x++) {
      const cs = p.cells.map(([cx, cy]) => [x + cx, y + cy]);
      if (cs.every(([cx, cy]) => cx < bd.W && cy < bd.H) && cs.some((c) => first.has(c.join(',')))) spot = { x, y };
    }
    expect(spot, '重なる置き場所が見つかりません').not.toBeNull();
    await hand.drag(
      L.dr.x + (home.x + a + 0.5) * L.dr.c, L.dr.y + (home.y + b0 + 0.5) * L.dr.c,
      L.dr.x + (spot!.x + a + 0.5) * L.dr.c, L.dr.y + (spot!.y + b0 + 0.5) * L.dr.c + (hand.touch ? L.lift : 0),
    );
    const b = (await gt<{ W: number; H: number; cells: number[] }>(page, 'board'))!;
    const ps = await pieces(page);
    const placedArea = ps.filter((q) => q.placed).reduce((s, q) => s + q.area, 0);
    expect(b.cells.filter((v) => v >= 0).length, '服が重なって置かれています').toBe(placedArea);
    expect(ps.find((q) => q.id === sol[1].id)!.placed, '重なる所に落とした服が、元の場所に戻りません').toEqual(home);
    expect(ps.find((q) => q.id === sol[0].id)!.placed, '1枚目が動いてしまいました').toEqual({
      x: Math.min(...sol[0].cells.map((c) => c[0])), y: Math.min(...sol[0].cells.map((c) => c[1])),
    });
    // 引き出しの右下の角から、大きくはみ出す場所に落とす
    const free = ps.find((q) => !q.placed);
    if (free) {
      if ((await gt<number>(page, 'selected')) !== free.id) {
        const it = (await layout(page)).tray.find((t) => t.id === free.id)!;
        await hand.tap(it.x + (free.cells[0][0] + 0.5) * it.c, it.y + (free.cells[0][1] + 0.5) * it.c);
      }
      const L2 = await layout(page);
      const q = (await pieces(page)).find((x) => x.id === free.id)!;
      const far = q.cells.reduce((m, c) => (c[0] + c[1] < m[0] + m[1] ? c : m), q.cells[0]);
      await hand.drag(
        L2.tp!.x + (far[0] + 0.5) * L2.tp!.c, L2.tp!.y + (far[1] + 0.5) * L2.tp!.c,
        L2.dr.x + L2.dr.w - L2.dr.c * 0.5, L2.dr.y + L2.dr.h - L2.dr.c * 0.5 + (hand.touch ? L2.lift : 0),
      );
      const after = (await pieces(page)).find((x) => x.id === free.id)!;
      if (size(q.cells).w > 1 || size(q.cells).h > 1) expect(after.placed, 'はみ出す場所に置けてしまいました').toBeNull();
    }
  });

  test('キーボードだけで、選ぶ・たたむ・置くができて、クリアできる', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'キーボードは desktop で確かめる');
    test.setTimeout(90_000);
    await openMenu(page, [1, 2]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath('menu.png') });
    // たんすの中も矢印キーと Enter で選べる(三の引き出しへ)
    await page.keyboard.press('Enter');
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    expect(await gt<number>(page, 'level'), '矢印キー+Enterで、次にしまう引き出しがひらきません').toBe(3);
    const sol = await gt<{ id: number; cells: Cell[]; folds: number }[]>(page, 'solution');
    for (const s of sol) {
      // Tab で服を選ぶ
      for (let i = 0; i < 10 && (await gt<number>(page, 'selected')) !== s.id; i++) { await page.keyboard.press('Tab'); await page.waitForTimeout(80); }
      expect(await gt<number>(page, 'selected'), 'Tab で服を選べません').toBe(s.id);
      const me = async () => (await pieces(page)).find((q) => q.id === s.id)!;
      // T で折り線を順に選び、Enter でたたむ。違ったら U でひろげる
      if (s.folds > 0) {
        const n = (await layout(page)).lines.length;
        let ok = false;
        for (let i = 0; i < n && !ok; i++) {
          for (let j = 0; j <= i; j++) await page.keyboard.press('t');
          expect((await gt<{ line: number }>(page, 'cursor')).line).toBe(i);
          await page.keyboard.press('Enter');
          await waitStill(page);
          if ((await me()).folds !== 1) throw new Error('T → Enter でたたまれません');
          if (sameShape((await me()).cells, s.cells)) ok = true;
          else { await page.keyboard.press('u'); await waitStill(page); }
        }
        expect(ok, 'キーボードで目標の形にたためません').toBeTruthy();
      }
      for (let i = 0; i < 8 && key((await me()).cells) !== key(s.cells); i++) {
        await page.keyboard.press(i === 3 ? 'f' : 'r');
        await waitStill(page);
      }
      expect(key((await me()).cells)).toBe(key(s.cells));
      // 矢印キーで置き場所へ
      const ox = Math.min(...s.cells.map((c) => c[0])), oy = Math.min(...s.cells.map((c) => c[1]));
      let cur = await gt<{ x: number; y: number }>(page, 'cursor');
      while (cur.x !== ox || cur.y !== oy) {
        await page.keyboard.press(cur.x < ox ? 'ArrowRight' : cur.x > ox ? 'ArrowLeft' : cur.y < oy ? 'ArrowDown' : 'ArrowUp');
        cur = await gt<{ x: number; y: number }>(page, 'cursor');
      }
      await page.keyboard.press('Space');
      expect((await me()).placed, 'Space で置けません').toEqual({ x: ox, y: oy });
    }
    await expect.poll(() => gt<string>(page, 'state')).toBe('clear');
    await page.waitForTimeout(700);
    await page.keyboard.press('Enter');
    await expect.poll(() => gt<number>(page, 'level'), { message: 'Enter で次の引き出しへ進みません' }).toBe(4);
  });

  test('スマホの指で、なぞって運び・タップでたたんで、クリアできる', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'タッチは mobile で確かめる');
    test.setTimeout(3 * 60_000);
    await openMenu(page, [1, 2, 3]);
    const hand = await touchOf(page);
    await openLevel(page, hand, 4);
    const r = await solveLevel(page, hand);
    console.log(`  スマホで4面: ${r.secs.toFixed(1)}秒(${r.pieces}枚・${r.taps}操作)`);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: info.outputPath('mobile-clear.png') });
    await hand.tap(...center((await layout(page)).btn.next));
    await expect.poll(() => gt<number>(page, 'level')).toBe(5);
    const r5 = await solveLevel(page, hand);
    console.log(`  スマホで5面: ${r5.secs.toFixed(1)}秒(${r5.pieces}枚・${r5.taps}操作)`);
    expect((await gt<{ cleared: number[] }>(page, 'progress')).cleared).toEqual([1, 2, 3, 4, 5]);
  });

  test('一番大きな引き出しでも、スマホの画面に収まり、指で押せる大きさがある', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'スマホの画面で確かめる');
    await openMenu(page, Array.from({ length: 23 }, (_, i) => i + 1));
    const vp = page.viewportSize()!;
    // たんす(面えらび)も画面に収まる
    const M = await layout(page);
    for (const m of M.menu) expect(m.y + m.h <= vp.height && m.x + m.w <= vp.width && m.h >= 24, `たんすの引き出し${m.n} が画面からはみ出すか、小さすぎます`).toBeTruthy();
    const hand = await touchOf(page);
    await openLevel(page, hand, 24);
    const L = await layout(page);
    const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= vp.width && r.y + r.h <= vp.height;
    expect(inside({ x: L.dr.x, y: L.dr.y, w: L.dr.w, h: L.dr.h }), '引き出しが画面からはみ出しています').toBeTruthy();
    expect(L.dr.c, '引き出しのマスが小さすぎて、指で置けません').toBeGreaterThanOrEqual(28);
    for (const n of ['rotate', 'flip', 'unfold', 'hint', 'back', 'restart']) {
      expect(inside(L.btn[n]), `ボタン ${n} が画面からはみ出しています`).toBeTruthy();
      expect(Math.min(L.btn[n].w, L.btn[n].h), `ボタン ${n} が小さすぎます`).toBeGreaterThanOrEqual(30);
    }
    for (const l of L.lines) expect(l.r * 2, '「折」の印が小さすぎます').toBeGreaterThanOrEqual(20);
    // 「折」の印どうしが重なっていると、押したい線と違う線でたたんでしまう
    for (const a of L.lines) for (const b of L.lines) {
      if (a.i < b.i) expect(Math.hypot(a.hx - b.hx, a.hy - b.hy), '「折」の印どうしが重なっています').toBeGreaterThanOrEqual(a.r + b.r);
    }
    // 上の名札がボタンに重ならない
    const tag = (L as any).tag as Rect;
    for (const n of ['back', 'restart']) {
      const r = L.btn[n];
      expect(tag.x + tag.w <= r.x || r.x + r.w <= tag.x, `名札が「${n}」ボタンに重なっています`).toBeTruthy();
    }
    // かごの服が全部、かごの中に見えている
    const ps = await pieces(page);
    const sel = await gt<number>(page, 'selected');
    expect(L.tray.length, 'かごに見えていない服があります').toBe(ps.filter((p) => !p.placed && p.id !== sel).length);
    for (const t of L.tray) {
      const p = ps.find((q) => q.id === t.id)!;
      const s = size(p.cells);
      expect(t.y + s.h * t.c <= vp.height && t.x + s.w * t.c <= vp.width, 'かごの服が画面からはみ出しています').toBeTruthy();
    }
    await page.screenshot({ path: info.outputPath('mobile-24.png') });
  });

  test('最後の二十四の引き出しまでしまうと完了になり、おまかせがひらく', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', '長いので desktop だけで行う');
    test.setTimeout(9 * 60_000);
    await page.setViewportSize({ width: 1200, height: 900 });
    await openMenu(page, Array.from({ length: 23 }, (_, i) => i + 1));
    const hand = mouseHand(page, 0.6);
    // おまかせは、まだひらかない
    let L = await layout(page);
    await hand.tap(...center(L.menu.find((m) => m.n === 25)!));
    expect(await gt<string>(page, 'state')).toBe('menu');
    await page.waitForTimeout(2600);
    await openLevel(page, hand, 24);
    let shot = false;
    const r = await solveLevel(page, hand, {
      each: async (i, n) => {
        // 見せ場: 大きな引き出しが半分ほど埋まり、台にたたむ前の服がのっている瞬間
        if (shot || i < n * 0.45) return;
        const sel = await gt<number>(page, 'selected');
        const p = (await pieces(page)).find((q) => q.id === sel);
        if (p && p.need > 0 && p.folds === 0) {
          await waitStill(page);
          await page.screenshot({ path: path.join(target!.dir, 'screenshot.png') });
          shot = true;
          console.log(`  見せ場のスクショを撮りました(${i + 1}/${n}枚しまった所)`);
        }
      },
    });
    console.log(`  二十四の引き出し: ${r.secs.toFixed(1)}秒(${r.pieces}枚・${r.taps}操作)`);
    if (!shot) console.log('  見せ場が来なかったので、スクショは撮り直しません');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: info.outputPath('final.png') });
    L = await layout(page);
    expect(L.btn.menu, '最後の引き出しなのに「つぎへ」が出ています').toBeFalsy();
    expect((await gt<{ cleared: number[] }>(page, 'progress')).cleared.length).toBe(24);
    await hand.tap(...center(L.btn.next));
    await expect.poll(() => gt<string>(page, 'state')).toBe('menu');
    // おまかせがひらき、毎回ちがう面で遊べる
    await openLevel(page, hand, 25);
    expect(await gt<boolean>(page, 'endless')).toBeTruthy();
    const first = JSON.stringify(await gt(page, 'solution'));
    const re = await solveLevel(page, hand);
    console.log(`  おまかせ1段: ${re.secs.toFixed(1)}秒(${re.pieces}枚)`);
    expect((await gt<{ endless: number }>(page, 'progress')).endless).toBe(1);
    await page.waitForTimeout(1000);
    await hand.tap(...center((await layout(page)).btn.next));
    await expect.poll(() => gt<string>(page, 'state')).toBe('play');
    expect(JSON.stringify(await gt(page, 'solution')), 'おまかせが毎回同じ面です').not.toBe(first);
  });

  test('投稿用のプレイ動画を撮る', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', '動画は desktop で1本だけ撮る');
    test.setTimeout(3 * 60_000);
    // 六の引き出しを、たたんで運んで、しまい切るまで(最後は「済」のはんこと落ち葉)
    await recordPlayVideo(browser, {
      dir: target!.dir,
      setup: async (page) => {
        await openMenu(page, [1, 2, 3, 4, 5]);
        await openLevel(page, mouseHand(page), 6);
        await page.waitForTimeout(400);
      },
      play: async (page) => {
        await solveLevel(page, mouseHand(page, 0.75));
      },
    });
  });
});

// mobile プロジェクトかどうか(タッチで操作するか)
function isMobile(page: Page) { return page.viewportSize()!.width < 500; }
async function touchOf(page: Page) { return touchHand(page, await page.context().newCDPSession(page)); }
