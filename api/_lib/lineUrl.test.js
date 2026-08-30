import test from "node:test";
import assert from "node:assert/strict";
import { extractFamimaCouponDetails, extractHttpUrls, extractPageMetadata, fetchUrlPreview, findFamimaProductImage } from "./lineUrl.js";

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
    <img class="couponImg" alt="商品画像" src="/products/riku.png">
    <img class="barcode" src="/barcode.png">
  </main>`;
  assert.equal(
    findFamimaProductImage(html, "https://ncpfa.famima.com/contents/coupon.html", "キリン陸ハイボール 350ml缶（税込206円）"),
    "https://ncpfa.famima.com/products/riku.png"
  );
});
