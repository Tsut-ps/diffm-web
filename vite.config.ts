import { defineConfig, type Plugin } from 'vite';

// 公開物に付ける CSP。外部への通信は一切許可しない。
// mediabunny は内部で blob: のワーカーを使うため worker-src blob: のみ許可する。
// 並べて再生は、選んだ動画のローカルな blob: URL を <video> で再生するため media-src blob: のみ許可する。
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  'img-src data:',
  'media-src blob:',
  'worker-src blob:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Cloudflare Workers が静的アセットの応答に付けるヘッダー（dist/_headers として出力）。
// CSP は meta と同じ内容に、meta では効かない frame-ancestors（埋め込み防止）を足す。
const HEADERS = `/*
  Content-Security-Policy: ${CSP}; frame-ancestors 'none'
`;

/** ビルド時に _headers を出力する。 */
function workersHeaders(): Plugin {
  return {
    name: 'workers-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: HEADERS });
    },
  };
}

/** ビルド時だけ CSP の meta を挿入する（開発サーバーはインラインのスタイルや通信を使うため）。 */
function cspMeta(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

// ビルドで mediabunny の著作権表示が消えるため、MPL-2.0 の表記とソースの入手先を JS の先頭に付ける
const BANNER = `/*!
 * This file includes mediabunny 1.62.1 (Copyright (c) 2026-present, Vanilagy and contributors),
 * licensed under the Mozilla Public License, v. 2.0: https://mozilla.org/MPL/2.0/
 * Source: https://github.com/Vanilagy/mediabunny/tree/f630141a4ac2936d00af14bf8ff2c5bb62b66150
 */`;

export default defineConfig({
  // 相対パスで出力し、サブパスで公開しても、ローカルでも動くようにする
  base: './',
  plugins: [cspMeta(), workersHeaders()],
  build: {
    target: 'es2022',
    // 古いブラウザ向けの modulepreload 補助処理（fetch を含む）は不要。WebCodecs が動くブラウザは対応済み
    modulePreload: { polyfill: false },
    // ソースマップは公開しない
    sourcemap: false,
    rolldownOptions: {
      // banner は minify で消えるため、minify 後に付く postBanner を使う
      output: { postBanner: BANNER },
    },
  },
});
