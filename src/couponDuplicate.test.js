import test from "node:test";
import assert from "node:assert/strict";

import { findDuplicateCoupon } from "./couponDuplicate.js";

test("区切り記号が違ってもバーコード全体が一致すれば重複と判定する", () => {
  const coupons = [{ id: "existing", codeType: "barcode", barcode: "490-1234-567890" }];

  assert.equal(findDuplicateCoupon(coupons, "4901234567890", "new")?.id, "existing");
});

test("末尾5桁だけが一致する別バーコードは重複と判定しない", () => {
  const coupons = [{ id: "muscat", codeType: "barcode", barcode: "4901234567890" }];

  assert.equal(findDuplicateCoupon(coupons, "4987654567890", "new"), null);
});

test("編集中の自分自身やQRコードをバーコード重複に含めない", () => {
  const coupons = [
    { id: "current", codeType: "barcode", barcode: "4901234567890" },
    { id: "qr", codeType: "qr", barcode: "4901234567890" },
  ];

  assert.equal(findDuplicateCoupon(coupons, "4901234567890", "current"), null);
});

test("QRコードはQR同士で内容が完全一致した場合だけ重複とする", () => {
  const coupons = [
    { id: "qr-same", codeType: "qr", barcode: "https://example.test/coupon?id=123" },
    { id: "barcode", codeType: "barcode", barcode: "123" },
  ];

  assert.equal(
    findDuplicateCoupon(coupons, "https://example.test/coupon?id=123", "new", "qr")?.id,
    "qr-same"
  );
  assert.equal(findDuplicateCoupon(coupons, "https://example.test/coupon?id=12", "new", "qr"), null);
});
