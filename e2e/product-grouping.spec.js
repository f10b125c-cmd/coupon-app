import { test, expect } from "@playwright/test";

const coupons = [
  { id: "cool-late", productName: "ロッテ クーリッシュ バニラ", expiresAt: "2026-09-20" },
  { id: "choco", productName: "チョコモナカジャンボ", expiresAt: "2026-09-13" },
  { id: "ice", productName: "アイスの実 ぶどうマスカット", expiresAt: "2026-09-11" },
  { id: "cool-soon", productName: "【お持ち帰り限定】クーリッシュ バニラ（税込194円）", expiresAt: "2026-09-12" },
  { id: "tako-one", productName: "サントリー こだわり酒場のタコハイ 1本", expiresAt: "2026-09-14" },
  { id: "tako-plain", productName: "こだわり酒場のタコハイ", expiresAt: "2026-09-15" },
  { id: "sui-500", productName: "翠ジンソーダ 500ml缶", expiresAt: "2026-09-17" },
  { id: "sui-350", productName: "サントリー 翠ジンソーダ 350ml缶", expiresAt: "2026-09-16" },
].map((coupon, index) => ({
  ...coupon,
  imageDataUrl: null,
  productImageDataUrl: null,
  barcodeImageDataUrl: null,
  couponPreviewImageDataUrl: null,
  store: "lawson",
  barcode: "",
  memo: "",
  status: "unused",
  inbox: false,
  autoScanned: true,
  createdAt: `2026-09-0${index + 1}T00:00:00Z`,
  updatedAt: `2026-09-0${index + 1}T00:00:00Z`,
}));

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-09T00:00:00Z"));
  await page.addInitScript((initialCoupons) => {
    localStorage.removeItem("coupons:sortKey");
    localStorage.removeItem("coupons:productGroupSortV1");
    window.__productGroupingCoupons = initialCoupons;
  }, coupons);
  await page.route(/https:\/\/[^/]*(?:googleapis\.com|firebaseio\.com)\//, (route) => {
    if (route.request().url().startsWith("https://fonts.googleapis.com/")) return route.continue();
    return route.abort();
  });
  await page.route("**/src/cloudStore.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        export async function subscribeCoupons(fn) { fn(window.__productGroupingCoupons); return () => {}; }
        export async function saveCouponToCloud() { throw new Error("Writes forbidden"); }
        export async function deleteCouponFromCloud() { throw new Error("Deletion forbidden"); }
        export async function compressImageForStorage(data) { return data; }
      `,
    })
  );
  await page.goto("/");
});

test("同じ商品を一覧とスワイプ順で隣り合わせにする", async ({ page }) => {
  await expect(page.getByLabel("並び順")).toHaveValue("product");
  await expect(page.getByLabel("並び順").locator("option:checked")).toHaveText(
    "同じ商品をまとめる"
  );

  expect(
    await page.locator("button[data-coupon-id]").evaluateAll((cards) =>
      cards.map((card) => card.dataset.couponId)
    )
  ).toEqual([
    "ice",
    "cool-soon",
    "cool-late",
    "choco",
    "tako-one",
    "tako-plain",
    "sui-350",
    "sui-500",
  ]);

  await page.locator('button[data-coupon-id="cool-soon"]').click();
  await expect(page.getByLabel("全8件中 2件目")).toBeVisible();
  await page.locator(".sheet").evaluate((sheet) => {
    const dispatchTouch = (type, clientX) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, type === "touchstart" ? "touches" : "changedTouches", {
        value: [{ clientX, clientY: 320 }],
      });
      sheet.dispatchEvent(event);
    };
    dispatchTouch("touchstart", 330);
    dispatchTouch("touchend", 80);
  });

  await expect(page.getByRole("heading", { name: "ロッテ クーリッシュ バニラ" })).toBeVisible();
  await expect(page.getByLabel("全8件中 3件目")).toBeVisible();
});
