import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateBarcodeCropRect,
  calculateCouponPreviewCropRect,
  detectLinearBarcodeCropRect,
  detectStoreFromBarcode,
  extractBarcodeNumberGuess,
  extractExpiryDate,
  extractProductNameGuess,
  extractProductNameForRescan,
  findProductNameRetryRect,
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

test("バーコードの反対側にある広い領域を商品プレビューとして切り出す", () => {
  assert.deepEqual(
    calculateCouponPreviewCropRect(750, 1334, {
      sourceX: 120,
      sourceY: 210,
      sourceWidth: 510,
      sourceHeight: 180,
    }),
    { sourceX: 0, sourceY: 401, sourceWidth: 750, sourceHeight: 933 }
  );

  assert.deepEqual(
    calculateCouponPreviewCropRect(600, 1000, {
      sourceX: 80,
      sourceY: 760,
      sourceWidth: 440,
      sourceHeight: 140,
    }),
    { sourceX: 0, sourceY: 0, sourceWidth: 600, sourceHeight: 752 }
  );

  assert.equal(
    calculateCouponPreviewCropRect(600, 500, {
      sourceX: 100,
      sourceY: 190,
      sourceWidth: 400,
      sourceHeight: 120,
    }),
    null
  );
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

test("プレモルの実画像で、ロゴより商品名2行と容量の段落を優先する", () => {
  const productLines = [
    { text: "g ry =", y: 818, y1: 845 },
    { text: "PREMIUM J F M |", y: 933, y1: 972 },
    { text: "MALT'S i eg", y: 968, y1: 1029 },
    { text: "Py ン", y: 1162, y1: 1182 },
    { text: "ザ ・ プ レミ アム ・ モ ルツ /", y: 1202, y1: 1230 },
    { text: "ザ ・ プ レミ アム ・ モ ルツ 夕映 舌 る エー ル", y: 1242, y1: 1271 },
    { text: "350ml 缶", y: 1284, y1: 1312 },
    { text: "いずれ か 1 本 無料 引換 え ク ー ポ ン", y: 1358, y1: 1387 },
  ];
  const expected = "ザ・プレミアム・モルツ／ザ・プレミアム・モルツ〈ジャパニーズエール〉夕映香るエール 350ml缶";
  assert.equal(extractProductNameGuess(productLines), expected);
  assert.equal(extractProductNameGuess(productLines.map(line => ({
    ...line, text: line.text.replace("夕映 舌", "夕映 香"),
  }))), expected);
});

test("ジャパニーズエールの途中で改行された選択券も商品名全体で読む", () => {
  const expected = "ザ・プレミアム・モルツ／ザ・プレミアム・モルツ〈ジャパニーズエール〉夕映香るエール 350ml缶";
  for (const [first, second] of [
    ["〈ジ", "ャパニーズエール〉夕映香るエール 350ml和缶 1本無料引"],
    ["〈", "ヤャパニーズエール〉夕映香るエール 350ml缶 1本無料引"],
    ["〈ジャ", "パニーズエール〉夕映舌るエール 350ml缶 1本無料引換え"],
  ]) {
    assert.equal(extractProductNameGuess(lines(
      `ザ・プレミアム・モルツ/ザ・プレミアム・モルツ ${first}`,
      second,
    )), expected);
  }
});

test("プレモル選択券の専用補正を別商品・別容量・離れた段落へ使わない", () => {
  for (const texts of [
    ["ザ・プレミアム・モルツ／", "ザ・プレミアム・モルツ香るエール", "350ml缶"],
    ["ザ・プレミアム・モルツ／", "ザ・プレミアム・モルツ夕映香るエール", "500ml缶"],
    ["ジャパニーズエール"],
    ["夕映香るエール 350ml缶"],
  ]) {
    assert.ok(!extractProductNameGuess(lines(...texts)).includes("モルツ〈ジャパニーズエール〉夕映香るエール 350ml缶"));
  }
  assert.notEqual(extractProductNameGuess([
    {text: "ザ・プレミアム・モルツ／", y: 0, y1: 20},
    {text: "ザ・プレミアム・モルツ夕映香るエール350ml缶", y: 300, y1: 320},
  ]), "ザ・プレミアム・モルツ／ザ・プレミアム・モルツ〈ジャパニーズエール〉夕映香るエール 350ml缶");
});

test("実画像で〈ジャが(Jvになっても、下部説明2行を照合して復元する", () => {
  assert.equal(extractProductNameGuess([
    {text: "ザ ・ プ レミ アム ・ モ ルツ / ザ ・ プ レミ アム ・ モ ルツ (Jv", y: 1393, y1: 1414},
    {text: "パニ ー ズ エー ル 〉 夕映 香る エー ル 350ml 缶 1 本 無料 引換 え", y: 1426, y1: 1447},
  ]), "ザ・プレミアム・モルツ／ザ・プレミアム・モルツ〈ジャパニーズエール〉夕映香るエール 350ml缶");
});

test("容量が別行の商品段落を読むが、ロゴの断片だけでは商品名を作らない", () => {
  assert.equal(
    extractProductNameGuess(lines("g ry =", "レモンスカッシュ", "250ml 缶", "1本無料引換えクーポン")),
    "レモンスカッシュ 250ml缶"
  );
  assert.equal(extractProductNameGuess(lines("g ry =")), "");
  assert.equal(extractProductNameGuess(lines("g ry =", "350ml 缶", "いずれか1本無料引換えクーポン")), "");
  assert.equal(extractProductNameGuess(lines("Red Bull")), "Red Bull");
  assert.equal(extractProductNameGuess(lines("「Coca-Cola」無料引換券")), "Coca-Cola");
});

test("端末ステータスやURLを商品名に採用しない", () => {
  for (const status of [
    "ul docomo 会 11:50 1¢@45%@)", "ul dokcomo会", "all docomo会 1:20 @ 77% «a»",
    "SoftBank 10:21 4G 80%", "10:21 LTE 80%", "Vv Q coupon.sej.co.jp X",
  ]) {
    assert.equal(extractProductNameGuess(lines(status)), "");
  }
  assert.equal(extractProductNameGuess(lines("ul dokcomo会", "Red Bull")), "Red Bull");
});

test("再読は弱いロゴ断片で既存名を壊さず、確実な商品名だけ上書きする", () => {
  const existing = "ザ・プレミアム・モルツ";
  assert.equal(extractProductNameForRescan(lines("ul docomo 会 11:50 1¢@45%@)"), existing), "");
  assert.equal(extractProductNameForRescan(lines("テー pis -"), existing), "");
  assert.equal(extractProductNameForRescan([], existing), "");
  assert.equal(extractProductNameForRescan(lines("Red Bull"), existing), "");
  assert.equal(extractProductNameForRescan(lines("Red Bull"), ""), "Red Bull");
  assert.equal(extractProductNameForRescan(lines("Red Bull"), "Red Bull"), "Red Bull");
  assert.equal(extractProductNameForRescan(lines("「Coca-Cola」無料引換券"), existing), "Coca-Cola");
  assert.equal(extractProductNameForRescan(lines("レモンスカッシュ 250ml缶"), existing), "レモンスカッシュ 250ml缶");
});

test("缶を&と誤読した実画像では、商品名段落だけを拡大再読する", () => {
  const actual = [
    {text:"ul docomo 会 11:50 1¢@45%@)",y:8,y1:31},
    {text:"Be",y:712,y1:770},
    {text:"ザ ・ プ レミ アム ・ モ ルツ /",y:794,y1:815},
    {text:"ザ ・ プ レミ アム ・ モ ルツ 夕映 香る エー ル",y:823,y1:843},
    {text:"350ml &",y:853,y1:872},
    {text:"いずれ か 1 本 無料 引換 え ク ー ポ ン",y:904,y1:927},
  ];
  assert.deepEqual(findProductNameRetryRect(actual,750,1334), {x:0,y:783,width:750,height:100});
  assert.equal(extractProductNameForRescan(actual,"プレモル"), "");
  assert.equal(findProductNameRetryRect(actual.map(line => line.y === 904 ? {...line,y:1200,y1:1223}:line),750,1334),null);
  assert.equal(findProductNameRetryRect(lines("ul dokcomo会","350ml &","1本無料引換えクーポン"),750,1334),null);
  assert.equal(findProductNameRetryRect([],750,1334),null);
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
