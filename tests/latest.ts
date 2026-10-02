import fs from 'node:fs';
import path from 'node:path';

// テストする作品のフォルダを返す。
// まだ投稿キュー(data/queue/投稿日.json)が無いフォルダ = いま作っている作品があれば、それを選ぶ
// (先の日付の作品がすでにある状態で、手前の日付の作品を作ることがあるため)。
// 無ければ、一番新しい(名前順で最後の)フォルダ。フォルダ名は 投稿日-slug なので、名前順 = 日付順になる。
const GAMES_DIR = path.join(__dirname, '..', 'games');
const QUEUE_DIR = path.join(__dirname, '..', 'data', 'queue');

export function latestGame(): { name: string; dir: string; html: string } | null {
  if (!fs.existsSync(GAMES_DIR)) return null;
  const names = fs
    .readdirSync(GAMES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(GAMES_DIR, n, 'index.html')))
    .sort();
  if (names.length === 0) return null;
  const building = names.filter((n) => !fs.existsSync(path.join(QUEUE_DIR, `${n.slice(0, 10)}.json`)));
  const name = building.length ? building[building.length - 1] : names[names.length - 1];
  const dir = path.join(GAMES_DIR, name);
  return { name, dir, html: path.join(dir, 'index.html') };
}
