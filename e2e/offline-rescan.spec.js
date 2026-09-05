import { test, expect } from "@playwright/test";
import fs from "node:fs";

const NAME = "ザ・プレミアム・モルツ／ザ・プレミアム・モルツ〈ジャパニーズエール〉夕映香るエール 350ml缶";
const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=";
const mkLines = texts => texts.map((text, i) => ({ text, y: i * 30, y1: i * 30 + 20 }));

async function prepare(page, { productName = NAME, image = BLANK, ocrTexts } = {}) {
  await page.clock.setFixedTime(new Date("2026-09-05T00:00:00Z"));
  await page.addInitScript(({ productName, image, forced }) => {
    window.__rescanWrites = [];
    window.__rescanResults = [];
    window.__forcedOcr = forced;
    window.__testCoupon = {
      id: "offline-rescan", productName, imageDataUrl: image, expiresAt: "2026-09-22",
      store: "seven", barcode: "", status: "unused", inbox: false, autoScanned: true,
      memo: "変更しないメモ", createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z",
    };
  }, { productName, image, forced: ocrTexts ? { text: ocrTexts.join("\n"), lines: mkLines(ocrTexts) } : null });

  const unexpectedRequests = [];
  await page.route(/https:\/\/[^/]*(?:googleapis\.com|firebaseio\.com)\//, route => {
    if (route.request().url().startsWith("https://fonts.googleapis.com/")) return route.continue();
    unexpectedRequests.push(route.request().url());
    return route.abort();
  });
  await page.route("**/src/cloudStore.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `
      const listeners = new Set();
      export async function subscribeCoupons(fn) { listeners.add(fn); fn([window.__testCoupon]); return () => listeners.delete(fn); }
      export async function saveCouponToCloud(c) {
        window.__testCoupon = structuredClone(c); window.__rescanWrites.push(structuredClone(c));
        for (const fn of listeners) fn([window.__testCoupon]);
      }
      export async function deleteCouponFromCloud() { throw new Error("Deletion forbidden"); }
      export async function compressImageForStorage(data) { return data; }
    `,
  }));
  await page.route("**/src/scan.js*", async route => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace("export async function scanText(", "async function actualScanText(");
    body = body.replace("export async function scanBarcodeWithCrop(", "async function actualScanBarcodeWithCrop(");
    body += `
      export async function scanText(...args) {
        const result = window.__forcedOcr || await actualScanText(...args);
        window.__rescanResults.push(structuredClone(result)); return result;
      }
      export async function scanBarcodeWithCrop(...args) {
        return window.__forcedOcr ? {text:"",barcodeImageDataUrl:null} : actualScanBarcodeWithCrop(...args);
      }
    `;
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await expect(page.getByText(productName, { exact: true })).toBeVisible();
  return { unexpectedRequests };
}

async function clickDetailRescan(page, productName = NAME) {
  await page.getByText(productName, { exact: true }).click();
  await page.getByRole("button", { name: "読み取り直す", exact: true }).click();
  await expect(page.getByRole("button", { name: "読み取り直す", exact: true })).toBeEnabled({ timeout: 180_000 });
}

for (const texts of [["ul docomo 会 11:50 1¢@45%@)"], ["ul dokcomo会"], ["テー pis -"]]) {
  test(`個別再読で弱いOCR「${texts[0]}」は既存の商品名を壊さない`, async ({ page }) => {
    const { unexpectedRequests } = await prepare(page, { ocrTexts: texts });
    await clickDetailRescan(page);
    await expect(page.getByText(/現在の商品名を保持しました/)).toBeVisible();
    expect(await page.evaluate(() => window.__rescanWrites.map(c => c.productName))).toEqual([NAME]);
    expect(unexpectedRequests).toEqual([]);
  });
}

test("選択再読でも端末表示へ上書きしない", async ({ page }) => {
  const { unexpectedRequests } = await prepare(page, { ocrTexts: ["ul dokcomo会"] });
  await page.getByRole("checkbox").click();
  await page.getByRole("button", { name: "読み取り直す", exact: true }).click();
  await expect(page.getByText(/商品名: 0件/)).toBeVisible();
  expect(await page.evaluate(() => window.__testCoupon.productName)).toBe(NAME);
  expect(unexpectedRequests).toEqual([]);
});

test("根拠のある商品名は個別再読で更新する", async ({ page }) => {
  const { unexpectedRequests } = await prepare(page, { ocrTexts: ["「Coca-Cola」無料引換券"] });
  await clickDetailRescan(page);
  expect(await page.evaluate(() => window.__testCoupon.productName)).toBe("Coca-Cola");
  expect(unexpectedRequests).toEqual([]);
});

test("実画像の個別再読で修復でき、続けて押しても壊れない", async ({ page }, testInfo) => {
  // 実OCRを2回行うため、ケース全体の時間枠だけを広げる（製品タイマーは変更しない）。
  test.setTimeout(420_000);
  test.skip(!process.env.COUPON_RESCAN_IMAGE, "実画像はGitに含めず環境変数で指定する");
  const image = `data:image/jpeg;base64,${fs.readFileSync(process.env.COUPON_RESCAN_IMAGE).toString("base64")}`;
  const initial = "ul docomo会";
  const { unexpectedRequests } = await prepare(page, { image, productName: initial });
  await clickDetailRescan(page, initial);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      await page.getByRole("button", { name: "読み取り直す", exact: true }).click();
      await expect(page.getByRole("button", { name: "読み取り直す", exact: true })).toBeEnabled({ timeout: 180_000 });
    }
    const saved = await page.evaluate(() => ({ name: window.__testCoupon.productName, expiry: window.__testCoupon.expiresAt,
      memo: window.__testCoupon.memo, crop: window.__rescanResults.at(-1).productCropRecovered }));
    expect(saved).toEqual({ name: NAME, expiry: "2026-09-22", memo: "変更しないメモ", crop: true });
    console.log(`実画像の個別再読 ${attempt + 1}/2: 商品名・期限・メモ保持を確認`);
  }
  expect(unexpectedRequests).toEqual([]);
  await testInfo.attach("rescan-verification", { contentType: "application/json", body: JSON.stringify({
    productName: NAME, consecutiveRescans: 2, productCropRecovered: true, externalDataWrites: 0,
  }, null, 2) });
});
