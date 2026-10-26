// 2本のフレーム列（非同期イテレータ）を1フレームずつ対応づける。
// sample は { timestamp, duration, close() } を持つ。
// 所有権: sample はこの関数が close する。呼び出し側が使えるのは、次の反復に進むまで。
// シークは使わず、先頭から順にデコードするだけなので、フレームはずれない。

async function releaseIterators(itA, itB) {
  await Promise.allSettled([itA.return?.(), itB.return?.()]);
}

/** フレーム番号で対応づける（A の n 番目 ↔ B の n 番目）。どちらかが尽きたら終了。 */
export async function* pairByIndex(itA, itB) {
  let index = 0;
  let a = null;
  let b = null;
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
export async function* pairByTime(itA, itB, offA = 0, offB = 0) {
  let index = 0;
  let a = null;
  let bCur = null;
  let bNext = null;
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
