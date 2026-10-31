// 数値の入力欄を、ドラッグで変えられるようにする（デザインツールの数値欄と同じ操作）。
// 欄の上、または欄を含むラベルの文字の上でドラッグする。ほとんど動かさない操作は、これまでどおりのクリック（入力）。
// ページ全体でイベントを受けるので、あとから作られる欄（動画ごとの開始オフセット）でも効く。
//
// 動く量は、値の大きさに応じて変える（可変）。小さい値では、1px で刻み 1 つ分（細かい）。
// 大きい値ほど、1px あたりの変化が値に比例して大きくなり、遠くまで素早く動かせる。行って戻れば、元の値に戻る。
// 可変にしたくない欄（開始オフセット）は、data-drag-curve="linear" を付ける。常に、1px で刻み 1 つ分。
//
// 普段は粗く動かし、小さい値のところだけ細かく合わせたい欄（しきい値）は、step を細かい刻み（0.01）にして、
// data-drag-step に普段の刻み（0.1）を書く。値が data-drag-step 以下のあいだは、1px で step 分（細かい）。
// それより大きいあいだは、1px で data-drag-step 分（値も、その刻みにそろえる）。
// Shift を押している間は、動く量が FINE 倍になる（値の刻みは変わらない）。付けない欄は、step だけを使う。
// 欄全体の動く量を落としたいときは、data-drag-speed に倍率（しきい値は 0.2）を書く。付けなければ 1。
// 距離（px）に掛けるだけなので、細かい区間も、指数の区間も、同じ割合で遅くなる。
// 欄の ↑↓（スピンボタンと、キーボードの ↑↓）も、同じ刻みにする（値が data-drag-step 以下は step、それより上は data-drag-step）。

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

/** 自分で入力イベントを出している間は、真（ブラウザの ↑↓ による変更と区別する） */
let own = false;
/** 欄ごとの、直前の値（↑↓ で、どちらへ動いたかを知るため） */
const previous = new WeakMap<HTMLInputElement, number>();

function dispatchOwn(input: HTMLInputElement, type: 'input' | 'change'): void {
  own = true;
  try {
    input.dispatchEvent(new Event(type, { bubbles: true }));
  } finally {
    own = false;
  }
}

/**
 * 粗い刻み（data-drag-step）を持つ欄の ↑↓ の 1 回分。
 * 値が粗い刻み以下のあいだは step 分、それより上は粗い刻み分（粗い刻みの目盛りにそろえる）。
 * 上へは、値 v のいる区間の刻みで進み、下へは、v の 1 つ手前の区間の刻みで戻る（0.1 から下へは 0.09）。
 */
function spinValue(input: HTMLInputElement, v: number, dir: 1 | -1): number {
  const step = Number(input.step) > 0 ? Number(input.step) : 1;
  const coarse = Number(input.dataset.dragStep);
  const eps = step / 1000;
  const min = input.min === '' ? -Infinity : Number(input.min);
  const max = input.max === '' ? Infinity : Number(input.max);
  let next: number;
  if (dir > 0) {
    next = v < coarse - eps ? v + step : (Math.floor(v / coarse + eps) + 1) * coarse;
  } else {
    next = v <= coarse + eps ? v - step : (Math.ceil(v / coarse - eps) - 1) * coarse;
  }
  next = Math.min(max, Math.max(min, next));
  const decimals = next <= coarse + eps ? decimalsOf(input.step || '1') : decimalsOf(input.dataset.dragStep ?? '');
  return Number(next.toFixed(decimals));
}

const isNumberInput = (t: EventTarget | null): t is HTMLInputElement => t instanceof HTMLInputElement && t.type === 'number';

const remember = (e: Event): void => {
  if (isNumberInput(e.target)) previous.set(e.target, Number(e.target.value));
};

/** ブラウザの ↑↓（スピンボタン・キー）で値が変わったら、同じ刻みに直す。打ち込みと、自分の変更は、そのまま。 */
function onNativeStep(e: Event): void {
  const input = e.target;
  if (!isNumberInput(input)) return;
  const prev = previous.get(input);
  const now = Number(input.value);
  remember(e);
  if (own || e instanceof InputEvent || !(Number(input.dataset.dragStep) > 0)) return;
  if (prev === undefined || !Number.isFinite(now) || now === prev) return;
  const next = spinValue(input, prev, now > prev ? 1 : -1);
  input.value = String(next);
  remember(e);
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || !e.isPrimary) return;
  const input = numberInputOf(e.target);
  if (!input) return;

  // 上下にドラッグする欄: data-drag="y" を付けた欄と、縦書き（-90 度回した）の欄。上へのドラッグが「増える」
  // （縦書きでは、文字の読む向きと同じ）。それ以外は、左右にドラッグする
  const vertical = input.dataset.drag === 'y' || /^(vertical|sideways)/.test(getComputedStyle(input).writingMode);
  const step = Number(input.step) > 0 ? Number(input.step) : 1; // 値の刻み（細かい側）
  // 普段のドラッグの刻み（粗い側）。data-drag-step が無ければ、step と同じ
  const coarse = Number(input.dataset.dragStep) > 0 ? Number(input.dataset.dragStep) : step;
  const min = input.min === '' ? -Infinity : Number(input.min);
  const max = input.max === '' ? Infinity : Number(input.max);
  const base = 0; // 刻みの基準は 0（最小が刻みの倍数でない欄でも、0.1・0.2 … にそろえ、最小は clamp で止める）
  const decimalsStep = decimalsOf(input.step || '1');
  const decimalsCoarse = coarse === step ? decimalsStep : decimalsOf(input.dataset.dragStep ?? '');
  const speed = Number(input.dataset.dragSpeed) > 0 ? Number(input.dataset.dragSpeed) : 1; // 欄全体の倍率
  const origin = { x: e.clientX, y: e.clientY };
  const travel = (ev: PointerEvent): number => (vertical ? origin.y - ev.clientY : ev.clientX - origin.x);
  const cursorClass = vertical ? 'dragging-number-v' : 'dragging-number';

  // 値を、ドラッグの距離 s（px）の関数にする（a = |値|、p = |s|）。
  //   a が fineZone 以下: 1px で step 分（細かい。粗い刻みを指定した欄だけ。ほかの欄は fineZone = 0）
  //   fineZone より大きく、T = 粗い刻み / GROWTH まで: 1px で粗い刻み 1 つ分（一次）
  //   T より大きい: 1px で値の GROWTH 倍（指数）。一次とのつなぎ目で、傾きがそろう
  //   どこも距離と値が 1 対 1 なので、行って戻れば、必ず元の値に戻る
  // data-drag-curve="linear" の欄は、可変にしない（指数にしない）。切り替わる値を、無限大にすればよい
  const fineZone = coarse > step ? coarse : 0;
  const fineZonePx = fineZone / step; // fineZone までの距離（px）
  const turn = input.dataset.dragCurve === 'linear' ? Infinity : coarse / GROWTH; // 一次から指数に切り替わる値
  const linearToPx = (a: number): number => (a <= fineZone ? a / step : fineZonePx + (a - fineZone) / coarse);
  const linearFromPx = (p: number): number => (p <= fineZonePx ? p * step : fineZone + (p - fineZonePx) * coarse);
  const turnPx = linearToPx(turn); // 一次から指数に切り替わる距離（px）
  const toPx = (v: number): number =>
    Math.abs(v) <= turn ? linearToPx(Math.abs(v)) * Math.sign(v) : Math.sign(v) * (turnPx + Math.log(Math.abs(v) / turn) / GROWTH);
  const fromPx = (s: number): number =>
    Math.abs(s) <= turnPx ? linearFromPx(Math.abs(s)) * Math.sign(s) : Math.sign(s) * turn * Math.exp(GROWTH * (Math.abs(s) - turnPx));
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
    s += (d - last) * speed * (ev.shiftKey ? FINE : 1);
    last = d;
    const value = clampValue(fromPx(s));
    s = toPx(value); // 上限・下限で止まったら、距離も、そこに合わせる（行き過ぎた分を、戻すときに消費しない）
    // 細かい区間は step、それより上は粗い刻みにそろえる（小数の桁も合わせる）
    const isFine = Math.abs(value) <= fineZone;
    const grain = isFine ? step : coarse;
    const snapped = Math.round((value - base) / grain) * grain + base;
    input.value = clampValue(snapped).toFixed(isFine ? decimalsStep : decimalsCoarse);
    dispatchOwn(input, 'input');
  };

  const end = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (!dragging) return;
    document.body.classList.remove(cursorClass);
    dispatchOwn(input, 'change'); // 設定の保存などは、動かし終えたときに
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

export function initDragNumber(): void {
  document.addEventListener('pointerdown', onPointerDown);
  // ↑↓ の前の値を覚える（押す前、キーを押す前、フォーカスしたとき）。入力イベントは、欄より先に受ける
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('keydown', remember, true);
  document.addEventListener('focusin', remember, true);
  document.addEventListener('input', onNativeStep, true);
}
