import test from "node:test";
import assert from "node:assert/strict";

import { takePendingLineScanIds } from "./lineAutoScan.js";

test("未読取画像のLINEクーポンだけを1回だけ自動処理対象にする", () => {
  const coupons = [
    { id: "line-new", source: "line", inbox: true, imageDataUrl: "image", autoScanned: false },
    { id: "line-done", source: "line", inbox: true, imageDataUrl: "image", autoScanned: true },
    { id: "line-no-image", source: "line", inbox: true, imageDataUrl: null, autoScanned: false },
    { id: "manual", source: "manual", inbox: true, imageDataUrl: "image", autoScanned: false },
  ];
  const attemptedIds = new Set();

  assert.deepEqual(takePendingLineScanIds(coupons, attemptedIds), ["line-new"]);
  assert.deepEqual(takePendingLineScanIds(coupons, attemptedIds), []);
});
