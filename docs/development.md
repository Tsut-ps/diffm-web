# 開発

## 仕組み

[mediabunny](https://mediabunny.dev/) と WebCodecs で、2本を先頭から順にデコードします。シークしないので、フレームはずれません。

記録するのは、数値とタイムスタンプだけです。画像は、表示・保存のときに、そのフレームだけ再デコードします。

音声は、動画の比較と並べて、別の流れで読みます。詳しくは、[audio.md](audio.md) にあります。

## 開発環境

Node.js 24 を使います（`.node-version` で固定。Workers Builds もこれを使います）。

```
npm ci --ignore-scripts
npm run dev        # 開発サーバー（http://localhost:5173/）
npm run typecheck  # 型チェック
npm run build      # 型チェックの後、dist/ に出力
npm run preview    # dist/ の確認（meta の CSP のみ。応答ヘッダーも見るなら npx wrangler dev）
```

- 開発サーバーは、自分の PC からだけ使います（`--host` で公開しません）。
- CSP は、ビルド時だけ付きます（開発サーバーと両立しないため）。通信先は許可せず、ワーカーと動画再生のための、ローカルな `blob:` だけを許可しています。
- mediabunny の更新: `npm install --ignore-scripts --save-exact mediabunny@<版>` の後、`vite.config.ts` と `index.html` の版とソース URL も直します。

## ソースの構成

```
src/
  app.ts       エントリーポイント（イベントを各機能につなぐ）
  player.ts    並べて再生（共通タイムライン、動画の追加・削除、操作）
  player.css   並べて再生の見た目
  loader.ts    動画の読み込み
  compare.ts   比較の実行
  audio.ts     音声の読み込みと、2本の音声の差の分析
  audioplay.ts 音声を聴く（Web Audio）
  frames.ts    任意フレームの再表示
  exporter.ts  ZIP / CSV の書き出し
  types.ts     型と状態
  lib/         DOM に触らない処理（差分計算、音声の FFT と差、フレームの合わせ方、ZIP）
  ui/          画面の要素、反映、グラフ（映像・音声）、タブ、ドロップ、設定の保存
```

## 公開

Cloudflare Workers の静的アセットとして公開します（設定は `wrangler.jsonc`、配信は `dist/` のみ）。

- `main` にプッシュすると、Cloudflare の Git 連携が `npm run build` → `npx wrangler deploy` で公開します。
- 手元からは、`npm run build` の後に `npx wrangler deploy` です。
- ビルド時に `dist/_headers` を出力し、Workers が CSP を応答ヘッダーでも付けます（meta と同じ内容に、埋め込みを防ぐ `frame-ancestors 'none'` を追加。`_headers` 自体は配信されません）。
