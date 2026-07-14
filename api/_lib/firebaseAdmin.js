import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// FIREBASE_SERVICE_ACCOUNT_B64 はサービスアカウントJSONをbase64エンコードした文字列。
// （private_keyの改行がVercel環境変数で壊れる事故を避けるためbase64で渡す）
function getDb() {
  if (!getApps().length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 is not set");
    const sa = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

export { getDb };
