import { defineConfig } from "@playwright/test";

// 家族のFirestoreへ接続しない回帰テストだけを選択する。
export default defineConfig({
  testDir: "./e2e",
  testMatch: "offline-rescan.spec.js",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
