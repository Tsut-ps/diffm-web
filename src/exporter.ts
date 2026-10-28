// 結果の書き出し（区間ごとのピーク画像を ZIP、フレームごとの値を CSV）

import { ui } from './ui/dom';
import { fetchPair, paint } from './frames';
import { state } from './types';
import { errorMessage, must, num } from './lib/util';
import { currentRanges, showError, syncButtons } from './ui/view';
import { makeZip, type ZipEntry } from './lib/zip';

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 各区間のピークを再デコードし、左から A | B | 差分 を並べた PNG にして ZIP で保存する。 */
export async function exportImages(): Promise<void> {
  const run = state.run;
  if (!run || state.running) return;
  const ranges = currentRanges();
  if (!ranges.length) return;
  ui.exportImages.disabled = true;
  showError('');

  const { w, h } = run;
  const ctxA = must(new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true }));
  const ctxB = must(new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true }));
  const ctxD = must(new OffscreenCanvas(w, h).getContext('2d'));
  const sheet = new OffscreenCanvas(w * 3, h);
  const sheetCtx = must(sheet.getContext('2d'));
  const entries: ZipEntry[] = [];

  try {
    for (const [k, r] of ranges.entries()) {
      ui.status.textContent = `画像を書き出し中 ${k + 1} / ${ranges.length}`;
      const { a, b } = await fetchPair(run, r.peak);
      try {
        const diff = paint(run, a, b, ctxA, ctxB, ctxD);
        sheetCtx.drawImage(ctxA.canvas, 0, 0);
        sheetCtx.drawImage(ctxB.canvas, w, 0);
        sheetCtx.drawImage(ctxD.canvas, w * 2, 0);
        const blob = await sheet.convertToBlob({ type: 'image/png' });
        const name = `${String(k + 1).padStart(4, '0')}_f${r.peak}_t${num(run.tsA[r.peak]!, 2)}s_d${num(diff)}.png`;
        entries.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
      } finally {
        a.close();
        b.close();
      }
    }
    download(makeZip(entries), 'diffm-over.zip');
    ui.status.textContent = `${entries.length} 枚を diffm-over.zip に保存しました（左から A | B | 差分）。`;
  } catch (e) {
    console.error(e);
    showError(`エラー: ${errorMessage(e)}`);
  } finally {
    syncButtons();
  }
}

export function exportCsv(): void {
  const run = state.run;
  if (!run) return;
  const rows = ['frame,time_a,time_b,diff'];
  for (let i = 0; i < run.values.length; i++) {
    rows.push(`${i},${run.tsA[i]},${run.tsB[i]},${run.values[i]}`);
  }
  download(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), 'diffm.csv');
}
