import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

// Firebaseコンソールの「プロジェクトの設定」>「マイアプリ」に表示される
// firebaseConfig をここに貼り付ける。
const firebaseConfig = {
  apiKey: "AIzaSyAEzkSloMTMPeJFYqwWXkULCIBytYkRBMs",
  authDomain: "couponapp-52775.firebaseapp.com",
  projectId: "couponapp-52775",
  storageBucket: "couponapp-52775.firebasestorage.app",
  messagingSenderId: "537776249298",
  appId: "1:537776249298:web:9d5c8f4a1b767f362ed00b",
};

// 家族で共有する固定のグループID（推測されにくいランダム文字列）。
// この値を知っている端末はすべて同じクーポン一覧を読み書きする。
export const HOUSEHOLD_ID = "LjsGkL-TYePy";

export const app = initializeApp(firebaseConfig);

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export const auth = getAuth(app);

let signInPromise = null;

// 匿名認証でサインインする（家族間はログイン画面なしで共有するため、
// 個人を識別しない匿名アカウントを各端末で自動発行するだけ）。
export function ensureSignedIn() {
  if (!signInPromise) {
    signInPromise = new Promise((resolve, reject) => {
      const unsubscribe = onAuthStateChanged(
        auth,
        (user) => {
          if (user) {
            unsubscribe();
            resolve(user);
          }
        },
        reject
      );
      signInAnonymously(auth).catch((e) => {
        unsubscribe();
        reject(e);
      });
    });
  }
  return signInPromise;
}
