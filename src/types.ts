import type { Input, InputVideoTrack, VideoCodec, VideoSampleSink } from 'mediabunny';
import type { ChartLayout } from './ui/chart';

/** 動画の枠。A が基準、B が比較対象。 */
export type Slot = 'A' | 'B';
export const SLOTS: readonly Slot[] = ['A', 'B'];

/** フレームの対応づけ方法。 */
export type Mode = 'index' | 'time';
/** 画面で選べる対応づけ方法（auto は読み込んだ動画から決める）。 */
export type ModeSetting = Mode | 'auto';

/** 読み込んだ動画の情報。 */
export interface VideoInfo {
  file: File;
  input: Input;
  track: InputVideoTrack;
  codec: VideoCodec | null;
  w: number;
  h: number;
  fps: number;
  duration: number;
  /** 先頭フレームのタイムスタンプ（秒） */
  first: number;
}

/** 比較の実行結果。フレームごとに1要素ずつ持つ（画像は持たない）。 */
export interface Run {
  /** 差分の明るさ（0〜255） */
  values: number[];
  /** 各フレームのタイムスタンプ（秒） */
  tsA: number[];
  tsB: number[];
  /** 再デコード用に、フレーム中央付近を指すタイムスタンプ */
  qA: number[];
  qB: number[];
  /** 計算用の描画サイズ */
  w: number;
  h: number;
  mode: Mode;
  gain: number;
  /** 総フレーム数の見込み（進捗とグラフの横軸に使う） */
  expected: number;
  /** 再デコードに使う。リセット後は null */
  sinks: Record<Slot, VideoSampleSink> | null;
  selected: number;
  hover: number;
  layout: ChartLayout | null;
}

export interface AppState {
  A: VideoInfo | null;
  B: VideoInfo | null;
  running: boolean;
  /** 停止ボタンが押された */
  stop: boolean;
  run: Run | null;
}

/** アプリ全体の状態（画面はこれを読んで描き直す）。 */
export const state: AppState = {
  A: null,
  B: null,
  running: false,
  stop: false,
  run: null,
};
