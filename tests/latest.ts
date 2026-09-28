import fs from 'node:fs';
import path from 'node:path';

// games/ の中で一番新しい(名前順で最後の)フォルダを返す。
// フォルダ名は 投稿日-slug なので、名前順 = 日付順になる。
const GAMES_DIR = path.join(__dirname, '..', 'games');

export function latestGame(): { name: string; dir: string; html: string } | null {
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
