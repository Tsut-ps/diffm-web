// index.html の要素を、型付きで一か所にまとめる。見つからなければ起動時に落とす。

import type { Slot } from './types';

function byId<T extends HTMLElement>(id: string): T {
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
  bar: byId<HTMLProgressElement>('bar'),
  status: byId('status'),

  canvas: {
    A: byId<HTMLCanvasElement>('cA'),
    B: byId<HTMLCanvasElement>('cB'),
    D: byId<HTMLCanvasElement>('cD'),
  } satisfies Record<Caption, HTMLCanvasElement>,
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
