// エントリーポイント: 画面のイベントを各機能につなぐ

import './style.css';
import { start, stop } from './compare';
import { pickIndex } from './ui/chart';
import { ui } from './ui/dom';
import { exportCsv, exportImages } from './exporter';
import { inspect } from './frames';
import { setFile } from './loader';
import { SLOTS, state } from './types';
import { num } from './lib/util';
import { drawGraph, refreshResults, refreshWarnings } from './ui/view';

/** 動画の選択とドロップ */
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
      root.classList.remove('dragging');
      const file = e.dataTransfer?.files?.[0];
      if (file) void setFile(slot, file);
    });
  }
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

bindSlots();
bindChart();
bindRanges();
ui.mode.addEventListener('change', refreshWarnings);
ui.threshold.addEventListener('input', refreshResults);
window.addEventListener('resize', drawGraph);
ui.start.addEventListener('click', () => void start());
ui.stop.addEventListener('click', stop);
ui.exportImages.addEventListener('click', () => void exportImages());
ui.exportCsv.addEventListener('click', exportCsv);

drawGraph();
