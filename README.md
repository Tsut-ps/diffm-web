# diffm-web

2本の動画を1フレームずつ比べて、どこがどれだけ違うかをグラフにするツール  
エンコード設定を変えたときの画質劣化や、編集で意図せず変わった箇所を見つけるのに使えます

- ブラウザだけで動きます。動画はどこにも送信されません
- [Tsut-ps/diffm](https://github.com/Tsut-ps/diffm) の考え方を Web にしたものです

<img width="1120" height="575" alt="image" src="https://github.com/user-attachments/assets/9df5fd12-3d90-4687-b83f-3303d889dbbe" />
（立ち絵: 一止月サノツキさん）

## 使い方

1. 動画 A（基準）と B（比較対象）を選ぶ（ドロップも可）
2. 「開始」を押す（「停止」で途中までの結果も使えます）
3. グラフの点か、しきい値を超えた区間をクリックすると、そのフレームを A / B / 差分で表示
4. 「各区間のピークを ZIP で保存」（PNG、左から A | B | 差分）、「CSV で保存」（全フレームの値）

**差分の値**は、画素ごとの色の差を輝度で平均したものです。0 なら完全に同じで、最大は 255。しきい値以上が続く範囲を「区間」として並べます。

## 設定

| 項目 | 内容 |
|---|---|
| 対応づけ | A と B のどのフレーム同士を比べるか（下の表）。初期値は自動 |
| 計算サイズ | 縦横をこの割合に縮小して比べる（50% なら画素数は 1/4）。小さいほど速く、正確さは下がる |
| 描画間隔 | 画面を更新する間隔。結果には影響しない |
| 差分の強調 | 差分画像の表示倍率。値には影響しない |
| しきい値 | 「違う」とみなす値。終了後に変えると区間もすぐ更新される |

## 対応づけ

| 方法 | 内容 |
|---|---|
| フレーム番号 | A の n 番目と B の n 番目を比べる。どちらかが尽きたら終了 |
| 時刻 | A の各フレームの時刻に表示されている B のフレームを当てる（B は重複・欠落する） |
| 自動（初期値） | fps が違えば時刻、同じならフレーム番号 |

## 警告

比較条件が違うと画面に警告を出します（比較は続行）。

- 解像度が違う: B を A の大きさに拡縮する（縦横比が違えば引き伸ばす）
- fps が違う: 対応づけ方法に応じた注意
- 長さが違う: 短い方に合わせる

## 動作環境と制約

- WebCodecs が使えるモダンブラウザが必要。デコードできるコーデックはブラウザ次第（H.264 / VP9 / AV1 など）で、読めない動画は読み込み時にエラー
- 解像度は 1 辺 4096px まで（4K UHD / DCI 4K を含む）。超えると読み込み時に断る
- 外部へは通信しない（CSP で通信先を許可していない）

## 速さの目安

1秒あたりに比べられるフレーム数（fps）の実測です。動画の絵の細かさやビットレートで変わります。

| 環境 | 動画 | 計算サイズ（縦横の縮小率） | fps |
|---|---|---|---|
| GPU なしのヘッドレス Chrome | 1080p | 100% | 約 14〜18 |
| GPU なしのヘッドレス Chrome | 4K | 100% | 約 1.5〜3 |
| Ryzen 9 9950X3D + RTX 5070 Ti、Chrome | 1080p（H.264 / VP9 / AV1 / HEVC） | 100% | 約 92〜97 |
| 同上 | 1080p（H.264、細かい絵・約 260Mbps） | 100% | 約 57 |
| 同上 | 1080p（H.264） | 50% / 25% | 約 238 / 395 |
| 同上 | 4K（H.264 / AV1） | 100% | 約 25〜27 |
| 同上 | 4K（H.264） | 50% | 約 74 |

Ryzen + RTX の行は、10 秒・30fps の合成映像を A と B の両方に入れて、1回測った値です。実写では変わります。

## 仕組み

[mediabunny](https://mediabunny.dev/) と WebCodecs で、2本を先頭から順にデコードします。シークしないので、フレームはずれません。
記録するのは数値とタイムスタンプだけで、画像は表示・保存のときに、そのフレームだけ再デコードします。

## 開発

Node.js 24（`.node-version` で固定。Workers Builds もこれを使う）。

```
npm ci --ignore-scripts
npm run dev        # 開発サーバー（http://localhost:5173/）
npm run typecheck  # 型チェック
npm run build      # 型チェックの後、dist/ に出力
npm run preview    # dist/ の確認（meta の CSP のみ。応答ヘッダーも見るなら npx wrangler dev）
```

- 開発サーバーは自分の PC からだけ使う（`--host` で公開しない）
- CSP はビルド時だけ付く（開発サーバーと両立しないため）
- mediabunny の更新: `npm install --ignore-scripts --save-exact mediabunny@<版>` の後、`vite.config.ts` と `index.html` の版とソース URL も直す

```
src/
  app.ts       エントリーポイント（イベントを各機能につなぐ）
  loader.ts    動画の読み込み
  compare.ts   比較の実行
  frames.ts    任意フレームの再表示
  exporter.ts  ZIP / CSV の書き出し
  types.ts     型と状態
  lib/         DOM に触らない処理（差分計算、対応づけ、ZIP）
  ui/          画面の要素、反映、グラフ
```

## 公開

Cloudflare Workers の静的アセットとして公開します（設定は `wrangler.jsonc`、配信は `dist/` のみ）。

- `main` にプッシュすると、Cloudflare の Git 連携が `npm run build` → `npx wrangler deploy` で公開
- 手元からは、`npm run build` の後に `npx wrangler deploy`
- ビルド時に `dist/_headers` を出力し、Workers が CSP を応答ヘッダーでも付ける（meta と同じ内容に、埋め込みを防ぐ `frame-ancestors 'none'` を追加。`_headers` 自体は配信されない）

## ライセンス表記

公開物には [mediabunny](https://github.com/Vanilagy/mediabunny) 1.62.1 を含みます。

- ライセンス: [MPL-2.0](https://mozilla.org/MPL/2.0/)
- ソースコード: <https://github.com/Vanilagy/mediabunny/tree/f630141a4ac2936d00af14bf8ff2c5bb62b66150>（1.62.1 の公開元コミット）
- ビルドした JS の先頭と、画面の下部に同じ表記を出しています
