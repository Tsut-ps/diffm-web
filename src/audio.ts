// 音声の読み込みと、2本の音声の差の分析（モノラルに混ぜて、波形・音量・スペクトログラムを比べる）

import { AudioSampleSink, type AudioSample } from 'mediabunny';
import { HOP_RATE, Stft, toDb } from './lib/audiodsp';
import { state, type AudioRun, type VideoInfo } from './types';
import { errorMessage, yieldToUI } from './lib/util';

/** 一度に処理する列数（約 1 秒分） */
const CHUNK_HOPS = HOP_RATE;
/** 画面の更新の間隔（ms）。更新は、スペクトログラムの描き直しを含むので、間引く */
const PROGRESS_INTERVAL = 250;
/** サンプルの時刻が、続きの位置とこれ以内（秒）のずれなら、つなげて置く（タイムスタンプの丸めを、ずれとして扱わない） */
const JOIN_TOLERANCE = 0.003;
/** 途中から読むとき、デコーダーの助走のために、手前から読み始める長さ（秒） */
const PREROLL = 0.25;

/**
 * 1本の音声を、モノラルの時系列として順に読む。位置は、サンプル番号（origin の時刻が 0）。
 * 途切れた所は無音で埋め、重なった所は捨てる。
 */
export class MonoStream {
  readonly rate: number;
  private readonly iter: AsyncGenerator<AudioSample, void, unknown>;
  private readonly first: number;
  private readonly origin: number;
  private data = new Float32Array(1 << 16);
  /** data[0] のサンプル番号 */
  private base = 0;
  /** 読み終えた末尾のサンプル番号 */
  private written = 0;
  private done = false;

  /**
   * first: 動画の先頭フレームの時刻。origin: 位置 0 にする時刻（動画の先頭からの秒）。
   * from / to は読む範囲（動画の先頭からの秒）。省略すると、先頭から最後まで。
   */
  constructor(audio: NonNullable<VideoInfo['audio']>, first: number, origin = 0, from?: number, to?: number) {
    this.rate = audio.rate;
    this.first = first;
    this.origin = origin;
    const sink = new AudioSampleSink(audio.track);
    this.iter = sink.samples(
      from === undefined ? undefined : first + Math.max(0, from - PREROLL),
      to === undefined ? undefined : first + to,
    );
  }

  /** サンプル番号 upTo の手前まで読み進める（終わっていれば、そこまで）。 */
  async fill(upTo: number): Promise<void> {
    while (!this.done && this.written < upTo) {
      const r = await this.iter.next();
      if (r.done) {
        this.done = true;
        break;
      }
      this.push(r.value);
    }
  }

  private ensure(endPos: number): void {
    const need = endPos - this.base;
    if (need <= this.data.length) return;
    const bigger = new Float32Array(Math.max(need, this.data.length * 2));
    bigger.set(this.data.subarray(0, this.written - this.base));
    this.data = bigger;
  }

  private push(s: AudioSample): void {
    try {
      const n = s.numberOfFrames;
      const ch = s.numberOfChannels;
      let pos = Math.round((s.timestamp - this.first - this.origin) * this.rate);
      let skip = 0;
      if (Math.abs(pos - this.written) <= JOIN_TOLERANCE * this.rate) {
        pos = this.written;
      } else if (pos > this.written) {
        this.ensure(pos);
        this.data.fill(0, this.written - this.base, pos - this.base);
        this.written = pos;
      } else {
        skip = this.written - pos;
        if (skip >= n) return;
        pos = this.written;
      }
      const m = n - skip;
      this.ensure(pos + m);
      const dst = this.data.subarray(pos - this.base, pos - this.base + m);
      dst.fill(0);
      const plane = new Float32Array(m);
      for (let c = 0; c < ch; c++) {
        s.copyTo(plane, { planeIndex: c, format: 'f32-planar', frameOffset: skip, frameCount: m });
        for (let i = 0; i < m; i++) dst[i]! += plane[i]!;
      }
      if (ch > 1) for (let i = 0; i < m; i++) dst[i]! /= ch;
      this.written = pos + m;
    } finally {
      s.close();
    }
  }

  /** サンプル番号 upTo より前を捨てる。 */
  trimTo(upTo: number): void {
    const to = Math.min(upTo, this.written);
    if (to <= this.base) return;
    this.data.copyWithin(0, to - this.base, this.written - this.base);
    this.base = to;
  }

  private at(idx: number): number {
    return idx >= this.base && idx < this.written ? this.data[idx - this.base]! : 0;
  }

  /** outRate での番号 [from, to) の区間を返す（rate が違えば、線形補間で変換する）。範囲の外は無音。 */
  read(from: number, to: number, outRate: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    if (outRate === this.rate) {
      for (let i = 0; i < out.length; i++) out[i] = this.at(from + i);
    } else {
      const k = this.rate / outRate;
      for (let i = 0; i < out.length; i++) {
        const p = (from + i) * k;
        const i0 = Math.floor(p);
        const x0 = this.at(i0);
        out[i] = x0 + (this.at(i0 + 1) - x0) * (p - i0);
      }
    }
    return out;
  }

  /** outRate での番号 upTo までを読むのに必要な、この音声のサンプル番号。 */
  indexFor(outIndex: number, outRate: number): number {
    return Math.ceil((outIndex * this.rate) / outRate) + 2;
  }

  async close(): Promise<void> {
    this.done = true;
    await this.iter.return(undefined);
  }
}

/** 音声があり、A と B が両方読めるときだけ true。 */
export const canCompareAudio = (a: VideoInfo | null, b: VideoInfo | null): boolean => !!a?.audio && !!b?.audio;

/**
 * A と B の音声を先頭から順に読み、1/HOP_RATE 秒ごとに、音量（A / B / A − B の波形）と、
 * 周波数ごとの音量の差を記録する。結果は state.audio に積み、進むたびに onProgress を呼ぶ。
 * エラーは state.audio.error に入れる（動画の比較は止めない）。
 */
export async function analyzeAudio(
  a: VideoInfo,
  b: VideoInfo,
  shouldStop: () => boolean,
  onProgress: () => void,
): Promise<void> {
  const aa = a.audio;
  const ba = b.audio;
  if (!aa || !ba) return;
  const hops = Math.floor(Math.min(aa.duration, ba.duration) * HOP_RATE);
  if (hops < 1) return;

  const rate = aa.rate;
  const stft = new Stft(rate);
  const { rows, fMin, fMax } = stft.bands;
  const au: AudioRun = {
    expected: hops, count: 0,
    levelA: [], levelB: [], diff: [],
    spec: new Int8Array(hops * rows), rows, fMin, fMax,
    energyA: 0, energyDiff: 0,
    done: false, error: '', selected: -1, hover: -1,
  };
  state.audio = au;

  const sa = new MonoStream(aa, a.first);
  const sb = new MonoStream(ba, b.first);
  const half = stft.size / 2;
  /** 列 k の始まりのサンプル番号（A の rate） */
  const boundary = (k: number) => Math.round((k * rate) / HOP_RATE);

  let lastProgress = performance.now();
  try {
    for (let k0 = 0; k0 < hops && !shouldStop(); k0 += CHUNK_HOPS) {
      const k1 = Math.min(hops, k0 + CHUNK_HOPS);
      // 窓は列の幅より広いので、前後に、窓の半分ずつの余白を付けて読む
      const from = boundary(k0) - half;
      const to = boundary(k1) + half;
      await Promise.all([sa.fill(to), sb.fill(sb.indexFor(to, rate))]);
      const x = sa.read(from, to, rate);
      const y = sb.read(from, to, rate);

      for (let k = k0; k < k1; k++) {
        const s = boundary(k) - from;
        const e = boundary(k + 1) - from;
        let ea = 0;
        let eb = 0;
        let ed = 0;
        for (let i = s; i < e; i++) {
          const p = x[i]!;
          const q = y[i]!;
          ea += p * p;
          eb += q * q;
          ed += (p - q) * (p - q);
        }
        const n = Math.max(1, e - s);
        au.levelA.push(toDb(Math.sqrt(ea / n)));
        au.levelB.push(toDb(Math.sqrt(eb / n)));
        au.diff.push(toDb(Math.sqrt(ed / n)));
        au.energyA += ea;
        au.energyDiff += ed;
        stft.diffFrame(x, y, Math.round((s + e) / 2) - half, au.spec, k * rows);
        au.count = k + 1;
      }
      sa.trimTo(boundary(k1) - half);
      sb.trimTo(Math.floor((boundary(k1) - half) * (sb.rate / rate)) - 2);
      const now = performance.now();
      if (now - lastProgress > PROGRESS_INTERVAL) {
        lastProgress = now;
        onProgress();
      }
      await yieldToUI();
    }
  } catch (e) {
    console.error(e);
    au.error = errorMessage(e);
  } finally {
    await Promise.allSettled([sa.close(), sb.close()]);
    au.done = true;
    onProgress();
  }
}

/** 聴くために読んだ区間。A と B は、A のサンプルレートにそろえる。 */
export interface AudioWindow {
  rate: number;
  a: Float32Array;
  b: Float32Array;
  /** A − B */
  d: Float32Array;
}

/** 動画の先頭から from 秒の位置から、seconds 秒ぶんの音声を、A / B / 差として読む。 */
export async function readWindow(a: VideoInfo, b: VideoInfo, from: number, seconds: number): Promise<AudioWindow> {
  const aa = a.audio;
  const ba = b.audio;
  if (!aa || !ba) throw new Error('音声がありません。');
  const rate = aa.rate;
  const n = Math.max(1, Math.round(seconds * rate));
  const to = from + seconds;
  const sa = new MonoStream(aa, a.first, from, from, to);
  const sb = new MonoStream(ba, b.first, from, from, to);
  try {
    await Promise.all([sa.fill(n), sb.fill(sb.indexFor(n, rate))]);
    const x = sa.read(0, n, rate);
    const y = sb.read(0, n, rate);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = x[i]! - y[i]!;
    return { rate, a: x, b: y, d };
  } finally {
    await Promise.allSettled([sa.close(), sb.close()]);
  }
}
