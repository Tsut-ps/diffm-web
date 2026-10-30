// 比較の設定の保存と復元（localStorage。保存できなくても動く）

import { ui } from './dom';

const KEY = 'diffm-settings';

const fields = {
  mode: ui.mode,
  scale: ui.scale,
  interval: ui.interval,
  gain: ui.gain,
  threshold: ui.threshold,
};

/** 保存した値を設定欄に戻す。いまの欄で認められない値は捨てる。 */
export function restoreSettings(): void {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return;
  }
  if (typeof saved !== 'object' || saved === null) return;
  for (const [name, el] of Object.entries(fields)) {
    const v = (saved as Record<string, unknown>)[name];
    if (typeof v !== 'string') continue;
    const prev = el.value;
    el.value = v;
    if (el.value !== v || !el.checkValidity()) el.value = prev;
  }
}

/** 設定欄が変わったら保存する。 */
export function bindSaveSettings(): void {
  const save = () => {
    const values = Object.fromEntries(Object.entries(fields).map(([name, el]) => [name, el.value]));
    try {
      localStorage.setItem(KEY, JSON.stringify(values));
    } catch {
      // 保存できなくても動く
    }
  };
  for (const el of Object.values(fields)) el.addEventListener('change', save);
}
