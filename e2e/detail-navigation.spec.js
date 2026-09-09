import { test, expect } from "@playwright/test";

const imageDataUrl = (width, height, fill) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${fill}"/></svg>`
  )}`;
const BARCODE_IMAGE = imageDataUrl(900, 240, "white");
const COUPON_IMAGE = imageDataUrl(650, 820, "lightblue");

const coupons = [
  { id: "nav-1", productName: "クーリッシュ バニラ", expiresAt: "2026-09-22" },
  { id: "nav-2", productName: "アイスの実 ぶどうマスカット", expiresAt: "2026-09-23" },
  { id: "nav-3", productName: "チョコモナカジャンボ", expiresAt: "2026-09-24" },
].map((coupon) => ({
  ...coupon,
  imageDataUrl: BARCODE_IMAGE,
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
    window.__savedCoupons = [];
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
        export async function saveCouponToCloud(coupon) { window.__savedCoupons.push(coupon); }
        export async function deleteCouponFromCloud() { throw new Error("Deletion forbidden"); }
        export async function compressImageForStorage(data) { return data; }
      `,
    })
  );
  await page.goto("/");
});

test("詳細画面は件数だけを表示し、スワイプで前後移動する", async ({ page }) => {
  await page.getByText("クーリッシュ バニラ", { exact: true }).click();

  const couponImage = page.getByRole("img", { name: "クーリッシュ バニラ", exact: true });
  const barcodeImage = page.getByRole("img", { name: "バーコード", exact: true });
  const positionBadge = page.getByLabel("全3件中 1件目");
  await expect(positionBadge).toBeVisible();
  await expect(page.getByRole("button", { name: "前のクーポン" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "次のクーポン" })).toHaveCount(0);
  await expect(page.getByText("左右にスワイプしても移動できます")).toHaveCount(0);
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
  const usedButton = page.getByRole("button", { name: "使用済みにする", exact: true });
  const rescanButton = page.getByRole("button", { name: "読み取り直す", exact: true });
  const editButton = page.getByRole("button", { name: "編集する", exact: true });
  const closeButton = page.getByRole("button", { name: "閉じる", exact: true });
  const [usedBox, rescanBox, editBox, closeBox] = await Promise.all([
    usedButton.boundingBox(),
    rescanButton.boundingBox(),
    editButton.boundingBox(),
    closeButton.boundingBox(),
  ]);
  expect(Math.abs(usedBox.y - editBox.y)).toBeLessThan(8);
  expect(Math.abs(editBox.y - closeBox.y)).toBeLessThan(8);
  expect(editBox.x).toBeGreaterThan(usedBox.x + usedBox.width);
  expect(closeBox.x).toBeGreaterThan(editBox.x + editBox.width);
  expect(editBox.y).toBeGreaterThan(statusBox.y + statusBox.height);
  expect(rescanBox.y).toBeGreaterThan(usedBox.y + usedBox.height);
  expect(
    await couponImage.evaluate((image) => {
      const rescan = image.closest(".sheet")?.querySelector('button[aria-label="読み取り直す"]');
      return Boolean(rescan && image.compareDocumentPosition(rescan) & Node.DOCUMENT_POSITION_FOLLOWING);
    })
  ).toBe(true);
  expect((await page.locator(".sheet").boundingBox()).y).toBeLessThan(24);

  await editButton.click();
  const autoReadBox = await page.getByRole("button", { name: "画像から自動読み取り", exact: true }).boundingBox();
  const editingCloseBox = await page.getByRole("button", { name: "編集画面を閉じる", exact: true }).boundingBox();
  expect(Math.abs(autoReadBox.y - editingCloseBox.y)).toBeLessThan(8);
  expect(editingCloseBox.x).toBeGreaterThan(autoReadBox.x + autoReadBox.width);
  await page.getByRole("button", { name: "編集画面を閉じる", exact: true }).click();

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

  await page.locator(".sheet").evaluate((sheet) => {
    const dispatchTouch = (type, clientX) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touches = [{ clientX, clientY: 320 }];
      Object.defineProperty(event, type === "touchstart" ? "touches" : "changedTouches", {
        value: touches,
      });
      sheet.dispatchEvent(event);
    };
    dispatchTouch("touchstart", 330);
    dispatchTouch("touchend", 80);
  });
  await expect(page.getByRole("heading", { name: "アイスの実 ぶどうマスカット" })).toBeVisible();
  await expect(page.getByLabel("全3件中 2件目")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__detailPageTransitions.slice(0, 3)))
    .toEqual(["idle", "leave-next", "enter-next"]);
});

test("使用済みボタンは詳細を閉じず次のクーポンへ進む", async ({ page }) => {
  await page.getByText("クーリッシュ バニラ", { exact: true }).click();
  await expect(page.getByText("上へスワイプで使用済み")).toHaveCount(0);
  await expect(page.locator("[data-use-swipe-handle]")).toHaveCount(0);
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

  await page.getByRole("button", { name: "使用済みにする", exact: true }).click();

  await expect(page.getByRole("heading", { name: "アイスの実 ぶどうマスカット" })).toBeVisible();
  await expect(page.locator(".sheet")).toBeVisible();
  await expect(page.getByLabel("全2件中 1件目")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__savedCoupons.map((coupon) => [coupon.id, coupon.status])))
    .toEqual([["nav-1", "used"]]);
  await expect
    .poll(() => page.evaluate(() => window.__detailPageTransitions.slice(0, 3)))
    .toEqual(["idle", "leave-used", "enter-used"]);

  await page.getByRole("button", { name: "使用済みにする", exact: true }).click();
  await expect(page.getByRole("heading", { name: "チョコモナカジャンボ" })).toBeVisible();
  await expect(page.locator(".sheet")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__savedCoupons.map((coupon) => [coupon.id, coupon.status])))
    .toEqual([
      ["nav-1", "used"],
      ["nav-2", "used"],
    ]);

  // 最後の1枚は次がないため、使用済み表示へ変えて詳細を開いたままにする。
  await page.getByRole("button", { name: "使用済みにする", exact: true }).click();
  await expect(page.getByRole("heading", { name: "チョコモナカジャンボ" })).toBeVisible();
  await expect(page.locator(".sheet").getByText("使用済み", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "未使用に戻す" })).toBeVisible();
  await expect(page.locator(".sheet")).toBeVisible();
});
