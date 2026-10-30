// 小さなユーティリティ（画面にも状態にも依存しない）

const intl = new Intl.NumberFormat('ja-JP');

/** 3桁区切りの整数表示。 */
export const fmt = (v: number): string => intl.format(v);

/** 小数を d 桁で表示。有限でなければ '-'。 */
export const num = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '-');

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|ogg|avi|3gp)$/i;

/** 動画ファイルらしいか（種類か拡張子で見る）。 */
export const isVideoFile = (f: File): boolean => f.type.startsWith('video/') || VIDEO_EXT.test(f.name);

export const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

/** 秒を m:ss.cc で表示。 */
export function formatTime(s: number): string {
  const cs = Math.floor((Number.isFinite(s) && s > 0 ? s : 0) * 100);
  const m = Math.floor(cs / 6000);
  const sec = Math.floor(cs / 100) % 60;
  return `${m}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** 描画やイベントを処理させるため、メインスレッドを一度手放す。 */
export const yieldToUI = (): Promise<void> =>
  globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r));

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** getContext の結果から null を除く。 */
export function must<T>(ctx: T | null): T {
  if (!ctx) throw new Error('2D コンテキストを取得できませんでした。');
  return ctx;
}
