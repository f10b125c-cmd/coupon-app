import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeProductGroupKey,
  sortCouponsByProduct,
} from "./couponSort.js";

test("券種・メーカー・価格・空白が違っても同じ商品キーに揃える", () => {
  assert.equal(
    normalizeProductGroupKey("【お持ち帰り限定】 クーリッシュ　バニラ（税込194円）無料引換券"),
    normalizeProductGroupKey("ロッテ クーリッシュ バニラ")
  );
  assert.equal(
    normalizeProductGroupKey("翠ジンソーダ 350ml缶"),
    normalizeProductGroupKey("翠ジンソーダ 500ml缶")
  );
  assert.notEqual(
    normalizeProductGroupKey("翠ジンソーダ 5% 350ml缶"),
    normalizeProductGroupKey("翠ジンソーダ 7% 500ml缶")
  );
  assert.notEqual(
    normalizeProductGroupKey("クーリッシュ バニラ 140ml"),
    normalizeProductGroupKey("クーリッシュ チョコ 140ml")
  );
});

test("末尾に券の数量1本が残っても同じ商品キーに揃える", () => {
  assert.equal(
    normalizeProductGroupKey("サントリー こだわり酒場のタコハイ 1本"),
    normalizeProductGroupKey("こだわり酒場のタコハイ")
  );
  assert.equal(
    normalizeProductGroupKey("こだわり酒場のタコハイ（一本）"),
    normalizeProductGroupKey("こだわり酒場のタコハイ")
  );
  assert.notEqual(
    normalizeProductGroupKey("1本満足バー"),
    normalizeProductGroupKey("満足バー")
  );
});

test("同じ商品を連続させ、商品グループ内は期限が近い順にする", () => {
  const coupons = [
    { id: "cool-late", productName: "ロッテ クーリッシュ バニラ", expiresAt: "2026-09-20" },
    { id: "choco", productName: "チョコモナカジャンボ", expiresAt: "2026-09-13" },
    { id: "ice", productName: "アイスの実 ぶどうマスカット", expiresAt: "2026-09-11" },
    { id: "cool-soon", productName: "【お持ち帰り限定】クーリッシュ バニラ（税込194円）", expiresAt: "2026-09-12" },
  ];

  assert.deepEqual(
    sortCouponsByProduct(coupons).map((coupon) => coupon.id),
    ["ice", "cool-soon", "cool-late", "choco"]
  );
});

test("商品名未設定の券は別々の券として追加が新しい順に扱う", () => {
  const coupons = [
    { id: "old", productName: "", createdAt: "2026-09-01T00:00:00Z" },
    { id: "new", productName: "", createdAt: "2026-09-02T00:00:00Z" },
  ];

  assert.deepEqual(
    sortCouponsByProduct(coupons).map((coupon) => coupon.id),
    ["new", "old"]
  );
});
