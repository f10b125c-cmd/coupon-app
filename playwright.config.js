import { defineConfig, devices } from "@playwright/test";

// E2Eは実際のFirestore（家族共有）につながるため、テストデータのidは必ず
// `tagtest_` で始める。各テストの後始末で同じ接頭辞のものだけを消している。
export default defineConfig({
  testDir: "./e2e",
  // OCRは1件あたり10秒以上かかるので長めに取る
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
