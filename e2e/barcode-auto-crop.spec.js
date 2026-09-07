import { test, expect } from "@playwright/test";

const FULL_IMAGE = "data:image/jpeg;base64,AA==";
const CROPPED_BARCODE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=";

test("未切り出しの画像は詳細を開いた時にバーコード部分だけを表示・保存する", async ({ page }) => {
  await page.addInitScript(({ fullImage, croppedBarcode }) => {
    window.__autoCropCalls = 0;
    window.__autoCropWrites = [];
    window.__autoCropResult = croppedBarcode;
    window.__autoCropCoupon = {
      id: "auto-crop",
      productName: "クーリッシュ バニラ",
      imageDataUrl: fullImage,
      productImageDataUrl: null,
      barcodeImageDataUrl: null,
      expiresAt: "2026-09-22",
      store: "lawson",
      barcode: "82220052425158444",
      memo: "変更しないメモ",
      status: "unused",
      inbox: false,
      autoScanned: true,
      createdAt: "2026-09-07T00:00:00Z",
      updatedAt: "2026-09-07T00:00:00Z",
    };
  }, { fullImage: FULL_IMAGE, croppedBarcode: CROPPED_BARCODE });

  await page.route(/https:\/\/[^/]*(?:googleapis\.com|firebaseio\.com)\//, (route) => {
    if (route.request().url().startsWith("https://fonts.googleapis.com/")) return route.continue();
    return route.abort();
  });
  await page.route("**/src/cloudStore.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        const listeners = new Set();
        export async function subscribeCoupons(fn) {
          listeners.add(fn); fn([window.__autoCropCoupon]); return () => listeners.delete(fn);
        }
        export async function saveCouponToCloud(coupon) {
          window.__autoCropCoupon = structuredClone(coupon);
          window.__autoCropWrites.push(structuredClone(coupon));
          for (const listener of listeners) listener([window.__autoCropCoupon]);
        }
        export async function deleteCouponFromCloud() { throw new Error("Deletion forbidden"); }
        export async function compressImageForStorage(data) { return data; }
      `,
    })
  );
  await page.route("**/src/scan.js*", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace("export async function scanBarcodeWithCrop(", "async function actualScanBarcodeWithCrop(");
    body += `
      export async function scanBarcodeWithCrop() {
        window.__autoCropCalls += 1;
        return { text: window.__autoCropCoupon.barcode, barcodeImageDataUrl: window.__autoCropResult };
      }
    `;
    await route.fulfill({ response, body });
  });

  await page.goto("/");
  await page.getByText("クーリッシュ バニラ", { exact: true }).click();

  await expect(page.getByRole("img", { name: "バーコード", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "クーリッシュ バニラ", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__autoCropWrites.length)).toBe(1);

  const result = await page.evaluate(() => ({
    calls: window.__autoCropCalls,
    saved: window.__autoCropWrites[0],
  }));
  expect(result.calls).toBe(1);
  expect(result.saved.barcodeImageDataUrl).toBe(CROPPED_BARCODE);
  expect(result.saved.imageDataUrl).toBe(FULL_IMAGE);
  expect(result.saved.productName).toBe("クーリッシュ バニラ");
  expect(result.saved.expiresAt).toBe("2026-09-22");
  expect(result.saved.memo).toBe("変更しないメモ");
});
