# diffm-web

2本の動画をフレーム単位で比較し、差分の明るさをグラフにする Web ツール。
[Tsut-ps/diffm](https://github.com/Tsut-ps/diffm) の発想をブラウザで再現したもの。処理はすべてブラウザ内で行い、動画は送信しない。

公開版: <https://tsut-ps.github.io/diffm-web/>

## 使い方

1. 動画 A（基準）と B（比較対象）を選ぶ（ドロップも可）
2. 「開始」を押す
3. グラフの点、または「しきい値を超えた区間」をクリックすると、そのフレームを A / B / 差分で表示
4. 「各区間のピークを ZIP で保存」で、区間ごとのピークフレームを PNG（左から A | B | 差分）で保存。「CSV で保存」でフレームごとの値を保存

## 開発

Node.js 22 以上。

```
npm ci --ignore-scripts
npm run dev      # 開発サーバー（http://localhost:5173/）
npm run build    # dist/ に公開物を出力
npm run preview  # dist/ を確認
```

- 開発サーバーは自分の PC からだけ使う（`--host` で外部に公開しない）
- CSP はビルド時だけ付く（開発サーバーとは両立しないため）。CSP の確認は `npm run preview` で行う
- mediabunny の更新: `npm install --ignore-scripts --save-exact mediabunny@<版>` の後、`vite.config.js` と `index.html` にある版とソースの URL も直す

## 公開

`main` にプッシュすると、GitHub Actions（`.github/workflows/pages.yml`）がビルドして `dist/` だけを GitHub Pages に公開する。

- 初回のみ、リポジトリの Settings → Pages → Source を「GitHub Actions」にする
- Actions はコミットのハッシュで固定し、権限はジョブごとに最小限にしている
- 依存はロックファイルどおりに入れ、インストール時のスクリプトは実行しない

## 仕組み

- [mediabunny](https://mediabunny.dev/) と WebCodecs で、両動画を先頭から順にデコードする。**シークしないので、フレームはずれない**
- 差分 = 画素ごとの絶対差の輝度平均（0〜255）。diffm の brightness と同じ考え方
- 結果として保持するのはフレームごとの数値とタイムスタンプだけ。画像は表示・保存のときに、そのフレームだけ再デコードする
- 描画間隔は表示の更新頻度のみに効く。計算は全フレームで行う

## 対応づけ

| 方法 | 内容 |
|---|---|
| フレーム番号 | A の n 番目 ↔ B の n 番目。どちらかが尽きたら終了 |
| 時刻 | A の各フレームの時刻に表示されている B のフレームを当てる（B は重複・欠落する） |
| 自動（既定） | fps が違えば時刻、同じならフレーム番号 |

## 警告

比較条件が違うと、画面に警告を出す（比較は続行する）。

- 解像度が違う: B を A の大きさに拡縮する（縦横比が違えば引き伸ばす）
- fps が違う: 対応づけ方法に応じた注意
- 長さが違う: 短い方に合わせる

## 動作環境と制約

- WebCodecs が使えるモダンブラウザ。デコードできるコーデックはブラウザ次第（H.264 / VP9 / AV1 など）。非対応なら読み込み時にエラーを出す
- 速度の目安: 1080p で約 14〜18 fps、4K で約 1.5〜3 fps（GPU なしのヘッドレス Chrome での実測）。「計算サイズ」を下げると速くなる（正確さは下がる）
- 解像度の上限は 1 辺 4096px（4K UHD 3840×2160、DCI 4K 4096×2160 を含む）。超える動画は読み込み時に拒否する
- 外部への通信はしない（CSP で通信先を一切許可していない）

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | 画面 |
| `src/app.js` | 読み込み、実行、グラフ操作、書き出し |
| `src/pairing.js` | 2本のフレーム列の対応づけ |
| `src/diff.js` | 差分計算、区間検出、比較条件の警告 |
| `src/chart.js` | グラフ描画 |
| `src/zip.js` | 無圧縮 ZIP の書き出し |
| `src/style.css` | スタイル |
| `vite.config.js` | ビルド設定（CSP、ライセンス表記） |
| `.github/workflows/pages.yml` | GitHub Pages への公開 |

## ライセンス表記

公開物には [mediabunny](https://github.com/Vanilagy/mediabunny) 1.62.1 を含む。

- ライセンス: [MPL-2.0](https://mozilla.org/MPL/2.0/)
- ソースコード: <https://github.com/Vanilagy/mediabunny/tree/f630141a4ac2936d00af14bf8ff2c5bb62b66150>（1.62.1 の公開元コミット）
- ビルドした JS の先頭と、画面の下部に同じ表記を出している
