// Claim each unscanned LINE image once per app session. Failed automatic scans
// remain eligible for the existing manual retry, but must not loop on snapshots.
export function takePendingLineScanIds(coupons, attemptedIds) {
  const ids = [];
  for (const coupon of coupons || []) {
    if (
      coupon?.source !== "line" ||
      !coupon.inbox ||
      !coupon.imageDataUrl ||
      coupon.autoScanned ||
      attemptedIds.has(coupon.id)
    ) {
      continue;
    }
    attemptedIds.add(coupon.id);
    ids.push(coupon.id);
  }
  return ids;
}
