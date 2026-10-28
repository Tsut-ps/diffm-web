// 任意フレームの再デコードと描画（A / B / 差分）

import type { VideoSample } from 'mediabunny';
import { renderDiff, meanLumaDiff } from './lib/diff';
import { ui } from './ui/dom';
import { state, type Run } from './types';
import { errorMessage, must } from './lib/util';
import { refreshResults, showCaptions, showError } from './ui/view';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 画面の A / B / 差分キャンバスの 2D コンテキスト。A と B は画素を読むので willReadFrequently。 */
export function viewContexts(): { A: Ctx2D; B: Ctx2D; D: Ctx2D } {
  return {
    A: must(ui.canvas.A.getContext('2d', { willReadFrequently: true })),
    B: must(ui.canvas.B.getContext('2d', { willReadFrequently: true })),
    D: must(ui.canvas.D.getContext('2d')),
  };
}

/** フレームを w×h に拡縮して ctx に描き、その RGBA を返す。 */
export function grab(sample: VideoSample, ctx: Ctx2D, w: number, h: number): Uint8ClampedArray {
  sample.draw(ctx, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** i 番目のペアを再デコードする（記録したタイムスタンプで取得するので、ずれない）。呼び出し側が close する。 */
export async function fetchPair(run: Run, i: number): Promise<{ a: VideoSample; b: VideoSample }> {
  const { sinks } = run;
  if (!sinks) throw new Error('比較結果が破棄されています。');
  const [a, b] = await Promise.all([sinks.A.getSample(run.qA[i]!), sinks.B.getSample(run.qB[i]!)]);
  if (!a || !b) {
    a?.close();
    b?.close();
    throw new Error(`#${i} のフレームを取得できませんでした。`);
  }
  return { a, b };
}

/** A / B を描き、差分を ctxD に描いて、差分の明るさを返す。 */
export function paint(
  run: Run,
  a: VideoSample,
  b: VideoSample,
  ctxA: Ctx2D,
  ctxB: Ctx2D,
  ctxD: Ctx2D,
): number {
  const da = grab(a, ctxA, run.w, run.h);
  const db = grab(b, ctxB, run.w, run.h);
  const out = ctxD.createImageData(run.w, run.h);
  renderDiff(da, db, out.data, run.gain);
  ctxD.putImageData(out, 0, 0);
  return meanLumaDiff(da, db);
}

let inspectToken = 0;

/** i 番目のフレームを選んで、A / B / 差分に表示する。 */
export async function inspect(i: number): Promise<void> {
  const run = state.run;
  if (!run || state.running || !run.sinks) return;
  const token = ++inspectToken;
  run.selected = i;
  refreshResults();
  try {
    const { a, b } = await fetchPair(run, i);
    try {
      if (token !== inspectToken) return;
      const ctx = viewContexts();
      const diff = paint(run, a, b, ctx.A, ctx.B, ctx.D);
      showCaptions(i, a.timestamp, b.timestamp, diff);
    } finally {
      a.close();
      b.close();
    }
  } catch (e) {
    showError(`エラー: ${errorMessage(e)}`);
  }
}
