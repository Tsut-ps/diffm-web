// 音声の差の計算（DOM にも mediabunny にも依存しない純粋関数）

/** 1秒あたりの分析の列数。グラフの 1 目盛りは 1/HOP_RATE 秒 */
export const HOP_RATE = 30;
/** 音量のグラフの下端（dBFS）。16 ビット音声の下限に合わせる */
export const DB_MIN = -96;
/** スペクトログラムで、これより小さい成分は無いものとして扱う（dBFS）。微小なノイズの差を、差として出さないため */
export const SPEC_FLOOR_DB = -90;
/** スペクトログラムの周波数の行数（対数の軸） */
export const SPEC_ROWS = 96;

/** 実効値（RMS）を dBFS にする。0 や下限以下は DB_MIN。 */
export const toDb = (rms: number): number => (rms > 0 ? Math.max(DB_MIN, 20 * Math.log10(rms)) : DB_MIN);

/** 基数 2 の FFT（その場で変換）。 */
export class Fft {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error('FFT の大きさは 2 のべき乗にしてください。');
    this.size = size;
    const half = size / 2;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / size);
      this.sin[k] = Math.sin((2 * Math.PI * k) / size);
    }
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
  }

  /** 複素数列 (re, im) を、順変換する。 */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k]!;
          const wi = -this.sin[k]!;
          const a = i + j;
          const b = a + half;
          const tr = re[b]! * wr - im[b]! * wi;
          const ti = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  }
}

/** 周波数の帯（対数の軸）。lo / hi は、FFT のビン番号（小数）での範囲。 */
export interface Bands {
  fMin: number;
  fMax: number;
  rows: number;
  lo: Float64Array;
  hi: Float64Array;
}

export function makeBands(rate: number, fftSize: number, rows = SPEC_ROWS): Bands {
  const fMax = Math.min(20000, (rate / 2) * 0.98);
  const fMin = Math.min(50, fMax / 8);
  const binHz = rate / fftSize;
  const lo = new Float64Array(rows);
  const hi = new Float64Array(rows);
  const edge = (k: number) => fMin * (fMax / fMin) ** (k / rows);
  for (let r = 0; r < rows; r++) {
    lo[r] = edge(r) / binHz;
    hi[r] = edge(r + 1) / binHz;
  }
  return { fMin, fMax, rows, lo, hi };
}

/**
 * 2 つの音を短時間フーリエ変換して、帯ごとの音量（dB）の差（B − A）を求める。
 * 実数の信号 2 本を、実部と虚部に入れた 1 回の FFT で同時に変換する。
 */
export class Stft {
  readonly size: number;
  readonly bands: Bands;
  private readonly fft: Fft;
  private readonly win: Float64Array;
  /** 窓の合計。振幅を、フルスケールの正弦波 = 0 dB にそろえるために使う */
  private readonly norm: number;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly pa: Float64Array;
  private readonly pb: Float64Array;
  private readonly ba: Float64Array;
  private readonly bb: Float64Array;

  constructor(rate: number) {
    // 窓は、約 40ms（2 のべき乗に切り上げる）
    this.size = Math.min(4096, 2 ** Math.ceil(Math.log2(rate * 0.04)));
    const n = this.size;
    this.fft = new Fft(n);
    this.bands = makeBands(rate, n);
    this.win = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); // Hann
      sum += this.win[i]!;
    }
    this.norm = 4 / (sum * sum);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.pa = new Float64Array(n / 2 + 1);
    this.pb = new Float64Array(n / 2 + 1);
    this.ba = new Float64Array(this.bands.rows);
    this.bb = new Float64Array(this.bands.rows);
  }

  /**
   * a と b の [start, start + size) の区間の、帯ごとの dB の差（B − A）を out[offset ..] に書く。
   * 範囲の外は、無音として扱う。
   */
  diffFrame(a: Float32Array, b: Float32Array, start: number, out: Int8Array, offset: number): void {
    const { size: n, re, im, win } = this;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      const w = win[i]!;
      re[i] = idx >= 0 && idx < a.length ? a[idx]! * w : 0;
      im[i] = idx >= 0 && idx < b.length ? b[idx]! * w : 0;
    }
    this.fft.transform(re, im);
    const half = n / 2;
    for (let k = 0; k <= half; k++) {
      const m = k === 0 ? 0 : n - k;
      const zr = re[k]!;
      const zi = im[k]!;
      const wr = re[m]!;
      const wi = im[m]!;
      this.pa[k] = ((zr + wr) ** 2 + (zi - wi) ** 2) * 0.25;
      this.pb[k] = ((zi + wi) ** 2 + (wr - zr) ** 2) * 0.25;
    }
    bandPower(this.pa, this.bands, this.ba);
    bandPower(this.pb, this.bands, this.bb);
    for (let r = 0; r < this.bands.rows; r++) {
      const da = Math.max(SPEC_FLOOR_DB, 10 * Math.log10(this.ba[r]! * this.norm + 1e-12));
      const db = Math.max(SPEC_FLOOR_DB, 10 * Math.log10(this.bb[r]! * this.norm + 1e-12));
      out[offset + r] = Math.max(-127, Math.min(127, Math.round(db - da)));
    }
  }
}

/** パワースペクトル p（ビン 0 〜 size/2）を、帯ごとの平均パワーにする。帯がビンより細かいときは、補間する。 */
function bandPower(p: Float64Array, bands: Bands, out: Float64Array): void {
  const last = p.length - 1;
  for (let r = 0; r < bands.rows; r++) {
    const lo = bands.lo[r]!;
    const hi = bands.hi[r]!;
    if (hi - lo >= 1) {
      const i0 = Math.ceil(lo);
      const i1 = Math.min(last, Math.floor(hi));
      let s = 0;
      for (let i = i0; i <= i1; i++) s += p[i]!;
      out[r] = s / (i1 - i0 + 1);
    } else {
      const c = Math.min(last, (lo + hi) / 2);
      const i = Math.floor(c);
      const f = c - i;
      out[r] = p[i]! * (1 - f) + p[Math.min(last, i + 1)]! * f;
    }
  }
}
