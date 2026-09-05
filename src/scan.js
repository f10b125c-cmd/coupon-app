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

// アプリ内のファミマ店舗キーは `famima`。外部取得側などから正式英名の
// `familymart` が来ても、画面の選択肢と一致するキーへ揃える。
export function normalizeStoreKey(value) {
  return value === "familymart" ? "famima" : value || "";
}

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

// ZXingが返すバーコード両端の座標を使い、レジ提示用にバーコード周辺だけを切り出す。
// 認識に使った候補画像から直接切り出すため、全体画像・横帯候補のどちらで
// 読めた場合も同じ処理で対応できる。
export function calculateBarcodeCropRect(imageWidth, imageHeight, resultPoints) {
  const points = resultPoints || [];
  if (points.length < 2) return null;
  const xs = points
    .map((point) => (typeof point?.getX === "function" ? point.getX() : point?.x))
    .filter(Number.isFinite);
  const ys = points
    .map((point) => (typeof point?.getY === "function" ? point.getY() : point?.y))
    .filter(Number.isFinite);
  if (xs.length < 2 || !ys.length) return null;

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const barcodeWidth = maxX - minX;
  if (barcodeWidth < 16) return null;

  const centerY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const padX = Math.max(16, barcodeWidth * 0.16);
  const desiredHeight = Math.max(72, barcodeWidth * 0.44);
  const sourceX = Math.max(0, Math.floor(minX - padX));
  const sourceWidth = Math.min(imageWidth - sourceX, Math.ceil(barcodeWidth + padX * 2));
  const sourceY = Math.max(0, Math.floor(centerY - desiredHeight / 2));
  const sourceHeight = Math.min(imageHeight - sourceY, Math.ceil(desiredHeight));
  if (sourceWidth < 20 || sourceHeight < 20) return null;

  return { sourceX, sourceY, sourceWidth, sourceHeight };
}

async function cropBarcodeFromResult(sourceDataUrl, result) {
  const img = await loadImage(sourceDataUrl);
  const crop = calculateBarcodeCropRect(img.width, img.height, result?.getResultPoints?.() || []);
  return canvasCropDataUrl(img, crop);
}

// バーコード番号をOCRでは読めてもZXingが線の位置を返せない画像向け。
// 横方向の明暗変化が多い状態が縦に続く帯を探し、その帯を貫く黒い縦線群から
// バーコード領域を推定する。商品写真や本文の文字列は数行ぶんしか続かないため、
// 一定の高さにわたって続く縦線群に限定すると誤検出を抑えられる。
export function detectLinearBarcodeCropRect(imageData) {
  const { data, width, height } = imageData || {};
  if (!data || width < 80 || height < 80) return null;

  const luminanceAt = (x, y) => {
    const offset = (y * width + x) * 4;
    return (data[offset] * 3 + data[offset + 1] * 4 + data[offset + 2]) / 8;
  };
  const rowScores = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let previous = luminanceAt(0, y);
    let transitions = 0;
    for (let x = 1; x < width; x++) {
      const current = luminanceAt(x, y);
      if (Math.abs(current - previous) >= 72 && Math.min(current, previous) < 145) {
        transitions++;
      }
      previous = current;
    }
    rowScores[y] = transitions;
  }

  // 細い文字1行ではなく、画像幅の約2.5%ぶんの高さで明暗変化が
  // 続く領域を調べる。商品写真の模様が最も強い画像もあるため、
  // 最強の1か所だけでなく画像全体の候補帯を比較する。
  const sampleHeight = Math.max(8, Math.round(width * 0.025));
  const windowStep = Math.max(4, Math.floor(sampleHeight / 2));
  const windowCandidates = [];
  for (let start = 0; start + sampleHeight <= height; start += windowStep) {
    let total = 0;
    for (let y = start; y < start + sampleHeight; y++) total += rowScores[y];
    const average = total / sampleHeight;
    if (average >= width * 0.015) {
      windowCandidates.push({ start, average });
    }
  }
  if (!windowCandidates.length) return null;

  // 商品ロゴや端末上部の文字は細い帯にしか現れない。バーコードの線が
  // 画像幅に対して一定以上の高さで続く候補だけを採用する。
  const minBandHeight = Math.max(10, Math.round(width * 0.07));
  const maxBandHeight = Math.round(width * 0.28);
  // Code128等では太い白バーが画像幅の2%前後になることがある。
  // 文字帯は高さ条件・反復回数でも除外するため、線群を分断しない範囲まで許容する。
  const maxGap = Math.max(4, Math.round(width * 0.035));
  let bestCandidate = null;

  for (const windowCandidate of windowCandidates) {
    let anchorY = windowCandidate.start;
    for (let y = windowCandidate.start; y < windowCandidate.start + sampleHeight; y++) {
      if (rowScores[y] > rowScores[anchorY]) anchorY = y;
    }
    const rowThreshold = Math.max(width * 0.02, rowScores[anchorY] * 0.42);
    let bandTop = anchorY;
    let bandBottom = anchorY;
    while (bandTop > 0 && rowScores[bandTop - 1] >= rowThreshold) bandTop--;
    while (bandBottom < height - 1 && rowScores[bandBottom + 1] >= rowThreshold) bandBottom++;
    const bandHeight = bandBottom - bandTop + 1;
    if (bandHeight < minBandHeight || bandHeight > maxBandHeight) continue;

    const activeColumns = [];
    const activeState = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      let darkPixels = 0;
      for (let y = bandTop; y <= bandBottom; y++) {
        if (luminanceAt(x, y) < 125) darkPixels++;
      }
      if (darkPixels / bandHeight >= 0.55) {
        activeColumns.push(x);
        activeState[x] = 1;
      }
    }
    if (activeColumns.length < 10) continue;

    let bestGroup = null;
    let groupStartIndex = 0;
    const considerGroup = (endIndex) => {
      const left = activeColumns[groupStartIndex];
      const right = activeColumns[endIndex];
      const groupWidth = right - left + 1;
      const activeCount = endIndex - groupStartIndex + 1;
      const density = activeCount / groupWidth;
      let transitions = 0;
      for (let x = left + 1; x <= right; x++) {
        if (activeState[x] !== activeState[x - 1]) transitions++;
      }
      const minTransitions = Math.max(16, Math.round(groupWidth * 0.08));
      // 赤い期限帯や端末のステータスバーは横長でもほぼ一色。
      // バーコードのように黒白が細かく交互に並ぶ候補だけを残す。
      if (
        groupWidth >= width * 0.12 &&
        density >= 0.14 &&
        transitions >= minTransitions
      ) {
        const score = groupWidth * density * transitions;
        if (!bestGroup || score > bestGroup.score) bestGroup = { left, right, score };
      }
    };
    for (let i = 1; i < activeColumns.length; i++) {
      if (activeColumns[i] - activeColumns[i - 1] > maxGap) {
        considerGroup(i - 1);
        groupStartIndex = i;
      }
    }
    considerGroup(activeColumns.length - 1);
    if (!bestGroup) continue;

    const candidateScore = bestGroup.score * bandHeight * windowCandidate.average;
    if (!bestCandidate || candidateScore > bestCandidate.score) {
      bestCandidate = { bandTop, bandHeight, bestGroup, score: candidateScore };
    }
  }
  if (!bestCandidate) return null;

  const { bandTop, bandHeight, bestGroup } = bestCandidate;
  const detectedWidth = bestGroup.right - bestGroup.left + 1;
  const padX = Math.max(12, detectedWidth * 0.12);
  // 数字行が残る程度の余白に留め、説明文や商品画像は極力含めない。
  const padY = Math.max(20, bandHeight * 0.6);
  const sourceX = Math.max(0, Math.floor(bestGroup.left - padX));
  const sourceY = Math.max(0, Math.floor(bandTop - padY));
  const sourceWidth = Math.min(
    width - sourceX,
    Math.ceil(detectedWidth + padX * 2)
  );
  const sourceHeight = Math.min(
    height - sourceY,
    Math.ceil(bandHeight + padY * 2)
  );
  return { sourceX, sourceY, sourceWidth, sourceHeight };
}

function canvasCropDataUrl(img, crop) {
  if (!crop) return null;
  const { sourceX, sourceY, sourceWidth, sourceHeight } = crop;
  const scale = Math.min(1, 1200 / sourceWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    img,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height
  );
  const png = canvas.toDataURL("image/png");
  if (png.length <= 180 * 1024) return png;
  for (const quality of [0.9, 0.8, 0.7, 0.6]) {
    const jpeg = canvas.toDataURL("image/jpeg", quality);
    if (jpeg.length <= 180 * 1024) return jpeg;
  }
  return canvas.toDataURL("image/jpeg", 0.5);
}

async function cropBarcodeByVisualDetection(sourceDataUrl) {
  const img = await loadImage(sourceDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const crop = detectLinearBarcodeCropRect(ctx.getImageData(0, 0, canvas.width, canvas.height));
  return canvasCropDataUrl(img, crop);
}

export async function scanBarcodeWithCrop(imageDataUrl) {
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
      if (result) {
        let barcodeImageDataUrl = null;
        try {
          barcodeImageDataUrl = await cropBarcodeFromResult(src, result);
          if (!barcodeImageDataUrl) {
            barcodeImageDataUrl = await cropBarcodeByVisualDetection(src);
          }
        } catch (e) {
          // 切り出しだけ失敗しても、バーコード番号の読み取り結果は返す。
        }
        return { text: result.getText(), barcodeImageDataUrl };
      }
    } catch (e) {
      // この候補では見つからなかった。次の候補へ。
    }
  }
  let barcodeImageDataUrl = null;
  try {
    barcodeImageDataUrl = await cropBarcodeByVisualDetection(baseDataUrl);
  } catch (e) {
    // 予備検出に失敗してもOCRによる番号抽出へ進めるよう空で返す。
  }
  return { text: null, barcodeImageDataUrl };
}

export async function scanBarcode(imageDataUrl) {
  const result = await scanBarcodeWithCrop(imageDataUrl);
  return result.text;
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

// 店舗利用期限は券面最下部に小さな赤文字で印字され、画像全体のOCRでは
// 見出しだけ読めても日付数字が落ちることがある。下部だけを切り出して拡大し、
// 期限専用の追加OCRに渡す。商品名用の行データには混ぜない。
function makeDeadlineCrop(
  img,
  highContrast = false,
  startRatio = 0.65,
  endRatio = 1,
  redOnly = false
) {
  const sourceY = Math.floor(img.height * startRatio);
  const sourceEnd = Math.min(img.height, Math.ceil(img.height * endRatio));
  const sourceHeight = Math.max(1, sourceEnd - sourceY);
  const scale = Math.min(4, 2800 / img.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const ctx = canvas.getContext("2d");
  // 小さい赤文字の輪郭を保つため、期限欄では補間を切って拡大する。
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    img,
    0,
    sourceY,
    img.width,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height
  );

  if (highContrast) {
    // ローソン券の期限は薄い赤で、通常OCRでは背景と同化しやすい。
    // 赤文字を含む暗い画素を黒、背景を白へ二値化して数字の輪郭を強調する。
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const luminance =
        pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
      const isDeadlineRed =
        pixels[i] > 100 &&
        pixels[i] > pixels[i + 1] * 1.2 &&
        pixels[i] > pixels[i + 2] * 1.06;
      const value = redOnly
        ? isDeadlineRed
          ? 0
          : 255
        : luminance < 210
          ? 0
          : 255;
      pixels[i] = value;
      pixels[i + 1] = value;
      pixels[i + 2] = value;
      pixels[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }
  return canvas.toDataURL("image/png");
}

// 期限日付は券面下部の赤い1行。画像の縦横比や余白が券ごとに違うため、
// 固定座標ではなく赤画素の最下段グループを探して切り出し位置を決める。
function findDeadlineRedBand(img) {
  const scale = Math.min(1, 800 / img.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const rows = [];
  const minRedPixels = Math.max(6, Math.round(canvas.width * 0.015));

  for (let y = Math.floor(canvas.height * 0.75); y < canvas.height; y++) {
    let count = 0;
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (r > 100 && r > g * 1.2 && r > b * 1.06) count++;
    }
    if (count >= minRedPixels) rows.push(y);
  }

  if (!rows.length) return [0.86, 0.98];
  let end = rows[rows.length - 1];
  let start = end;
  for (let i = rows.length - 2; i >= 0; i--) {
    if (start - rows[i] > 4) break;
    start = rows[i];
  }
  if (end - start < 2) return [0.86, 0.98];

  const padding = Math.max(8, Math.round(canvas.height * 0.018));
  return [
    Math.max(0.72, (start - padding) / canvas.height),
    Math.min(1, (end + padding) / canvas.height),
  ];
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
  let deadlineTargets = [];
  try {
    const img = await loadImage(imageDataUrl);
    const canvas = toBoundedCanvas(img, 2000);
    // 保存済みの画像はすでにJPEG圧縮されている。ここでさらにJPEGへ再エンコードすると
    // 圧縮ノイズが二重にかかって細い文字が潰れるうえ、JPEGの出力は端末ごとに違うため
    // 同じ画像でも端末によってOCR結果が変わってしまう。可逆なPNGにして差をなくす。
    normalTarget = canvas.toDataURL("image/png");
    invertedTarget = invertCanvas(canvas).toDataURL("image/png");
    const [deadlineStart, deadlineEnd] = findDeadlineRedBand(img);
    deadlineTargets = [
      makeDeadlineCrop(img),
      makeDeadlineCrop(img, true),
      // 実画像では期限の赤文字が高さの約92〜94%にある。バーコードを除外し、
      // この1行だけを読む候補も用意して数字列へOCRを集中させる。
      makeDeadlineCrop(img, true, deadlineStart, deadlineEnd, true),
    ];
  } catch (e) {
    // 縮小に失敗しても元画像でOCRを続行する（反転パスはスキップ）
  }

  const { createWorker, PSM } = await import("tesseract.js");
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
    const fullText = lines.map((l) => l.text).join("\n");
    let deadlineText = "";
    // 全体OCRですでに期限を取得できた画像は追加処理を省き、モバイルの負荷を抑える。
    if (deadlineTargets.length && !extractExpiryDate(fullText)) {
      for (let index = 0; index < deadlineTargets.length; index++) {
        try {
          const highContrast = index >= 1;
          const { data: deadlineData } = await withTimeout(
            worker.recognize(
              deadlineTargets[index],
              highContrast
                ? {
                    tessedit_pageseg_mode:
                      index === 2 ? PSM.SINGLE_LINE : PSM.SPARSE_TEXT,
                    tessedit_char_whitelist: "0123456789/:.-",
                  }
                : { tessedit_pageseg_mode: PSM.SINGLE_BLOCK },
              { text: true }
            ),
            45000,
            "店舗利用期限の文字認識"
          );
          const candidate = (deadlineData.text || "").trim();
          deadlineText = [deadlineText, candidate].filter(Boolean).join("\n");
          if (extractExpiryDate(deadlineText)) break;
        } catch (e) {
          // この期限専用パスの失敗は無視し、次の候補へ進む
        }
      }
    }

    return {
      text: [fullText, deadlineText].filter(Boolean).join("\n"),
      lines,
    };
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

function toValidIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";

  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return "";
  }
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function normalizeDeadlineYear(year) {
  const parsed = Number(year);
  const currentYear = new Date().getFullYear();
  // コンビニクーポンが数十年先まで有効になることはない。期限欄に限定し、
  // 2026を2075と読むような大幅な誤読は現在年へ戻す。
  if (parsed < currentYear - 1 || parsed > currentYear + 2) {
    return String(currentYear);
  }
  return year;
}

// ローソン券面の「店舗利用期限 YYYY/MM/DD 23:59まで」は文字が小さく、
// 実画像では「2026708724」「2026/0S/24」のようにスラッシュや8が崩れた。
// 23:59の直前だけを期限欄として扱い、既存の日付抽出とは独立して補正する。
// 「まで」が別の文字へ崩れても、時刻が読めていれば期限として復元する。
function extractStoreDeadlineDate(text) {
  const normalized = normalizeDigits(text);
  const deadlinePattern =
    /20\d{2}[^\r\n]{0,24}?(?=\s*23\s*[:：]?\s*5?59(?:\s*ま\s*で)?)/g;

  for (const match of normalized.matchAll(deadlinePattern)) {
    const raw = match[0]
      .replace(/[Oo]/g, "0")
      .replace(/[SsＢB]/g, "8")
      .replace(/[Il|]/g, "1");
    const yearMatch = raw.match(/20\d{2}/);
    if (!yearMatch) continue;

    const year = normalizeDeadlineYear(yearMatch[0]);
    const tail = raw.slice((yearMatch.index || 0) + year.length);
    const separated = tail.match(
      /^\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/
    );
    if (separated) {
      const iso = toValidIsoDate(year, separated[1], separated[2]);
      if (iso) return iso;
    }

    // スラッシュが数字として混入した場合は、末尾2桁を日として固定し、
    // その直前側から成立する月を探す（708724 → 08/24）。
    const digits = tail.replace(/\D/g, "");
    if (digits.length < 4) continue;
    const day = digits.slice(-2);
    const beforeDay = digits.slice(0, -2);
    for (let i = beforeDay.length - 2; i >= 0; i--) {
      const month = beforeDay.slice(i, i + 2);
      const iso = toValidIsoDate(year, month, day);
      if (iso) return iso;
    }
  }
  return "";
}

// クーポンは「利用期間 6/30〜7/13」のように開始日と終了日が並ぶため、
// 見つかった日付の中で一番遅いものを有効期限として採用する。
export function extractExpiryDate(text) {
  if (!text) return "";
  const normalized = normalizeDigits(text);
  const storeDeadline = extractStoreDeadlineDate(normalized);
  if (storeDeadline) return storeDeadline;

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

// ローソンのお持ち帰り限定券では、バーコード下の17桁が
// 「8222 0052 4251 5844 4」のように4桁ずつ空白で区切られて印字される。
// 従来の連続数字・ハイフン区切りパターンはそのまま残し、専用パターンを追加する。
const LAWSON_GROUPED_BARCODE_PATTERN = /\b\d{4}(?:[ \t]+\d{4}){3}[ \t]+\d\b/g;

function extractLawsonGroupedBarcodeGuess(text) {
  for (const line of text.split(/\r?\n/)) {
    const chunks = line.trim().split(/\s+/);
    for (let i = 0; i <= chunks.length - 5; i++) {
      const groups = chunks
        .slice(i, i + 5)
        .map((chunk) => chunk.replace(/\D/g, ""));
      if (
        groups[0].length !== 4 ||
        groups[4].length !== 1 ||
        groups.slice(1, 4).some((group) => group.length < 3 || group.length > 4)
      ) {
        continue;
      }

      // OCRが各4桁グループ先頭の0を I / D 等と読むと、数字だけでは3桁になる。
      // ローソン券面の固定レイアウトに限り、先頭0を補って17桁へ戻す。
      const digits =
        groups[0] +
        groups
          .slice(1, 4)
          .map((group) => group.padStart(4, "0"))
          .join("") +
        groups[4];
      if (digits.length === 17) return digits;
    }
  }
  return "";
}

export function extractBarcodeNumberGuess(text) {
  if (!text) return "";
  const normalized = normalizeDigits(text);

  for (const m of normalized.matchAll(LAWSON_GROUPED_BARCODE_PATTERN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length === 17) return digits;
  }

  const groupedLawsonGuess = extractLawsonGroupedBarcodeGuess(normalized);
  if (groupedLawsonGuess) return groupedLawsonGuess;

  let best = "";
  for (const m of normalized.matchAll(BARCODE_NUMBER_PATTERN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length > best.length) best = digits;
  }
  return best;
}

// ローソンのお持ち帰り限定券面パターン:
// 「【お持ち帰り限定】商品名（税込xxx円）無料引換券」が商品画像の上に置かれる。
// 商品名が複数行に折り返される場合もあるため、価格・引換券表記までの近接行を連結する。
// 既存の画像直下・鉤括弧・引換え行パターンには手を加えず、独立した抽出ルールとして扱う。
// 実画像では「お 持ち 帰り 具 定」「お 持ち 需 り 骨 定」と読まれたため、
// この券面の見出しに限って、文字間空白と字形の近い誤読を許容する。
const LAWSON_TAKEOUT_MARKER_PATTERN = /お\s*持ち\s*[帰需]\s*り\s*[限具骨]\s*定/;
const LAWSON_TAKEOUT_PREFIX_PATTERN =
  /^.*?お\s*持ち\s*[帰需]\s*り\s*[限具骨]\s*定\s*[】\]」』〉>）)]*/;
const LAWSON_TAKEOUT_END_PATTERN =
  /[（(]\s*税込\s*[\d０-９,，]+\s*円\s*[）)].*$|(?:無料\s*)?引き?換え?券.*$/;
const LAWSON_TAKEOUT_PRICE_PATTERN =
  /[（(]\s*税込\s*([\d０-９,，]+)\s*円\s*[）)]/;
const LAWSON_TAKEOUT_NAME_PATTERNS = [
  [/^クーリッシュバニラ$/, "クーリッシュ バニラ"],
  [/^アイスの実ぶどうマスカット$/, "アイスの実 ぶどうマスカット"],
  [/^チョコモナカジャン[ボポ]$/, "チョコモナカジャンボ"],
];

function normalizeLawsonTakeoutName(raw) {
  // この券面では日本語1語の途中にもOCR由来の空白が大量に入ることがあるため、
  // 既存ルールと同じ文字間整理を、このパターン内だけで適用する。
  const compact = tidySpacing(raw);
  const known = LAWSON_TAKEOUT_NAME_PATTERNS.find(([pattern]) => pattern.test(compact));
  return known ? known[1] : compact;
}

function extractLawsonTakeoutHeader(lines, strict) {
  const markerIndex = lines.findIndex(({ text }) =>
    LAWSON_TAKEOUT_MARKER_PATTERN.test(normalizeBrackets(text || ""))
  );
  if (markerIndex < 0) return "";

  const parts = [];
  for (let i = markerIndex; i < lines.length && i <= markerIndex + 3; i++) {
    const current = lines[i];
    if (i > markerIndex) {
      const previous = lines[i - 1];
      const previousHeight = Math.max((previous.y1 || previous.y) - previous.y, 1);
      const gap = current.y - (previous.y1 || previous.y);
      if (gap > previousHeight * 2.2) break;
    }

    parts.push(normalizeBrackets(current.text || ""));
    if (PRICE_PATTERN.test(current.text || "") || /引き?換え?券/.test(current.text || "")) break;
  }

  // 行は区切りなしで連結する。これにより「マスカ」+「ット」のような
  // 行末で分割された語を復元しつつ、同じ行に元からある商品名内の空白は維持できる。
  const joined = parts.join("");
  const priceMatch = normalizeDigits(joined).match(LAWSON_TAKEOUT_PRICE_PATTERN);
  const price = priceMatch ? priceMatch[1].replace(/[,，]/g, "") : "";
  let name = joined;
  name = name.replace(LAWSON_TAKEOUT_PREFIX_PATTERN, "");
  name = name.replace(LAWSON_TAKEOUT_END_PATTERN, "");
  name = name.replace(/^[\s【\[「『〈<】\]」』〉>）)]+/, "");
  name = normalizeLawsonTakeoutName(name.replace(/\s+/g, " ").trim());

  if (name.length < 3 || NOISE_PATTERN.test(name)) return "";
  const digitRatio = (name.match(/\d/g) || []).length / name.length;
  if (digitRatio >= 0.5 || !hasEnoughNameChars(name, strict)) return "";
  return `【お持ち帰り限定】 ${name}${price ? `(税込${price}円)` : ""}`;
}

// OCRは似た字形の括弧をよく取り違える（「→『、〈→《 など）。
// 商品名は「◯◯」や〈◯◯〉の括弧を手がかりに切り出しているため、判定前に字形を揃える。
function normalizeBrackets(s) {
  return s
    .replace(/[『｢]/g, "「")
    .replace(/[』｣]/g, "」")
    .replace(/[《＜<]/g, "〈")
    .replace(/[》＞>]/g, "〉");
}

// OCRが日本語の文字間に入れてしまう半角スペースを取り除く
function tidySpacing(s) {
  return normalizeBrackets(s)
    .replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, "$1")
    .replace(/\s*([〈〉（）()])\s*/g, "$1")
    // 「350ml 缶」「1 本」のように半角英数と日本語の間に入った空白も詰める
    .replace(/([A-Za-z0-9%])\s+([ぁ-んァ-ヶ一-龠])/g, "$1$2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function removeFirstChar(s, ch, count) {
  let out = s;
  for (let i = 0; i < count; i++) out = out.replace(ch, "");
  return out;
}

function removeLastChar(s, ch, count) {
  let out = s;
  for (let i = 0; i < count; i++) {
    const idx = out.lastIndexOf(ch);
    if (idx < 0) break;
    out = out.slice(0, idx) + out.slice(idx + 1);
  }
  return out;
}

const BRACKET_PAIRS = [
  ["「", "」"],
  ["〈", "〉"],
  ["(", ")"],
  ["（", "）"],
];

// OCRは括弧を二重に拾うことがある（〈ダブルレモン〉が「〈ダブルレモン)〉」になるなど）。
// 重なった括弧と、相方のない括弧を落として商品名を読みやすくする。
function tidyBrackets(t) {
  let s = t;
  // 開き括弧の直後・閉じ括弧の直前に重なった括弧（と、括弧と読み違えられた「く」）を1つにまとめる。
  // 例: 〈ダブルレモン〉が「〈くダブルレモン)〉」「〈ダブルレモン〉〉」と読まれる。
  s = s.replace(/〈[〈くク(（]+/g, "〈");
  s = s.replace(/[〉)）]+〉/g, "〉");
  s = s.replace(/「[「]+/g, "「");
  s = s.replace(/[」]+」/g, "」");
  for (const [open, close] of BRACKET_PAIRS) {
    const opens = s.split(open).length - 1;
    const closes = s.split(close).length - 1;
    if (opens > closes) s = removeFirstChar(s, open, opens - closes);
    else if (closes > opens) s = removeLastChar(s, close, closes - opens);
  }
  return s.trim();
}

// 案内文などの定型ノイズ（商品名ではありえない行）
const NOISE_PATTERN =
  // OCRは「ください」の「く」を落として「ださい」と読むことがあるため、
  // 「ださい」で拾って両方に効かせる（同様に「下さい」も部分一致で拾う）。
  /クーポン|スクリーンショット|受付|利用期間|ださい|下さい|バーコード|レジ|有効期限|同時利用|お1人様|お一人様|注意|対象|画面|提示|詳細をみる|お問合せ|お客様|再読み込み|再読込|賞品|当選者|引換えは|申し付|スキャン/;

// 商品名らしさの手がかりになる単位語
const PRODUCT_UNIT_PATTERN = /(ml|ML|ｍｌ|缶|ボトル|パック|袋|カップ|杯|個|本)/;

// 「（税込237円）」のような価格表記がある行は、コンビニクーポンでは
// ほぼ確実に商品名の行に付いているため、他のどのルールよりも強い手がかりになる
const PRICE_PATTERN = /[(（]\s*税込\s*[\d０-９,，]+\s*円\s*[)）]/;

function stripPrice(t) {
  return t.replace(PRICE_PATTERN, "").trim();
}

// 開き鉤括弧「は細い縦棒なのでOCRが 1 / r / l / I などの文字と読み違えやすい。
// 閉じ「」だけが残っている行は、本来そこに「があったとみなして
// 商品名部分（」の手前）だけを取り出し、先頭に紛れ込んだ誤読1文字を落とす。
// ハイフンは商品名そのものの先頭（-196 など）でありうるので落とさない。
const BROKEN_OPEN_BRACKET_CHARS = /^[0-9A-Za-z|｜[\]()（）_~^"'`､、。･]/;

function recoverFromBrokenOpenBracket(t) {
  const close = t.indexOf("」");
  if (close < 0) return t;
  const head = t.slice(0, close);
  if (!head.trim()) return t;
  return head.replace(BROKEN_OPEN_BRACKET_CHARS, "").trim();
}

// 行テキストを商品名として整える。「◯本と引き換え〜」などの定型の尻尾を落とし、
// ノイズ行・数字だらけの行なら空文字を返す。
function cleanProductLine(raw, strict = true) {
  let t = tidySpacing(raw);
  const bracket = t.match(/「(.+?)」/);
  if (bracket) t = bracket[1];
  else {
    // 鉤括弧で区切られていない＝行まるごとを商品名として使う場合は、
    // 定型の尻尾を落とす前にノイズ判定をしておく。
    // 「※賞品の引換えはお一人様一回のみ」のような注意書きは、
    // 尻尾（引換え以降）を落としたあとでは「賞品の」しか残らず、
    // ノイズ語が消えてしまって商品名と誤認されるため。
    if (NOISE_PATTERN.test(t)) return "";
    t = recoverFromBrokenOpenBracket(t);
  }
  // 「◯本と引き換え〜」「無料引き換えクーポン」「無料引換クーポン」「いずれか◯本と引き換え〜」
  // などの定型の尻尾を落とす。「いずれか」は商品名を含まずこの尻尾だけの行になっていることがあり、
  // 落とさずに残すと切り落とし後の残りカス（「いずれか」）が誤って商品名として採用されてしまう。
  t = t.replace(/(?:いずれか)?\s*(?:\d+\s*(?:本|個|つ|杯|枚|袋|缶))?\s*(?:コンビニ)?\s*(?:無料)?\s*と?\s*引き?換え?.*$/, "").trim();
  // 行の折り返しで「〜無料引き」までで途切れた尻尾も落とす
  t = t.replace(/(?:コンビニ)?\s*無料\s*引?き?$/, "").trim();
  t = tidyBrackets(t);
  if (t.length < 3) return "";
  if (NOISE_PATTERN.test(t)) return "";
  const digitRatio = (t.match(/\d/g) || []).length / t.length;
  if (digitRatio >= 0.5) return "";
  // 日本語がほとんど無い行は商品名ではない（缶のロゴ等の誤読）。
  // ここで弾いておくと、同じ商品名がページ下部にもう一度書かれている場合に
  // そちらを拾い直せる。
  if (!hasEnoughNameChars(t, strict)) return "";
  return t;
}

// 定型文除去のあとに数字・単位語しか残らなかった行（「4)350ml缶」など）は、
// 商品名がもっと上の別行に書かれていて、この行は末尾の断片に過ぎない可能性が高い。
// そのため商品名の手がかりとしては採用しない。
//
// 判定は「単位語を除いた日本語が3文字以上あるか」で行う。
// コンビニクーポンの商品名は必ず日本語を含むのに対し、缶のデザインやロゴを
// 誤読した行は英数字と記号ばかりになる（実例: 「196(¥ 7ILL EV)5% 350ml缶」）。
// 英字だけを数えると後者を弾けないため、日本語の文字数で見る。
// strict=true: 日本語だけを数える（缶のロゴ誤読を弾くための厳しい判定）
// strict=false: 従来どおり英字も数える（英字混じりの商品名を取りこぼさないための緩い判定）
function hasEnoughNameChars(t, strict = true) {
  const withoutUnits = t.replace(/ml|ML|ｍｌ|缶|ボトル|パック|袋|カップ|杯|個|本/g, "");
  const keep = strict ? /[^ぁ-んァ-ヶ一-龠々]/g : /[^ぁ-んァ-ヶ一-龠々A-Za-zＡ-Ｚａ-ｚ]/g;
  return withoutUnits.replace(keep, "").length >= 3;
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

// 商品名の推定。まず厳しい判定（日本語必須・単位語必須）で探し、
// それで見つからなければ従来どおりの緩い判定でもう一度探す。
// **Why:** 厳しい判定だけにすると、これまで読めていた英字混じりの商品名などを
// 取りこぼす恐れがある。緩い判定を後段に残しておけば、従来読めていたものは
// これまでどおり読めたうえで、缶のロゴ誤読などは前段で先に弾ける。
export function extractProductNameGuess(lines) {
  const guessed =
    extractJapaneseAleExchangeProduct(lines) ||
    extractMultilineExchangeProduct(lines) ||
    guessProductName(lines, true) ||
    guessProductName(lines, false);
  // 英字を許す従来のフォールバックでも、等号・縦棒を含むロゴの断片は採用しない。
  // 「g ry =」を特定商品へ置換せず、商品名の根拠がない場合は読み取り失敗にする。
  if (/[=|｜]/.test(guessed) && !hasEnoughNameChars(guessed, true) &&
      !PRODUCT_UNIT_PATTERN.test(guessed)) return "";
  return normalizeKnownProductName(guessed);
}

// この2種選択券の画像内キャプションにはシリーズ名が省略され、下部説明には
// 「〈ジ／ャパニーズエール〉」のように改行されている。単位を含む後半の行だけを
// 採用せず、近接する全文を照合する独立パターン。2商品のブランド名・夕映・350ml
// がすべて一致するときだけ、実券の下部説明で確認した完全な表記へ揃える。
function extractJapaneseAleExchangeProduct(lines) {
  if (!lines?.length) return "";
  // 「〈ジャ」が「(Jv」になる崩れも、この券のブラウザOCRで確認済み。
  const pattern = /^ザ・プレミアム・モルツ[/／]ザ・プレミアム・モルツ(?:(?:〈?(?:ジャ|ヤャ|ャ)?|\(Jv)パニーズエール〉?)?夕映[香舌]るエール350ml(?:和)?缶(?:いずれか)?(?:1本(?:無料(?:引(?:き?換え?(?:クーポン)?)?)?)?)?$/i;
  for (let start = 0; start < lines.length; start++) {
    let paragraph = "";
    for (let end = start; end < lines.length && end < start + 4; end++) {
      if (end > start) {
        const above = lines[end - 1];
        const height = Math.max(1, (above.y1 || above.y) - above.y);
        const gap = lines[end].y - (above.y1 || above.y);
        if (gap < 0 || gap > height * 2.2) break;
      }
      paragraph += tidySpacing(lines[end].text || "").replace(/\s+/g, "");
      if (pattern.test(paragraph)) {
        return "ザ・プレミアム・モルツ／ザ・プレミアム・モルツ〈ジャパニーズエール〉夕映香るエール 350ml缶";
      }
    }
  }
  return "";
}

// セブン等の「商品名（複数行）→容量だけの行→いずれか1本無料引換えクーポン」。
// 既存の抽出では容量行だけが単位語に一致し、商品名行は候補から落ちる。
// 引換文にはノイズ語「クーポン」があるため、そのまま連結しても採用されない。
// 独立したパターンで引換文をアンカーにし、直前の近接した商品名段落だけを読む。
function extractMultilineExchangeProduct(lines) {
  if (!lines?.length) return "";
  const exchangePattern = /^(?:いずれか\s*)?\d+\s*(?:本|個|袋|缶)\s*無料\s*引き?換え?\s*クーポン[。.!！]?$/;
  const volumePattern = /^\d+(?:\.\d+)?\s*(?:ml|ｍｌ|g)\s*(?:缶|ボトル|パック|袋)?$/i;
  const adjacent = (above, below) => {
    const height = Math.max(1, (above.y1 || above.y) - above.y);
    const gap = below.y - (above.y1 || above.y);
    return gap >= 0 && gap <= height * 2.2;
  };

  for (let i = 2; i < lines.length; i++) {
    if (!exchangePattern.test(tidySpacing(lines[i].text || ""))) continue;
    const volume = tidySpacing(lines[i - 1].text || "");
    if (!volumePattern.test(volume) || !adjacent(lines[i - 1], lines[i])) continue;
    const names = [];
    for (let k = i - 2; k >= 0 && k >= i - 4; k--) {
      if (!adjacent(lines[k], lines[k + 1])) break;
      const name = cleanProductLine(lines[k].text || "", true);
      if (!name || PRODUCT_UNIT_PATTERN.test(name)) break;
      names.unshift(name);
    }
    if (names.length) {
      const name = names.join("").replace(/\s*[/／]\s*/g, "／");
      return `${name} ${volume.replace(/\s+/g, "")}`;
    }
  }
  return "";
}

// 商品固有のデザイン文字は、同じ券面でも端末や圧縮状態によって大きく崩れる。
// 従来の汎用抽出結果を変えず、十分に特徴的な後半表記が読めた場合だけ復元する。
// 「すいじんそーだ」はLINE経由の圧縮画像で実際に得られた読み取り結果。
const KNOWN_PRODUCT_NAME_PATTERNS = [
  [/[〈<]本格濃いめ[〉>]\s*500\s*ml\s*缶/i, "翠ジンソーダ〈本格濃いめ〉500ml缶"],
  [/^すい\s*じん\s*そ[ー一]\s*だ$/u, "翠ジンソーダ"],
];

function normalizeKnownProductName(value) {
  if (!value) return "";
  const normalized = tidySpacing(value);
  // 実画像で「夕映香る」が「夕映舌る」になった。プレモル2種の選択券の
  // 商品名全体が一致した場合だけ補正し、他のエールや容量へ流用しない。
  if (/^ザ・プレミアム・モルツ[/／]ザ・プレミアム・モルツ夕映[香舌]るエール350ml缶$/i
    .test(normalized.replace(/\s+/g, ""))) {
    return "ザ・プレミアム・モルツ／ザ・プレミアム・モルツ 夕映香るエール 350ml缶";
  }
  const known = KNOWN_PRODUCT_NAME_PATTERNS.find(([pattern]) => pattern.test(normalized));
  return known ? known[1] : value;
}

function guessProductName(lines, strict) {
  if (!lines || !lines.length) return "";

  // ローソン「お持ち帰り限定」券面は商品画像の上に商品名がある。
  const lawsonTakeoutName = extractLawsonTakeoutHeader(lines, strict);
  if (lawsonTakeoutName) return lawsonTakeoutName;

  // 0) 「（税込237円）」のような価格表記がある行は最有力の手がかりなので最優先で使う
  for (const { text } of lines) {
    const tidied = tidySpacing(text);
    if (PRICE_PATTERN.test(tidied)) {
      const name = cleanProductLine(stripPrice(tidied), strict);
      if (name) return name;
    }
  }

  // 1) 商品名はだいたい商品画像のすぐ下に書かれているので、
  //    テキストの大きな縦空白（＝画像領域）の直後の行を最優先で採用する
  const belowImage = findLineBelowLargestGap(lines);
  if (belowImage) {
    const name = cleanProductLine(belowImage.text, strict);
    if (name) return name;
  }

  // 2) 「商品名」の鉤括弧表記（コンビニクーポンの定番）
  //    OCRの括弧の取り違えを揃えてから探す
  for (const { text } of lines) {
    const m = tidySpacing(text).match(/「(.+?)」/);
    if (m) {
      const name = cleanProductLine(m[1], strict);
      if (name) return name;
    }
  }

  // 3) 「◯◯◯と引き換え」「◯◯◯無料引換クーポン」の◯◯◯部分
  const pageBottom = Math.max(...lines.map((l) => l.y1 || l.y));
  for (let i = 0; i < lines.length; i++) {
    const tidied = tidySpacing(lines[i].text);
    if (!/引き?換え?/.test(tidied)) continue;
    const name = cleanProductLine(tidied, strict);
    if (name && hasEnoughNameChars(name, strict)) return name;

    // 長い商品名は「商品名／350ml缶／いずれか1本無料引換えクーポン」のように
    // 複数行に折り返されてOCRされることがあり、この行単体では断片しか残らない。
    // 縦に近接している直前の行（＝同じ段落）を最大2行さかのぼって連結して再判定する。
    // ただし画像の上部2割はスマホのステータスバーやブラウザのタブ見出しが並ぶ領域で、
    // そこにある引換行はページタイトルであり、さかのぼるとUI行を巻き込むため連結しない。
    if (lines[i].y < pageBottom * 0.2) continue;
    let joined = tidied;
    for (let k = i - 1; k >= 0 && k >= i - 2; k--) {
      const prev = lines[k];
      const below = lines[k + 1];
      const prevTidied = tidySpacing(prev.text);
      // 「…」はタブ見出しの切り詰め表示に特有なので、その行は商品名に巻き込まない
      if (/[…]/.test(prevTidied)) break;
      const prevHeight = Math.max((prev.y1 || prev.y) - prev.y, 1);
      const gap = below.y - (prev.y1 || prev.y);
      if (gap > prevHeight * 1.8) break; // 行間が開きすぎ＝別ブロックなので連結しない
      joined = prevTidied + joined;
      const joinedName = cleanProductLine(joined, strict);
      if (joinedName && hasEnoughNameChars(joinedName, strict)) return joinedName;
    }
  }

  // 4) 最後の手段。商品らしい語（ml/缶/本など）を含む行を優先する。
  //    厳しい判定のときはそこで打ち切り、緩い判定のときだけ従来どおり
  //    「残った候補の1行目」まで拾う。前段で弾けなかったときの取りこぼし防止。
  const candidates = lines.map(({ text }) => cleanProductLine(text, strict)).filter(Boolean);
  const productLike = candidates.find(
    (text) => PRODUCT_UNIT_PATTERN.test(text) && hasEnoughNameChars(text, strict)
  );
  if (productLike) return productLike;
  return strict ? "" : candidates[0] || "";
}
