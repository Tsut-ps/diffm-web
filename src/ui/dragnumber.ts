// 数値の入力欄を、ドラッグで変えられるようにする（デザインツールの数値欄と同じ操作）。
// 欄の上、または欄を含むラベルの文字の上でドラッグする。ほとんど動かさない操作は、これまでどおりのクリック（入力）。
// ページ全体でイベントを受けるので、あとから作られる欄（動画ごとの開始オフセット）でも効く。
//
// 動く量は、値の大きさに応じて変える（可変）。小さい値では、1px で刻み 1 つ分（細かい）。
// 大きい値ほど、1px あたりの変化が値に比例して大きくなり、遠くまで素早く動かせる。行って戻れば、元の値に戻る。
// 可変にしたくない欄（開始オフセット）は、data-drag-curve="linear" を付ける。常に、1px で刻み 1 つ分。

/** これだけ動かしたら、ドラッグとみなす（px）。クリックと区別する */
const START_PX = 3;
/** 1px あたりの変化を、値の大きさの何割にするか（指数の部分）。ただし、刻み（step）より小さくはしない */
const GROWTH = 0.015;
/** Shift を押しているときの倍率（細かく） */
const FINE = 0.2;

/** target が数値の入力欄、またはそれを持つラベルなら、その入力欄を返す。 */
function numberInputOf(target: EventTarget | null): HTMLInputElement | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest('input') ?? target.closest('label')?.control ?? null;
  if (!(control instanceof HTMLInputElement) || control.type !== 'number') return null;
  return control.disabled || control.readOnly ? null : control;
}

const decimalsOf = (s: string): number => (s.split('.')[1] ?? '').length;

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || !e.isPrimary) return;
  const input = numberInputOf(e.target);
  if (!input) return;

  // 上下にドラッグする欄: data-drag="y" を付けた欄と、縦書き（-90 度回した）の欄。上へのドラッグが「増える」
  // （縦書きでは、文字の読む向きと同じ）。それ以外は、左右にドラッグする
  const vertical = input.dataset.drag === 'y' || /^(vertical|sideways)/.test(getComputedStyle(input).writingMode);
  const step = Number(input.step) > 0 ? Number(input.step) : 1;
  const min = input.min === '' ? -Infinity : Number(input.min);
  const max = input.max === '' ? Infinity : Number(input.max);
  const base = Number.isFinite(min) ? min : 0;
  const decimals = decimalsOf(input.step || '1');
  const origin = { x: e.clientX, y: e.clientY };
  const travel = (ev: PointerEvent): number => (vertical ? origin.y - ev.clientY : ev.clientX - origin.x);
  const cursorClass = vertical ? 'dragging-number-v' : 'dragging-number';

  // 値を、ドラッグの距離 s（px）の関数にする。
  //   |値| が T = 刻み / GROWTH までは、1px で刻み 1 つ分（一次）。それより大きいと、1px で値の GROWTH 倍（指数）。
  //   二つはつなぎ目で、傾きがそろう。距離と値が 1 対 1 なので、行って戻れば、必ず元の値に戻る
  // data-drag-curve="linear" の欄は、可変にしない（常に、1px で刻み 1 つ分）。切り替わる値を、無限大にすればよい
  const turn = input.dataset.dragCurve === 'linear' ? Infinity : step / GROWTH; // 一次から指数に切り替わる値
  const turnPx = turn / step; // そこまでの距離（px）
  const toPx = (v: number): number =>
    Math.abs(v) <= turn ? v / step : Math.sign(v) * (turnPx + Math.log(Math.abs(v) / turn) / GROWTH);
  const fromPx = (s: number): number =>
    Math.abs(s) <= turnPx ? s * step : Math.sign(s) * turn * Math.exp(GROWTH * (Math.abs(s) - turnPx));
  const clampValue = (v: number): number => Math.min(max, Math.max(min, v));

  let dragging = false;
  let last = 0; // 前回の位置（px）
  let s = toPx(Number(input.value) || 0); // 現在の距離。丸めた値から求め直すと、細かい動きが消えるので、持ち続ける

  const move = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return;
    const d = travel(ev);
    if (!dragging) {
      if (Math.abs(d) < START_PX) return;
      dragging = true;
      // 最初の START_PX だけは、値に反映しない（クリックとの境目で、値が飛ばないように）。
      // 1 回のイベントで大きく動いたときも、残りは反映する
      last = Math.sign(d) * START_PX;
      document.body.classList.add(cursorClass);
      window.getSelection()?.removeAllRanges(); // 動かし始める前に選ばれた文字を、解除する
    }
    s += (d - last) * (ev.shiftKey ? FINE : 1);
    last = d;
    const value = clampValue(fromPx(s));
    s = toPx(value); // 上限・下限で止まったら、距離も、そこに合わせる（行き過ぎた分を、戻すときに消費しない）
    const snapped = Math.round((value - base) / step) * step + base;
    input.value = clampValue(snapped).toFixed(decimals);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const end = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (!dragging) return;
    document.body.classList.remove(cursorClass);
    input.dispatchEvent(new Event('change', { bubbles: true })); // 設定の保存などは、動かし終えたときに
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

export function initDragNumber(): void {
  document.addEventListener('pointerdown', onPointerDown);
}
