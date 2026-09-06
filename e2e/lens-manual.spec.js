import { test, expect } from "@playwright/test";

const PRODUCT_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=";
const FULL_IMAGE = "data:image/jpeg;base64,AA==";

async function prepare(page, { productImageDataUrl = PRODUCT_IMAGE } = {}) {
  await page.addInitScript(({ productImageDataUrl, fullImage }) => {
    window.__lensShares = [];
    window.__lensWrites = [];
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true, value: async data => {
      window.__lensShares.push({
        title: data.title,
        text: data.text,
        files: data.files.map(file => ({ name: file.name, type: file.type, size: file.size })),
      });
    }});
    window.__lensCoupon = {
      id: "lens-manual", productName: "ul dokcomo会", imageDataUrl: fullImage,
      productImageDataUrl, expiresAt: "2026-09-22", store: "seven",
      barcode: "2393997412078", memo: "変更しないメモ", status: "unused",
      inbox: false, autoScanned: true, createdAt: "2026-09-05T00:00:00Z",
      updatedAt: "2026-09-05T00:00:00Z",
    };
  }, { productImageDataUrl, fullImage: FULL_IMAGE });

  await page.route(/https:\/\/[^/]*(?:googleapis\.com|firebaseio\.com)\//, route => {
    if (route.request().url().startsWith("https://fonts.googleapis.com/")) return route.continue();
    return route.abort();
  });
  await page.route("**/src/cloudStore.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `
      const listeners = new Set();
      export async function subscribeCoupons(fn) { listeners.add(fn); fn([window.__lensCoupon]); return () => listeners.delete(fn); }
      export async function saveCouponToCloud(coupon) {
        window.__lensCoupon = structuredClone(coupon); window.__lensWrites.push(structuredClone(coupon));
        for (const listener of listeners) listener([window.__lensCoupon]);
      }
      export async function deleteCouponFromCloud() { throw new Error("Deletion forbidden"); }
      export async function compressImageForStorage(data) { return data; }
    `,
  }));
  await page.goto("/");
  await page.getByText("ul dokcomo会", { exact: true }).click();
}

test("分離した商品画像を共有し、確認した商品名だけを登録する", async ({ page }) => {
  await prepare(page);
  await page.getByRole("button", { name: "Google Lensで商品名を調べる", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("GoogleまたはGoogle Lens");
  expect(await page.evaluate(() => window.__lensShares)).toEqual([{
    title: "Google Lensで商品名を調べる",
    text: "この商品画像をGoogle Lensで検索してください",
    files: [{ name: "coupon-product.png", type: "image/png", size: 68 }],
  }]);

  await page.getByLabel("Lensで確認した商品名").fill(" ロッテ クーリッシュ バニラ 140ml ");
  await page.getByRole("button", { name: "この商品名を登録", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("ロッテ クーリッシュ バニラ 140ml");
  const saved = await page.evaluate(() => window.__lensCoupon);
  expect(saved.productName).toBe("ロッテ クーリッシュ バニラ 140ml");
  expect(saved.expiresAt).toBe("2026-09-22");
  expect(saved.barcode).toBe("2393997412078");
  expect(saved.memo).toBe("変更しないメモ");
});

test("商品画像が未分離なら券面全体を送る前に確認する", async ({ page }) => {
  await prepare(page, { productImageDataUrl: null });
  let warning = "";
  page.once("dialog", async dialog => {
    warning = dialog.message();
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Google Lensで商品名を調べる", exact: true }).click();
  expect(warning).toContain("バーコードなどが含まれる場合があります");
  expect(await page.evaluate(() => window.__lensShares[0].files[0].type)).toBe("image/jpeg");
});
