import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Link as LinkIcon,
  Image as ImageIcon,
  X,
  Pencil,
  Check,
  ExternalLink,
  Ticket,
  Clock,
  Layers,
  ScanLine,
  Send,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import {
  scanBarcode,
  scanText,
  detectStoreFromBarcode,
  extractExpiryDate,
  extractProductNameGuess,
  extractBarcodeNumberGuess,
} from "./scan.js";
import {
  subscribeCoupons,
  saveCouponToCloud,
  deleteCouponFromCloud,
  compressImageForStorage,
} from "./cloudStore.js";

/* ---------------------------------------------------------
   フォント読み込み（やわらかい丸ゴシックの世界観に寄せる）
--------------------------------------------------------- */
function useFonts() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&family=M+PLUS+Rounded+1c:wght@400;500;700;800&display=swap";
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);
}

/* ---------------------------------------------------------
   デザイントークン
--------------------------------------------------------- */
const COLORS = {
  paper: "#FFF6F2",
  paperDark: "#FBE9E2",
  ink: "#5B4A48",
  muted: "#B7938E",
  forest: "#E28CA0",
  forestSoft: "#FCE4EB",
  crimson: "#C46B7A",
  crimsonSoft: "#F6DFE4",
  amber: "#E8A15C",
  amberSoft: "#FBEAD6",
  line: "#F0D9D2",
};

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const STORAGE_KEY = "coupons:list";

/* ---------------------------------------------------------
   店舗マスタ
--------------------------------------------------------- */
const STORES = [
  { key: "seven", label: "セブンイレブン", short: "セブン", color: "#C9700A", bg: "#FBE7D0" },
  { key: "lawson", label: "ローソン", short: "ローソン", color: "#0B84A5", bg: "#D9F0F5" },
  { key: "famima", label: "ファミマ", short: "ファミマ", color: "#6B8E23", bg: "#EAF3D3" },
  { key: "other", label: "その他", short: "その他", color: "#8C8368", bg: "#EFEAD9" },
];

const storeLabel = (key) => STORES.find((s) => s.key === key)?.label || "";
const storeColors = (key) =>
  STORES.find((s) => s.key === key) || { color: "#8C8368", bg: "#EFEAD9" };

function displayName(coupon) {
  if (coupon.productName) return coupon.productName;
  if (coupon.url) {
    try {
      return new URL(coupon.url).hostname;
    } catch (e) {
      /* URLとして不正なら無視 */
    }
  }
  return "（商品名未設定）";
}

// バーコードは数字のみに揃えて比較・保存する（スキャン結果の表記ゆれで重複判定を取りこぼさないため）
function normalizeBarcode(raw) {
  return (raw || "").replace(/\D/g, "");
}

// 完全一致がない場合に比較する末尾の桁数。バーコード画像が読み取れずOCRで一部の桁しか
// 拾えなかった場合などのフォールバックで、家族内の少数のクーポンなら末尾一致でも衝突しにくい。
const BARCODE_TAIL_MATCH_LEN = 5;

// 同じバーコードを持つ、自分以外のクーポンを探す（重複登録チェック用）
function findDuplicateCoupon(coupons, barcode, excludeId) {
  const target = normalizeBarcode(barcode);
  if (!target) return null;
  const exact = coupons.find((c) => c.id !== excludeId && normalizeBarcode(c.barcode) === target);
  if (exact) return exact;
  if (target.length < BARCODE_TAIL_MATCH_LEN) return null;
  const tail = target.slice(-BARCODE_TAIL_MATCH_LEN);
  return (
    coupons.find((c) => {
      const cb = normalizeBarcode(c.barcode);
      return c.id !== excludeId && cb.length >= BARCODE_TAIL_MATCH_LEN && cb.slice(-BARCODE_TAIL_MATCH_LEN) === tail;
    }) || null
  );
}

/* ---------------------------------------------------------
   日付ユーティリティ
--------------------------------------------------------- */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.round((today - target) / (1000 * 60 * 60 * 24));
}

function computeStatus(coupon) {
  if (coupon.status === "used") return "used";
  if (coupon.inbox) return "inbox";
  const d = daysUntil(coupon.expiresAt);
  if (d !== null && d < 0) return "expired";
  return "unused";
}

function fmtDate(dateStr) {
  if (!dateStr) return "未設定";
  const d = new Date(dateStr);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/* ---------------------------------------------------------
   スタンプ（ステータスバッジ）
--------------------------------------------------------- */
function StampBadge({ status }) {
  const cfg = {
    inbox: { label: "未整理", color: COLORS.amber, bg: COLORS.amberSoft },
    unused: { label: "未使用", color: COLORS.forest, bg: COLORS.forestSoft },
    used: { label: "使用済み", color: COLORS.crimson, bg: COLORS.crimsonSoft },
    expired: { label: "期限切れ", color: COLORS.muted, bg: "#EFE2DF" },
  }[status];

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        border: `1.5px dashed ${cfg.color}`,
        color: cfg.color,
        background: cfg.bg,
        fontFamily: "'M PLUS Rounded 1c', sans-serif",
        fontWeight: 700,
        fontSize: 12,
        letterSpacing: "0.05em",
        transform: status === "used" ? "rotate(-4deg)" : "none",
        whiteSpace: "nowrap",
      }}
    >
      {cfg.label}
    </span>
  );
}

/* ---------------------------------------------------------
   店舗タグ（コンビニごとに色分け）
--------------------------------------------------------- */
function StoreBadge({ store, small }) {
  if (!store) return null;
  const cfg = storeColors(store);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: small ? "2px 8px" : "4px 10px",
        borderRadius: 999,
        border: `1.5px solid ${cfg.color}`,
        color: cfg.color,
        background: cfg.bg,
        fontFamily: "'M PLUS Rounded 1c', sans-serif",
        fontWeight: 700,
        fontSize: small ? 11 : 12,
        whiteSpace: "nowrap",
      }}
    >
      {storeLabel(store)}
    </span>
  );
}

/* ---------------------------------------------------------
   店舗選択チップ（追加・編集フォーム共通）
--------------------------------------------------------- */
function StoreChips({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
      {STORES.map((s) => {
        const active = value === s.key;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onChange(active ? "" : s.key)}
            style={{
              padding: "8px 12px",
              borderRadius: 999,
              border: `1.5px solid ${active ? COLORS.forest : COLORS.line}`,
              background: active ? COLORS.forestSoft : "#FFF9F6",
              color: active ? COLORS.forest : COLORS.muted,
              fontFamily: "'M PLUS Rounded 1c', sans-serif",
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {s.short}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------
   チケット半券カード（署名要素）
--------------------------------------------------------- */
function TicketCard({ coupon, onOpen, selectMode, selected, onToggleSelect }) {
  const status = computeStatus(coupon);
  const d = daysUntil(coupon.expiresAt);
  const urgent = status === "unused" && d !== null && d <= 2;

  let dayLabel = "-";
  let dayColor = COLORS.ink;
  if (status === "expired") {
    dayLabel = "終了";
    dayColor = COLORS.muted;
  } else if (status === "used") {
    dayLabel = "済";
    dayColor = COLORS.crimson;
  } else if (status === "inbox") {
    dayLabel = d === null ? "未定" : d < 0 ? "終了" : d === 0 ? "本日" : `${d}日`;
    dayColor = COLORS.amber;
  } else if (d !== null) {
    dayLabel = d === 0 ? "本日" : `${d}日`;
    dayColor = urgent ? COLORS.crimson : COLORS.forest;
  }

  return (
    <button
      onClick={() => (selectMode ? onToggleSelect(coupon.id) : onOpen(coupon))}
      style={{
        display: "flex",
        width: "100%",
        textAlign: "left",
        background: selected ? COLORS.forestSoft : "#FFF9F6",
        border: selected ? `2px solid ${COLORS.forest}` : `1px solid ${COLORS.line}`,
        borderRadius: 14,
        overflow: "hidden",
        boxShadow: "0 1px 0 rgba(91,74,72,0.04)",
        cursor: "pointer",
        opacity: status === "expired" ? 0.6 : 1,
        position: "relative",
      }}
    >
      {selectMode && (
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            width: 22,
            height: 22,
            borderRadius: "50%",
            border: `2px solid ${selected ? COLORS.forest : COLORS.line}`,
            background: selected ? COLORS.forest : "#FFF9F6",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2,
          }}
        >
          {selected && <Check size={13} color="#fff" />}
        </div>
      )}

      {/* 本体 */}
      <div
        style={{
          flex: 1,
          paddingTop: 14,
          paddingRight: 16,
          paddingBottom: 14,
          paddingLeft: selectMode ? 40 : 16,
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {coupon.imageDataUrl && <ImageIcon size={13} color={COLORS.muted} />}
            {coupon.url && <LinkIcon size={13} color={COLORS.muted} />}
          </div>
          <StampBadge status={status} />
        </div>
        <div
          style={{
            fontFamily: "'Zen Maru Gothic', sans-serif",
            fontWeight: 700,
            fontSize: 17,
            color: COLORS.ink,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {displayName(coupon)}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              fontFamily: "'M PLUS Rounded 1c', sans-serif",
              fontSize: 12,
              color: COLORS.muted,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            期限 {fmtDate(coupon.expiresAt)}
          </span>
          <StoreBadge store={coupon.store} small />
        </div>
      </div>

      {/* 切り取り線 + ノッチ */}
      <div style={{ position: "relative", width: 0 }}>
        <div
          style={{
            position: "absolute",
            top: -1,
            bottom: -1,
            left: 0,
            borderLeft: `2px dashed ${COLORS.line}`,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: -9,
            left: -9,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "var(--page-bg, #FFF6F2)",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -9,
            left: -9,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "var(--page-bg, #FFF6F2)",
          }}
        />
      </div>

      {/* 半券（残り日数） */}
      <div
        style={{
          width: 76,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          padding: "10px 6px",
        }}
      >
        <div
          style={{
            fontFamily: "'M PLUS Rounded 1c', sans-serif",
            fontWeight: 600,
            fontSize: dayLabel.length > 3 ? 14 : 20,
            color: dayColor,
          }}
        >
          {dayLabel}
        </div>
        {(status === "unused" || status === "inbox") && d !== null && d >= 0 && (
          <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "'M PLUS Rounded 1c', sans-serif" }}>
            のこり
          </div>
        )}
      </div>
    </button>
  );
}

/* ---------------------------------------------------------
   とりあえず貼るだけバー（未整理へ即保存）
--------------------------------------------------------- */
function QuickAddBar({ onQuickAdd }) {
  const [url, setUrl] = useState("");

  function saveUrl() {
    const v = url.trim();
    if (!v) return;
    onQuickAdd({ sourceType: "url", url: v });
    setUrl("");
  }

  function handleFiles(e) {
    filesToDataUrls(e.target.files).then((urls) => {
      urls.forEach((imageDataUrl) => onQuickAdd({ sourceType: "screenshot", imageDataUrl }));
    });
    e.target.value = "";
  }

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        background: "#FFFDFB",
        borderTop: `1.5px solid ${COLORS.line}`,
        boxShadow: "0 -4px 16px rgba(91,74,72,0.06)",
        padding: "13px 12px",
        paddingBottom: "calc(13px + env(safe-area-inset-bottom))",
        zIndex: 30,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveUrl();
          }}
          placeholder="URLを貼るだけで保存できます♪"
          style={{
            flex: 1,
            minWidth: 0,
            padding: "14px 16px",
            borderRadius: 999,
            border: `1.5px solid ${COLORS.line}`,
            background: COLORS.paper,
            color: COLORS.ink,
            fontFamily: "'M PLUS Rounded 1c', sans-serif",
            fontSize: 15,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <div style={{ position: "relative", flexShrink: 0 }}>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={handleFiles}
            aria-label="スクリーンショットをとりあえず保存"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: 0,
              cursor: "pointer",
            }}
          />
          <span
            style={{
              ...iconBtnStyle,
              width: 52,
              height: 52,
              background: COLORS.amberSoft,
              border: `1.5px solid ${COLORS.amber}`,
            }}
          >
            <ImageIcon size={22} color={COLORS.amber} />
          </span>
        </div>
        <button
          onClick={saveUrl}
          disabled={!url.trim()}
          aria-label="保存"
          style={{
            flexShrink: 0,
            width: 52,
            height: 52,
            borderRadius: "50%",
            border: "none",
            background: url.trim() ? COLORS.forest : COLORS.line,
            color: "#FFFDFB",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: url.trim() ? "pointer" : "not-allowed",
          }}
        >
          <Send size={21} />
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   レジで見せるセット（複数画像を選んですぐスワイプ表示）
--------------------------------------------------------- */
function filesToDataUrls(fileList) {
  const files = [...(fileList || [])].filter((f) => f.type?.startsWith("image/"));
  return Promise.all(
    files.map(
      (file) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        })
    )
  );
}

function UseSetButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "9px 14px",
        borderRadius: 999,
        border: `1.5px solid ${COLORS.ink}`,
        background: COLORS.ink,
        color: COLORS.paper,
        fontFamily: "'M PLUS Rounded 1c', sans-serif",
        fontWeight: 700,
        fontSize: 13,
        whiteSpace: "nowrap",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <Layers size={15} />
      セット
    </button>
  );
}

function UseSetViewer({ images, onClose }) {
  const [index, setIndex] = useState(0);

  function handleScroll(e) {
    const el = e.currentTarget;
    if (!el.clientWidth) return;
    setIndex(Math.round(el.scrollLeft / el.clientWidth));
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#111",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 18px 10px",
        }}
      >
        <span
          style={{
            color: "#fff",
            fontFamily: "'M PLUS Rounded 1c', sans-serif",
            fontSize: 13,
            letterSpacing: "0.05em",
          }}
        >
          {images.length ? `${index + 1} / ${images.length}` : ""}
        </span>
        <button
          onClick={onClose}
          style={{
            width: 34,
            height: 34,
            borderRadius: "50%",
            border: "none",
            background: "rgba(255,255,255,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <X size={18} color="#fff" />
        </button>
      </div>

      <div
        onScroll={handleScroll}
        style={{
          flex: 1,
          display: "flex",
          overflowX: "auto",
          scrollSnapType: "x mandatory",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {images.map((src, i) => (
          <div
            key={i}
            style={{
              flex: "0 0 100%",
              scrollSnapAlign: "center",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "8px 12px",
              boxSizing: "border-box",
            }}
          >
            <img
              src={src}
              alt={`セット画像 ${i + 1}`}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 10 }}
            />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "12px 0 26px" }}>
        {images.map((_, i) => (
          <div
            key={i}
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: i === index ? "#fff" : "rgba(255,255,255,0.35)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   詳細 / 編集モーダル
--------------------------------------------------------- */
function SwipeArrows({ onPrev, onNext }) {
  const btnStyle = {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    width: 36,
    height: 36,
    borderRadius: "50%",
    border: "none",
    background: "rgba(255,253,251,0.9)",
    boxShadow: "0 2px 8px rgba(91,74,72,0.25)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  };
  return (
    <>
      {onPrev && (
        <button onClick={onPrev} aria-label="前のクーポン" style={{ ...btnStyle, left: 8 }}>
          <ChevronLeft size={20} color={COLORS.ink} />
        </button>
      )}
      {onNext && (
        <button onClick={onNext} aria-label="次のクーポン" style={{ ...btnStyle, right: 8 }}>
          <ChevronRight size={20} color={COLORS.ink} />
        </button>
      )}
    </>
  );
}

function DetailModal({ coupon, coupons, onClose, onUpdate, onDelete, onPrev, onNext, position }) {
  const [editing, setEditing] = useState(!!coupon.inbox);
  const [productName, setProductName] = useState(coupon.productName);
  const [url, setUrl] = useState(coupon.url || "");
  const [imageDataUrl, setImageDataUrl] = useState(coupon.imageDataUrl || null);
  const [expiresAt, setExpiresAt] = useState(coupon.expiresAt);
  const [store, setStore] = useState(coupon.store || "");
  const [memo, setMemo] = useState(coupon.memo || "");
  const [barcode, setBarcode] = useState(coupon.barcode || "");
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const touchStartRef = useRef({ x: 0, y: 0 });

  const status = computeStatus(coupon);
  const hasImage = !!coupon.imageDataUrl;
  const barcodeDetectedStore = detectStoreFromBarcode(barcode);
  const barcodeDup = findDuplicateCoupon(coupons, barcode, coupon.id);

  function handleImageFile(e) {
    const file = e.target.files?.[0];
    if (!file || !file.type?.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result);
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function handleTouchStart(e) {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  }

  function handleTouchEnd(e) {
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartRef.current.x;
    const dy = t.clientY - touchStartRef.current.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && onNext) onNext();
      else if (dx > 0 && onPrev) onPrev();
    }
  }

  async function autoScan() {
    if (!imageDataUrl) return;
    setScanning(true);
    let detectedStore = "";
    let detectedDate = "";
    let detectedName = "";
    try {
      setScanMessage("バーコードを解析中…");
      let barcodeText = await scanBarcode(imageDataUrl);

      setScanMessage("文字を認識中…（初回は時間がかかります）");
      const { text, lines } = await scanText(imageDataUrl, (pct) =>
        setScanMessage(`文字を認識中…${pct}%`)
      );
      detectedDate = extractExpiryDate(text);
      if (detectedDate && !expiresAt) setExpiresAt(detectedDate);
      detectedName = extractProductNameGuess(lines);
      if (detectedName && !productName) setProductName(detectedName);

      // ファミマの28桁のような密なバーコードは画像からだと解像度不足で読み取れないことがあるため、
      // 失敗した場合は印字されている数字をOCRで拾って代わりに使う
      let barcodeSource = "image";
      if (!barcodeText) {
        const guess = extractBarcodeNumberGuess(text);
        if (guess) {
          barcodeText = guess;
          barcodeSource = "ocr";
        }
      }

      detectedStore = detectStoreFromBarcode(barcodeText);
      if (detectedStore) setStore(detectedStore);
      if (barcodeText) setBarcode(normalizeBarcode(barcodeText) || barcodeText);

      const dup = barcodeText ? findDuplicateCoupon(coupons, barcodeText, coupon.id) : null;

      const found = [
        detectedStore && `店舗:${storeLabel(detectedStore)}`,
        detectedDate && `期限:${detectedDate}`,
        detectedName && `商品名候補:${detectedName}`,
        barcodeText && barcodeSource === "ocr" && "バーコード番号(数字OCR)",
      ].filter(Boolean);
      const dupWarning = dup ? `⚠️「${displayName(dup)}」と同じバーコードです（重複の可能性）。` : "";
      setScanMessage(
        (found.length
          ? `${found.join(" / ")} を入力しました。内容を確認してください。`
          : "読み取れませんでした。手入力してください。") + (dupWarning ? ` ${dupWarning}` : "")
      );
    } catch (e) {
      console.error("[autoScan] 読み取りに失敗しました", e);
      const msg = String((e && e.message) || e || "");
      if (/module|chunk|fetch|network/i.test(msg)) {
        setScanMessage(
          "アプリの更新が必要かもしれません。画面を下に引っ張るなどして再読み込みしてから、もう一度お試しください。"
        );
      } else {
        setScanMessage(
          `読み取りに失敗しました${msg ? `（${msg.slice(0, 50)}）` : ""}。もう一度試すか、手入力してください。`
        );
      }
    } finally {
      setScanning(false);
    }
  }

  // 未整理クーポンを開いて登録するタイミングで、画像があれば自動で読み取る
  // （とりあえず貼るだけバーで追加した時点で背景処理済み＝autoScanned の場合は二重に読み取らない。
  //   そのときはクラウド保存用に圧縮済みの画像しか残っておらず、バーコードの細い線が潰れて
  //   読み取れなくなっていることが多いため、再スキャンしても無駄になりやすい）
  useEffect(() => {
    if (coupon.inbox && coupon.imageDataUrl && !coupon.autoScanned) {
      autoScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveEdit() {
    const dup = findDuplicateCoupon(coupons, barcode, coupon.id);
    if (dup) {
      const ok = window.confirm(
        `このクーポンは「${displayName(dup)}」と同じバーコードのようです。重複登録の可能性がありますが、このまま登録しますか？`
      );
      if (!ok) return;
    }
    // 画像が新しく選ばれた／変わった場合のみ圧縮する（既存のクラウド画像はそのまま）
    let finalImage = imageDataUrl;
    if (finalImage && finalImage !== coupon.imageDataUrl) {
      try {
        finalImage = await compressImageForStorage(finalImage);
      } catch (e) {
        console.error("[saveEdit] 画像の圧縮に失敗しました", e);
      }
    }
    onUpdate({
      ...coupon,
      productName,
      url,
      imageDataUrl: finalImage,
      sourceType: finalImage ? "screenshot" : url ? "url" : coupon.sourceType,
      expiresAt,
      store,
      memo,
      barcode: normalizeBarcode(barcode) || barcode,
      inbox: false,
      updatedAt: new Date().toISOString(),
    });
    onClose();
  }

  function markUsed() {
    onUpdate({
      ...coupon,
      status: "used",
      inbox: false,
      usedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    onClose();
  }

  function markUnused() {
    onUpdate({ ...coupon, status: "unused", usedAt: null, updatedAt: new Date().toISOString() });
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(91,74,72,0.45)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{
          background: COLORS.paper,
          width: "100%",
          maxWidth: 480,
          borderRadius: "20px 20px 0 0",
          padding: "20px 20px 28px",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StampBadge status={status} />
            {position && (
              <span
                style={{
                  fontFamily: "'M PLUS Rounded 1c', sans-serif",
                  fontSize: 12,
                  color: COLORS.muted,
                }}
              >
                {position.index + 1} / {position.total}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!hasImage && onPrev && (
              <button onClick={onPrev} aria-label="前のクーポン" style={{ ...iconBtnStyle, width: 36, height: 36 }}>
                <ChevronLeft size={18} color={COLORS.ink} />
              </button>
            )}
            {!hasImage && onNext && (
              <button onClick={onNext} aria-label="次のクーポン" style={{ ...iconBtnStyle, width: 36, height: 36 }}>
                <ChevronRight size={18} color={COLORS.ink} />
              </button>
            )}
            <button onClick={() => setEditing((v) => !v)} style={{ ...iconBtnStyle, width: 44, height: 44 }}>
              {editing ? <Check size={20} color={COLORS.forest} /> : <Pencil size={19} color={COLORS.ink} />}
            </button>
            <button onClick={onClose} aria-label="閉じる" style={{ ...iconBtnStyle, width: 44, height: 44 }}>
              <X size={22} color={COLORS.ink} />
            </button>
          </div>
        </div>

        {editing ? (
          <>
            <div style={fieldLabel}>クーポン画像（任意）</div>
            {imageDataUrl ? (
              <div style={{ position: "relative", marginBottom: 10 }}>
                <img
                  src={imageDataUrl}
                  alt="クーポン画像"
                  style={{
                    width: "100%",
                    maxHeight: 180,
                    objectFit: "contain",
                    borderRadius: 12,
                    border: `1px solid ${COLORS.line}`,
                    display: "block",
                    background: "#FFF9F6",
                  }}
                />
                <SwipeArrows onPrev={onPrev} onNext={onNext} />
                <div style={{ position: "absolute", bottom: 8, right: 8, display: "flex", gap: 6 }}>
                  <div style={{ position: "relative" }}>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleImageFile}
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        opacity: 0,
                        cursor: "pointer",
                      }}
                    />
                    <span style={smallBtnStyle}>写真を変更</span>
                  </div>
                  <button
                    onClick={() => setImageDataUrl(null)}
                    style={{ ...smallBtnStyle, background: "rgba(184,67,58,0.85)" }}
                  >
                    削除
                  </button>
                </div>
              </div>
            ) : (
              <div
                style={{
                  position: "relative",
                  width: "100%",
                  padding: "22px 14px",
                  borderRadius: 10,
                  border: `1.5px dashed ${COLORS.line}`,
                  background: "#FFF9F6",
                  color: COLORS.muted,
                  fontFamily: "'M PLUS Rounded 1c', sans-serif",
                  fontSize: 13,
                  textAlign: "center",
                  boxSizing: "border-box",
                  marginBottom: 10,
                }}
              >
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageFile}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    opacity: 0,
                    cursor: "pointer",
                  }}
                />
                <ImageIcon size={20} color={COLORS.line} style={{ marginBottom: 6 }} />
                <div>タップして画像を追加</div>
              </div>
            )}
            {imageDataUrl && (
              <div style={{ marginBottom: 14 }}>
                <button
                  onClick={autoScan}
                  disabled={scanning}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: `1.5px solid ${COLORS.forest}`,
                    background: scanning ? COLORS.line : COLORS.forestSoft,
                    color: COLORS.forest,
                    fontFamily: "'M PLUS Rounded 1c', sans-serif",
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: scanning ? "not-allowed" : "pointer",
                  }}
                >
                  <ScanLine size={15} />
                  {scanning ? "読み取り中…" : "画像から自動読み取り"}
                </button>
                {scanMessage && (
                  <div
                    style={{
                      marginTop: 6,
                      fontFamily: "'M PLUS Rounded 1c', sans-serif",
                      fontSize: 12,
                      color: COLORS.muted,
                    }}
                  >
                    {scanMessage}
                  </div>
                )}
              </div>
            )}
            <label style={fieldLabel}>
              バーコード番号（任意）
              <input
                value={barcode}
                onChange={(e) => {
                  const v = e.target.value;
                  setBarcode(v);
                  const detected = detectStoreFromBarcode(v);
                  if (detected && !store) setStore(detected);
                }}
                inputMode="numeric"
                placeholder="スキャンすると自動入力されます"
                style={{ ...inputStyle, fontFamily: "monospace", letterSpacing: 1 }}
              />
              {barcode && (
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: "'M PLUS Rounded 1c', sans-serif",
                    fontSize: 12,
                    color: COLORS.muted,
                  }}
                >
                  {barcodeDetectedStore
                    ? `店舗判定: ${storeLabel(barcodeDetectedStore)}`
                    : "店舗を自動判定できませんでした（下で手動選択してください）"}
                </div>
              )}
              {barcodeDup && (
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: "'M PLUS Rounded 1c', sans-serif",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#B8433A",
                  }}
                >
                  ⚠️「{displayName(barcodeDup)}」と同じバーコードです（重複登録の可能性）
                </div>
              )}
            </label>
            <label style={fieldLabel}>
              クーポンURL（任意）
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://..."
                style={{ ...inputStyle, wordBreak: "break-all" }}
              />
            </label>
            <label style={fieldLabel}>
              商品名
              <input value={productName} onChange={(e) => setProductName(e.target.value)} style={inputStyle} />
            </label>
            <div style={fieldLabel}>
              使える店舗
              <StoreChips value={store} onChange={setStore} />
            </div>
            <label style={fieldLabel}>
              有効期限
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={inputStyle} />
            </label>
            <label style={fieldLabel}>
              メモ
              <textarea
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                rows={3}
                style={{ ...inputStyle, resize: "vertical", fontFamily: "'M PLUS Rounded 1c', sans-serif" }}
              />
            </label>
            <button onClick={saveEdit} style={primaryBtn(COLORS.forest)}>
              {coupon.inbox ? "この内容で登録する" : "変更を保存"}
            </button>
            <button
              onClick={() => {
                if (window.confirm("このクーポンを削除しますか？")) onDelete(coupon.id);
              }}
              style={{
                width: "100%",
                marginTop: 10,
                padding: "11px 12px",
                borderRadius: 10,
                border: `1px solid ${COLORS.line}`,
                background: "transparent",
                color: COLORS.muted,
                fontFamily: "'M PLUS Rounded 1c', sans-serif",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              削除する
            </button>
          </>
        ) : (
          <>
            {coupon.imageDataUrl && (
              <div style={{ position: "relative", marginBottom: 12 }}>
                <img
                  src={coupon.imageDataUrl}
                  alt={coupon.productName}
                  style={{ width: "100%", borderRadius: 12, border: `1px solid ${COLORS.line}`, display: "block" }}
                />
                <SwipeArrows onPrev={onPrev} onNext={onNext} />
              </div>
            )}

            <h2
              style={{
                fontFamily: "'Zen Maru Gothic', sans-serif",
                fontWeight: 800,
                fontSize: 22,
                color: COLORS.ink,
                margin: "4px 0 6px",
              }}
            >
              {displayName(coupon)}
            </h2>
            <div
              style={{
                fontFamily: "'M PLUS Rounded 1c', sans-serif",
                fontSize: 13,
                color: COLORS.muted,
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 16,
                flexWrap: "wrap",
              }}
            >
              <Clock size={13} />
              期限 {fmtDate(coupon.expiresAt)}
              <StoreBadge store={coupon.store} small />
            </div>
            {coupon.barcode && (
              <div
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  letterSpacing: 1,
                  color: COLORS.muted,
                  marginTop: -10,
                  marginBottom: 16,
                }}
              >
                バーコード: {coupon.barcode}
              </div>
            )}

            {coupon.memo && (
              <div
                style={{
                  fontFamily: "'M PLUS Rounded 1c', sans-serif",
                  fontSize: 13,
                  color: COLORS.ink,
                  background: "#FFF9F6",
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 16,
                  whiteSpace: "pre-wrap",
                }}
              >
                {coupon.memo}
              </div>
            )}

            {coupon.url && (
              <a
                href={coupon.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  ...primaryBtn(COLORS.ink),
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  textDecoration: "none",
                  marginBottom: 10,
                }}
              >
                <ExternalLink size={15} />
                クーポンを開く
              </a>
            )}

            {coupon.inbox && (
              <button
                onClick={() => setEditing(true)}
                style={{ ...primaryBtn(COLORS.amber), marginBottom: 10 }}
              >
                内容を登録する
              </button>
            )}

            {status !== "used" ? (
              <button onClick={markUsed} style={primaryBtn(COLORS.crimson)}>
                使用済みにする
              </button>
            ) : (
              <button onClick={markUnused} style={primaryBtn(COLORS.forest)}>
                未使用に戻す
              </button>
            )}

            <button
              onClick={() => {
                if (window.confirm("このクーポンを削除しますか？")) onDelete(coupon.id);
              }}
              style={{
                width: "100%",
                marginTop: 10,
                padding: "11px 12px",
                borderRadius: 10,
                border: `1px solid ${COLORS.line}`,
                background: "transparent",
                color: COLORS.muted,
                fontFamily: "'M PLUS Rounded 1c', sans-serif",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              削除する
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   共通スタイル
--------------------------------------------------------- */
const fieldLabel = {
  display: "block",
  fontFamily: "'M PLUS Rounded 1c', sans-serif",
  fontSize: 12,
  fontWeight: 700,
  color: COLORS.muted,
  marginBottom: 14,
};

const inputStyle = {
  display: "block",
  width: "100%",
  marginTop: 6,
  padding: "10px 12px",
  borderRadius: 9,
  border: `1.5px solid ${COLORS.line}`,
  background: "#FFF9F6",
  color: COLORS.ink,
  fontFamily: "'M PLUS Rounded 1c', sans-serif",
  fontSize: 14,
  boxSizing: "border-box",
};

const iconBtnStyle = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  border: `1px solid ${COLORS.line}`,
  background: "#FFF9F6",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const smallBtnStyle = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "none",
  background: "rgba(43,42,37,0.75)",
  color: "#fff",
  fontFamily: "'M PLUS Rounded 1c', sans-serif",
  fontSize: 11,
  cursor: "pointer",
};

function primaryBtn(bg) {
  return {
    width: "100%",
    boxSizing: "border-box",
    padding: "13px 12px",
    borderRadius: 10,
    border: "none",
    background: bg,
    color: "#FFF9F6",
    fontFamily: "'M PLUS Rounded 1c', sans-serif",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  };
}

const MIGRATION_FLAG_KEY = "coupons:migratedToCloud";

// この端末のlocalStorageに残っている旧データを、初回だけ家族共有クラウドに移行する。
async function migrateLocalDataIfNeeded() {
  if (localStorage.getItem(MIGRATION_FLAG_KEY)) return;

  let localCoupons = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) localCoupons = JSON.parse(raw);
  } catch (e) {
    // 壊れたデータは移行せず無視する
  }

  if (!Array.isArray(localCoupons) || !localCoupons.length) {
    localStorage.setItem(MIGRATION_FLAG_KEY, "1");
    return;
  }

  const ok = window.confirm(
    `この端末に保存されている${localCoupons.length}件のクーポンを、家族共有のクラウドに移行しますか？`
  );
  if (!ok) {
    localStorage.setItem(MIGRATION_FLAG_KEY, "1");
    return;
  }

  for (const raw of localCoupons) {
    const coupon = { store: "", inbox: false, barcode: "", ...raw };
    if (coupon.imageDataUrl) {
      try {
        coupon.imageDataUrl = await compressImageForStorage(coupon.imageDataUrl);
      } catch (e) {
        coupon.imageDataUrl = null;
      }
    }
    try {
      await saveCouponToCloud(coupon);
    } catch (e) {
      console.error("[migration] failed to save", coupon.id, e);
    }
  }
  localStorage.setItem(MIGRATION_FLAG_KEY, "1");
}

/* ---------------------------------------------------------
   メインアプリ
--------------------------------------------------------- */
export default function CouponApp() {
  useFonts();
  const [coupons, setCoupons] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("unused");
  const [storeFilter, setStoreFilter] = useState("all");
  const [daysFilter, setDaysFilter] = useState("");
  const [openCoupon, setOpenCoupon] = useState(null);
  const [useSetImages, setUseSetImages] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [combinedPicker, setCombinedPicker] = useState(false);
  const [expiryBannerDismissed, setExpiryBannerDismissed] = useState(false);
  const [bulkScanProgress, setBulkScanProgress] = useState(null);

  // 家族共有クラウド（Firestore）に接続し、以後はリアルタイムに同期する
  useEffect(() => {
    let unsubscribe = null;
    let cancelled = false;

    (async () => {
      try {
        await migrateLocalDataIfNeeded();
      } catch (e) {
        console.error("[migration] 移行に失敗しました", e);
      }
      try {
        unsubscribe = await subscribeCoupons(
          (list) => {
            if (cancelled) return;
            setCoupons(list.map((c) => ({ store: "", inbox: false, barcode: "", ...c })));
            setLoaded(true);
          },
          (e) => {
            console.error("[coupons] 同期に失敗しました", e);
            setLoaded(true);
          }
        );
      } catch (e) {
        console.error("[coupons] 接続に失敗しました", e);
        setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // 期限切れ・使用済みになってから2日経ったクーポンは自動で削除する
  useEffect(() => {
    if (!loaded) return;
    coupons.forEach((c) => {
      const status = computeStatus(c);
      if (status === "expired") {
        const d = daysUntil(c.expiresAt);
        if (d !== null && d <= -2) {
          deleteCouponFromCloud(c.id).catch((e) => {
            console.error("[autoCleanup] 期限切れクーポンの削除に失敗しました", c.id, e);
          });
        }
      } else if (status === "used") {
        const d = daysSince(c.usedAt);
        if (d !== null && d >= 2) {
          deleteCouponFromCloud(c.id).catch((e) => {
            console.error("[autoCleanup] 使用済みクーポンの削除に失敗しました", c.id, e);
          });
        }
      }
    });
  }, [coupons, loaded]);

  function quickAdd({ sourceType, url = "", imageDataUrl = null }) {
    const now = new Date().toISOString();
    const coupon = {
      id: uid(),
      title: "",
      productName: "",
      sourceType,
      url,
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
    };
    // すぐ画面に反映しつつ、裏側で画像を圧縮してからクラウドに保存する
    setCoupons((prev) => [coupon, ...prev]);
    setTab("inbox");

    (async () => {
      let toSave = coupon;
      if (imageDataUrl) {
        // Firestore保存用の圧縮（1MB制限対策）はバーコードの細い線を潰してしまい
        // 読み取れなくなるため、圧縮する前のオリジナル画像でバーコード・OCRを解析しておく
        try {
          let barcodeText = await scanBarcode(imageDataUrl);
          const { text, lines } = await scanText(imageDataUrl);
          // 画像からのバーコード読み取りが失敗した場合、印字されている数字をOCRで拾って代用する
          // （ファミマの28桁のような密なバーコードは画像解像度不足で失敗しやすいため）
          if (!barcodeText) barcodeText = extractBarcodeNumberGuess(text);
          const detectedStore = detectStoreFromBarcode(barcodeText);
          const detectedDate = extractExpiryDate(text);
          const detectedName = extractProductNameGuess(lines);
          toSave = {
            ...toSave,
            barcode: normalizeBarcode(barcodeText) || barcodeText || "",
            store: detectedStore || "",
            expiresAt: detectedDate || "",
            productName: detectedName || "",
            autoScanned: true,
          };
        } catch (e) {
          console.error("[quickAdd] 自動読み取りに失敗しました", e);
          toSave = { ...toSave, autoScanned: true };
        }

        try {
          toSave = { ...toSave, imageDataUrl: await compressImageForStorage(imageDataUrl) };
        } catch (e) {
          console.error("[quickAdd] 画像の圧縮に失敗しました", e);
        }
      }
      try {
        await saveCouponToCloud(toSave);
      } catch (e) {
        console.error("[quickAdd] 保存に失敗しました", e);
        window.alert("クラウドへの保存に失敗しました。通信環境を確認してもう一度お試しください。");
      }
    })();
  }

  function updateCoupon(updated) {
    setCoupons((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setOpenCoupon(updated);
    saveCouponToCloud(updated).catch((e) => {
      console.error("[updateCoupon] 保存に失敗しました", e);
      window.alert("クラウドへの保存に失敗しました。通信環境を確認してもう一度お試しください。");
    });
  }

  function deleteCoupon(id) {
    setCoupons((prev) => prev.filter((c) => c.id !== id));
    setOpenCoupon(null);
    deleteCouponFromCloud(id).catch((e) => {
      console.error("[deleteCoupon] 削除に失敗しました", e);
      window.alert("クラウドでの削除に失敗しました。通信環境を確認してもう一度お試しください。");
    });
  }

  // 未整理のスクショ付きクーポンをまとめて自動読み取りする
  // （autoScanned済み＝追加時に背景で解析済みのものは、クラウド保存用に圧縮された
  //   画像しか残っておらずバーコードが読み取れなくなっていることが多いため対象外にする）
  async function bulkScanInbox() {
    const targets = coupons.filter((c) => c.inbox && c.imageDataUrl && !c.autoScanned);
    if (!targets.length) return;

    setBulkScanProgress({ done: 0, total: targets.length });
    let filledCount = 0;
    let dupCount = 0;
    let autoMovedCount = 0;
    // 同じバッチ内に同じクーポンが複数枚あっても重複判定できるよう、
    // 保存するたびに手元のリストも更新しながら進める
    let knownCoupons = [...coupons];

    for (let i = 0; i < targets.length; i++) {
      const c = targets[i];
      try {
        let barcodeText = await scanBarcode(c.imageDataUrl);
        const { text, lines } = await scanText(c.imageDataUrl);
        if (!barcodeText) barcodeText = extractBarcodeNumberGuess(text);
        const detectedStore = detectStoreFromBarcode(barcodeText);
        const detectedDate = extractExpiryDate(text);
        const detectedName = extractProductNameGuess(lines);
        const dup = barcodeText ? findDuplicateCoupon(knownCoupons, barcodeText, c.id) : null;

        if (detectedStore || detectedDate || detectedName) filledCount++;
        if (dup) dupCount++;

        // 店舗が判別でき、かつ重複の疑いがない＝読み取りがうまくいったものは
        // そのまま未使用へ自動登録する。判別できなかったもの・重複の疑いがあるものは
        // ユーザーの確認が必要なため未整理に残す。
        const canAutoRegister = !!detectedStore && !dup;
        if (canAutoRegister) autoMovedCount++;

        const updated = {
          ...c,
          store: c.store || detectedStore || "",
          expiresAt: c.expiresAt || detectedDate || "",
          productName: c.productName || detectedName || "",
          barcode: (barcodeText && (normalizeBarcode(barcodeText) || barcodeText)) || c.barcode || "",
          inbox: canAutoRegister ? false : c.inbox,
          updatedAt: new Date().toISOString(),
        };
        await saveCouponToCloud(updated);
        knownCoupons = knownCoupons.map((x) => (x.id === updated.id ? updated : x));
      } catch (e) {
        console.error("[bulkScanInbox] 読み取りに失敗しました", c.id, e);
      }
      setBulkScanProgress({ done: i + 1, total: targets.length });
    }

    setBulkScanProgress(null);
    const needsReview = targets.length - autoMovedCount;
    window.alert(
      `${targets.length}件を読み取りました（未使用に自動登録: ${autoMovedCount}件` +
        (needsReview
          ? `、要確認のため未整理に残したもの: ${needsReview}件${dupCount ? `／うち重複の疑い: ${dupCount}件` : ""}`
          : "") +
        "）。"
    );
  }

  function toggleSelectMode() {
    setSelectMode((v) => !v);
    setSelectedIds([]);
    setCombinedPicker(false);
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // ヘッダーの「セット」ボタン：未使用・未整理をまとめた一覧から選ぶモードに入る
  function startHeaderSetPicker() {
    setCombinedPicker(true);
    setSelectMode(true);
    setSelectedIds([]);
  }

  function openSetFromSelection() {
    const images = coupons
      .filter((c) => selectedIds.includes(c.id) && c.imageDataUrl)
      .map((c) => c.imageDataUrl);
    if (!images.length) {
      window.alert("選択したクーポンに画像がありません（URLクーポンはセットに表示できません）");
      return;
    }
    setUseSetImages(images);
    setSelectMode(false);
    setSelectedIds([]);
    setCombinedPicker(false);
  }

  // 選択したクーポンをまとめて使用済みにする
  function markSelectedAsUsed() {
    const targets = coupons.filter((c) => selectedIds.includes(c.id) && c.status !== "used");
    if (!targets.length) return;
    const ok = window.confirm(`選択した${targets.length}件をまとめて使用済みにしますか？`);
    if (!ok) return;
    const now = new Date().toISOString();
    const updatedList = targets.map((c) => ({
      ...c,
      status: "used",
      inbox: false,
      usedAt: now,
      updatedAt: now,
    }));
    setCoupons((prev) =>
      prev.map((c) => updatedList.find((u) => u.id === c.id) || c)
    );
    updatedList.forEach((u) => {
      saveCouponToCloud(u).catch((e) => {
        console.error("[markSelectedAsUsed] 保存に失敗しました", u.id, e);
      });
    });
    setSelectMode(false);
    setSelectedIds([]);
    setCombinedPicker(false);
  }

  const urgentCoupons = useMemo(() => {
    return coupons.filter((c) => {
      if (computeStatus(c) !== "unused") return false;
      const d = daysUntil(c.expiresAt);
      return d !== null && d <= 2;
    });
  }, [coupons]);

  const filtered = useMemo(() => {
    let list = coupons.map((c) => ({ ...c, _status: computeStatus(c) }));
    if (combinedPicker) {
      // ヘッダーの「セット」ボタン用：未使用・未整理のみをまとめて表示する
      list = list.filter((c) => c._status === "unused" || c._status === "inbox");
    } else {
      list = list.filter((c) => c._status === tab);
    }
    if (storeFilter !== "all") list = list.filter((c) => c.store === storeFilter);
    if (daysFilter) {
      const limit = Number(daysFilter);
      list = list.filter((c) => {
        const d = daysUntil(c.expiresAt);
        return d !== null && d >= 0 && d <= limit;
      });
    }
    list.sort((a, b) => {
      // 未整理（貼っただけ）は新しい順で先頭に、それ以外は期限が近い順
      if (a.inbox !== b.inbox) return a.inbox ? -1 : 1;
      if (a.inbox && b.inbox) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      const da = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
      const db = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
      return da - db;
    });
    return list;
  }, [coupons, tab, storeFilter, daysFilter, combinedPicker]);

  const openIndex = openCoupon ? filtered.findIndex((c) => c.id === openCoupon.id) : -1;

  const counts = useMemo(() => {
    const c = { inbox: 0, unused: 0, used: 0, expired: 0 };
    coupons.forEach((cp) => (c[computeStatus(cp)] += 1));
    return c;
  }, [coupons]);

  const tabs = [
    { key: "inbox", label: "未整理", count: counts.inbox },
    { key: "unused", label: "未使用", count: counts.unused },
    { key: "used", label: "使用済み", count: counts.used },
    { key: "expired", label: "期限切れ", count: counts.expired },
  ];

  const storeFilters = [
    { key: "all", label: "すべて" },
    ...STORES.map((s) => ({ key: s.key, label: s.short })),
  ];

  return (
    <div
      style={{
        "--page-bg": COLORS.paper,
        minHeight: "100vh",
        background: COLORS.paper,
        backgroundImage:
          "radial-gradient(circle at 1px 1px, rgba(91,74,72,0.06) 1px, transparent 0)",
        backgroundSize: "16px 16px",
        fontFamily: "'M PLUS Rounded 1c', sans-serif",
        paddingBottom: selectMode ? 24 : 100,
      }}
    >
      {/* ヘッダー */}
      <header style={{ padding: "22px 18px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Ticket size={20} color={COLORS.forest} />
            <span style={{ fontFamily: "'M PLUS Rounded 1c', sans-serif", fontSize: 11, color: COLORS.muted, letterSpacing: "0.1em" }}>
              COUPON MANAGER
            </span>
          </div>
          <h1
            style={{
              fontFamily: "'Zen Maru Gothic', sans-serif",
              fontWeight: 800,
              fontSize: 26,
              color: COLORS.ink,
              margin: 0,
            }}
          >
            クーポン管理
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => window.location.reload()}
            aria-label="データを更新"
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              border: `1.5px solid ${COLORS.line}`,
              background: "#FFF9F6",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <RefreshCw size={17} color={COLORS.ink} />
          </button>
          <UseSetButton onClick={startHeaderSetPicker} />
        </div>
      </header>

      {/* 期限が近いクーポンのお知らせ */}
      {loaded && !expiryBannerDismissed && urgentCoupons.length > 0 && (
        <div style={{ padding: "0 18px 14px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              border: `1.5px solid ${COLORS.crimson}`,
              background: COLORS.crimsonSoft,
              borderRadius: 12,
              padding: "10px 12px",
            }}
          >
            <Clock size={16} color={COLORS.crimson} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: "'M PLUS Rounded 1c', sans-serif",
                  fontWeight: 700,
                  fontSize: 13,
                  color: COLORS.crimson,
                  marginBottom: 2,
                }}
              >
                期限が近いクーポンが{urgentCoupons.length}件あります
              </div>
              <div
                style={{
                  fontFamily: "'M PLUS Rounded 1c', sans-serif",
                  fontSize: 12,
                  color: COLORS.ink,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {urgentCoupons.map((c) => displayName(c)).join("、")}
              </div>
            </div>
            <button
              onClick={() => setExpiryBannerDismissed(true)}
              style={{
                flexShrink: 0,
                width: 26,
                height: 26,
                borderRadius: "50%",
                border: "none",
                background: "transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
              aria-label="お知らせを閉じる"
            >
              <X size={15} color={COLORS.crimson} />
            </button>
          </div>
        </div>
      )}

      {/* 期限で絞り込み */}
      <div style={{ padding: "0 18px 14px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "#FFF9F6",
            border: `1.5px solid ${COLORS.line}`,
            borderRadius: 10,
            padding: "9px 12px",
          }}
        >
          <Clock size={15} color={COLORS.muted} />
          <select
            value={daysFilter}
            onChange={(e) => setDaysFilter(e.target.value)}
            style={{
              border: "none",
              outline: "none",
              background: "transparent",
              flex: 1,
              fontFamily: "'M PLUS Rounded 1c', sans-serif",
              fontSize: 14,
              color: COLORS.ink,
            }}
          >
            <option value="">期限：すべて表示</option>
            <option value="3">3日以内</option>
            <option value="7">7日以内</option>
            <option value="14">14日以内</option>
            <option value="30">30日以内</option>
          </select>
        </div>
      </div>

      {/* タブ */}
      {combinedPicker ? (
        <div style={{ padding: "0 18px 10px" }}>
          <span
            style={{
              fontFamily: "'M PLUS Rounded 1c', sans-serif",
              fontSize: 13,
              fontWeight: 700,
              color: COLORS.crimson,
            }}
          >
            未使用・未整理からセットするクーポンを選んでください
          </span>
        </div>
      ) : (
      <div style={{ display: "flex", gap: 6, padding: "0 18px 10px", overflowX: "auto" }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              borderRadius: 999,
              border: `1.5px solid ${tab === t.key ? COLORS.ink : COLORS.line}`,
              background: tab === t.key ? COLORS.ink : "transparent",
              color: tab === t.key ? COLORS.paper : COLORS.muted,
              fontFamily: "'M PLUS Rounded 1c', sans-serif",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {t.label}
            <span
              style={{
                fontFamily: "'M PLUS Rounded 1c', sans-serif",
                fontSize: 11,
                opacity: 0.8,
              }}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>
      )}

      {/* 店舗フィルタ */}
      <div style={{ display: "flex", gap: 6, padding: "0 18px 16px", overflowX: "auto" }}>
        {storeFilters.map((s) => (
          <button
            key={s.key}
            onClick={() => setStoreFilter(s.key)}
            style={{
              flexShrink: 0,
              padding: "6px 12px",
              borderRadius: 999,
              border: `1.5px solid ${storeFilter === s.key ? COLORS.forest : COLORS.line}`,
              background: storeFilter === s.key ? COLORS.forestSoft : "transparent",
              color: storeFilter === s.key ? COLORS.forest : COLORS.muted,
              fontFamily: "'M PLUS Rounded 1c', sans-serif",
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* まとめて自動読み取り／選択してセットする */}
      {(filtered.length > 0 || (tab === "inbox" && bulkScanProgress)) && (
        <div
          style={{
            padding: "0 18px 12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          {tab === "inbox" && !selectMode ? (
            <button
              onClick={bulkScanInbox}
              disabled={!!bulkScanProgress}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 12px",
                borderRadius: 999,
                border: `1.5px solid ${COLORS.forest}`,
                background: bulkScanProgress ? COLORS.line : COLORS.forestSoft,
                color: COLORS.forest,
                fontFamily: "'M PLUS Rounded 1c', sans-serif",
                fontWeight: 700,
                fontSize: 12,
                cursor: bulkScanProgress ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <ScanLine size={13} />
              {bulkScanProgress
                ? `読み取り中…${bulkScanProgress.done}/${bulkScanProgress.total}`
                : "まとめて自動読み取り"}
            </button>
          ) : (
            <span />
          )}
          {filtered.length > 0 && (
            <button
              onClick={toggleSelectMode}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 12px",
                borderRadius: 999,
                border: `1.5px solid ${selectMode ? COLORS.crimson : COLORS.line}`,
                background: selectMode ? COLORS.crimsonSoft : "transparent",
                color: selectMode ? COLORS.crimson : COLORS.muted,
                fontFamily: "'M PLUS Rounded 1c', sans-serif",
                fontWeight: 700,
                fontSize: 12,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <Layers size={13} />
              {selectMode ? "選択をやめる" : "選んでセットする"}
            </button>
          )}
        </div>
      )}

      {/* 一覧 */}
      <div style={{ padding: "0 18px", display: "flex", flexDirection: "column", gap: 10 }}>
        {!loaded ? (
          <div style={{ textAlign: "center", color: COLORS.muted, padding: "40px 0", fontSize: 13 }}>
            読み込み中…
          </div>
        ) : filtered.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              color: COLORS.muted,
              padding: "50px 20px",
              fontSize: 13,
              lineHeight: 1.8,
            }}
          >
            <Ticket size={28} color={COLORS.line} style={{ marginBottom: 10 }} />
            <div>クーポンがありません。</div>
            <div>下の「とりあえず貼るだけ」から追加してください。</div>
          </div>
        ) : (
          filtered.map((c) => (
            <TicketCard
              key={c.id}
              coupon={c}
              onOpen={setOpenCoupon}
              selectMode={selectMode}
              selected={selectedIds.includes(c.id)}
              onToggleSelect={toggleSelected}
            />
          ))
        )}
      </div>

      {/* 選択中の操作バー */}
      {selectMode && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            background: COLORS.paper,
            borderTop: `1.5px solid ${COLORS.line}`,
            padding: "12px 18px",
            paddingBottom: "calc(12px + env(safe-area-inset-bottom))",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            zIndex: 40,
          }}
        >
          <span
            style={{
              fontFamily: "'M PLUS Rounded 1c', sans-serif",
              fontSize: 13,
              fontWeight: 700,
              color: COLORS.ink,
            }}
          >
            {selectedIds.length}件選択中
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={toggleSelectMode}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: `1px solid ${COLORS.line}`,
                background: "transparent",
                color: COLORS.muted,
                fontFamily: "'M PLUS Rounded 1c', sans-serif",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              キャンセル
            </button>
            <button
              onClick={markSelectedAsUsed}
              disabled={selectedIds.length === 0}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "none",
                background: selectedIds.length ? COLORS.crimson : COLORS.line,
                color: COLORS.paper,
                fontFamily: "'M PLUS Rounded 1c', sans-serif",
                fontWeight: 700,
                fontSize: 13,
                cursor: selectedIds.length ? "pointer" : "not-allowed",
              }}
            >
              使用済みに
            </button>
            <button
              onClick={openSetFromSelection}
              disabled={selectedIds.length === 0}
              style={{
                padding: "10px 16px",
                borderRadius: 10,
                border: "none",
                background: selectedIds.length ? COLORS.ink : COLORS.line,
                color: COLORS.paper,
                fontFamily: "'M PLUS Rounded 1c', sans-serif",
                fontWeight: 700,
                fontSize: 13,
                cursor: selectedIds.length ? "pointer" : "not-allowed",
              }}
            >
              セットして表示
            </button>
          </div>
        </div>
      )}

      {openCoupon && (
        <DetailModal
          key={openCoupon.id}
          coupon={coupons.find((c) => c.id === openCoupon.id) || openCoupon}
          coupons={coupons}
          onClose={() => setOpenCoupon(null)}
          onUpdate={updateCoupon}
          onDelete={deleteCoupon}
          onPrev={openIndex > 0 ? () => setOpenCoupon(filtered[openIndex - 1]) : null}
          onNext={
            openIndex >= 0 && openIndex < filtered.length - 1
              ? () => setOpenCoupon(filtered[openIndex + 1])
              : null
          }
          position={openIndex >= 0 ? { index: openIndex, total: filtered.length } : null}
        />
      )}
      {useSetImages && (
        <UseSetViewer images={useSetImages} onClose={() => setUseSetImages(null)} />
      )}

      {/* とりあえず貼るだけ（未整理へ／画面下部固定） */}
      {!selectMode && <QuickAddBar onQuickAdd={quickAdd} />}
    </div>
  );
}
