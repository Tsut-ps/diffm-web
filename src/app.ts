// エントリーポイント: 画面のイベントを各機能につなぐ

import './style.css';
import { start, stop } from './compare';
import { pickIndex } from './ui/chart';
import { ui } from './ui/dom';
import { exportCsv, exportImages } from './exporter';
import { inspect } from './frames';
import { clearFile, setFile } from './loader';
import { addVideos, initPlayer, resetPlayer, setPlayerActive } from './player';
import { SLOTS, state, type Slot } from './types';
import { isVideoFile, num } from './lib/util';
import { bindWindowDrop } from './ui/dropzone';
import { initDragNumber } from './ui/dragnumber';
import { bindSaveSettings, restoreSettings } from './ui/settings';
import { initTabs } from './ui/tabs';
import { currentRanges, drawGraph, refreshResults, refreshWarnings } from './ui/view';

const isDiffTab = (): boolean => document.body.dataset.tab === 'diff';

/** A / B の枠に直接ドロップしたとき、同じドロップをウィンドウ側で二重に処理しないための印 */
let droppedOnSlot = false;

// 並べて再生のタブへ送り済みの動画。タブを行き来しても、プレーヤーで外した動画は戻さない
const offered = new Set<File>();

/**
 * 比較に動画を入れる。隣のタブ（並べて再生）は、古い動画を残さないよう、空に戻す。
 * 戻したあと、そのタブを開くと、いまの A と B だけが入る。
 */
function loadSlot(slot: Slot, file: File): void {
  if (state.running) return;
  resetPlayer();
  offered.clear();
  void setFile(slot, file);
}

/** 並べて再生に動画が入ったら、比較は初期状態に戻す（古い A / B や結果を残さない）。 */
async function resetCompare(): Promise<void> {
  if (state.running) {
    stop();
    while (state.running) await new Promise((r) => setTimeout(r, 50));
  }
  for (const slot of SLOTS) clearFile(slot);
  offered.clear();
}

/** 動画の選択とドロップ（A / B の枠） */
function bindSlots(): void {
  for (const slot of SLOTS) {
    const root = ui.slotRoot[slot];
    ui.fileInput[slot].addEventListener('change', (e) => {
      const input = e.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (file) loadSlot(slot, file);
      input.value = '';
    });
    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      root.classList.add('dragging');
    });
    root.addEventListener('dragleave', () => root.classList.remove('dragging'));
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      droppedOnSlot = true;
      root.classList.remove('dragging');
      const file = e.dataTransfer?.files?.[0];
      if (file) loadSlot(slot, file);
    });
  }
}

/** 枠の外（ウィンドウのどこか）へのドロップ: 2本以上なら A → B、1本なら空いている枠へ */
function dropToSlots(files: File[]): void {
  if (droppedOnSlot) {
    droppedOnSlot = false;
    return;
  }
  if (state.running) return;
  const videos = files.filter(isVideoFile);
  if (videos.length === 0) {
    ui.status.textContent = '動画ファイルが見つかりませんでした。';
    return;
  }
  if (videos.length >= 2) {
    loadSlot('A', videos[0]!);
    loadSlot('B', videos[1]!);
    return;
  }
  const empty = SLOTS.find((s) => !ui.slotRoot[s].classList.contains('loaded'));
  if (empty) loadSlot(empty, videos[0]!);
  else ui.status.textContent = '入れ替えるには、A か B の枠にドロップしてください。';
}

/** グラフの操作: ホバーで値、クリックでそのフレームを表示 */
function bindChart(): void {
  const cssX = (e: MouseEvent) => e.clientX - ui.chart.getBoundingClientRect().left;

  ui.chart.addEventListener('pointermove', (e) => {
    const run = state.run;
    if (!run || run.values.length === 0) return;
    const i = pickIndex(run.layout, run.values, cssX(e));
    if (i < 0) return;
    run.hover = i;
    drawGraph();
    ui.tip.hidden = false;
    const range = currentRanges().find((r) => i >= r.start && i <= r.end);
    ui.tip.textContent =
      `#${i} · ${num(run.tsA[i]!, 3)} s · 差分 ${num(run.values[i]!)}` +
      (range ? ` · 区間 #${range.start}–${range.end}（ピーク ${num(run.values[range.peak]!)} @ #${range.peak}）` : '');
    const host = (ui.chart.parentElement ?? ui.chart).getBoundingClientRect();
    ui.tip.style.left = `${Math.min(e.clientX - host.left + 12, host.width - ui.tip.offsetWidth - 4)}px`;
    ui.tip.style.top = `${e.clientY - host.top - 30}px`;
  });
  ui.chart.addEventListener('pointerleave', () => {
    ui.tip.hidden = true;
    if (state.run) {
      state.run.hover = -1;
      drawGraph();
    }
  });
  ui.chart.addEventListener('click', (e) => {
    const run = state.run;
    if (!run) return;
    const i = pickIndex(run.layout, run.values, cssX(e));
    if (i >= 0) void inspect(i);
  });
}

/** 前（-1）/ 次（+1）の区間のピークへ移る */
function jumpRange(dir: 1 | -1): void {
  const run = state.run;
  if (!run || state.running) return;
  const peaks = currentRanges().map((r) => r.peak);
  const cur = run.selected;
  const target = dir > 0 ? peaks.find((p) => p > cur) : peaks.findLast((p) => p < cur);
  if (target !== undefined) void inspect(target);
}

/** 一般的な最低限のキー: ← → 前後のフレーム（Shift で10）/ Home End 先頭・末尾 / Esc 比較を止める */
function bindKeys(): void {
  window.addEventListener('keydown', (e) => {
    if (!isDiffTab() || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (target?.closest('[role="tablist"]')) return;

    if (e.key === 'Escape' && state.running) {
      stop();
      e.preventDefault();
      return;
    }
    const run = state.run;
    if (!run || state.running || run.values.length === 0) return;

    const last = run.values.length - 1;
    const cur = run.selected;
    const stride = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') void inspect(Math.max(0, (cur < 0 ? 0 : cur) - stride));
    else if (e.key === 'ArrowRight') void inspect(Math.min(last, cur + stride));
    else if (e.key === 'Home') void inspect(0);
    else if (e.key === 'End') void inspect(last);
    else return;
    e.preventDefault();
  });
}

/** 比較で読み込んだ A と B を、並べて再生へ入れる（初めて開くとき、または読み込み直したとき）。
 *  フレームを選んでいれば、その時刻から始める。 */
function loadComparedVideos(): void {
  const { A, B, run } = state;
  const fresh = [A, B].flatMap((v) => (v && !offered.has(v.file) ? [v.file] : []));
  if (fresh.length === 0) return;
  for (const f of fresh) offered.add(f);
  const at = A && run && run.selected >= 0 ? run.tsA[run.selected]! - A.first : undefined;
  addVideos(fresh, at);
}

restoreSettings();
bindSaveSettings();
bindSlots();
bindWindowDrop({
  enabled: isDiffTab,
  onActive: (on) => document.body.classList.toggle('dropping', on),
  onDrop: dropToSlots,
});
bindChart();
ui.rangePrev.addEventListener('click', () => jumpRange(-1));
ui.rangeNext.addEventListener('click', () => jumpRange(1));
bindKeys();
initDragNumber();
initPlayer(() => void resetCompare());
initTabs((tab) => {
  setPlayerActive(tab === 'player');
  if (tab === 'player') loadComparedVideos();
  // 隠れている間は幅が 0 で描けないので、戻ったときに描き直す
  if (tab === 'diff') drawGraph();
});
ui.mode.addEventListener('change', refreshWarnings);
ui.threshold.addEventListener('input', refreshResults);
window.addEventListener('resize', drawGraph);
ui.start.addEventListener('click', () => void start());
ui.stop.addEventListener('click', stop);
ui.exportImages.addEventListener('click', () => void exportImages());
ui.exportCsv.addEventListener('click', exportCsv);

drawGraph();
