import type { AudioCodec, Input, InputAudioTrack, InputVideoTrack, VideoCodec, VideoSampleSink } from 'mediabunny';
import type { ChartLayout } from './ui/chart';

/** 動画の枠。A が基準、B が比較対象。 */
export type Slot = 'A' | 'B';
export const SLOTS: readonly Slot[] = ['A', 'B'];

/** フレームの対応づけ方法。 */
export type Mode = 'index' | 'time';
/** 画面で選べる対応づけ方法（auto は読み込んだ動画から決める）。 */
export type ModeSetting = Mode | 'auto';

/** 読み込んだファイルに含まれる音声（読めるときだけ持つ）。時刻は、先頭（映像があれば先頭フレーム）を 0 とする。 */
export interface AudioInfo {
  track: InputAudioTrack;
  codec: AudioCodec | null;
  /** サンプルレート（Hz） */
  rate: number;
  channels: number;
  /** 先頭から、音声の終わりまで（秒） */
  duration: number;
}

/** 読み込んだファイル（動画、または音声だけのファイル）の情報。 */
export interface VideoInfo {
  file: File;
  input: Input;
  /** 映像。音声だけのファイルでは null（このとき w / h / fps は 0、codec は null） */
  track: InputVideoTrack | null;
  codec: VideoCodec | null;
  w: number;
  h: number;
  fps: number;
  duration: number;
  /** 先頭のタイムスタンプ（秒）。映像があれば先頭フレーム、なければ音声の先頭 */
  first: number;
  /** 音声。無い・読めないときは null */
  audio: AudioInfo | null;
  /** audio が null の理由（画面に出す）。読めるときは空 */
  audioNote: string;
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

/** 音声の差の分析結果。1/HOP_RATE 秒ごとに 1 列（画像は持たない） */
export interface AudioRun {
  /** 総列数（短いほうの音声の長さから決める。進捗と横軸に使う） */
  expected: number;
  /** 分析済みの列数 */
  count: number;
  /** 列ごとの音量（dBFS）。levelA / levelB は各音声、diff は A − B の波形 */
  levelA: number[];
  levelB: number[];
  diff: number[];
  /** スペクトログラムの差（B − A、dB）。列 k の行 r は spec[k * rows + r]。行は低い周波数から */
  spec: Int8Array;
  rows: number;
  fMin: number;
  fMax: number;
  /** 全体のエネルギー（サンプルの二乗和）。全体の差の大きさを出す */
  energyA: number;
  energyDiff: number;
  /** 分析が終わった（停止・エラーを含む） */
  done: boolean;
  error: string;
  /** 選んだ時刻（秒。動画の先頭から）。無ければ -1 */
  selected: number;
  hover: number;
}

/** 映像を持つか（音声だけのファイルではない）。 */
export const hasVideo = (v: VideoInfo): v is VideoInfo & { track: InputVideoTrack } => v.track !== null;

export interface AppState {
  A: VideoInfo | null;
  B: VideoInfo | null;
  running: boolean;
  /** 停止ボタンが押された */
  stop: boolean;
  run: Run | null;
  audio: AudioRun | null;
}

/** アプリ全体の状態（画面はこれを読んで描き直す）。 */
export const state: AppState = {
  A: null,
  B: null,
  running: false,
  stop: false,
  run: null,
  audio: null,
};
