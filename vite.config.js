import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // アプリの更新日（ビルド実行日時）。ヘッダーの「更新 M/D」表示に使う
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      workbox: {
        // 再デプロイ後に古いキャッシュ・古いチャンク参照が残って
        // 動的読み込み（バーコード/OCR）が失敗するのを防ぐ
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
      },
      manifest: {
        name: "クーポン管理",
        short_name: "クーポン管理",
        description: "URLやスクリーンショットで受け取ったクーポン・無料券を一元管理するアプリ",
        theme_color: "#E28CA0",
        background_color: "#FFF6F2",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  server: {
    host: true,
  },
});
