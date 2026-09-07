import { test, expect } from "@playwright/test";

const COUPON_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=";

const coupons = [
  { id: "nav-1", productName: "クーリッシュ バニラ", expiresAt: "2026-09-22" },
  { id: "nav-2", productName: "アイスの実 ぶどうマスカット", expiresAt: "2026-09-23" },
  { id: "nav-3", productName: "チョコモナカジャンボ", expiresAt: "2026-09-24" },
].map((coupon) => ({
  ...coupon,
  imageDataUrl: COUPON_IMAGE,
  productImageDataUrl: COUPON_IMAGE,
  barcodeImageDataUrl: null,
  store: "lawson",
  barcode: "",
  memo: "",
  status: "unused",
  inbox: false,
  autoScanned: true,
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:00Z",
}));

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-07T00:00:00Z"));
  await page.addInitScript((initialCoupons) => {
    window.__navigationCoupons = initialCoupons;
  }, coupons);
  await page.route(/https:\/\/[^/]*(?:googleapis\.com|firebaseio\.com)\//, (route) => {
    if (route.request().url().startsWith("https://fonts.googleapis.com/")) return route.continue();
    return route.abort();
  });
  await page.route("**/src/cloudStore.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        export async function subscribeCoupons(fn) { fn(window.__navigationCoupons); return () => {}; }
        export async function saveCouponToCloud() { throw new Error("Writes forbidden"); }
        export async function deleteCouponFromCloud() { throw new Error("Deletion forbidden"); }
        export async function compressImageForStorage(data) { return data; }
      `,
    })
  );
  await page.goto("/");
});

test("詳細画面で現在位置と前後移動を分かりやすく表示する", async ({ page }) => {
  await page.getByText("クーリッシュ バニラ", { exact: true }).click();

  const navigation = page.getByRole("navigation", { name: "クーポンのページ移動" });
  const couponImage = page.getByRole("img", { name: "クーリッシュ バニラ", exact: true });
  const barcodeImage = page.getByRole("img", { name: "バーコード", exact: true });
  const positionBadge = page.getByLabel("全3件中 1件目");
  await expect(positionBadge).toBeVisible();
  await expect(navigation.getByRole("button", { name: "前のクーポン" })).toBeDisabled();
  await expect(navigation.getByRole("button", { name: "次のクーポン" })).toBeEnabled();
  await expect(navigation).toContainText("左右にスワイプしても移動できます");
  expect(
    await couponImage.evaluate((image) => {
      const nav = image.closest(".sheet")?.querySelector('[aria-label="クーポンのページ移動"]');
      return Boolean(nav && image.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING);
    })
  ).toBe(true);
  expect(
    await page.evaluate(() => {
      const elements = [
        document.querySelector('img[alt="バーコード"]'),
        document.querySelector('img[alt="クーリッシュ バニラ"]'),
        document.querySelector('[aria-label="全3件中 1件目"]'),
      ];
      return elements.every((element) => {
        const rect = element?.getBoundingClientRect();
        return rect && rect.top >= 0 && rect.bottom <= window.innerHeight;
      });
    })
  ).toBe(true);
  await expect(barcodeImage).toBeVisible();
  const statusBox = await page.locator(".sheet").getByText("未使用", { exact: true }).boundingBox();
  const positionBox = await positionBadge.boundingBox();
  expect(Math.abs(statusBox.y - positionBox.y)).toBeLessThan(8);
  expect(positionBox.x).toBeGreaterThan(statusBox.x + statusBox.width);
  expect(
    await navigation.evaluate((nav) => {
      const rescan = nav.closest(".sheet")?.querySelector('button[aria-label="読み取り直す"]');
      return Boolean(rescan && nav.compareDocumentPosition(rescan) & Node.DOCUMENT_POSITION_FOLLOWING);
    })
  ).toBe(true);
  expect((await page.locator(".sheet").boundingBox()).y).toBeLessThan(24);

  await page.evaluate(() => {
    window.__detailPageTransitions = [];
    const record = () => {
      const value = document.querySelector(".sheet")?.dataset.pageTransition;
      if (value && window.__detailPageTransitions.at(-1) !== value) {
        window.__detailPageTransitions.push(value);
      }
    };
    record();
    new MutationObserver(record).observe(document.body, {
      attributes: true,
      attributeFilter: ["data-page-transition"],
      childList: true,
      subtree: true,
    });
  });

  await navigation.getByRole("button", { name: "次のクーポン" }).click();
  await expect(page.getByRole("heading", { name: "アイスの実 ぶどうマスカット" })).toBeVisible();
  await expect(page.getByLabel("全3件中 2件目")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__detailPageTransitions.slice(0, 3)))
    .toEqual(["idle", "leave-next", "enter-next"]);
});
