import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// 実物のクーポン画像（2320-2196-71661 / -196 〈ダブルレモン〉 5% 350ml缶）。
// 商品名が「ださい TE」などの誤読になる再発を防ぐための固定データ。
const FIXTURE = path.join(here, "fixtures", "coupon2-doublelemon.jpg");

const TEST_ID = "tagtest_e2e_rescan";

function fixtureDataUrl() {
  const b64 = fs.readFileSync(FIXTURE).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

async function seedCoupon(page, { productName }) {
  await page.evaluate(
    async ({ id, imageDataUrl, productName }) => {
      const cloud = await import("/src/cloudStore.js");
      const now = new Date().toISOString();
      await cloud.saveCouponToCloud({
        id,
        title: "",
        productName,
        sourceType: "screenshot",
        url: "",
        imageDataUrl,
        expiresAt: "",
        store: "",
        barcode: "",
        autoScanned: true,
        inbox: false,
        status: "unused",
        memo: "",
        createdAt: now,
        updatedAt: now,
        usedAt: null,
      });
    },
    { id: TEST_ID, imageDataUrl: fixtureDataUrl(), productName }
  );
}

async function readCoupon(page) {
  return page.evaluate(async (id) => {
    const cloud = await import("/src/cloudStore.js");
    const list = await new Promise((resolve) => {
      let unsub;
      unsub = cloud.subscribeCoupons((cs) => {
        resolve(cs);
        if (unsub) unsub();
      });
    });
    const c = list.find((x) => x.id === id);
    return c ? { productName: c.productName, store: c.store, barcode: c.barcode, expiresAt: c.expiresAt } : null;
  }, TEST_ID);
}

async function cleanUp(page) {
  await page.evaluate(async (id) => {
    const cloud = await import("/src/cloudStore.js");
    try {
      await cloud.deleteCouponFromCloud(id);
    } catch (e) {
      /* すでに消えていれば無視 */
    }
  }, TEST_ID);
}

test.describe("未使用クーポンを選択して読み取り直す", () => {
  test.afterEach(async ({ page }) => {
    await cleanUp(page);
  });

  test("壊れた商品名がOCRで正しい商品名に上書きされる", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "クーポン管理" })).toBeVisible();

    // 実際に起きた誤読の値を初期値として仕込む
    await seedCoupon(page, { productName: "ださい TE" });
    await page.reload();

    const card = page.locator("button").filter({ hasText: "ださい TE" }).first();
    await expect(card).toBeVisible();

    // カード左端のチェックで選択 → 下部バーの「読み取り直す」
    await card.getByRole("checkbox").click();
    await page.getByRole("button", { name: "読み取り直す" }).click();

    // OCRの完了は、完了時に出るトーストで待つ（進捗表示の有無で待つと取りこぼす）
    await expect(page.getByText(/読み取り直しました/)).toBeVisible({ timeout: 150_000 });

    const saved = await readCoupon(page);
    expect(saved).not.toBeNull();

    // 商品名が誤読のままになっていないこと（今回の不具合の再発防止）
    expect(saved.productName).not.toContain("ださい");
    expect(saved.productName).not.toContain("TE");
    // 商品名が読み取れていること
    expect(saved.productName).toContain("ダブルレモン");
    // バーコードと店舗も拾えていること
    expect(saved.barcode).toBe("2320219671661");
    expect(saved.store).toBe("seven");
  });

  test("読み取れなかったときに注意書きやUI文字を商品名にしない", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "クーポン管理" })).toBeVisible();

    // 商品名の手がかりが無い行だけを渡したとき、空を返すこと。
    // （ここで「残った候補の1行目」を拾ってしまうのが「ださい TE」の原因だった）
    const results = await page.evaluate(async () => {
      const scan = await import("/src/scan.js");
      const mk = (arr) => arr.map((t, i) => ({ text: t, y: i * 30, y1: i * 30 + 20 }));
      return {
        noiseOnly: scan.extractProductNameGuess(
          mk(["示 し て いる バー コー ド 」 の スキャン を お 申し付", "ださい TE", "SN", "Go |"])
        ),
        boilerplateOnly: scan.extractProductNameGuess(
          mk(["※ 賞 品 の 引換 え は お 一 人 様 一 回 の み 、 当 選者 ご 本 人 に"])
        ),
      };
    });

    expect(results.noiseOnly).toBe("");
    expect(results.boilerplateOnly).toBe("");
  });
});
