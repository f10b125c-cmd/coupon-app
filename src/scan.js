/* ---------------------------------------------------------
   バーコードの桁数・先頭数字によるコンビニ判別
--------------------------------------------------------- */
const STORE_BARCODE_RULES = [
  // セブンは実物のクーポンで13桁表記も確認されたため13〜14桁を許容する
  { key: "seven", test: (d) => (d.length === 13 || d.length === 14) && (d.startsWith("23") || d.startsWith("24")) },
  // ローソンは実物で16〜17桁・先頭71/53を確認（当初情報の「16桁・93始まり」より幅がある）。
  // セブン(13-14桁)・ファミマ(24-28桁)と桁数帯が重ならないため、桁数だけで判定する。
  { key: "lawson", test: (d) => d.length >= 15 && d.length <= 18 },
  { key: "famima", test: (d) => d.length >= 24 && d.length <= 28 && d.startsWith("10") },
];

export function detectStoreFromBarcode(rawText) {
  const digits = (rawText || "").replace(/\D/g, "");
  if (!digits) return "";
  const rule = STORE_BARCODE_RULES.find((r) => r.test(digits));
  return rule ? rule.key : "";
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// カメラロールの写真は数千pxを超えることがあり、そのまま処理すると
// 低スペック端末で極端に遅くなったり失敗したりするため上限を設けて縮小する。
function toBoundedCanvas(img, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}がタイムアウトしました`)), ms)),
  ]);
}

// バーコードは横長の帯として写っているため、画像全体で見つからない場合は
// 縦方向に重なりのある横帯に切り出し、拡大してから再トライする。
function makeBandCrops(img) {
  const crops = [];
  const bandCount = 5;
  const bandHeight = Math.floor(img.height / 3);
  const step = Math.floor((img.height - bandHeight) / (bandCount - 1)) || bandHeight;
  for (let i = 0; i < bandCount; i++) {
    const y = Math.min(i * step, img.height - bandHeight);
    const canvas = document.createElement("canvas");
    const scale = Math.min(2, 1600 / img.width);
    canvas.width = Math.floor(img.width * scale);
    canvas.height = Math.floor(bandHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, y, img.width, bandHeight, 0, 0, canvas.width, canvas.height);
    crops.push(canvas.toDataURL("image/png"));
  }
  return crops;
}

export async function scanBarcode(imageDataUrl) {
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  const { DecodeHintType } = await import("@zxing/library");
  const hints = new Map();
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new BrowserMultiFormatReader(hints);

  let baseDataUrl = imageDataUrl;
  let boundedImg = null;
  try {
    const original = await loadImage(imageDataUrl);
    baseDataUrl = toBoundedCanvas(original, 2000).toDataURL("image/png");
    boundedImg = await loadImage(baseDataUrl);
  } catch (e) {
    // 縮小に失敗しても元画像でトライを続ける
  }

  const candidates = [baseDataUrl];
  if (boundedImg) {
    try {
      candidates.push(...makeBandCrops(boundedImg));
    } catch (e) {
      // クロップに失敗しても全体画像だけでトライする
    }
  }

  for (const src of candidates) {
    try {
      const result = await withTimeout(reader.decodeFromImageUrl(src), 15000, "バーコード解析");
      if (result) return result.getText();
    } catch (e) {
      // この候補では見つからなかった。次の候補へ。
    }
  }
  return null;
}

/* ---------------------------------------------------------
   OCR（商品名・有効期限の抽出）
--------------------------------------------------------- */
// 色付き帯に白抜きで書かれたタイトル（ローソン系クーポンの定番）は
// そのままではOCRできないため、色を反転した画像でも読み取れるようにする。
function invertCanvas(canvas) {
  const inv = document.createElement("canvas");
  inv.width = canvas.width;
  inv.height = canvas.height;
  const ctx = inv.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = "difference";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, inv.width, inv.height);
  return inv;
}

function extractLines(data) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const t = (line.text || "").trim();
        if (t) {
          lines.push({
            text: t,
            y: line.bbox ? line.bbox.y0 : 0,
            y1: line.bbox ? line.bbox.y1 : 0,
          });
        }
      }
    }
  }
  return lines;
}

// 反転パスの行は、通常パスが何も読めなかった縦位置のものだけ採用する
// （通常の黒文字領域を反転して読むとゴミ行が出るため、その混入を防ぐ）。
function mergeLines(base, extra) {
  const merged = [...base];
  for (const l of extra) {
    const overlaps = base.some((b) => {
      const top = Math.max(b.y, l.y);
      const bottom = Math.min(b.y1 || b.y, l.y1 || l.y);
      const minH = Math.max(1, Math.min((b.y1 || b.y) - b.y, (l.y1 || l.y) - l.y));
      return (bottom - top) / minH > 0.5;
    });
    if (!overlaps) merged.push(l);
  }
  return merged;
}

export async function scanText(imageDataUrl, onProgress) {
  let normalTarget = imageDataUrl;
  let invertedTarget = null;
  try {
    const img = await loadImage(imageDataUrl);
    const canvas = toBoundedCanvas(img, 2000);
    normalTarget = canvas.toDataURL("image/jpeg", 0.9);
    invertedTarget = invertCanvas(canvas).toDataURL("image/jpeg", 0.9);
  } catch (e) {
    // 縮小に失敗しても元画像でOCRを続行する（反転パスはスキップ）
  }

  const { createWorker } = await import("tesseract.js");
  const worker = await withTimeout(
    createWorker("jpn+eng", 1, {
      logger: (m) => {
        if (onProgress && m.status === "recognizing text") {
          onProgress(Math.round((m.progress || 0) * 100));
        }
      },
    }),
    45000,
    "文字認識の準備"
  );
  try {
    // デフォルトはtextのみ計算される設定のため、行の位置(bbox)を取るには
    // blocksの出力を明示的に指定する必要がある。
    const { data } = await withTimeout(
      worker.recognize(normalTarget, {}, { text: true, blocks: true }),
      60000,
      "文字認識"
    );
    let lines = extractLines(data);

    if (invertedTarget) {
      try {
        const { data: invData } = await withTimeout(
          worker.recognize(invertedTarget, {}, { text: true, blocks: true }),
          60000,
          "文字認識（反転）"
        );
        lines = mergeLines(lines, extractLines(invData));
      } catch (e) {
        // 反転パスの失敗は無視（通常パスの結果だけで続行）
      }
    }

    lines.sort((a, b) => a.y - b.y);
    return { text: lines.map((l) => l.text).join("\n"), lines };
  } finally {
    await worker.terminate();
  }
}

function normalizeDigits(str) {
  return str.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

const DATE_PATTERNS = [
  // 2026/07/20, 2026-07-20, 2026.07.20, 2026年7月20日
  /(20\d{2})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/g,
  // OCRで区切り文字が消えた場合のフォールバック（20260720）
  /(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/g,
];

// クーポンは「利用期間 6/30〜7/13」のように開始日と終了日が並ぶため、
// 見つかった日付の中で一番遅いものを有効期限として採用する。
export function extractExpiryDate(text) {
  if (!text) return "";
  const normalized = normalizeDigits(text);
  let latest = "";
  for (const pattern of DATE_PATTERNS) {
    for (const m of normalized.matchAll(pattern)) {
      const [, y, mo, d] = m;
      const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (iso > latest) latest = iso;
    }
    if (latest) break;
  }
  return latest;
}

// バーコードの画像自体は桁数が多いと（特にファミマの28桁など）スマホのスクショ解像度では
// 線が細くなりすぎて読み取れないことがある。一方でバーコードの下に印字された数字は
// 太字の活字なのでOCRで拾いやすいため、こちらを読み取りのフォールバックにする。
// 「2334-2130-65401」のようなハイフン区切り、「1092002920260609213453407801」のような
// 連続した数字のどちらにも対応できるよう、数字とハイフンの並びの中から一番長いものを採用する。
const BARCODE_NUMBER_PATTERN = /\d[\d\-]{7,30}\d/g;

export function extractBarcodeNumberGuess(text) {
  if (!text) return "";
  const normalized = normalizeDigits(text);
  let best = "";
  for (const m of normalized.matchAll(BARCODE_NUMBER_PATTERN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length > best.length) best = digits;
  }
  return best;
}

// OCRが日本語の文字間に入れてしまう半角スペースを取り除く
function tidySpacing(s) {
  return s
    .replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, "$1")
    .replace(/\s*([<>＜＞（）()])\s*/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// 案内文などの定型ノイズ（商品名ではありえない行）
const NOISE_PATTERN =
  /クーポン|スクリーンショット|受付|利用期間|ください|下さい|バーコード|レジ|有効期限|同時利用|お1人様|お一人様|注意|対象|画面|提示/;

// 行テキストを商品名として整える。「◯本と引き換え〜」などの定型の尻尾を落とし、
// ノイズ行・数字だらけの行なら空文字を返す。
function cleanProductLine(raw) {
  let t = tidySpacing(raw);
  const bracket = t.match(/「(.+?)」/);
  if (bracket) t = bracket[1];
  // 「◯本と引き換え〜」「無料引き換えクーポン」「無料引換クーポン」などの定型の尻尾を落とす
  t = t.replace(/(?:\d+\s*(?:本|個|つ|杯|枚|袋|缶))?\s*(?:コンビニ)?\s*(?:無料)?\s*と?\s*引き?換え?.*$/, "").trim();
  // 行の折り返しで「〜無料引き」までで途切れた尻尾も落とす
  t = t.replace(/(?:コンビニ)?\s*無料\s*引?き?$/, "").trim();
  if (t.length < 3) return "";
  if (NOISE_PATTERN.test(t)) return "";
  const digitRatio = (t.match(/\d/g) || []).length / t.length;
  if (digitRatio >= 0.5) return "";
  return t;
}

// テキストが縦に大きく途切れている箇所＝商品画像などの領域とみなし、
// その直後（画像のすぐ下）の行を返す。
function findLineBelowLargestGap(lines) {
  if (lines.length < 2) return null;
  const heights = lines.map((l) => (l.y1 || l.y) - l.y).filter((h) => h > 0);
  const avgHeight = heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : 0;
  let best = null;
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i].y - (lines[i - 1].y1 || lines[i - 1].y);
    if (!best || gap > best.gap) best = { gap, line: lines[i] };
  }
  // 平均行高の3倍を超える空白だけを「画像の領域」とみなす
  if (best && avgHeight && best.gap > avgHeight * 3) return best.line;
  return null;
}

export function extractProductNameGuess(lines) {
  if (!lines || !lines.length) return "";

  // 1) 商品名はだいたい商品画像のすぐ下に書かれているので、
  //    テキストの大きな縦空白（＝画像領域）の直後の行を最優先で採用する
  const belowImage = findLineBelowLargestGap(lines);
  if (belowImage) {
    const name = cleanProductLine(belowImage.text);
    if (name) return name;
  }

  // 2) 「商品名」の鉤括弧表記（コンビニクーポンの定番）
  for (const { text } of lines) {
    const m = text.match(/「(.+?)」/);
    if (m) {
      const name = cleanProductLine(m[1]);
      if (name) return name;
    }
  }

  // 3) 「◯◯◯と引き換え」「◯◯◯無料引換クーポン」の◯◯◯部分
  for (const { text } of lines) {
    const tidied = tidySpacing(text);
    if (/引き?換え?/.test(tidied)) {
      const name = cleanProductLine(tidied);
      if (name) return name;
    }
  }

  // 4) ノイズ行を除き、商品らしい語（ml/缶/本など）を含む行を優先、なければ一番上の行
  const candidates = lines
    .map(({ text }) => cleanProductLine(text))
    .filter(Boolean)
    .map((text) => ({ text }));
  const productLike = candidates.find(({ text }) => /(ml|ML|ｍｌ|缶|ボトル|パック|袋|カップ|杯|個|本)/.test(text));
  return (productLike || candidates[0])?.text || "";
}
