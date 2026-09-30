import type { Page } from '@playwright/test';

// スマホで重くないかを測る。CPU をわざと遅くして(既定4倍)、ms ミリ秒のあいだの描画の速さを返す。
// ゲームが一番にぎやかな場面(敵や演出が多いところ)で呼ぶこと。Chromium だけで動く(desktop / mobile どちらも可)。
// 測っているあいだは window.gameTest を読まないこと(読む処理も遅いCPUを使い、ゲームより重く測れてしまう)。
// 座標は先に読んでおき、指やキーの操作だけを続けながら測る。
//   fps : 1秒あたりのコマ数の平均
//   p95 : 遅いほうから5%のコマの間隔(ミリ秒)。カクつきの目安
export async function measureFps(page: Page, ms = 3000, cpuSlowdown = 4): Promise<{ fps: number; p95: number }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
  try {
    return await page.evaluate(
      (ms) =>
        new Promise<{ fps: number; p95: number }>((resolve) => {
          const times: number[] = [];
          const t0 = performance.now();
          const tick = (t: number) => {
            times.push(t);
            if (t - t0 < ms) {
              requestAnimationFrame(tick);
              return;
            }
            const gaps = times.slice(1).map((x, i) => x - times[i]).sort((a, b) => a - b);
            const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            resolve({
              fps: Math.round(1000 / avg),
              p95: Math.round(gaps[Math.floor(gaps.length * 0.95)]),
            });
          };
          requestAnimationFrame(tick);
        }),
      ms,
    );
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
  }
}
