import { defineConfig } from 'vite';

// 公開物に付ける CSP。外部への通信は一切許可しない。
// mediabunny は内部で blob: のワーカーを使うため worker-src blob: のみ許可する。
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  'img-src data:',
  'worker-src blob:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** ビルド時だけ CSP の meta を挿入する（開発サーバーはインラインのスタイルや通信を使うため）。 */
function cspMeta() {
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
  plugins: [cspMeta()],
  build: {
    target: 'es2022',
    // ソースマップは公開しない
    sourcemap: false,
    rolldownOptions: {
      // banner は minify で消えるため、minify 後に付く postBanner を使う
      output: { postBanner: BANNER },
    },
  },
});
