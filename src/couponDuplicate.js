function normalizeCodeType(value) {
  return value === "qr" ? "qr" : value === "barcode" ? "barcode" : "";
}

function normalizeBarcode(value) {
  return String(value || "").replace(/\D/g, "");
}

// Partial suffix matches are too ambiguous for a warning: unrelated coupon
// barcodes can share their last few digits. Only a complete normalized code
// match is strong enough to be treated as a duplicate.
export function findDuplicateCoupon(coupons, barcode, excludeId, codeType = "barcode") {
  if (normalizeCodeType(codeType) === "qr") {
    const target = String(barcode || "").trim();
    if (!target) return null;
    return (
      coupons.find(
        (coupon) =>
          coupon.id !== excludeId &&
          normalizeCodeType(coupon.codeType) === "qr" &&
          String(coupon.barcode || "").trim() === target
      ) || null
    );
  }

  const target = normalizeBarcode(barcode);
  if (!target) return null;
  return (
    coupons.find(
      (coupon) =>
        coupon.id !== excludeId &&
        normalizeCodeType(coupon.codeType) !== "qr" &&
        normalizeBarcode(coupon.barcode) === target
    ) || null
  );
}
