import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const FULL_IMAGE = "data:image/jpeg;base64,AA==";
const CROPPED_BARCODE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=";
const CROPPED_PRODUCT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/58BAQEDAQAIicLsAAAAAElFTkSuQmCC";
const require = createRequire(import.meta.url);
const QRCodeWriter = require("../node_modules/@zxing/library/cjs/core/qrcode/QRCodeWriter.js").default;
const BarcodeFormat = require("../node_modules/@zxing/library/cjs/core/BarcodeFormat.js").default;

function makeQrSvgDataUrl(text, size = 360) {
  const matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, new Map());
  const cells = [];
  for (let y = 0; y < matrix.getHeight(); y++) {
    for (let x = 0; x < matrix.getWidth(); x++) {
      if (matrix.get(x, y)) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${matrix.getWidth()} ${matrix.getHeight()}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><g fill="black">${cells.join("")}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

test("未切り出しの画像は詳細を開いた時にバーコードと商品部分を表示・保存する", async ({ page }) => {
  await page.addInitScript(({ fullImage, croppedBarcode, croppedProduct }) => {
    window.__autoCropCalls = 0;
    window.__autoCropWrites = [];
    window.__autoCropResult = croppedBarcode;
    window.__autoProductCropResult = croppedProduct;
    window.__autoCropCoupon = {
      id: "auto-crop",
      productName: "クーリッシュ バニラ",
      imageDataUrl: fullImage,
      productImageDataUrl: null,
      barcodeImageDataUrl: null,
      couponPreviewImageDataUrl: null,
      expiresAt: "2099-09-22",
      store: "lawson",
      barcode: "82220052425158444",
      memo: "変更しないメモ",
      status: "unused",
      inbox: false,
      autoScanned: true,
      createdAt: "2026-09-07T00:00:00Z",
      updatedAt: "2026-09-07T00:00:00Z",
    };
  }, { fullImage: FULL_IMAGE, croppedBarcode: CROPPED_BARCODE, croppedProduct: CROPPED_PRODUCT });

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
        return {
          text: window.__autoCropCoupon.barcode,
          codeType: "barcode",
          barcodeImageDataUrl: window.__autoCropResult,
          couponPreviewImageDataUrl: window.__autoProductCropResult,
        };
      }
    `;
    await route.fulfill({ response, body });
  });

  await page.goto("/");
  // 商品名はカード本体と title 属性の両方に現れるため、カードの識別子で開く。
  await page.locator('button[data-coupon-id="auto-crop"]').click();

  await expect(page.getByRole("img", { name: "バーコード", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "クーリッシュ バニラ", exact: true })).toBeVisible();
  await expect(page.getByText("商品部分（自動切り出し）", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__autoCropWrites.length)).toBe(1);

  const result = await page.evaluate(() => ({
    calls: window.__autoCropCalls,
    saved: window.__autoCropWrites[0],
  }));
  expect(result.calls).toBe(1);
  expect(result.saved.barcodeImageDataUrl).toBe(CROPPED_BARCODE);
  expect(result.saved.codeType).toBe("barcode");
  expect(result.saved.couponPreviewImageDataUrl).toBe(CROPPED_PRODUCT);
  expect(result.saved.imageDataUrl).toBe(FULL_IMAGE);
  expect(result.saved.productName).toBe("クーリッシュ バニラ");
  expect(result.saved.expiresAt).toBe("2099-09-22");
  expect(result.saved.memo).toBe("変更しないメモ");
});

test("QRコードを判別し、上下を切らず正方形で切り出す", async ({ page }) => {
  const qrText = "https://example.sushiro.jp/coupon/1000";
  const qrDataUrl = makeQrSvgDataUrl(qrText);

  await page.route(/https:\/\/[^/]*(?:googleapis\.com|firebaseio\.com)\//, (route) => {
    if (route.request().url().startsWith("https://fonts.googleapis.com/")) return route.continue();
    return route.abort();
  });
  await page.goto("/");

  const result = await page.evaluate(async ({ imageDataUrl }) => {
    const { scanBarcodeWithCrop } = await import("/src/scan.js");
    const scanned = await scanBarcodeWithCrop(imageDataUrl);
    const dimensions = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = reject;
      image.src = scanned.barcodeImageDataUrl;
    });
    return { ...scanned, dimensions };
  }, { imageDataUrl: qrDataUrl });

  expect(result.text).toBe(qrText);
  expect(result.codeType).toBe("qr");
  expect(result.barcodeImageDataUrl).toMatch(/^data:image\//);
  expect(result.dimensions.width).toBe(result.dimensions.height);
});

test("実画像でもバーコードの反対側を商品プレビューにできる", async ({ page }, testInfo) => {
  const imagePaths = (process.env.COUPON_CROP_IMAGES || "").split(":").filter(Boolean);
  test.skip(!imagePaths.length, "実画像はGitに含めず環境変数で指定する");
  test.setTimeout(180_000);

  await page.route(/https:\/\/[^/]*(?:googleapis\.com|firebaseio\.com)\//, (route) => {
    if (route.request().url().startsWith("https://fonts.googleapis.com/")) return route.continue();
    return route.abort();
  });
  await page.goto("/");

  for (const imagePath of imagePaths) {
    const dataUrl = `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString("base64")}`;
    const result = await page.evaluate(async (imageDataUrl) => {
      const { scanBarcodeWithCrop } = await import("/src/scan.js");
      const cropped = await scanBarcodeWithCrop(imageDataUrl);
      const dimensions = await Promise.all(
        [imageDataUrl, cropped.couponPreviewImageDataUrl].map(
          (src) =>
            new Promise((resolve, reject) => {
              const image = new Image();
              image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
              image.onerror = reject;
              image.src = src;
            })
        )
      );
      return { ...cropped, dimensions };
    }, dataUrl);

    expect(result.barcodeImageDataUrl).toMatch(/^data:image\//);
    expect(result.couponPreviewImageDataUrl).toMatch(/^data:image\//);
    expect(result.couponPreviewImageDataUrl.length).toBeLessThanOrEqual(90 * 1024);
    expect(result.dimensions[1].height).toBeLessThan(result.dimensions[0].height);
    await testInfo.attach(`商品プレビュー-${path.basename(imagePath)}`, {
      contentType: result.couponPreviewImageDataUrl.match(/^data:([^;,]+)/)?.[1] || "image/jpeg",
      body: Buffer.from(result.couponPreviewImageDataUrl.split(",")[1], "base64"),
    });
    if (process.env.COUPON_CROP_OUTPUT_DIR) {
      fs.mkdirSync(process.env.COUPON_CROP_OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(process.env.COUPON_CROP_OUTPUT_DIR, `preview-${path.basename(imagePath)}`),
        Buffer.from(result.couponPreviewImageDataUrl.split(",")[1], "base64")
      );
    }
  }
});
