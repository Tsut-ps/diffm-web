// エントリーポイント: 画面のイベントを各機能につなぐ

import './style.css';
import { start, stop } from './compare';
import { pickIndex } from './ui/chart';
import { ui } from './ui/dom';
import { exportCsv, exportImages } from './exporter';
import { inspect } from './frames';
import { setFile } from './loader';
import { addVideos, initPlayer, setPlayerActive } from './player';
import { SLOTS, state } from './types';
import { isVideoFile, num } from './lib/util';
import { bindWindowDrop } from './ui/dropzone';
import { bindSaveSettings, restoreSettings } from './ui/settings';
import { initTabs, selectTab } from './ui/tabs';
import { currentRanges, drawGraph, refreshResults, refreshWarnings } from './ui/view';

const isDiffTab = (): boolean => document.body.dataset.tab === 'diff';

/** A / B の枠に直接ドロップしたとき、同じドロップをウィンドウ側で二重に処理しないための印 */
let droppedOnSlot = false;

/** 動画の選択とドロップ（A / B の枠） */
function bindSlots(): void {
  for (const slot of SLOTS) {
    const root = ui.slotRoot[slot];
    ui.fileInput[slot].addEventListener('change', (e) => {
      const input = e.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (file) void setFile(slot, file);
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
      if (file) void setFile(slot, file);
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
    void setFile('A', videos[0]!);
    void setFile('B', videos[1]!);
    return;
  }
  const empty = SLOTS.find((s) => !ui.slotRoot[s].classList.contains('loaded'));
  if (empty) void setFile(empty, videos[0]!);
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
    ui.tip.textContent = `#${i} · ${num(run.tsA[i]!, 3)} s · 差分 ${num(run.values[i]!)}`;
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

/** 区間リストのボタン（data-peak）は、再描画で作り直されるので、親で受ける */
function bindRanges(): void {
  ui.ranges.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('button[data-peak]');
    if (btn) void inspect(Number(btn.dataset.peak));
  });
}

/** 結果の閲覧: ← / → で前後のフレーム（Shift で10）、[ / ] で前後の区間のピークへ */
function bindKeys(): void {
  window.addEventListener('keydown', (e) => {
    if (!isDiffTab() || e.ctrlKey || e.metaKey || e.altKey) return;
    const run = state.run;
    if (!run || state.running || run.values.length === 0) return;
    const target = e.target instanceof Element ? e.target : null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (target?.closest('[role="tablist"]')) return;

    const last = run.values.length - 1;
    const cur = run.selected;
    const stride = e.shiftKey ? 10 : 1;
    let next: number | undefined;
    if (e.key === 'ArrowLeft') next = Math.max(0, (cur < 0 ? 0 : cur) - stride);
    else if (e.key === 'ArrowRight') next = Math.min(last, cur + stride);
    else if (e.key === '[' || e.key === ']') {
      const peaks = currentRanges().map((r) => r.peak);
      next = e.key === ']' ? peaks.find((p) => p > cur) : peaks.findLast((p) => p < cur);
    }
    if (next === undefined) return;
    e.preventDefault();
    void inspect(next);
  });
}

/** 比較中の A と B を、並べて再生のタブへ送る。フレームを選んでいれば、その時刻から始める */
function bindOpenPlayer(): void {
  ui.openPlayer.addEventListener('click', () => {
    const { A, B, run } = state;
    if (!A || !B) return;
    const at = run && run.selected >= 0 ? run.tsA[run.selected]! - A.first : undefined;
    selectTab('player');
    addVideos([A.file, B.file], at);
  });
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
bindRanges();
bindKeys();
bindOpenPlayer();
initPlayer();
initTabs((tab) => {
  setPlayerActive(tab === 'player');
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
