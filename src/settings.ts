// 設定欄の値を読む

import { ui } from './dom';
import type { Mode, ModeSetting, VideoInfo } from './types';
import { resolveMode } from './diff';

export function currentThreshold(): number {
  const v = Number(ui.threshold.value);
  return Number.isFinite(v) ? v : 0;
}

function modeSetting(): ModeSetting {
  const v = ui.mode.value;
  return v === 'index' || v === 'time' ? v : 'auto';
}

/** 実行時に使う設定。 */
export interface RunSettings {
  mode: Mode;
  /** 計算用の描画サイズ */
  w: number;
  h: number;
  /** 画面を更新するフレーム間隔 */
  interval: number;
  gain: number;
}

/** 設定欄の値から、実行用の設定を作る。サイズは A を基準にする。 */
export function readRunSettings(a: VideoInfo, b: VideoInfo): RunSettings {
  const scale = Number(ui.scale.value) || 1;
  return {
    mode: resolveMode(modeSetting(), a, b),
    w: Math.max(2, Math.round(a.w * scale)),
    h: Math.max(2, Math.round(a.h * scale)),
    interval: Math.max(1, Math.floor(Number(ui.interval.value)) || 30),
    gain: Number(ui.gain.value) || 1,
  };
}

/** 読み込み済みの A / B から、いま選ばれている対応づけ方法を返す。 */
export function currentMode(a: VideoInfo, b: VideoInfo): Mode {
  return resolveMode(modeSetting(), a, b);
}
