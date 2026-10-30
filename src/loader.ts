// 動画ファイルの読み込み（枠 A / B ごと）

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import { ui } from './ui/dom';
import { state, type Slot, type VideoInfo } from './types';
import { errorMessage, must, num } from './lib/util';
import { refreshWarnings, resetRun, setMeta, showError } from './ui/view';

// 1辺の上限（px）。これを超える動画はメモリ不足でタブが落ちうるため、読み込み時に拒否する。
const MAX_SIDE = 4096;

// 枠ごとの読み込み世代。新しいファイルが選ばれたら、古い読み込みの結果は捨てる。
const loadGen: Record<Slot, number> = { A: 0, B: 0 };

/**
 * 動画のメタデータを読む。isStale が真になったら中断して null を返す。
 * 失敗や中断のときは、開いた Input を閉じる。
 */
async function readVideoInfo(file: File, isStale: () => boolean): Promise<VideoInfo | null> {
  if (typeof VideoDecoder === 'undefined') {
    throw new Error('このブラウザは WebCodecs に対応していません。最新の Chrome / Edge / Safari / Firefox を使ってください。');
  }
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let keep = false;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (isStale()) return null;
    if (!track) throw new Error('映像トラックが見つかりません。');

    // 解像度は重い処理（全パケットの走査）の前に確かめる
    const [w, h] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
    if (isStale()) return null;
    if (!(w > 0 && h > 0)) throw new Error('解像度を読み取れません。');
    if (w > MAX_SIDE || h > MAX_SIDE) {
      throw new Error(`解像度 ${w}×${h} は上限（1辺 ${MAX_SIDE}px）を超えているため、比較できません。`);
    }

    const [codec, canDecode, first, duration, stats] = await Promise.all([
      track.getCodec(),
      track.canDecode(),
      track.getFirstTimestamp(),
      track.computeDuration(),
      track.computePacketStats(300),
    ]);
    if (isStale()) return null;
    if (!canDecode) {
      throw new Error(`このブラウザは ${codec ?? '不明な'} 形式の映像をデコードできません。`);
    }
    const fps = stats.averagePacketRate;
    if (!(fps > 0 && duration > 0)) throw new Error('フレームレートや長さを読み取れません。');

    keep = true;
    return { file, input, track, codec, w, h, fps, duration, first };
  } finally {
    if (!keep && !input.disposed) input.dispose();
  }
}

// 枠に出す先頭フレームの横幅の上限（px）。比較前の確認用なので、原寸は要らない。
const PREVIEW_WIDTH = 960;

/** 先頭フレームを枠のキャンバスに描く。確認用なので、失敗しても読み込み自体は成功のままにする。 */
async function drawPreview(slot: Slot, info: VideoInfo, isStale: () => boolean): Promise<void> {
  try {
    const sample = await new VideoSampleSink(info.track).getSample(info.first);
    if (!sample) return;
    try {
      if (isStale()) return;
      const canvas = ui.canvas[slot];
      const k = Math.min(1, PREVIEW_WIDTH / info.w);
      canvas.width = Math.max(2, Math.round(info.w * k));
      canvas.height = Math.max(2, Math.round(info.h * k));
      sample.draw(must(canvas.getContext('2d', { willReadFrequently: true })), 0, 0, canvas.width, canvas.height);
    } finally {
      sample.close();
    }
  } catch (e) {
    console.warn('先頭フレームを表示できませんでした', e);
  }
}

/** 枠 slot に動画を読み込む。結果は state と画面に反映する。 */
export async function setFile(slot: Slot, file: File): Promise<void> {
  if (state.running) return;
  const gen = ++loadGen[slot];
  const isStale = () => gen !== loadGen[slot];

  state[slot]?.input.dispose();
  state[slot] = null;
  resetRun();
  showError('');
  ui.fileName[slot].textContent = file.name;
  ui.slotRoot[slot].classList.add('loaded');
  setMeta(slot, '読み込み中…');
  refreshWarnings();

  try {
    const info = await readVideoInfo(file, isStale);
    if (!info) return;
    state[slot] = info;
    await drawPreview(slot, info, isStale);
    if (isStale()) return;
    setMeta(slot, `${info.w}×${info.h} · ${num(info.fps)} fps · ${num(info.duration)} 秒 · ${info.codec ?? '不明'}`);
  } catch (e) {
    if (isStale()) return;
    console.error(e);
    setMeta(slot, errorMessage(e), true);
  }
  refreshWarnings();
}
