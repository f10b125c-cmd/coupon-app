import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
} from "firebase/firestore";
import { db, HOUSEHOLD_ID, ensureSignedIn } from "./firebase.js";

function couponsCollection() {
  return collection(db, "households", HOUSEHOLD_ID, "coupons");
}

// Firestoreの1ドキュメント上限(1MiB)に収まるよう、画像を段階的に圧縮する。
// Storage（要課金プラン）を使わず、画像をドキュメントに直接埋め込むための対策。
export function compressImageForStorage(dataUrl, maxBytes = 700 * 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let dim = 1400;
      let quality = 0.75;
      let result = dataUrl;
      for (let attempt = 0; attempt < 7; attempt++) {
        const scale = Math.min(1, dim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        result = canvas.toDataURL("image/jpeg", quality);
        if (result.length <= maxBytes) break;
        dim = Math.round(dim * 0.8);
        quality = Math.max(0.35, quality - 0.1);
      }
      resolve(result);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export async function subscribeCoupons(onChange, onError) {
  await ensureSignedIn();
  return onSnapshot(
    couponsCollection(),
    (snapshot) => {
      const list = snapshot.docs.map((d) => d.data());
      onChange(list);
    },
    onError
  );
}

export async function saveCouponToCloud(coupon) {
  await ensureSignedIn();
  await setDoc(doc(couponsCollection(), coupon.id), coupon);
}

export async function deleteCouponFromCloud(id) {
  await ensureSignedIn();
  await deleteDoc(doc(couponsCollection(), id));
}
