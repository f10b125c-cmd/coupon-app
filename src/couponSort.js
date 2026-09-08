function timestamp(raw, fallback) {
  const value = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function expiryMs(coupon) {
  return timestamp(coupon?.expiresAt, Infinity);
}

function createdMs(coupon) {
  return timestamp(coupon?.createdAt || coupon?.updatedAt, 0);
}

// OCRや手入力で付きやすい券種・メーカー・価格表記を除き、同じ商品を
// 並べて比較するためのキーにする。容量・味・度数など商品差は残す。
export function normalizeProductGroupKey(productName) {
  return String(productName || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/【?\s*お持ち帰り限定\s*】?/g, "")
    .replace(/[（(]?\s*税込?\s*\d+(?:\.\d+)?\s*円\s*[）)]?/g, "")
    .replace(/(?:いずれか)?\s*\d*\s*本\s*(?:無料)?\s*引(?:き)?換(?:え)?(?:券|クーポン)?/g, "")
    .replace(/(?:無料)?\s*引(?:き)?換(?:え)?(?:券|クーポン)/g, "")
    .replace(/(?:ロッテ|サントリー|アサヒ|キリン|森永乳業|森永製菓|赤城乳業)/g, "")
    .replace(/[^\p{L}\p{N}%]+/gu, "");
}

function compareWithinProduct(a, b) {
  const aExpiry = expiryMs(a);
  const bExpiry = expiryMs(b);
  if (aExpiry !== bExpiry) {
    if (!Number.isFinite(aExpiry)) return 1;
    if (!Number.isFinite(bExpiry)) return -1;
    return aExpiry - bExpiry;
  }
  return createdMs(b) - createdMs(a);
}

// 同じ商品を必ず連続させつつ、期限が最も近い券を持つ商品グループから並べる。
// 商品名未設定の券はすべてを同一商品とはみなさず、1件ずつ独立させる。
export function sortCouponsByProduct(coupons) {
  const groups = new Map();

  coupons.forEach((coupon, index) => {
    const normalizedName = normalizeProductGroupKey(coupon.productName);
    const key = normalizedName
      ? `product:${normalizedName}`
      : `unnamed:${coupon.id || index}`;
    const group = groups.get(key) || {
      key,
      normalizedName,
      items: [],
      earliestExpiry: Infinity,
      latestCreated: 0,
    };
    group.items.push(coupon);
    group.earliestExpiry = Math.min(group.earliestExpiry, expiryMs(coupon));
    group.latestCreated = Math.max(group.latestCreated, createdMs(coupon));
    groups.set(key, group);
  });

  return [...groups.values()]
    .sort((a, b) => {
      const expiryDifference = a.earliestExpiry - b.earliestExpiry;
      if (Number.isFinite(expiryDifference) && expiryDifference !== 0) {
        return expiryDifference;
      }
      if (a.earliestExpiry !== b.earliestExpiry) {
        return Number.isFinite(a.earliestExpiry) ? -1 : 1;
      }
      if (a.latestCreated !== b.latestCreated) return b.latestCreated - a.latestCreated;
      return a.normalizedName.localeCompare(b.normalizedName, "ja");
    })
    .flatMap((group) => group.items.sort(compareWithinProduct));
}
