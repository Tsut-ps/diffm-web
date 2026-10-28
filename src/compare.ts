// 比較の実行: 2本を先頭から順にデコードし、フレームごとの差分を記録する

import { VideoSampleSink, type VideoSample } from 'mediabunny';
import { meanLumaDiff, renderDiff } from './diff';
import { ui } from './dom';
import { grab, viewContexts } from './frames';
import { pairByIndex, pairByTime } from './pairing';
import { readRunSettings } from './settings';
import { state } from './state';
import type { Run } from './types';
import { errorMessage, fmt, num, yieldToUI } from './util';
import { refreshResults, resetRun, showCaptions, showError, summary, syncButtons } from './view';

/** 進捗表示を更新する間隔（ms） */
const UI_INTERVAL = 120;

/** 再デコード時に、このフレームを確実に指すタイムスタンプ（フレーム中央付近）。 */
const queryTime = (s: VideoSample) => s.timestamp + (s.duration > 0 ? s.duration / 2 : 1e-6);

export async function start(): Promise<void> {
  const { A, B } = state;
  if (state.running || !A || !B) return;
  resetRun();
  showError('');

  const { mode, w, h, interval, gain } = readRunSettings(A, B);
  for (const c of Object.values(ui.canvas)) {
    c.width = w;
    c.height = h;
  }
  const ctx = viewContexts();
  const outImage = ctx.D.createImageData(w, h);

  const expected = Math.floor(
    mode === 'time' ? A.duration * A.fps : Math.min(A.duration * A.fps, B.duration * B.fps),
  );
  const sinks = { A: new VideoSampleSink(A.track), B: new VideoSampleSink(B.track) };
  const run: Run = {
    values: [], tsA: [], tsB: [], qA: [], qB: [],
    w, h, mode, gain, expected, sinks,
    selected: -1, hover: -1, layout: null,
  };
  state.run = run;
  state.running = true;
  state.stop = false;
  syncButtons();

  const pairs =
    mode === 'time'
      ? pairByTime(sinks.A.samples(), sinks.B.samples(), A.first, B.first)
      : pairByIndex(sinks.A.samples(), sinks.B.samples());

  const t0 = performance.now();
  let lastUi = t0;

  try {
    for await (const { index, a, b } of pairs) {
      const da = grab(a, ctx.A, w, h);
      const db = grab(b, ctx.B, w, h);

      run.values.push(meanLumaDiff(da, db));
      run.tsA.push(a.timestamp);
      run.tsB.push(b.timestamp);
      run.qA.push(queryTime(a));
      run.qB.push(queryTime(b));

      if (index % interval === 0) {
        renderDiff(da, db, outImage.data, gain);
        ctx.D.putImageData(outImage, 0, 0);
        const last = run.values.length - 1;
        showCaptions(last, a.timestamp, b.timestamp, run.values[last]!);
        refreshResults();
      }

      const now = performance.now();
      if (now - lastUi > UI_INTERVAL) {
        const n = run.values.length;
        const fps = n / ((now - t0) / 1000);
        ui.bar.value = expected > 0 ? Math.min(1, n / expected) : 0;
        ui.status.textContent =
          `処理中 ${fmt(n)}${expected ? ` / 約 ${fmt(expected)}` : ''} フレーム · ${num(fps, 1)} fps`;
        lastUi = now;
        await yieldToUI();
      }
      if (state.stop) break;
    }
    if (run.values.length === 0) throw new Error('比較できるフレームがありませんでした。');
  } catch (e) {
    console.error(e);
    showError(`エラー: ${errorMessage(e)}`);
  } finally {
    state.running = false;
    ui.bar.value = run.values.length ? 1 : 0;
    const secs = (performance.now() - t0) / 1000;
    ui.status.textContent =
      `${state.stop ? '停止' : '完了'} ${fmt(run.values.length)} フレーム · ${summary(run)} · ${num(secs, 1)} 秒`;
    refreshResults();
    syncButtons();
  }
}

export function stop(): void {
  state.stop = true;
}
