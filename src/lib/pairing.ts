// 2本のフレーム列（非同期イテレータ）を1フレームずつ対応づける。
// 所有権: sample はこの関数が close する。呼び出し側が使えるのは、次の反復に進むまで。
// シークは使わず、先頭から順にデコードするだけなので、フレームはずれない。

/** 対応づけの対象。mediabunny の VideoSample がこの形を満たす。 */
export interface FrameSample {
  timestamp: number;
  duration: number;
  close(): void;
}

export interface FramePair<T extends FrameSample> {
  index: number;
  a: T;
  b: T;
}

async function releaseIterators(itA: AsyncIterator<unknown>, itB: AsyncIterator<unknown>): Promise<void> {
  await Promise.allSettled([itA.return?.(), itB.return?.()]);
}

/** フレーム番号で対応づける（A の n 番目 ↔ B の n 番目）。どちらかが尽きたら終了。 */
export async function* pairByIndex<T extends FrameSample>(
  itA: AsyncIterator<T>,
  itB: AsyncIterator<T>,
): AsyncGenerator<FramePair<T>, void, undefined> {
  let index = 0;
  let a: T | null = null;
  let b: T | null = null;
  try {
    while (true) {
      const [ra, rb] = await Promise.all([itA.next(), itB.next()]);
      a = ra.done ? null : ra.value;
      b = rb.done ? null : rb.value;
      if (!a || !b) return;
      yield { index: index++, a, b };
      a.close();
      b.close();
      a = b = null;
    }
  } finally {
    a?.close();
    b?.close();
    await releaseIterators(itA, itB);
  }
}

/**
 * 時刻（秒）で対応づける。A の各フレームに、その時刻に表示されている B のフレーム
 * （開始時刻が A の時刻以前で最新のもの）を当てる。プレーヤーで見える絵と同じ規則。
 * fps が違うとき用。B のフレームは重複したり、飛ばされたりする。
 * タイムスタンプの丸め（mkv/webm のミリ秒など）を吸収するため、フレーム長の 1/4 だけ許容する。
 * offA / offB は各動画の先頭タイムスタンプ（開始オフセットを揃えるため）。
 */
export async function* pairByTime<T extends FrameSample>(
  itA: AsyncIterator<T>,
  itB: AsyncIterator<T>,
  offA = 0,
  offB = 0,
): AsyncGenerator<FramePair<T>, void, undefined> {
  let index = 0;
  let a: T | null = null;
  let bCur: T | null = null;
  let bNext: T | null = null;
  try {
    const first = await itB.next();
    if (first.done) return;
    bCur = first.value;
    const second = await itB.next();
    bNext = second.done ? null : second.value;

    while (true) {
      const ra = await itA.next();
      if (ra.done) return;
      a = ra.value;
      const tA = a.timestamp - offA;
      const eps = 0.25 * (a.duration || bCur.duration || 0);

      while (bNext && bNext.timestamp - offB <= tA + eps) {
        bCur.close();
        bCur = bNext;
        const r = await itB.next();
        bNext = r.done ? null : r.value;
      }

      // B が尽きていて、A の時刻が B の終端を過ぎたら終了
      if (!bNext && tA >= bCur.timestamp - offB + (bCur.duration || 0) - 1e-9) return;

      yield { index: index++, a, b: bCur };
      a.close();
      a = null;
    }
  } finally {
    a?.close();
    bCur?.close();
    bNext?.close();
    await releaseIterators(itA, itB);
  }
}
