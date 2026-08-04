# デプロイ記録

## 本番URL（固定）

https://coupon-app-dusky.vercel.app

家族が使うのはこのURLだけ。下の `coupon-xxxxx-...vercel.app` は毎回発行される個別URLで、
最新のものが上のURLに割り当てられる。

## デプロイ手順

```
cd ~/claude-workspace/coupon-app
export PATH="$HOME/.local/node/bin:$PATH"
npm run build          # 先にビルドが通ることを確認する
npx vercel deploy --prod --yes
```

**注意**: Bashのカレントディレクトリがプロジェクト外（`/Users/apple` など）だと、
`npx vite build` が別バージョンのviteを拾って
`Cannot resolve entry module index.html` で失敗する。必ず `cd` してから実行する。

## 反映の確認方法

アプリのヘッダーに出ている「更新 M/D」がビルド日。家族の端末がここを見て
古い日付なら、PWAが古いキャッシュで動いている（アプリを完全に終了して開き直す）。

本番に狙いの変更が乗っているかはコマンドで確認できる。

```
ASSET=$(curl -s https://coupon-app-dusky.vercel.app/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)
curl -s "https://coupon-app-dusky.vercel.app/$ASSET" | grep -c "確認したい文字列"
```

ビルド日時そのものは同じファイルから取れる。

```
curl -s "https://coupon-app-dusky.vercel.app/$ASSET" | grep -oE '2026-[0-9]{2}-[0-9]{2}T[0-9:.]+Z' | head -1
```

なお本番のバンドル名（ハッシュ）はローカルの `dist/` と一致しない。Vercel側でビルドし直しており、
`__BUILD_DATE__` に埋まる時刻が変わるため。中身が同じかはローカルのハッシュではなく上の方法で確かめる。

---

## 履歴

### 2026-07-29 商品名OCRの誤読対策 ＋ 読み取り直しUI ＋ 終了確認 ＋ E2E

- コミット: `7ea233c`
- 本番に反映されたデプロイ: https://coupon-20xwmfhce-kamesanusagisan1234.vercel.app
- 作成日時: 2026-07-29 21:25:38 JST（バンドルのビルド時刻 2026-07-29T12:25:43Z）
- 状態: Ready / Production

内容（詳細と経緯は [HANDOVER.md](HANDOVER.md)）:

- 商品名が `r-196<ダブルレモン>` `196(¥ 7ILL EV)` `ださい TE` のように壊れる問題を修正
- 一覧で複数選択して「読み取り直す」（商品名のみ上書き）
- クーポン表示画面の上部にも「読み取り直す」を追加
- 左スワイプでの終了確認
- OCR前の画像をJPEGからPNGへ（端末ごとに結果が割れる原因だった二重圧縮の解消）
- Playwright E2E を追加（`npm run e2e` / `npm run e2e:prod`）

この日は同じ内容を段階的に直しながら複数回デプロイしている。上記が最終版で、
それ以前の当日分（`coupon-m5t2iyq25` `coupon-cyygfym1v` `coupon-i5m7xcmfo`
`coupon-l9q309u7d` `coupon-lxf5kwyii` `coupon-5rbmtlq07` `coupon-3x5auale1`）は途中経過。
