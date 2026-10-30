// 音声の差のパネル: 状態を画面に反映し、グラフの操作（ホバー・押して選ぶ）と、聴く操作を受け付ける。

import { cursorTime, diffBoost, isLoading, isPlaying, onPlaybackChange, startPlayback, stopPlayback, switchSource, type Source } from '../audioplay';
import { DB_MIN, HOP_RATE } from '../lib/audiodsp';
import { clamp, errorMessage, formatTime, num } from '../lib/util';
import { state } from '../types';
import { drawAudioLine, drawSpectrogram, freqAt, timeAt, type AudioLayout } from './audiochart';
import { ui } from './dom';

let lineLayout: AudioLayout | null = null;
let specLayout: AudioLayout | null = null;
let source: Source = 'A';
let playError = '';
/** 音声の選択へ反映済みの、動画のフレーム番号。動画側で選び直されたら、音声の選択も合わせる */
let syncedFrame = -2;

const SOURCE_NAME: Record<Source, string> = { A: 'A', B: 'B', D: '差（A − B）' };

/** 音声の選択を、動画のフレーム i に合わせたことにする（音声のグラフから動画を選ぶとき、選択を上書きされないように）。 */
export function markFrameSynced(i: number): void {
  syncedFrame = i;
}

/** 動画の選択が変わっていたら、音声の選択を、そのフレームの時刻に合わせる。 */
function syncSelection(): void {
  const { A, run, audio: au } = state;
  if (!run || !au || run.selected === syncedFrame) return;
  syncedFrame = run.selected;
  au.selected = run.selected >= 0 && A ? Math.max(0, run.tsA[run.selected]! - A.first) : -1;
}

const dbText = (v: number): string => (v <= DB_MIN ? '-∞' : num(v, 1));

function resultText(): string {
  const au = state.audio;
  if (!au || au.count === 0) return '';
  let max = DB_MIN - 1;
  let at = 0;
  for (let i = 0; i < au.count; i++) {
    if (au.diff[i]! > max) {
      max = au.diff[i]!;
      at = i;
    }
  }
  const upTo = au.count < au.expected ? ` · ${formatTime(au.count / HOP_RATE)} まで` : '';
  if (au.energyDiff === 0) return `差なし（完全に一致）${upTo}`;
  const rel = au.energyA > 0 ? `${num(10 * Math.log10(au.energyDiff / au.energyA), 1)} dB（A の音量に対して）` : '-';
  return `全体の差 ${rel} · 最大 ${dbText(max)} dBFS（${formatTime(at / HOP_RATE)}）${upTo}`;
}

function summaryText(): string {
  const { A, B, audio: au } = state;
  if (playError) return playError;
  if (isLoading()) return '音声を読み込み中…';
  if (isPlaying()) {
    const boost = diffBoost();
    return `${SOURCE_NAME[source]} を再生中${source === 'D' && boost > 1 ? `（差の音は ×${num(boost, 1)} に増幅）` : ''}`;
  }
  if (!au) {
    if (A && B && !(A.audio && B.audio)) {
      return A.audio || B.audio ? '音声がない動画があるため、音声の差は出しません' : '音声がないため、音声の差は出しません';
    }
    return A && B ? '解析すると、音声の差も出ます' : '';
  }
  if (au.error) return `エラー: ${au.error}`;
  if (!au.done) return `解析中 ${formatTime(au.count / HOP_RATE)} / ${formatTime(au.expected / HOP_RATE)}`;
  return resultText();
}

/** パネルの表示（文言・ボタン・グラフ）を、いまの状態に合わせる。 */
export function refreshAudio(): void {
  syncSelection();
  const au = state.audio;
  const ready = !!au && au.done && au.count > 0;
  const busy = isPlaying() || isLoading();
  ui.aSummary.textContent = summaryText();
  ui.aPlay.disabled = !ready;
  ui.aPlay.setAttribute('aria-pressed', String(busy));
  ui.aPlayLabel.textContent = busy ? '止める' : '聴く';
  ui.aCsv.disabled = !(au && au.count > 0);
  for (const b of ui.aSrc.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.src === source));

  const o = { au, selected: au?.selected ?? -1, hover: au?.hover ?? -1, cursor: cursorTime() ?? -1 };
  lineLayout = drawAudioLine(ui.aChart, o);
  specLayout = drawSpectrogram(ui.aSpec, o);
}

/** 前回の分析結果を捨てて、初期状態に戻す。 */
export function resetAudio(): void {
  stopPlayback();
  state.audio = null;
  syncedFrame = -2;
  playError = '';
  refreshAudio();
}

/** 選んだ位置から、いまの音を聴く。聴いている最中なら止める。操作できたら true（できないときは false）。 */
export function togglePlayback(): boolean {
  const au = state.audio;
  playError = '';
  if (isPlaying() || isLoading()) {
    stopPlayback();
    return true;
  }
  if (!au || !au.done || au.count === 0) return false;
  const end = au.expected / HOP_RATE;
  const from = au.selected >= 0 && au.selected < end - 0.05 ? au.selected : 0;
  startPlayback(from, source).catch((e) => {
    playError = errorMessage(e);
    refreshAudio();
  });
  return true;
}

let raf = 0;
/** 再生中は、位置の線を動かし続ける。 */
function followCursor(): void {
  cancelAnimationFrame(raf);
  if (!isPlaying()) return;
  raf = requestAnimationFrame(() => {
    refreshAudio();
    followCursor();
  });
}

function placeTip(e: PointerEvent, canvas: HTMLCanvasElement, text: string): void {
  ui.aTip.hidden = false;
  ui.aTip.textContent = text;
  const host = (canvas.parentElement ?? canvas).getBoundingClientRect();
  ui.aTip.style.left = `${Math.min(e.clientX - host.left + 12, host.width - ui.aTip.offsetWidth - 4)}px`;
  ui.aTip.style.top = `${e.clientY - host.top - 30}px`;
}

/**
 * 音声のグラフの操作: ホバーで値、押すとその位置を選び、押したまま動かすと追従する。
 * 選んだ時刻は seek で動画側へ伝える（動画のフレームも、その時刻に合わせる）。
 */
export function bindAudio(seek: (time: number) => void): void {
  const bindCanvas = (canvas: HTMLCanvasElement, layout: () => AudioLayout | null, tip: (t: number, y: number) => string): void => {
    let pressed = false;
    const cssX = (e: MouseEvent) => e.clientX - canvas.getBoundingClientRect().left;
    const cssY = (e: MouseEvent) => e.clientY - canvas.getBoundingClientRect().top;
    const choose = (e: PointerEvent): void => {
      const au = state.audio;
      if (!au || au.count === 0) return;
      const k = clamp(Math.floor(timeAt(layout(), cssX(e)) * HOP_RATE), 0, au.count - 1);
      const t = k / HOP_RATE;
      if (t === au.selected) return;
      au.selected = t;
      seek(t);
      refreshAudio();
    };

    canvas.addEventListener('pointerdown', (e) => {
      const au = state.audio;
      if (e.button !== 0 || !au || au.count === 0) return;
      stopPlayback(); // 選び直すので、再生は止める
      playError = '';
      pressed = true;
      try {
        canvas.setPointerCapture(e.pointerId); // グラフの外へ動かしても追従を続ける
      } catch {
        // 取れなくても動く
      }
      choose(e);
    });
    const release = () => {
      pressed = false;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('pointermove', (e) => {
      const au = state.audio;
      if (!au || au.count === 0) return;
      const t = timeAt(layout(), cssX(e));
      au.hover = t;
      if (pressed) choose(e);
      else refreshAudio();
      placeTip(e, canvas, tip(t, cssY(e)));
    });
    canvas.addEventListener('pointerleave', () => {
      ui.aTip.hidden = true;
      if (state.audio) {
        state.audio.hover = -1;
        refreshAudio();
      }
    });
  };

  const column = (t: number): number => clamp(Math.floor(t * HOP_RATE), 0, Math.max(0, (state.audio?.count ?? 1) - 1));

  bindCanvas(ui.aChart, () => lineLayout, (t) => {
    const au = state.audio;
    if (!au) return '';
    const k = column(t);
    return `${formatTime(k / HOP_RATE)} · A ${dbText(au.levelA[k]!)} · B ${dbText(au.levelB[k]!)} · 差 ${dbText(au.diff[k]!)} dB`;
  });

  bindCanvas(ui.aSpec, () => specLayout, (t, y) => {
    const au = state.audio;
    const lay = specLayout;
    if (!au || !lay) return '';
    const k = column(t);
    const f = freqAt(lay, au, y);
    const row = clamp(Math.floor((Math.log(f / au.fMin) / Math.log(au.fMax / au.fMin)) * au.rows), 0, au.rows - 1);
    const v = au.spec[k * au.rows + row]!;
    const freq = f >= 1000 ? `${num(f / 1000, 1)} kHz` : `${Math.round(f)} Hz`;
    return `${formatTime(k / HOP_RATE)} · ${freq} · B − A ${v > 0 ? '+' : ''}${v} dB`;
  });

  ui.aPlay.addEventListener('click', () => void togglePlayback());
  ui.aSrc.addEventListener('click', (e) => {
    const next = (e.target as Element).closest<HTMLButtonElement>('button[data-src]')?.dataset.src;
    if (next !== 'A' && next !== 'B' && next !== 'D') return;
    source = next;
    switchSource(source);
    refreshAudio();
  });
  onPlaybackChange(() => {
    refreshAudio();
    followCursor();
  });
}
