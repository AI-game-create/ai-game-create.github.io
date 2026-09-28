import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// games/ の中で一番新しい(名前順で最後の)フォルダを対象にする。
// フォルダ名は 投稿日-slug なので、名前順 = 日付順になる。
const GAMES_DIR = path.join(__dirname, '..', 'games');

function latestGame(): { name: string; dir: string; html: string } | null {
  if (!fs.existsSync(GAMES_DIR)) return null;
  const names = fs
    .readdirSync(GAMES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(GAMES_DIR, n, 'index.html')))
    .sort();
  if (names.length === 0) return null;
  const name = names[names.length - 1];
  const dir = path.join(GAMES_DIR, name);
  return { name, dir, html: path.join(dir, 'index.html') };
}

const target = latestGame();

test.describe('今日のゲーム', () => {
  test.skip(target === null, 'games/ にまだゲームがありません');

  const game = target!;
  const url = () => pathToFileURL(game.html).href;

  test.beforeAll(() => {
    console.log(`対象: games/${game.name}/index.html`);
  });

  test('ソースが制作ルールを守っている', () => {
    const src = fs.readFileSync(game.html, 'utf8');
    const lines = src.split('\n').length;
    console.log(`  行数: ${lines}`);

    // 1ファイル完結(外部ライブラリ・外部画像・外部フォントを読み込まない)
    expect(src, '外部ファイルを読み込んでいます(1ファイル完結にしてください)').not.toMatch(
      /(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i,
    );
    expect(src, '@import で外部CSSを読み込んでいます').not.toMatch(/@import/i);
    expect(src, 'CSSから外部URLを読み込んでいます').not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);

    // 外部サーバーへの通信は禁止
    expect(
      src,
      '外部と通信するコードがあります(fetch / XMLHttpRequest / WebSocket などは使えません)',
    ).not.toMatch(/\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon)/);

    // 個人情報の入力欄は禁止
    expect(src, '個人情報の入力欄があります').not.toMatch(
      /<input[^>]*type\s*=\s*["']?(?:email|tel|password)/i,
    );

    // スマホ対応(viewport 指定)
    expect(src, 'viewport の meta タグがありません(スマホで崩れます)').toMatch(
      /<meta[^>]+name\s*=\s*["']?viewport/i,
    );

    // 行数の目安は公開日の曜日で変わる(土曜は大作枠)。強制上限は目安の2割増し。
    // フォルダ名の先頭10文字が公開日(YYYY-MM-DD)。読めなければ通常枠として扱う。
    const day = new Date(`${game.name.slice(0, 10)}T00:00:00`).getDay();
    const guide = day === 6 ? 5000 : 1500;
    const hard = Math.round(guide * 1.2);
    console.log(`  行数の目安: ${guide}(上限 ${hard})${day === 6 ? ' ※土曜の大作枠' : ''}`);
    expect(lines, `${lines}行あります。${guide}行を目安に作り直してください`).toBeLessThanOrEqual(hard);
  });

  test('画面が表示され、必要な要素がそろっている', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });

    await page.goto(url());
    await page.waitForLoadState('load');

    // タイトル
    const title = await page.title();
    expect(title.trim(), '<title> が空です').not.toBe('');

    const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const src = fs.readFileSync(game.html, 'utf8');
    const seen = `${bodyText} ${src}`;

    // 操作説明
    expect(seen, '操作説明が見つかりません').toMatch(
      /(操作|あそびかた|遊び方|使い方|タップ|スワイプ|クリック|キー|ドラッグ)/,
    );
    // スコア
    expect(seen, 'スコア表示が見つかりません').toMatch(/(スコア|SCORE|Score|得点|点数|タイム|残り)/);
    // リトライ(ゲームオーバー後に出る作りでもよいので、ソースも含めて探す)
    expect(seen, 'リトライの手段が見つかりません').toMatch(
      /(リトライ|もう一度|もういちど|やり直|リスタート|再挑戦|RETRY|Retry|Restart|はじめから)/,
    );

    // 何かが描かれていること
    const hasCanvas = (await page.locator('canvas').count()) > 0;
    expect(hasCanvas || bodyText.length > 20, '画面に何も表示されていません').toBeTruthy();

    expect(errors, `JSエラーが出ています:\n${errors.join('\n')}`).toEqual([]);
  });

  test('キーボードとタッチで操作してもエラーにならない', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });

    await page.goto(url());
    await page.waitForLoadState('load');

    const box = page.viewportSize() ?? { width: 800, height: 600 };
    const cx = Math.floor(box.width / 2);
    const cy = Math.floor(box.height / 2);

    // 画面中央をタップ/クリック(スタートボタンを兼ねている作りが多い)
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(300);

    // よく使うキーを順に押す
    for (const key of ['Space', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(80);
    }

    // タッチ操作(スワイプを含む)
    await page.touchscreen.tap(cx, cy).catch(() => {});
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy, { steps: 8 });
    await page.mouse.up();

    // 少し遊ばせてループが壊れないか見る
    await page.waitForTimeout(2000);

    expect(errors, `操作中にJSエラーが出ました:\n${errors.join('\n')}`).toEqual([]);
  });

  test('スクリーンショットを保存する', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'screenshot は desktop で1枚だけ保存する');

    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(url());
    await page.waitForLoadState('load');

    // タイトル画面のままだと寂しいので、一度だけ触って動かしてから撮る
    await page.mouse.click(600, 450);
    await page.keyboard.press('Space');
    await page.waitForTimeout(1500);

    const out = path.join(game.dir, 'screenshot.png');
    await page.screenshot({ path: out });
    expect(fs.existsSync(out), 'screenshot.png が保存できませんでした').toBeTruthy();
    console.log(`  保存: games/${game.name}/screenshot.png`);
  });
});
