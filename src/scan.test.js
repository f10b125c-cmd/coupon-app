import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateBarcodeCropRect,
  detectLinearBarcodeCropRect,
  detectStoreFromBarcode,
  extractBarcodeNumberGuess,
  extractExpiryDate,
  extractProductNameGuess,
  normalizeStoreKey,
} from "./scan.js";

function lines(...texts) {
  return texts.map((text, index) => ({
    text,
    y: 10 + index * 18,
    y1: 24 + index * 18,
  }));
}

test("検出したバーコード座標へ余白を足して画像内に収まる範囲を作る", () => {
  assert.deepEqual(
    calculateBarcodeCropRect(750, 1334, [
      { x: 180, y: 190 },
      { x: 570, y: 194 },
    ]),
    { sourceX: 117, sourceY: 106, sourceWidth: 515, sourceHeight: 172 }
  );

  const edgeCrop = calculateBarcodeCropRect(400, 300, [
    { x: 8, y: 25 },
    { x: 360, y: 25 },
  ]);
  assert.equal(edgeCrop.sourceX, 0);
  assert.equal(edgeCrop.sourceY, 0);
  assert.ok(edgeCrop.sourceWidth <= 400);
  assert.ok(edgeCrop.sourceHeight <= 300);
});

test("番号を復号できなくても縦線群からバーコード領域を見つける", () => {
  const width = 400;
  const height = 300;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 90; y <= 145; y++) {
    for (let x = 95; x <= 305; x++) {
      if (Math.floor((x - 95) / 3) % 2 === 0) {
        const offset = (y * width + x) * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
      }
    }
  }

  const crop = detectLinearBarcodeCropRect({ data, width, height });
  assert.ok(crop.sourceX < 95);
  assert.ok(crop.sourceY < 90);
  assert.ok(crop.sourceX + crop.sourceWidth > 305);
  assert.ok(crop.sourceY + crop.sourceHeight > 145);
});

test("横長でも黒白の反復がない文字帯はバーコードにしない", () => {
  const width = 400;
  const height = 300;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  // 暗い帯に数本だけ明るい矩形がある状態を、期限バナーの文字として模擬する。
  for (let y = 100; y <= 140; y++) {
    for (let x = 60; x <= 340; x++) {
      const lightLetter = [100, 145, 190, 235, 280].some(
        (start) => x >= start && x < start + 12
      );
      const value = lightLetter ? 255 : 80;
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
    }
  }
  assert.equal(detectLinearBarcodeCropRect({ data, width, height }), null);
});

test("ファミマの外部店舗キーを画面の内部キーへ揃える", () => {
  assert.equal(normalizeStoreKey("familymart"), "famima");
  assert.equal(normalizeStoreKey("famima"), "famima");
  assert.equal(normalizeStoreKey("lawson"), "lawson");
});

test("ローソンお持ち帰り限定券の商品名を上部見出しから読む", () => {
  assert.equal(
    extractProductNameGuess(
      lines("【 お 持ち 帰り 具 定 】 クー リッ シュ バニ ラ", "(税込 194 円 ) 角 料 引換 券")
    ),
    "【お持ち帰り限定】 クーリッシュ バニラ(税込194円)"
  );

  assert.equal(
    extractProductNameGuess(
      lines("【 お 持ち 需 り 骨 定 】 ア イス の 実 ぶどう マス カ", "ッ ト (税込 184 円 ) 衣 料 引 招 三")
    ),
    "【お持ち帰り限定】 アイスの実 ぶどうマスカット(税込184円)"
  );

  assert.equal(
    extractProductNameGuess(
      lines("【 お 持ち 帰り 限定 】 チ ョ コモ ナカ ジャ ン ポ", "(税込 194 円 ) 無料 引換 券")
    ),
    "【お持ち帰り限定】 チョコモナカジャンボ(税込194円)"
  );

  // 読み取れていたガリガリ君も同じ券面。違いはレイアウトではなくOCRの崩れ方。
  assert.equal(
    extractProductNameGuess(
      lines("【 お 持ち 帰り 限定 】 ガリ ガリ 君 ソー ダ", "（税込97円）無料引換券")
    ),
    "【お持ち帰り限定】 ガリガリ君ソーダ(税込97円)"
  );
});

test("既存の鉤括弧パターンも従来どおり読む", () => {
  assert.equal(
    extractProductNameGuess(lines("「ガリガリ君ソーダ」無料引換券")),
    "ガリガリ君ソーダ"
  );
});

test("翠ジンソーダの先頭が崩れても特徴的な後半表記から復元する", () => {
  assert.equal(
    extractProductNameGuess(lines("BYYY =H〈本格濃いめ〉500ml缶 1本無")),
    "翠ジンソーダ〈本格濃いめ〉500ml缶"
  );
  assert.equal(extractProductNameGuess(lines("すいじんそーだ")), "翠ジンソーダ");
});

test("ローソン券の空白区切り17桁バーコードを検出する", () => {
  const printedNumbers = [
    "8222 0052 4251 5844 4",
    "2540_ 0O054 DI151 5846 0",
    "3208 0050 2851 5845 0",
  ];

  for (const printed of printedNumbers) {
    const barcode = extractBarcodeNumberGuess(`ローソン\n${printed}\n店舗利用期限`);
    assert.equal(barcode.length, 17);
    assert.equal(detectStoreFromBarcode(barcode), "lawson");
  }
});

test("ローソン券の店舗利用期限をOCRの崩れから復元する", () => {
  const currentYear = String(new Date().getFullYear());
  const ocrTexts = [
    "店 贈 利 用 期限 2026708724 23:59 まで",
    "| 店 鞭 判 用 其 昌 | 2026/0S/24 23:59 まで",
    "店 舗 利用 誠 限 2026/08/24 23:59 まで",
    "uu 芽 2026/08/2423559 ま で",
    "uuUL 其 癌 2026708/2423:59 まで",
    // 実画像では「まで」が xc に崩れ、区切りも数字へ誤認された。
    "GLULLI 2026108242359 xc |",
    // 高コントラスト期限OCRは数字と区切りだけを返すことがある。
    "202608242359",
  ];

  for (const text of ocrTexts) {
    assert.equal(extractExpiryDate(text), "2026-08-24");
  }

  assert.equal(
    extractExpiryDate("uuUL 其 癌 2075/08/2423:59 ま で"),
    `${currentYear}-08-24`
  );
});

test("既存の日付パターンも従来どおり読む", () => {
  assert.equal(extractExpiryDate("利用期間 2026/08/01〜2026/08/31"), "2026-08-31");
});
