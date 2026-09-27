import { defineConfig, devices } from '@playwright/test';

// 一番新しい games/ のフォルダを、PC(キーボード)とスマホ(タッチ)の両方で確認する。
// screenshot.png は desktop プロジェクトだけが保存する。
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});
