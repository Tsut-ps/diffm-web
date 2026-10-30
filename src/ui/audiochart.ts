// 音声の差のグラフ（Canvas）: 音量の折れ線（A / B / 差）と、周波数 × 時間のスペクトログラム（B − A）。
// 2 つは、横軸（時間）の位置をそろえる。

import { DB_MIN, HOP_RATE } from '../lib/audiodsp';
import { formatTime, must } from '../lib/util';
import type { AudioRun } from '../types';

/** 描いた範囲。マウスの位置から、時刻や周波数を求めるのに使う。 */
export interface AudioLayout {
  l: number;
  t: number;
  plotW: number;
  plotH: number;
  /** 横軸の長さ（秒） */
  total: number;
}

export interface AudioChartOptions {
  au: AudioRun | null;
  /** 選んだ時刻 / ホバーの時刻 / 再生中の位置（秒）。無ければ負 */
  selected: number;
  hover: number;
  cursor: number;
}

/** 差が、色の最大になる値（dB）。これ以上は同じ濃さ */
const SPEC_SCALE_DB = 24;

// 余白（CSS px）。折れ線は、下に時刻の目盛りを置かない
const MARGIN = { l: 48, r: 12, t: 10 };

function setup(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; cw: number; ch: number } {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const pw = Math.max(1, Math.round(cw * dpr));
  const ph = Math.max(1, Math.round(ch * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = must(canvas.getContext('2d'));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  return { ctx, cw, ch };
}

const colorOf = (canvas: HTMLCanvasElement) => {
  const css = getComputedStyle(canvas);
  return { get: (name: string) => css.getPropertyValue(name).trim(), font: css.fontFamily };
};

/** 選択・ホバー・再生位置の縦線。 */
function drawLines(
  ctx: CanvasRenderingContext2D,
  lay: AudioLayout,
  o: AudioChartOptions,
  col: (name: string) => string,
): void {
  const line = (sec: number, color: string, width: number) => {
    if (sec < 0 || sec > lay.total) return;
    const x = Math.round(lay.l + (sec / lay.total) * lay.plotW) + 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, lay.t);
    ctx.lineTo(x, lay.t + lay.plotH);
    ctx.stroke();
  };
  line(o.hover, col('--grid'), 1);
  line(o.selected, col('--accent'), 2);
  line(o.cursor, col('--text'), 1.5);
}

function totalSeconds(au: AudioRun | null): number {
  return au ? Math.max(au.expected / HOP_RATE, 1 / HOP_RATE) : 1;
}

/** 音量の折れ線（A / B / 差。dBFS）。 */
export function drawAudioLine(canvas: HTMLCanvasElement, o: AudioChartOptions): AudioLayout {
  const { ctx, cw, ch } = setup(canvas);
  const { get: col, font } = colorOf(canvas);
  const lay: AudioLayout = {
    l: MARGIN.l,
    t: MARGIN.t,
    plotW: Math.max(1, cw - MARGIN.l - MARGIN.r),
    plotH: Math.max(1, ch - MARGIN.t - 6),
    total: totalSeconds(o.au),
  };
  const y = (db: number) => lay.t + (lay.plotH * -db) / -DB_MIN;

  // グリッドと軸ラベル
  ctx.font = `11px ${font}`;
  ctx.fillStyle = col('--muted');
  ctx.strokeStyle = col('--grid');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let db = 0; db >= DB_MIN; db -= 24) {
    const yy = Math.round(y(db)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(lay.l, yy);
    ctx.lineTo(lay.l + lay.plotW, yy);
    ctx.stroke();
    ctx.fillText(`${db} dB`, lay.l - 6, Math.min(Math.max(yy, lay.t + 6), lay.t + lay.plotH - 6));
  }

  const au = o.au;
  if (au && au.count > 0) {
    const n = au.count;
    const total = Math.max(au.expected, 2);
    const draw = (values: readonly number[], color: string, width: number, alpha: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.globalAlpha = alpha;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (n <= lay.plotW * 2) {
        for (let i = 0; i < n; i++) {
          const x = lay.l + (i / (total - 1)) * lay.plotW;
          i ? ctx.lineTo(x, y(values[i]!)) : ctx.moveTo(x, y(values[i]!));
        }
      } else {
        // 画素の列ごとの最大値で間引く（スパイクを落とさない）
        for (let c = 0; c < lay.plotW; c++) {
          const i0 = Math.floor((c * total) / lay.plotW);
          if (i0 >= n) break;
          const i1 = Math.max(i0 + 1, Math.min(n, Math.floor(((c + 1) * total) / lay.plotW)));
          let mx = -Infinity;
          for (let i = i0; i < i1; i++) if (values[i]! > mx) mx = values[i]!;
          c ? ctx.lineTo(lay.l + c + 0.5, y(mx)) : ctx.moveTo(lay.l + c + 0.5, y(mx));
        }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    // 主役は差（実線）。A と B は、音量の目安として、点線で敷く
    ctx.setLineDash([2, 3]);
    draw(au.levelA, col('--a-line'), 1, 0.8);
    ctx.lineDashOffset = 2.5; // 重なったとき、青と赤が交互に見えるように、点線の位置をずらす
    draw(au.levelB, col('--b-line'), 1, 0.8);
    ctx.lineDashOffset = 0;
    ctx.setLineDash([]);
    draw(au.diff, col('--line'), 1.6, 1);
  }

  drawLines(ctx, lay, o, col);
  return lay;
}

// スペクトログラムの画像は重いので、データと大きさが変わらない間は使い回す
let specCache: { key: string; image: OffscreenCanvas } | null = null;

function renderSpec(au: AudioRun, cols: number): OffscreenCanvas {
  const key = `${au.count}|${au.expected}|${cols}|${au.rows}`;
  if (specCache?.key === key) return specCache.image;
  const { rows, spec, count, expected } = au;
  const img = new ImageData(cols, rows);
  for (let c = 0; c < cols; c++) {
    const i0 = Math.floor((c * expected) / cols);
    if (i0 >= count) break;
    const i1 = Math.max(i0 + 1, Math.min(count, Math.floor(((c + 1) * expected) / cols)));
    for (let r = 0; r < rows; r++) {
      // 画素の列に入る列のうち、差が最大のもの（符号つき）
      let best = 0;
      for (let i = i0; i < i1; i++) {
        const v = spec[i * rows + r]!;
        if (Math.abs(v) > Math.abs(best)) best = v;
      }
      const t = Math.min(1, Math.abs(best) / SPEC_SCALE_DB) ** 0.7;
      const p = ((rows - 1 - r) * cols + c) * 4;
      // 折れ線の色に合わせる。B が大きい（best > 0）: 赤 / A が大きい（best < 0）: 青
      img.data[p] = best > 0 ? 255 : 80;
      img.data[p + 1] = best > 0 ? 96 : 170;
      img.data[p + 2] = best > 0 ? 90 : 255;
      img.data[p + 3] = Math.round(t * 255);
    }
  }
  const image = new OffscreenCanvas(cols, rows);
  must(image.getContext('2d')).putImageData(img, 0, 0);
  specCache = { key, image };
  return image;
}

/** スペクトログラム（周波数は対数の軸、下が低い音）。色は、B − A の音量の差。 */
export function drawSpectrogram(canvas: HTMLCanvasElement, o: AudioChartOptions): AudioLayout {
  const { ctx, cw, ch } = setup(canvas);
  const { get: col, font } = colorOf(canvas);
  const lay: AudioLayout = {
    l: MARGIN.l,
    t: MARGIN.t,
    plotW: Math.max(1, cw - MARGIN.l - MARGIN.r),
    plotH: Math.max(1, ch - MARGIN.t - 26),
    total: totalSeconds(o.au),
  };

  ctx.fillStyle = col('--bg');
  ctx.fillRect(lay.l, lay.t, lay.plotW, lay.plotH);

  const au = o.au;
  if (au && au.count > 0) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(renderSpec(au, Math.max(1, Math.floor(lay.plotW))), lay.l, lay.t, lay.plotW, lay.plotH);
  }

  // 周波数の軸（100 / 1k / 10k）と、時刻の目盛り
  ctx.font = `11px ${font}`;
  ctx.fillStyle = col('--muted');
  ctx.strokeStyle = col('--grid');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  if (au) {
    for (const [f, label] of [[100, '100 Hz'], [1000, '1 kHz'], [10000, '10 kHz']] as const) {
      if (f < au.fMin || f > au.fMax) continue;
      const yy = Math.round(lay.t + lay.plotH * (1 - Math.log(f / au.fMin) / Math.log(au.fMax / au.fMin))) + 0.5;
      ctx.beginPath();
      ctx.moveTo(lay.l, yy);
      ctx.lineTo(lay.l + lay.plotW, yy);
      ctx.stroke();
      ctx.fillText(label, lay.l - 6, yy);
    }
  }
  ctx.strokeRect(lay.l + 0.5, lay.t + 0.5, lay.plotW - 1, lay.plotH - 1);
  ctx.textBaseline = 'top';
  const ticks: [number, CanvasTextAlign][] = [
    [0, 'left'],
    [lay.total / 2, 'center'],
    [lay.total, 'right'],
  ];
  for (const [sec, align] of ticks) {
    ctx.textAlign = align;
    ctx.fillText(formatTime(sec), lay.l + (sec / lay.total) * lay.plotW, lay.t + lay.plotH + 6);
  }

  drawLines(ctx, lay, o, col);
  return lay;
}

/** x（CSS px）が指す時刻（秒）。範囲の外は、端にする。 */
export function timeAt(lay: AudioLayout | null, cssX: number): number {
  if (!lay) return 0;
  return Math.min(lay.total, Math.max(0, ((cssX - lay.l) / lay.plotW) * lay.total));
}

/** y（CSS px）が指す、スペクトログラムの周波数（Hz）。 */
export function freqAt(lay: AudioLayout, au: AudioRun, cssY: number): number {
  const u = Math.min(1, Math.max(0, 1 - (cssY - lay.t) / lay.plotH));
  return au.fMin * (au.fMax / au.fMin) ** u;
}
