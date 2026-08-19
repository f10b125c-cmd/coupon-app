import test from "node:test";
import assert from "node:assert/strict";

import {
  detectStoreFromBarcode,
  extractBarcodeNumberGuess,
  extractExpiryDate,
  extractProductNameGuess,
} from "./scan.js";

function lines(...texts) {
  return texts.map((text, index) => ({
    text,
    y: 10 + index * 18,
    y1: 24 + index * 18,
  }));
}

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
  const ocrTexts = [
    "店 贈 利 用 期限 2026708724 23:59 まで",
    "| 店 鞭 判 用 其 昌 | 2026/0S/24 23:59 まで",
    "店 舗 利用 誠 限 2026/08/24 23:59 まで",
    "uu 芽 2026/08/2423559 ま で",
    "uuUL 其 癌 2026708/2423:59 まで",
  ];

  for (const text of ocrTexts) {
    assert.equal(extractExpiryDate(text), "2026-08-24");
  }
});

test("既存の日付パターンも従来どおり読む", () => {
  assert.equal(extractExpiryDate("利用期間 2026/08/01〜2026/08/31"), "2026-08-31");
});
