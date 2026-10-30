// 状態を画面に反映する（メッセージ、ボタン、グラフ、結果リスト）

import { drawChart } from './chart';
import { compareInfo, findRanges, type Range } from '../lib/diff';
import { currentMode, currentThreshold, lockableInputs, ui } from './dom';
import { state, type Run, type Slot } from '../types';
import { fmt, num } from '../lib/util';

/** 結果リストに並べる区間の上限（全区間は ZIP に含める）。 */
const MAX_LISTED = 200;

export function showError(message: string): void {
  ui.error.textContent = message;
  ui.error.hidden = !message;
}

export function setMeta(slot: Slot, text: string, bad = false): void {
  ui.meta[slot].textContent = text;
  ui.meta[slot].classList.toggle('bad', bad);
}

/** i 番目のフレームの時刻と差分を、A / B / 差分の見出しに出す。 */
export function showCaptions(i: number, tsA: number, tsB: number, diff: number): void {
  ui.caption.A.textContent = `A · #${i} · ${num(tsA, 3)} s`;
  ui.caption.B.textContent = `B · #${i} · ${num(tsB, 3)} s`;
  ui.caption.D.textContent = `差分 · ${num(diff)}`;
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

export function syncButtons(): void {
  const { A, B, run, running } = state;
  ui.start.disabled = running || !(A && B);
  ui.stop.disabled = !running;
  ui.bar.hidden = !running;
  ui.openPlayer.disabled = !(A && B);
  for (const el of lockableInputs) el.disabled = running;
  const done = !!run && run.values.length > 0 && !running;
  ui.exportCsv.disabled = !done;
  ui.exportImages.disabled = !done || currentRanges().length === 0;
}

export function refreshWarnings(): void {
  ui.warnings.replaceChildren();
  const { A, B } = state;
  if (A && B) {
    for (const msg of compareInfo(A, B, currentMode(A, B))) {
      const li = document.createElement('li');
      li.textContent = msg;
      ui.warnings.append(li);
    }
    ui.status.textContent = '開始を押すと比較します。';
  }
  syncButtons();
}

export function drawGraph(): void {
  const run = state.run;
  const layout = drawChart(ui.chart, {
    values: run?.values ?? [],
    expectedTotal: run?.expected ?? 0,
    threshold: currentThreshold(),
    selected: run?.selected ?? -1,
    hover: run?.hover ?? -1,
  });
  if (run) run.layout = layout;
}

/** グラフとしきい値超えの区間リストを描き直す。区間のボタンには data-peak を付ける。 */
export function refreshResults(): void {
  drawGraph();
  const run = state.run;
  ui.ranges.replaceChildren();
  if (!run) return;
  const ranges = currentRanges();
  for (const r of ranges.slice(0, MAX_LISTED)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.peak = String(r.peak);
    const span = r.start === r.end ? `#${r.start}` : `#${r.start}–${r.end}（${r.end - r.start + 1} フレーム）`;
    btn.textContent = `${span} · ピーク ${num(run.values[r.peak])} @ #${r.peak} · ${num(run.tsA[r.peak], 2)} s`;
    btn.setAttribute('aria-current', String(run.selected === r.peak));
    li.append(btn);
    ui.ranges.append(li);
  }
  if (ranges.length > MAX_LISTED) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `ほか ${fmt(ranges.length - MAX_LISTED)} 区間（ZIP には全区間を含めます）`;
    ui.ranges.append(li);
  }
  syncButtons();
}

/** 前回の比較結果を捨てて、表示を初期状態に戻す。 */
export function resetRun(): void {
  const run = state.run;
  state.run = null;
  if (run) run.sinks = null;
  ui.ranges.replaceChildren();
  ui.bar.value = 0;
  ui.caption.A.textContent = 'A';
  ui.caption.B.textContent = 'B';
  ui.caption.D.textContent = '差分';
  ui.canvas.D.getContext('2d')?.clearRect(0, 0, ui.canvas.D.width, ui.canvas.D.height);
  ui.diffHint.hidden = false;
  drawGraph();
  syncButtons();
}
