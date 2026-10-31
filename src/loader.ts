// 動画ファイルの読み込み（枠 A / B ごと）

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import { ui } from './ui/dom';
import { state, type Slot, type VideoInfo } from './types';
import { channelLabel, errorMessage, khz, must, num } from './lib/util';
import { refreshWarnings, resetRun, setMeta, showError } from './ui/view';

// 1辺の上限（px）。これを超える動画はメモリ不足でタブが落ちうるため、読み込み時に拒否する。
const MAX_SIDE = 4096;

// 枠ごとの読み込み世代。新しいファイルが選ばれたら、古い読み込みの結果は捨てる。
const loadGen: Record<Slot, number> = { A: 0, B: 0 };

/** 音声のメタデータを読む。音声が無い・読めなくても、動画の読み込みは失敗にしない（理由を audioNote に入れる）。 */
async function readAudioInfo(input: Input, first: number): Promise<Pick<VideoInfo, 'audio' | 'audioNote'>> {
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { audio: null, audioNote: '音声なし' };
    const [codec, canDecode, rate, channels, end] = await Promise.all([
      track.getCodec(),
      track.canDecode(),
      track.getSampleRate(),
      track.getNumberOfChannels(),
      track.computeDuration(),
    ]);
    if (!canDecode) return { audio: null, audioNote: `音声は非対応（${codec ?? '不明'}）` };
    return { audio: { track, codec, rate, channels, duration: Math.max(0, end - first) }, audioNote: '' };
  } catch (e) {
    console.warn('音声を読み取れませんでした', e);
    return { audio: null, audioNote: '音声は読み取れません' };
  }
}

/** 映像のないファイル（音声だけ）の情報。音声も読めなければ、読み込みの失敗にする。 */
async function readAudioOnlyInfo(file: File, input: Input): Promise<VideoInfo> {
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('映像も音声も見つかりません。');
  const first = await track.getFirstTimestamp();
  const { audio, audioNote } = await readAudioInfo(input, first);
  if (!audio) throw new Error(`${audioNote}。`);
  return { file, input, track: null, codec: null, w: 0, h: 0, fps: 0, duration: audio.duration, first, audio, audioNote: '' };
}

/**
 * 動画（映像がなければ、音声だけのファイル）のメタデータを読む。isStale が真になったら中断して null を返す。
 * 失敗や中断のときは、開いた Input を閉じる。
 */
async function readVideoInfo(file: File, isStale: () => boolean): Promise<VideoInfo | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let keep = false;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (isStale()) return null;
    if (!track) {
      const audioOnly = await readAudioOnlyInfo(file, input);
      if (isStale()) return null;
      keep = true;
      return audioOnly;
    }
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('このブラウザは WebCodecs に対応していません。最新の Chrome / Edge / Safari / Firefox を使ってください。');
    }

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

    const { audio, audioNote } = await readAudioInfo(input, first);
    if (isStale()) return null;

    keep = true;
    return { file, input, track, codec, w, h, fps, duration, first, audio, audioNote };
  } finally {
    if (!keep && !input.disposed) input.dispose();
  }
}

// 枠に出す先頭フレームの横幅の上限（px）。比較前の確認用なので、原寸は要らない。
const PREVIEW_WIDTH = 960;

/** 先頭フレームを枠のキャンバスに描く。確認用なので、失敗しても読み込み自体は成功のままにする。 */
async function drawPreview(slot: Slot, info: VideoInfo, isStale: () => boolean): Promise<void> {
  if (!info.track) return; // 音声だけのファイルには、絵がない
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

// 空の枠に出ている案内の文言（HTML にある初期の文言を、そのまま使う）
const emptyName: Record<Slot, string> = {
  A: ui.fileName.A.textContent ?? '',
  B: ui.fileName.B.textContent ?? '',
};

/** 枠 slot を空に戻す。読み込み中のものがあれば、その結果は捨てる。 */
export function clearFile(slot: Slot): void {
  loadGen[slot]++;
  state[slot]?.input.dispose();
  state[slot] = null;
  ui.fileName[slot].textContent = emptyName[slot];
  ui.slotRoot[slot].classList.remove('loaded', 'audio-only');
  setMeta(slot, '');
  // 幅を変えると、描いてあった絵も消える
  ui.canvas[slot].width = 16;
  ui.canvas[slot].height = 9;
  resetRun();
  showError('');
  refreshWarnings();
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
  ui.slotRoot[slot].classList.remove('audio-only');
  // 前の動画の絵を残さない（失敗したときに、別の動画が映ったままにならないように）。幅を変えると、絵が消える
  ui.canvas[slot].width = 16;
  ui.canvas[slot].height = 9;
  setMeta(slot, '読み込み中…');
  refreshWarnings();

  try {
    const info = await readVideoInfo(file, isStale);
    if (!info) return;
    state[slot] = info;
    ui.slotRoot[slot].classList.toggle('audio-only', !info.track);
    await drawPreview(slot, info, isStale);
    if (isStale()) return;
    const sound = info.audio
      ? `${info.audio.codec ?? '不明'} ${khz(info.audio.rate)} ${channelLabel(info.audio.channels)}`
      : info.audioNote;
    // 映像と音声を 2 行に分ける（1 行にすると、枠の幅に収まらない）
    const video = info.track
      ? `${info.w}×${info.h} · ${num(info.fps)} fps · ${num(info.duration)} 秒 · ${info.codec ?? '不明'}`
      : `音声のみ · ${num(info.duration)} 秒`;
    setMeta(slot, `${video}\n${sound}`);
  } catch (e) {
    if (isStale()) return;
    console.error(e);
    setMeta(slot, errorMessage(e), true);
  }
  refreshWarnings();
}
