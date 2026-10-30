// 音声を聴く: 選んだ位置から数秒を読み、A / B / 差（A − B）のどれかを鳴らす。再生中も、音を切り替えられる。
// 比較は Web Audio で鳴らす（モノラルに混ぜた音）。

import { readWindow } from './audio';
import { state } from './types';

/** 聴く長さ（秒） */
export const PLAY_SECONDS = 10;
/** 差の音は小さいので、ピークがこの値になるまで増幅する（最大 MAX_BOOST 倍） */
const DIFF_TARGET_PEAK = 0.5;
const MAX_BOOST = 100;

export type Source = 'A' | 'B' | 'D';

interface Session {
  from: number;
  buffers: Record<Source, AudioBuffer>;
  node: AudioBufferSourceNode | null;
  /** ノードを始めた時の、AudioContext の時刻と、窓の中の位置（秒） */
  ctxStart: number;
  offset: number;
  source: Source;
}

let ctx: AudioContext | null = null;
let session: Session | null = null;
let token = 0;
let loading = false;
let boost = 1;
let listener: () => void = () => {};

/** 再生の状態が変わったときに呼ぶ関数を決める。 */
export function onPlaybackChange(fn: () => void): void {
  listener = fn;
}

export const isPlaying = (): boolean => session?.node != null;
export const isLoading = (): boolean => loading;
/** 差の音を増幅した倍率（1 なら、そのまま）。 */
export const diffBoost = (): number => boost;

/** 再生中の位置（動画の先頭からの秒）。再生していなければ null。 */
export function cursorTime(): number | null {
  if (!session?.node || !ctx) return null;
  return session.from + session.offset + (ctx.currentTime - session.ctxStart);
}

function startNode(s: Session, source: Source, offset: number): void {
  if (!ctx) return;
  s.node?.stop();
  const node = ctx.createBufferSource();
  node.buffer = s.buffers[source];
  node.connect(ctx.destination);
  node.onended = () => {
    if (session === s && s.node === node) {
      s.node = null;
      listener();
    }
  };
  s.node = node;
  s.source = source;
  s.offset = offset;
  s.ctxStart = ctx.currentTime;
  node.start(0, offset);
}

function toBuffer(c: AudioContext, data: Float32Array, rate: number, gain = 1): AudioBuffer {
  const buf = c.createBuffer(1, data.length, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) ch[i] = Math.max(-1, Math.min(1, data[i]! * gain));
  return buf;
}

export function stopPlayback(): void {
  token++;
  loading = false;
  const s = session;
  session = null;
  if (s?.node) {
    s.node.onended = null;
    s.node.stop();
  }
  listener();
}

/** 動画の先頭から from 秒の位置から、source の音を鳴らす。 */
export async function startPlayback(from: number, source: Source): Promise<void> {
  const { A, B, audio } = state;
  if (!A || !B || !audio) return;
  stopPlayback();
  const my = ++token;
  loading = true;
  listener();
  try {
    // 音を出すには、ユーザーの操作の中で作る必要がある（先に作って、読み込み中に待たせる）
    ctx ??= new AudioContext();
    void ctx.resume();
    const limit = Math.min(A.audio?.duration ?? 0, B.audio?.duration ?? 0);
    const seconds = Math.min(PLAY_SECONDS, limit - from);
    if (!(seconds > 0.05)) throw new Error('この位置には、聴ける音声がありません。');
    const w = await readWindow(A, B, from, seconds);
    if (my !== token) return;

    let peak = 0;
    for (const v of w.d) peak = Math.max(peak, Math.abs(v));
    boost = peak > 0 ? Math.min(MAX_BOOST, Math.max(1, DIFF_TARGET_PEAK / peak)) : 1;
    const s: Session = {
      from,
      buffers: {
        A: toBuffer(ctx, w.a, w.rate),
        B: toBuffer(ctx, w.b, w.rate),
        D: toBuffer(ctx, w.d, w.rate, boost),
      },
      node: null,
      ctxStart: 0,
      offset: 0,
      source,
    };
    session = s;
    startNode(s, source, 0);
  } finally {
    if (my === token) loading = false;
    listener();
  }
}

/** 再生中なら、いまの位置から、別の音に切り替える。 */
export function switchSource(source: Source): void {
  const s = session;
  if (!s?.node || !ctx || s.source === source) return;
  const at = ctx.currentTime - s.ctxStart + s.offset;
  s.node.onended = null;
  startNode(s, source, at);
  listener();
}
