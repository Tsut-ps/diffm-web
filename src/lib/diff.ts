// 差分の計算と、比較条件のチェック（DOM に依存しない純粋関数）

import type { Mode, ModeSetting, VideoInfo } from '../types';

type Pixels = ArrayLike<number>;
type Timing = Pick<VideoInfo, 'w' | 'h' | 'fps' | 'duration'>;

/** しきい値以上が連続する区間。peak は区間内で最大のフレーム番号。 */
export interface Range {
  start: number;
  end: number;
  peak: number;
}

/** 2つの RGBA 配列の差分の明るさ（輝度の平均、0〜255）。diffm の「brightness」に相当。 */
export function meanLumaDiff(a: Pixels, b: Pixels): number {
  const n = a.length;
  let total = 0;
  for (let i = 0; i < n; i += 4) {
    total +=
      77 * Math.abs(a[i] - b[i]) +
      150 * Math.abs(a[i + 1] - b[i + 1]) +
      29 * Math.abs(a[i + 2] - b[i + 2]);
  }
  return total / 256 / (n / 4);
}

/** 表示用の差分画像（チャンネルごとの絶対差 × gain）を out に書く。 */
export function renderDiff(a: Pixels, b: Pixels, out: Uint8ClampedArray, gain = 1): void {
  for (let i = 0; i < a.length; i += 4) {
    out[i] = Math.abs(a[i] - b[i]) * gain;
    out[i + 1] = Math.abs(a[i + 1] - b[i + 1]) * gain;
    out[i + 2] = Math.abs(a[i + 2] - b[i + 2]) * gain;
    out[i + 3] = 255;
  }
}

/** しきい値以上が連続する区間を返す。 */
export function findRanges(values: readonly number[], threshold: number): Range[] {
  const ranges: Range[] = [];
  let cur: Range | null = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] >= threshold) {
      if (!cur) cur = { start: i, end: i, peak: i };
      cur.end = i;
      if (values[i] > values[cur.peak]) cur.peak = i;
    } else if (cur) {
      ranges.push(cur);
      cur = null;
    }
  }
  if (cur) ranges.push(cur);
  return ranges;
}

const fpsDiffers = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) > 0.005;

/** 比較方法の決定。auto は fps が違えば時刻、同じならフレーム番号。 */
export function resolveMode(selected: ModeSetting, a: Pick<Timing, 'fps'>, b: Pick<Timing, 'fps'>): Mode {
  if (selected !== 'auto') return selected;
  return fpsDiffers(a.fps, b.fps) ? 'time' : 'index';
}

/** 比較条件の警告（日本語）。 */
export function compareInfo(a: Timing, b: Timing, mode: Mode): string[] {
  const warnings: string[] = [];

  if (a.w !== b.w || a.h !== b.h) {
    let msg = `解像度が違います（A ${a.w}×${a.h} / B ${b.w}×${b.h}）。B を A の大きさに拡縮して比較するため、差分が大きく出ます。`;
    if (Math.abs(a.w / a.h - b.w / b.h) > 0.01) msg += '縦横比も違うので、B は引き伸ばされます。';
    warnings.push(msg);
  }

  if (fpsDiffers(a.fps, b.fps)) {
    warnings.push(
      mode === 'time'
        ? `fps が違います（A ${a.fps.toFixed(2)} / B ${b.fps.toFixed(2)}）。時刻で対応づけるため、B のフレームが重複・欠落します。`
        : `fps が違います（A ${a.fps.toFixed(2)} / B ${b.fps.toFixed(2)}）。フレーム番号で対応づけるため、後ろほど時間がずれます。`,
    );
  }

  const tol = 1.5 / Math.min(a.fps, b.fps);
  if (Math.abs(a.duration - b.duration) > tol) {
    warnings.push(
      `長さが違います（A ${a.duration.toFixed(2)} 秒 / B ${b.duration.toFixed(2)} 秒）。短い方に合わせて比較します。`,
    );
  }

  return warnings;
}
