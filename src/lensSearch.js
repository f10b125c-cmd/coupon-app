export const GOOGLE_LENS_URL = "https://www.google.com/imghp?hl=ja";

export function selectLensImage(coupon) {
  if (coupon?.productImageDataUrl) {
    return { dataUrl: coupon.productImageDataUrl, productOnly: true };
  }
  return { dataUrl: coupon?.imageDataUrl || "", productOnly: false };
}

export function dataUrlToImageFile(dataUrl, fileName = "coupon-product") {
  const match = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(dataUrl || "");
  if (!match) throw new Error("商品画像の形式を確認できませんでした");
  const mimeType = match[1].toLowerCase();
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1].replace("+xml", "");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], `${fileName}.${extension}`, { type: mimeType });
}

function dataUrlToPngBlob(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("商品画像を準備できませんでした"))),
        "image/png"
      );
    };
    image.onerror = () => reject(new Error("商品画像を開けませんでした"));
    image.src = dataUrl;
  });
}

// モバイルでは共有シートからGoogle / Lensを選ぶ。ファイル共有に未対応の端末では、
// 商品画像をクリップボードへコピーしてGoogle画像検索を開く。Lensの検索結果を
// アプリへ戻す公開APIはないため、この関数は画像を渡すところまでに限定する。
export async function handoffImageToGoogleLens(dataUrl, environment = {}) {
  const navigatorObject = environment.navigatorObject || navigator;
  const openWindow = environment.openWindow || ((...args) => window.open(...args));
  const ClipboardItemClass = environment.ClipboardItemClass || globalThis.ClipboardItem;
  const file = dataUrlToImageFile(dataUrl);
  const shareData = {
    files: [file],
    title: "Google Lensで商品名を調べる",
    text: "この商品画像をGoogle Lensで検索してください",
  };

  if (
    typeof navigatorObject.share === "function" &&
    typeof navigatorObject.canShare === "function" &&
    navigatorObject.canShare({ files: shareData.files })
  ) {
    await navigatorObject.share(shareData);
    return { method: "share", opened: true };
  }

  const lensWindow = openWindow(GOOGLE_LENS_URL, "_blank", "noopener,noreferrer");
  let copied = false;
  if (navigatorObject.clipboard?.write && ClipboardItemClass) {
    try {
      const pngBlob = dataUrlToPngBlob(dataUrl);
      await navigatorObject.clipboard.write([
        new ClipboardItemClass({ "image/png": pngBlob }),
      ]);
      copied = true;
    } catch (error) {
      // コピーできなくても、開いたGoogle画像検索から手動アップロードできる。
    }
  }
  return { method: copied ? "clipboard" : "open", opened: Boolean(lensWindow) };
}
