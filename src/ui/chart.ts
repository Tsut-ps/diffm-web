// 差分グラフ（Canvas）。フレーム数が画素数より多いときは、画素列ごとの最大値で間引く（スパイクを落とさない）。

import { must } from '../lib/util';

/** クリック位置の逆引きに使う、描画時のレイアウト。 */
export interface ChartLayout {
  /** プロット領域の左端（CSS px） */
  l: number;
  plotW: number;
  /** 横軸のフレーム数（見込みを含む） */
  total: number;
}

/** しきい値を超えた区間（フレーム番号の範囲と、その中のピーク） */
export interface ChartRange {
  start: number;
  end: number;
  peak: number;
}

export interface ChartOptions {
  values: readonly number[];
  /** 帯で塗り、ピークに印を付ける区間 */
  ranges?: readonly ChartRange[];
  /** 完了前でも横軸を確定させるための、総フレーム数の見込み */
  expectedTotal?: number;
  threshold?: number | null;
  selected?: number;
  hover?: number;
}

/** 折れ線の点: [x, y, 値] */
type Point = [x: number, y: number, value: number];

const M = { l: 48, r: 12, t: 10, b: 26 };

function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** 描画して、クリック位置の逆引きに使うレイアウトを返す。 */
export function drawChart(
  canvas: HTMLCanvasElement,
  { values, ranges = [], expectedTotal = 0, threshold = null, selected = -1, hover = -1 }: ChartOptions,
): ChartLayout {
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

  const css = getComputedStyle(canvas);
  const col = (name: string) => css.getPropertyValue(name).trim();
  const font = css.fontFamily;

  const plotW = Math.max(1, cw - M.l - M.r);
  const plotH = Math.max(1, ch - M.t - M.b);
  const n = values.length;
  const total = Math.max(n, expectedTotal, 2);

  let vmax = 1;
  for (let i = 0; i < n; i++) if (values[i] > vmax) vmax = values[i];
  if (threshold != null && threshold * 1.15 > vmax) vmax = threshold * 1.15;
  const yMax = niceMax(vmax);

  const x = (i: number) => M.l + (i / (total - 1)) * plotW;
  const y = (v: number) => M.t + plotH - (v / yMax) * plotH;

  // グリッドと軸ラベル
  ctx.font = `11px ${font}`;
  ctx.fillStyle = col('--muted');
  ctx.strokeStyle = col('--grid');
  ctx.lineWidth = 1;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let k = 0; k <= 4; k++) {
    const v = (yMax * k) / 4;
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(M.l, yy);
    ctx.lineTo(M.l + plotW, yy);
    ctx.stroke();
    ctx.fillText(String(+v.toFixed(2)), M.l - 6, yy);
  }
  ctx.textBaseline = 'top';
  const ticks: [number, CanvasTextAlign][] = [
    [0, 'left'],
    [Math.round((total - 1) / 2), 'center'],
    [total - 1, 'right'],
  ];
  for (const [i, align] of ticks) {
    ctx.textAlign = align;
    ctx.fillText(`#${i}`, x(i), M.t + plotH + 6);
  }

  // しきい値を超えた区間は、折れ線の下に帯で敷く（細すぎる区間も見えるよう、最小幅を持たせる）
  if (ranges.length > 0 && total > 1) {
    const step = plotW / (total - 1);
    ctx.fillStyle = col('--danger');
    ctx.globalAlpha = 0.16;
    for (const r of ranges) {
      const x0 = Math.max(M.l, x(r.start) - step / 2);
      const x1 = Math.min(M.l + plotW, x(r.end) + step / 2);
      ctx.fillRect(x0, M.t, Math.max(2, x1 - x0), plotH);
    }
    ctx.globalAlpha = 1;
  }

  // 折れ線
  const points: Point[] = [];
  if (n > 0) {
    if (n <= plotW * 2) {
      for (let i = 0; i < n; i++) points.push([x(i), y(values[i]), values[i]]);
    } else {
      for (let c = 0; c < plotW; c++) {
        const i0 = Math.floor((c * total) / plotW);
        if (i0 >= n) break;
        const i1 = Math.max(i0 + 1, Math.min(n, Math.floor(((c + 1) * total) / plotW)));
        let mx = -Infinity;
        for (let i = i0; i < i1; i++) if (values[i] > mx) mx = values[i];
        points.push([M.l + c + 0.5, y(mx), mx]);
      }
    }
    ctx.strokeStyle = col('--line');
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.stroke();
  }

  // しきい値
  if (threshold != null) {
    const yy = Math.round(y(threshold)) + 0.5;
    ctx.strokeStyle = col('--danger');
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(M.l, yy);
    ctx.lineTo(M.l + plotW, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col('--danger');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('しきい値', M.l + plotW, yy - 2);

    // しきい値以上の点
    for (const [px, py, v] of points) {
      if (v >= threshold) {
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 各区間のピーク（区間が多すぎると潰れるので、見える数のときだけ）
  if (threshold != null && ranges.length > 0 && ranges.length <= plotW / 6) {
    ctx.strokeStyle = col('--danger');
    ctx.lineWidth = 1.5;
    for (const r of ranges) {
      ctx.beginPath();
      ctx.arc(x(r.peak), y(values[r.peak]!), 4.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ホバー / 選択
  const vline = (i: number, color: string, width: number) => {
    if (i < 0 || i >= total) return;
    const xx = Math.round(x(i)) + 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(xx, M.t);
    ctx.lineTo(xx, M.t + plotH);
    ctx.stroke();
  };
  vline(hover, col('--grid'), 1);
  vline(selected, col('--accent'), 2);

  return { l: M.l, plotW, total };
}

/**
 * キャンバス内の x（CSS px）が指すフレーム番号を、そのまま返す（押しながら動かすときに使う）。
 * 描いた範囲の外は、端のフレームにする。比較済みのフレームが無ければ -1。
 */
export function frameAt(layout: ChartLayout | null, count: number, cssX: number): number {
  if (!layout || count === 0) return -1;
  const f = Math.round(((cssX - layout.l) / layout.plotW) * (layout.total - 1));
  return Math.min(count - 1, Math.max(0, f));
}

/** キャンバス内の x（CSS px）から、近傍で最大のフレーム番号を返す（無ければ -1）。 */
export function pickIndex(layout: ChartLayout | null, values: readonly number[], cssX: number): number {
  if (!layout || values.length === 0) return -1;
  const f = Math.round(((cssX - layout.l) / layout.plotW) * (layout.total - 1));
  const span = Math.max(0, Math.round(layout.total / layout.plotW / 2));
  let best = -1;
  let bv = -Infinity;
  for (let i = Math.max(0, f - span); i <= Math.min(values.length - 1, f + span); i++) {
    if (values[i] > bv) {
      bv = values[i];
      best = i;
    }
  }
  return best;
}
