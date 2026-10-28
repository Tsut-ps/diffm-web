// 小さなユーティリティ（画面にも状態にも依存しない）

const intl = new Intl.NumberFormat('ja-JP');

/** 3桁区切りの整数表示。 */
export const fmt = (v: number): string => intl.format(v);

/** 小数を d 桁で表示。有限でなければ '-'。 */
export const num = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '-');

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
