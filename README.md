# kakeibo-pwa

家計簿システム「kakeibo」のレシート撮影PWA(GitHub Pages配信用・Public)。

- カメラ1画面のみ。アイコンタップ → シャッターの2タップでレシートをGAS Web APIへ送信する
- GAS WebアプリURLは**このリポジトリに含めない**。初回に `https://<pages-url>/?gas=<WebアプリURL>` を
  一度開くと localStorage に保存され、以後は不要(URLは即座にアドレスバーから消える)
- 本体(GAS・移行スクリプト・設計書)は別リポジトリ `kakeibo`(Private)で管理

## スマホへの導入手順

1. Chromeで `?gas=...` 付きURLを開く(URLは所有者のみが知る)
2. カメラ許可を求められたら許可
3. メニュー →「ホーム画面に追加」
4. 以後はホームのアイコンから起動 → 撮影 → 「登録完了。閉じてOK」表示で完了
