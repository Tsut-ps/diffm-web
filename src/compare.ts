// 比較の実行: 2本を先頭から順にデコードし、フレームごとの差分を記録する

import { VideoSampleSink, type VideoSample } from 'mediabunny';
import { analyzeAudio, canCompareAudio } from './audio';
import { HOP_RATE } from './lib/audiodsp';
import { meanLumaDiff, renderDiff } from './lib/diff';
import { readRunSettings, ui } from './ui/dom';
import { grab, viewContexts } from './frames';
import { pairByIndex, pairByTime } from './lib/pairing';
import { hasVideo, state, type Run, type VideoInfo } from './types';
import { errorMessage, fmt, formatTime, num, yieldToUI } from './lib/util';
import { refreshAudio } from './ui/audioview';
import { refreshResults, resetRun, showCaptions, showError, summary, syncButtons } from './ui/view';

/** 進捗表示を更新して、画面に描画の機会を渡す間隔（ms）。描画間隔が自動のときは、描き直しの下限にもなる */
const UI_INTERVAL = 120;
/**
 * 描画間隔が自動のとき、差分の画像とグラフの描き直しにかかった時間の、何倍の間を空けるか。
 * 大きな動画ほど描画が重いので、間を広げて、描画が比較の足を引っ張るのを 2 割ほどに抑える。
 * （フレーム数ではなく時間で決める。速さは、動画や比較の解像度で 1.5fps 〜 400fps と大きく変わるため）
 */
const REDRAW_COST_RATIO = 4;

/** 再デコード時に、このフレームを確実に指すタイムスタンプ（フレーム中央付近）。 */
const queryTime = (s: VideoSample) => s.timestamp + (s.duration > 0 ? s.duration / 2 : 1e-6);

/** 音声だけで比べる（A か B に、映像がないとき）。映像の比較は行わない。 */
async function startAudioOnly(A: VideoInfo, B: VideoInfo): Promise<void> {
  state.running = true;
  state.stop = false;
  syncButtons();
  const t0 = performance.now();
  ui.status.textContent = '音声を解析中…';
  try {
    await analyzeAudio(A, B, () => state.stop, () => {
      refreshAudio();
      const au = state.audio;
      if (au && au.expected > 0) ui.bar.value = Math.min(1, au.count / au.expected);
    });
  } finally {
    state.running = false;
    ui.bar.value = 1;
    const au = state.audio;
    const secs = (performance.now() - t0) / 1000;
    ui.status.textContent =
      `${state.stop ? '停止' : '完了'} 音声 ${formatTime((au?.count ?? 0) / HOP_RATE)} · ${num(secs, 1)} 秒`;
    refreshAudio();
    syncButtons();
  }
}

export async function start(): Promise<void> {
  const { A, B } = state;
  if (state.running || !A || !B) return;
  const audioOnly = !(hasVideo(A) && hasVideo(B));
  if (audioOnly && !canCompareAudio(A, B)) return;
  resetRun();
  showError('');
  if (!(hasVideo(A) && hasVideo(B))) return startAudioOnly(A, B);

  const { mode, w, h, gain, redrawMs } = readRunSettings(A, B);
  for (const c of Object.values(ui.canvas)) {
    c.width = w;
    c.height = h;
  }
  ui.diffResolution.textContent = `${w}×${h}`;
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

  // 音声の差は、動画の比較と並べて分析する（動画が止まる・失敗したら、音声も止める）
  let videoFailed = false;
  const audioTask = canCompareAudio(A, B)
    ? analyzeAudio(A, B, () => state.stop || videoFailed, refreshAudio)
    : Promise.resolve();

  const pairs =
    mode === 'time'
      ? pairByTime(sinks.A.samples(), sinks.B.samples(), A.first, B.first)
      : pairByIndex(sinks.A.samples(), sinks.B.samples());

  const t0 = performance.now();
  let lastUi = t0;
  let nextDraw = t0; // これより前には、差分の画像とグラフを描き直さない
  // 描画の機会を渡す間隔。描き直しの間隔より長いと、決めた頻度に届かない
  const yieldEvery = redrawMs === null ? UI_INTERVAL : Math.min(UI_INTERVAL, redrawMs);

  /**
   * 差分の画像を描いて、見出しとグラフを更新する。次に描いてよい時刻を決める。
   * 間隔を選んでいればその間隔、自動なら、描くのにかかった時間に合わせる。
   */
  const redraw = (da: Uint8ClampedArray, db: Uint8ClampedArray, a: VideoSample, b: VideoSample): void => {
    const begin = performance.now();
    renderDiff(da, db, outImage.data, gain);
    ctx.D.putImageData(outImage, 0, 0);
    const last = run.values.length - 1;
    showCaptions(last, a.timestamp, b.timestamp, run.values[last]!);
    refreshResults();
    const cost = performance.now() - begin;
    nextDraw = begin + (redrawMs ?? Math.max(UI_INTERVAL, REDRAW_COST_RATIO * cost));
  };

  try {
    for await (const { index, a, b } of pairs) {
      const da = grab(a, ctx.A, w, h);
      const db = grab(b, ctx.B, w, h);

      run.values.push(meanLumaDiff(da, db));
      run.tsA.push(a.timestamp);
      run.tsB.push(b.timestamp);
      run.qA.push(queryTime(a));
      run.qB.push(queryTime(b));

      // 最初のフレームは、すぐ見せる
      if (index === 0) redraw(da, db, a, b);

      const now = performance.now();
      if (now >= nextDraw) redraw(da, db, a, b);
      if (now - lastUi > yieldEvery) {
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
    videoFailed = true;
    showError(`エラー: ${errorMessage(e)}`);
  } finally {
    await audioTask;
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
