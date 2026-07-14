import crypto from "node:crypto";
import sharp from "sharp";
import { getDb } from "./_lib/firebaseAdmin.js";

// 家族LINEグループに投稿されたクーポン画像を受け取り、
// アプリの「未整理」としてFirestoreに登録するwebhook。
// LINE Developersコンソールで Webhook URL に /api/line-webhook を設定して使う。

const HOUSEHOLD_ID = process.env.HOUSEHOLD_ID || "LjsGkL-TYePy";

// クライアントの compressImageForStorage と同じ目標（dataURL文字列長 ≤ 700KB、
// Firestoreの1MiB/ドキュメント制限対策）。ただしLINE経由はこの圧縮後画像しか
// アプリに残らず、これがバーコード読み取りの素材になるため、
// まず品質を下げ、寸法の縮小は最後の手段にして細い線を守る。
const MAX_DATA_URL_CHARS = 700 * 1024;

function verifySignature(rawBody, signature, channelSecret) {
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function compressToDataUrl(buffer) {
  let dim = 1600;
  let lastDataUrl = null;
  for (const quality of [85, 75, 65, 55, 45]) {
    const out = await sharp(buffer)
      .rotate() // EXIFの向きを反映してから保存する
      .resize({ width: dim, height: dim, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    lastDataUrl = `data:image/jpeg;base64,${out.toString("base64")}`;
    if (lastDataUrl.length <= MAX_DATA_URL_CHARS) return lastDataUrl;
    if (quality <= 55) dim = Math.round(dim * 0.85);
  }
  // 品質を下げ切っても収まらない場合の最終手段
  const out = await sharp(buffer)
    .rotate()
    .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 40, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

async function fetchLineImage(messageId, accessToken) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`LINE content API failed: ${res.status} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function saveCouponFromLine(db, messageId, imageDataUrl) {
  const now = new Date().toISOString();
  const id = `line-${messageId}`;
  // アプリ側のデータモデル（App.jsx quickAdd）と互換の形で保存する。
  // autoScanned:false なので「まとめて自動読み取り」の対象になる。
  await db.doc(`households/${HOUSEHOLD_ID}/coupons/${id}`).set({
    id,
    title: "",
    productName: "",
    sourceType: "screenshot",
    url: "",
    imageDataUrl,
    expiresAt: "",
    store: "",
    barcode: "",
    autoScanned: false,
    inbox: true,
    status: "unused",
    memo: "",
    createdAt: now,
    updatedAt: now,
    usedAt: null,
    source: "line",
  });
}

export async function POST(request) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelSecret || !accessToken) {
    console.error("[line-webhook] LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN が未設定です");
    return new Response("Server not configured", { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  if (!verifySignature(rawBody, signature, channelSecret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let events;
  try {
    events = JSON.parse(rawBody).events || [];
  } catch (e) {
    return new Response("Bad request", { status: 400 });
  }

  const targetGroupId = process.env.LINE_TARGET_GROUP_ID || "";
  let okCount = 0;
  let failCount = 0;

  for (const event of events) {
    // botがグループに招待された時にgroupIdをログへ出す（初回セットアップ用）
    if (event.type === "join" && event.source?.type === "group") {
      console.log("[line-webhook] joined group. groupId:", event.source.groupId);
      continue;
    }
    if (event.type !== "message" || event.message?.type !== "image") continue;
    if (event.source?.type !== "group") continue;
    if (!targetGroupId) {
      // LINE_TARGET_GROUP_ID 未設定の間は登録せず、設定用にgroupIdだけ知らせる
      console.log("[line-webhook] LINE_TARGET_GROUP_ID未設定のためskip. groupId:", event.source.groupId);
      continue;
    }
    if (event.source.groupId !== targetGroupId) continue;

    try {
      const db = getDb();
      const docRef = db.doc(`households/${HOUSEHOLD_ID}/coupons/line-${event.message.id}`);
      // webhookは同じイベントが再配送されることがあるため、登録済みならskip
      if ((await docRef.get()).exists) continue;

      const image = await fetchLineImage(event.message.id, accessToken);
      const dataUrl = await compressToDataUrl(image);
      await saveCouponFromLine(db, event.message.id, dataUrl);
      okCount++;
      console.log("[line-webhook] saved coupon line-" + event.message.id);
    } catch (e) {
      failCount++;
      console.error("[line-webhook] 取り込みに失敗しました", event.message?.id, e);
    }
  }

  // 全滅時のみ500を返してLINE側の再配送に期待する（部分成功は200）
  if (failCount > 0 && okCount === 0) {
    return new Response("Failed", { status: 500 });
  }
  return new Response("OK", { status: 200 });
}
