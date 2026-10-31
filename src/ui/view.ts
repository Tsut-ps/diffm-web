// 状態を画面に反映する（メッセージ、ボタン、グラフ）

import { drawChart } from './chart';
import { audioInfo, compareInfo, findRanges, videoInfo, type Range } from '../lib/diff';
import { refreshAudio, resetAudio } from './audioview';
import { currentMode, currentThreshold, lockableInputs, ui } from './dom';
import { hasVideo, state, type Run, type Slot, type VideoInfo } from '../types';
import { num } from '../lib/util';

export function showError(message: string): void {
  ui.error.textContent = message;
  ui.error.hidden = !message;
}

export function setMeta(slot: Slot, text: string, bad = false): void {
  ui.meta[slot].textContent = text;
  ui.meta[slot].classList.toggle('bad', bad);
}

/** i 番目のフレームの時刻と差分を、各枠の見出しに出す。A / B は枠の位置で分かるので、書かない。 */
export function showCaptions(i: number, tsA: number, tsB: number, diff: number): void {
  ui.caption.A.textContent = `${num(tsA, 3)} s`;
  ui.caption.B.textContent = `${num(tsB, 3)} s`;
  ui.caption.D.textContent = `#${i} · 差分 ${num(diff)}`;
  ui.diffHint.hidden = true;
}

export function currentRanges(): Range[] {
  return state.run ? findRanges(state.run.values, currentThreshold()) : [];
}

/** 平均と最大の要約。 */
export function summary(run: Run): string {
  const n = run.values.length;
  if (n === 0) return '';
  let max = -1;
  let maxAt = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += run.values[i];
    if (run.values[i] > max) {
      max = run.values[i];
      maxAt = i;
    }
  }
  return `平均 ${num(sum / n)} · 最大 ${num(max)}（#${maxAt}）`;
}

/** 比べられるか: 映像どうし、または音声どうし（音声だけのファイルは、映像がないので、音声で比べる）。 */
function comparable(a: VideoInfo | null, b: VideoInfo | null): boolean {
  return !!a && !!b && ((hasVideo(a) && hasVideo(b)) || (!!a.audio && !!b.audio));
}

export function syncButtons(): void {
  const { A, B, run, running } = state;
  ui.start.disabled = running || !comparable(A, B);
  ui.stop.disabled = !running;
  ui.bar.hidden = !running;
  for (const el of lockableInputs) el.disabled = running;
  const done = !!run && run.values.length > 0 && !running;
  const hasRanges = done && currentRanges().length > 0;
  ui.exportCsv.disabled = !done;
  ui.exportImages.disabled = !hasRanges;
  ui.rangePrev.disabled = !hasRanges;
  ui.rangeNext.disabled = !hasRanges;
}

export function refreshWarnings(): void {
  ui.warnings.replaceChildren();
  const { A, B } = state;
  // 音声だけのファイルがあるときは、映像の欄（差分の枠・設定・グラフ）を隠す
  ui.panel.dataset.video = [A, B].some((v) => v && !hasVideo(v)) ? 'off' : 'on';
  if (A && B) {
    const video = hasVideo(A) && hasVideo(B) ? compareInfo(A, B, currentMode(A, B)) : videoInfo(A, B);
    for (const msg of [...video, ...audioInfo(A, B)]) {
      const li = document.createElement('li');
      li.textContent = msg;
      ui.warnings.append(li);
    }
  }
  syncButtons();
  refreshAudio();
}

export function drawGraph(): void {
  const run = state.run;
  const layout = drawChart(ui.chart, {
    values: run?.values ?? [],
    ranges: currentRanges(),
    expectedTotal: run?.expected ?? 0,
    threshold: currentThreshold(),
    selected: run?.selected ?? -1,
    hover: run?.hover ?? -1,
  });
  if (run) run.layout = layout;
  refreshAudio(); // 音声の選択も、動画の選択に合わせる
}

/** グラフ（区間の帯を含む）と、区間の件数を描き直す。 */
export function refreshResults(): void {
  drawGraph();
  const n = currentRanges().length;
  ui.rangeSummary.textContent = state.run?.values.length ? (n ? `区間 ${n} 件` : '区間なし') : '';
  syncButtons();
}

/** 前回の比較結果を捨てて、表示を初期状態に戻す。 */
export function resetRun(): void {
  const run = state.run;
  state.run = null;
  if (run) run.sinks = null;
  ui.bar.value = 0;
  ui.status.textContent = '';
  for (const c of Object.values(ui.caption)) c.textContent = '';
  ui.diffResolution.textContent = '';
  ui.canvas.D.getContext('2d')?.clearRect(0, 0, ui.canvas.D.width, ui.canvas.D.height);
  ui.diffHint.hidden = false;
  resetAudio();
  refreshResults();
}
