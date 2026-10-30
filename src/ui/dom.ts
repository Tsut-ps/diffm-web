// 画面の要素（型付き）と、設定欄の値。要素が見つからなければ起動時に落とす。

import { resolveMode } from '../lib/diff';
import type { Mode, ModeSetting, Slot, VideoInfo } from '../types';

export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} が見つかりません。`);
  return el as T;
}

const bySlot = <T>(make: (slot: Slot) => T): Record<Slot, T> => ({ A: make('A'), B: make('B') });

type Caption = Slot | 'D';

export const ui = {
  slotRoot: bySlot((s) => {
    const el = document.querySelector<HTMLElement>(`.slot[data-slot="${s}"]`);
    if (!el) throw new Error(`枠 ${s} が見つかりません。`);
    return el;
  }),
  fileInput: bySlot((s) => byId<HTMLInputElement>(`file${s}`)),
  fileName: bySlot((s) => byId(`name${s}`)),
  meta: bySlot((s) => byId(`meta${s}`)),

  mode: byId<HTMLSelectElement>('mode'),
  scale: byId<HTMLSelectElement>('scale'),
  interval: byId<HTMLInputElement>('interval'),
  gain: byId<HTMLSelectElement>('gain'),
  threshold: byId<HTMLInputElement>('threshold'),

  warnings: byId<HTMLUListElement>('warnings'),
  error: byId('error'),
  start: byId<HTMLButtonElement>('start'),
  stop: byId<HTMLButtonElement>('stop'),
  openPlayer: byId<HTMLButtonElement>('openPlayer'),
  bar: byId<HTMLProgressElement>('bar'),
  status: byId('status'),

  canvas: {
    A: byId<HTMLCanvasElement>('cA'),
    B: byId<HTMLCanvasElement>('cB'),
    D: byId<HTMLCanvasElement>('cD'),
  } satisfies Record<Caption, HTMLCanvasElement>,
  /** 差分の枠の案内（比較結果が出たら隠す） */
  diffHint: byId('diffHint'),
  caption: { A: byId('capA'), B: byId('capB'), D: byId('capD') } satisfies Record<Caption, HTMLElement>,

  chart: byId<HTMLCanvasElement>('chart'),
  tip: byId('tip'),
  ranges: byId<HTMLUListElement>('ranges'),
  exportImages: byId<HTMLButtonElement>('exportImages'),
  exportCsv: byId<HTMLButtonElement>('exportCsv'),
};

/** 設定欄（実行中は触れないようにする対象）。 */
export const lockableInputs: readonly (HTMLInputElement | HTMLSelectElement)[] = [
  ui.fileInput.A,
  ui.fileInput.B,
  ui.mode,
  ui.scale,
  ui.interval,
  ui.gain,
];

// ---------- 設定欄の値 ----------

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
