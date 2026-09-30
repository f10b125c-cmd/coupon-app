import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { extractFamimaCouponDetails, extractHttpUrls, extractPageMetadata, extractValueGiftDetails, fetchUrlPreview, findFamimaProductImage, isSupportedPreviewImage } from "./lineUrl.js";
import { couponIdForUrl, isReadyUrlCoupon } from "../line-webhook.js";

test("LINEテキストから通常URLを取り出す", () => {
  assert.deepEqual(
    extractHttpUrls("クーポンはこちら https://example.com/coupon?id=12。予備: https://example.net/a)"),
    ["https://example.com/coupon?id=12", "https://example.net/a"]
  );
});

test("同じURLは一度だけ登録する", () => {
  assert.deepEqual(
    extractHttpUrls("https://example.com/a https://example.com/a"),
    ["https://example.com/a"]
  );
});

test("Open Graphのタイトルと相対画像URLを取得する", () => {
  const html = `<!doctype html><html><head>
    <title>通常タイトル</title>
    <meta property="og:title" content="ローソン &amp; クーポン">
    <meta property="og:image" content="/images/coupon.png">
  </head></html>`;
  assert.deepEqual(extractPageMetadata(html, "https://example.com/path/page"), {
    title: "ローソン & クーポン",
    imageUrl: "https://example.com/images/coupon.png",
  });
});

test("OG情報がなければtitleとimage_srcを使う", () => {
  const html = `<html><head><title>  ページ\nタイトル  </title>
    <link href="../preview.jpg" rel="image_src">
  </head></html>`;
  assert.deepEqual(extractPageMetadata(html, "https://example.com/coupon/detail/"), {
    title: "ページ タイトル",
    imageUrl: "https://example.com/coupon/preview.jpg",
  });
});

test("プライベートIPのURLは取得しない", async () => {
  await assert.rejects(() => fetchUrlPreview("http://127.0.0.1/coupon"), /プライベートIP/);
});

test("ファミマのクーポン画面から商品名と有効期限を取得する", () => {
  const html = `<main>ファミリーマートクーポン　引換券 キリン陸ハイボール 350ml缶（税込206円） 有効期限：2026年09月07日(月) 23:59</main>`;
  assert.deepEqual(extractFamimaCouponDetails(html), {
    productName: "キリン陸ハイボール 350ml缶（税込206円）",
    expiresAt: "2026-09-07",
  });
});

test("ファミマの券面からバーコード以外の商品画像を選ぶ", () => {
  const html = `<main>
    <img class="logo" src="/logo.png">
    <img class="couponImg" alt="商品画像" src="/products/riku.png?signature=qr-random-token">
    <img class="barcode" src="/barcode.png">
  </main>`;
  assert.equal(
    findFamimaProductImage(html, "https://ncpfa.famima.com/contents/coupon.html", "キリン陸ハイボール 350ml缶（税込206円）"),
    "https://ncpfa.famima.com/products/riku.png?signature=qr-random-token"
  );
});

test("valuegiftの券名と利用期限を取得する", () => {
  const html = `<html><head>
    <title>27年9月期限 株主優待券 | 株式会社すかいらーくホールディングス</title>
    <meta property="og:title" content="株式会社すかいらーくホールディングス">
  </head><body>
    <div>27年9月期限 株主優待券</div><div>2027年9月30日 23時59分 まで有効</div>
  </body></html>`;
  assert.deepEqual(extractValueGiftDetails(html), {
    productName: "株式会社すかいらーくホールディングス 27年9月期限 株主優待券",
    expiresAt: "2027-09-30",
  });
});

test("octet-streamでも中身が画像なら券面画像として扱う", async () => {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).jpeg().toBuffer();
  assert.equal(await isSupportedPreviewImage(image, "application/octet-stream"), true);
  assert.equal(await isSupportedPreviewImage(Buffer.from("not an image"), "application/octet-stream"), false);
});

test("同じvaluegiftリンクの再投稿は同じクーポンIDになる", () => {
  const url = "https://valuegift.jp/g/skylark/sample-gift";
  assert.equal(couponIdForUrl("first-message", 0, url), couponIdForUrl("next-message", 2, url));
  assert.notEqual(couponIdForUrl("first-message", 0, url), couponIdForUrl("first-message", 0, `${url}-different`));
  assert.notEqual(couponIdForUrl("first-message", 0, "https://example.com/coupon"), couponIdForUrl("next-message", 0, "https://example.com/coupon"));
});

test("券名・期限・店舗と券面画像が揃ったURL券だけ未使用へ振り分ける", () => {
  const preview = { productName: "株主優待券", expiresAt: "2027-09-30", store: "other" };
  assert.equal(isReadyUrlCoupon(preview, null, "data:image/jpeg;base64,abc"), true);
  assert.equal(isReadyUrlCoupon({ ...preview, expiresAt: "" }, null, "data:image/jpeg;base64,abc"), false);
  assert.equal(isReadyUrlCoupon(preview, null, null), false);
});
