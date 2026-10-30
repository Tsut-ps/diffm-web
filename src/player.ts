// 並べて再生: 複数の動画を、1本の共通タイムラインで同時に再生する。
// 共通の時刻 t を持ち、各動画の再生位置を「t − その動画の開始オフセット」に合わせる。

import './player.css';
import { byId } from './ui/dom';
import { bindWindowDrop } from './ui/dropzone';
import { clamp, formatTime, isVideoFile } from './lib/util';

/** コマ送りの幅（秒） */
const FRAME = 1 / 30;
/** Shift を押しながらの ← → で動く幅（秒） */
const SKIP = 5;
/** 再生中に、これ以上ズレた動画は、位置を合わせ直す（秒）。カクつくので、大きなズレだけにする */
const TOL = 0.2;
/** これ以下のズレは、補正しない（秒）。1コマ ≒ 0.033 */
const DEAD_ZONE = 0.03;
/** DEAD_ZONE〜TOL のズレは、再生速度を少し変えて解消する。速度の変え幅の上限（±15%） */
const NUDGE_MAX = 0.15;
/** ズレを、おおよそこの秒数で解消する強さにする */
const NUDGE_SPAN = 0.5;
/** 再生を始めてから、全動画が動き出すのを待つ上限（ms）。超えたら待たずに時計を進める */
const START_TIMEOUT = 1500;
const LAYOUT_KEY = 'diffm-player-layout';
/** 動画の枠の見出し（上に置くとき）のおおよその高さ（px）。自動の並べ方の見積もりに使う */
const CAPTION_HEIGHT = 42;
/** 横長の枠では、見出しを左の縦タブにする。その判定（幅 / 高さ）と、縦タブの幅（px）。player.css と合わせる */
const STRIP_ASPECT = 3 / 2;
const STRIP_WIDTH = 41;
const STAGE_GAP = 12;

type Layout = 'h' | 'v';
/** 並べ方の設定。auto は画面と動画の形から選ぶ */
type LayoutSetting = Layout | 'auto';

interface Clip {
  file: File;
  url: string;
  /** 開始オフセット（秒）。プラスで遅らせる */
  offset: number;
  /** 長さ（秒）。メタデータを読むまで NaN */
  duration: number;
  /** 縦横比（幅 / 高さ）。メタデータを読むまでは 16:9 とみなす */
  ratio: number;
  muted: boolean;
  tile: HTMLElement;
  video: HTMLVideoElement;
  muteBtn: HTMLButtonElement;
}

const el = {
  wrap: byId('pl-wrap'),
  stage: byId('pl-stage'),
  cta: byId('pl-cta'),
  file: byId<HTMLInputElement>('pl-file'),
  layAuto: byId<HTMLButtonElement>('pl-layAuto'),
  layH: byId<HTMLButtonElement>('pl-layH'),
  layV: byId<HTMLButtonElement>('pl-layV'),
  back: byId<HTMLButtonElement>('pl-back'),
  play: byId<HTMLButtonElement>('pl-play'),
  fwd: byId<HTMLButtonElement>('pl-fwd'),
  cur: byId('pl-cur'),
  tot: byId('pl-tot'),
  scrub: byId<HTMLInputElement>('pl-scrub'),
  rate: byId<HTMLSelectElement>('pl-rate'),
  loop: byId<HTMLButtonElement>('pl-loop'),
  muteAll: byId<HTMLButtonElement>('pl-muteAll'),
  veil: byId('pl-veil'),
  toast: byId('pl-toast'),
  tile: byId<HTMLTemplateElement>('pl-tile'),
};

const clips: Clip[] = [];
const tl = { t: 0, total: 0, playing: false, rate: 1, loop: false };

let layoutSetting: LayoutSetting = 'auto';
/** 動画の読み込みが終わったら移る位置（秒）。指定がなければ null */
let pendingStart: number | null = null;
let active = false;
let raf = 0;
let last = 0;
/**
 * 再生を始めて、全動画が動き出すのを待っている間だけ、始めた時刻を持つ（待っている間、時計は止める）。
 * シーク直後は、動画ごとに動き出すまでの時間が違う（キーフレームの間隔が長い動画ほど遅い）。
 * 時計だけ先に進めると、遅れて動き出した動画は、その分だけずっと遅れる。
 */
let startedAt: number | null = null;
let scrubbing = false;
let resumeAfterScrub = false;
let shownTime = '';
let toastTimer = 0;

function toast(msg: string): void {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), 3600);
}

// ---------- 並べ方 ----------

/** 幅 w × 高さ h の枠に、縦横比 ratio の動画を収めたときの面積 */
function fittedArea(w: number, h: number, ratio: number): number {
  const fitW = Math.max(0, Math.min(w, h * ratio));
  return fitW * (fitW / ratio);
}

/** 動画が大きく映るほうを選ぶ（画面の形、動画の本数と縦横比から見積もる）。 */
function autoLayout(): Layout {
  const { width, height } = el.wrap.getBoundingClientRect();
  if (width <= 0 || height <= 0) return 'h';
  const n = Math.max(clips.length, 2);
  const ratios = clips.length ? clips.map((c) => c.ratio) : [16 / 9];
  const score = (layout: Layout): number => {
    const cellW = layout === 'h' ? (width - STAGE_GAP * (n - 1)) / n : width;
    const cellH = layout === 'h' ? height : (height - STAGE_GAP * (n - 1)) / n;
    // 横長の枠は見出しが左の縦タブ（幅を使う）、そうでなければ上（高さを使う）
    const [videoW, videoH] =
      cellW / cellH >= STRIP_ASPECT ? [cellW - STRIP_WIDTH, cellH] : [cellW, cellH - CAPTION_HEIGHT];
    return ratios.reduce((sum, r) => sum + fittedArea(videoW, videoH, r), 0);
  };
  return score('v') > score('h') ? 'v' : 'h';
}

/** 設定から実際の並べ方を決めて、舞台とボタンに反映する。 */
function applyLayout(): void {
  el.stage.dataset.layout = layoutSetting === 'auto' ? autoLayout() : layoutSetting;
  el.layAuto.setAttribute('aria-pressed', String(layoutSetting === 'auto'));
  el.layH.setAttribute('aria-pressed', String(layoutSetting === 'h'));
  el.layV.setAttribute('aria-pressed', String(layoutSetting === 'v'));
}

function setLayout(setting: LayoutSetting): void {
  layoutSetting = setting;
  applyLayout();
  try {
    localStorage.setItem(LAYOUT_KEY, setting);
  } catch {
    // 保存できなくても動く
  }
}

function savedLayout(): LayoutSetting {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'h' || v === 'v' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function refreshStage(): void {
  const n = clips.length;
  const empty = n === 0;
  el.stage.style.setProperty('--n', String(n || 1));
  el.cta.hidden = !empty;
  applyLayout();
  for (const b of [el.play, el.scrub, el.rate, el.loop, el.muteAll, el.back, el.fwd]) b.disabled = empty;
}

// ---------- タイムライン ----------

function recomputeTotal(): void {
  let total = 0;
  for (const c of clips) if (Number.isFinite(c.duration)) total = Math.max(total, c.duration + c.offset);
  tl.total = total;
  tl.t = clamp(tl.t, 0, total);
  el.scrub.max = String(Math.max(1, Math.round(total * 1000)));
  el.tot.textContent = formatTime(total);
}

function onPlayBlocked(err: unknown): void {
  if (err instanceof DOMException && err.name === 'AbortError') return;
  if (tl.playing) {
    pause();
    toast('再生を始められませんでした。もう一度、再生ボタンを押してください。');
  }
}

/** 再生速度を、設定の速度に戻す（補正で変えたものを戻す）。 */
function restoreRates(): void {
  for (const c of clips) if (c.video.playbackRate !== tl.rate) c.video.playbackRate = tl.rate;
}

/** drift（動画の位置 − 合わせたい位置。プラスなら進みすぎ）を、再生速度を少し変えて解消する。 */
function nudgeRate(v: HTMLVideoElement, drift: number): void {
  const adjust = Math.abs(drift) <= DEAD_ZONE ? 0 : clamp(-drift / NUDGE_SPAN, -NUDGE_MAX, NUDGE_MAX);
  const rate = tl.rate * (1 + adjust);
  if (v.playbackRate !== rate) v.playbackRate = rate;
}

/** 出番（開始オフセットを引いた位置が、動画の長さの中）にあるか。 */
const inRange = (c: Clip): boolean => {
  const target = tl.t - c.offset;
  return target >= 0 && target < c.duration;
};

/** 出番にある動画が、すべて実際に動き出したか。 */
function allRunning(): boolean {
  return clips.every((c) => {
    const v = c.video;
    return !inRange(c) || (!v.paused && !v.seeking && v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
  });
}

/** 全クリップを共通の時刻 tl.t に合わせる。force なら、ズレの大小に関わらず位置を合わせ直す。 */
function applyTime(force: boolean): void {
  for (const c of clips) {
    const { video: v, duration: d } = c;
    if (!Number.isFinite(d)) continue;
    const target = tl.t - c.offset;
    if (tl.playing && inRange(c)) {
      if (v.paused) {
        if (force || Math.abs(v.currentTime - target) > 0.05) v.currentTime = target;
        v.play().catch(onPlayBlocked);
      } else if (!v.seeking) {
        const drift = v.currentTime - target;
        if (Math.abs(drift) > TOL) {
          v.currentTime = target;
          v.playbackRate = tl.rate;
        } else {
          nudgeRate(v, drift);
        }
      }
    } else {
      if (!v.paused) v.pause();
      // シーク中に重ねて指示すると、キーフレームの間隔が長い動画ほど描画が追いつかず、動画ごとにずれて見える。
      // シークが終わるまで待ち、終わったら最新の位置へ移る（seeked で呼び直す）
      const pos = clamp(target, 0, d);
      if (!v.seeking && (force || Math.abs(v.currentTime - pos) > DEAD_ZONE)) v.currentTime = pos;
    }
  }
}

function seek(t: number): void {
  tl.t = clamp(t, 0, tl.total);
  applyTime(true);
}

function paintPlayState(): void {
  el.play.setAttribute('aria-pressed', String(tl.playing));
}

function play(): void {
  if (!clips.length) return;
  if (tl.total <= 0) {
    toast('動画を読み込んでいます。少し待ってください。');
    return;
  }
  if (tl.t >= tl.total - 0.02) tl.t = 0;
  tl.playing = true;
  startedAt = performance.now();
  applyTime(true);
  paintPlayState();
}

function pause(): void {
  tl.playing = false;
  startedAt = null;
  for (const c of clips) c.video.pause();
  restoreRates();
  applyTime(true); // 止めた位置を全員そろえる
  paintPlayState();
}

const toggle = (): void => (tl.playing ? pause() : play());

function step(dir: 1 | -1): void {
  if (!clips.length) return;
  if (tl.playing) pause();
  seek(tl.t + dir * FRAME);
}

function tick(now: number): void {
  // 全動画が動き出すまで、時計は進めない
  if (tl.playing && startedAt !== null && (allRunning() || now - startedAt > START_TIMEOUT)) {
    startedAt = null;
    last = now;
  }
  if (tl.playing && startedAt === null) {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    tl.t += dt * tl.rate;
    if (tl.t >= tl.total) {
      if (tl.loop && tl.total > 0) {
        tl.t = 0;
        applyTime(true);
      } else {
        tl.t = tl.total;
        pause();
      }
    } else {
      applyTime(false);
    }
  }
  const text = formatTime(tl.t);
  if (text !== shownTime) {
    shownTime = text;
    el.cur.textContent = text;
  }
  if (!scrubbing) el.scrub.value = String(Math.round(tl.t * 1000));
  el.scrub.style.setProperty('--p', tl.total > 0 ? String((tl.t / tl.total) * 100) : '0');
  raf = requestAnimationFrame(tick);
}

/** タブの表示に合わせて、時計を動かす / 止める。隠れるときは再生も止める。 */
export function setPlayerActive(on: boolean): void {
  if (on === active) return;
  active = on;
  if (on) {
    raf = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(raf);
    if (tl.playing) pause();
  }
}

// ---------- 動画 ----------

function syncMuteUI(): void {
  for (const c of clips) {
    c.video.muted = c.muted;
    c.muteBtn.setAttribute('aria-pressed', String(c.muted));
  }
  el.muteAll.setAttribute('aria-pressed', String(clips.length > 0 && clips.every((c) => c.muted)));
}

function addClip(file: File): void {
  const tile = el.tile.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const video = tile.querySelector('video')!;
  const offsetInput = tile.querySelector<HTMLInputElement>('.shift input')!;
  const nameEl = tile.querySelector<HTMLElement>('.name')!;
  const clip: Clip = {
    file,
    url: URL.createObjectURL(file),
    offset: 0,
    duration: NaN,
    ratio: 16 / 9,
    muted: clips.length > 0, // 音は最初の1本だけ
    tile,
    video,
    muteBtn: tile.querySelector<HTMLButtonElement>('.mute')!,
  };
  nameEl.textContent = file.name;
  nameEl.title = file.name;
  offsetInput.setAttribute('aria-label', `${file.name} の開始オフセット（秒）`);
  video.muted = clip.muted;
  video.playbackRate = tl.rate;
  video.src = clip.url;

  video.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(video.duration)) {
      toast(`「${file.name}」の長さを読み取れませんでした。`);
      removeClip(clip);
      return;
    }
    clip.duration = video.duration;
    if (video.videoWidth > 0 && video.videoHeight > 0) clip.ratio = video.videoWidth / video.videoHeight;
    recomputeTotal();
    applyLayout();
    applyTime(true);
    applyPendingStart();
  });
  // 止まっているときは、シーク中の指示を待たせているので、終わったら最新の位置へ移る
  video.addEventListener('seeked', () => {
    if (!tl.playing) applyTime(false);
  });
  video.addEventListener('error', () => {
    toast(`「${file.name}」はこのブラウザで再生できない形式です。`);
    removeClip(clip);
  });
  offsetInput.addEventListener('input', () => {
    const x = parseFloat(offsetInput.value);
    clip.offset = Number.isFinite(x) ? x : 0;
    recomputeTotal();
    applyTime(true);
  });
  clip.muteBtn.addEventListener('click', () => {
    clip.muted = !clip.muted;
    syncMuteUI();
  });
  tile.querySelector('.rm')!.addEventListener('click', () => removeClip(clip));

  clips.push(clip);
  el.stage.append(tile);
}

function removeClip(clip: Clip): void {
  const i = clips.indexOf(clip);
  if (i < 0) return;
  clip.video.pause();
  clip.video.removeAttribute('src');
  clip.video.load();
  URL.revokeObjectURL(clip.url);
  clip.tile.remove();
  clips.splice(i, 1);
  recomputeTotal();
  refreshStage();
  syncMuteUI();
  if (!clips.length || tl.total <= 0) {
    if (tl.playing) pause();
    tl.t = 0;
  }
  applyTime(true);
  applyPendingStart();
}

/** 読み込み待ちの開始位置があり、全動画の長さが分かったら、そこへ移る。 */
function applyPendingStart(): void {
  if (pendingStart === null || !clips.every((c) => Number.isFinite(c.duration))) return;
  const t = pendingStart;
  pendingStart = null;
  seek(t);
}

/**
 * 動画を追加する。同じファイルが既にあれば足さない。動画でないものは無視して知らせる。
 * startAt（秒）を渡すと、新しく足したときだけ、全動画の読み込み後にその位置へ移る。
 * 足した本数を返す。
 */
export function addVideos(list: Iterable<File>, startAt?: number): number {
  const all = [...list];
  const files = all.filter(isVideoFile);
  if (!files.length) {
    toast('動画ファイルが見つかりませんでした。');
    return 0;
  }
  const fresh = files.filter((f) => !clips.some((c) => c.file === f));
  if (fresh.length === 0) return 0;
  if (tl.playing) pause();
  for (const f of fresh) addClip(f);
  refreshStage();
  syncMuteUI();
  if (startAt !== undefined) {
    pendingStart = Math.max(0, startAt);
    applyPendingStart();
  }
  if (files.length < all.length) toast(`${all.length - files.length}件は動画ではないため無視しました。`);
  return fresh.length;
}

/** 動画をすべて外して、動画のない最初の状態に戻す（再生速度やループなどの設定は残す）。 */
export function resetPlayer(): void {
  for (const c of [...clips]) removeClip(c);
  pendingStart = null;
}

// 利用者が動画を入れたときに呼ぶ（比較で読み込んだ動画を自動で入れたときは呼ばない）
let onUserAdd: () => void = () => {};

function addByUser(files: Iterable<File>): void {
  if (addVideos(files) > 0) onUserAdd();
}

// ---------- 操作 ----------

function toggleMuteAll(): void {
  if (!clips.length) return;
  const muted = !clips.every((c) => c.muted);
  for (const c of clips) c.muted = muted;
  syncMuteUI();
}

function bindDrop(): void {
  bindWindowDrop({
    enabled: () => active,
    onActive: (on) => (el.veil.hidden = !on),
    onDrop: addByUser,
  });
}

function bindKeys(): void {
  window.addEventListener('keydown', (e) => {
    if (!active || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    const tag = target?.tagName;
    // 入力欄と選択欄では、その部品の操作を優先する。再生位置のバーは、ここで扱う（1ミリ秒刻みでは動かさない）
    if ((tag === 'INPUT' && target !== el.scrub) || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (target?.closest('[role="tablist"]')) return;
    // 一般的な最低限のキー: Space 再生 / ← → 1コマ（Shift で5秒）/ Home End 先頭・末尾 / M ミュート
    switch (e.key) {
      case ' ':
        if (tag === 'BUTTON') return; // ボタンの Space は、そのボタンの押下
        e.preventDefault();
        toggle();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) seek(tl.t - SKIP);
        else step(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) seek(tl.t + SKIP);
        else step(1);
        break;
      case 'Home':
        e.preventDefault();
        seek(0);
        break;
      case 'End':
        e.preventDefault();
        seek(tl.total);
        break;
      case 'm':
      case 'M':
        toggleMuteAll();
        break;
    }
  });
}

/** onVideosAdded: 利用者が動画を入れたときに呼ぶ（隣のタブのリセットに使う）。 */
export function initPlayer(onVideosAdded: () => void): void {
  onUserAdd = onVideosAdded;
  byId('pl-add').addEventListener('click', () => el.file.click());
  byId('pl-pick').addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => {
    addByUser(el.file.files ?? []);
    el.file.value = '';
  });
  el.layAuto.addEventListener('click', () => setLayout('auto'));
  el.layH.addEventListener('click', () => setLayout('h'));
  el.layV.addEventListener('click', () => setLayout('v'));

  el.play.addEventListener('click', toggle);
  el.back.addEventListener('click', () => step(-1));
  el.fwd.addEventListener('click', () => step(1));

  // つまみを動かしている間は止めて、離したら元に戻す
  el.scrub.addEventListener('pointerdown', () => {
    scrubbing = true;
    resumeAfterScrub = tl.playing;
    if (resumeAfterScrub) pause();
  });
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (resumeAfterScrub) play();
    resumeAfterScrub = false;
  };
  window.addEventListener('pointerup', endScrub);
  window.addEventListener('pointercancel', endScrub);
  el.scrub.addEventListener('input', () => seek(Number(el.scrub.value) / 1000));

  el.rate.addEventListener('change', () => {
    tl.rate = Number(el.rate.value) || 1;
    for (const c of clips) c.video.playbackRate = tl.rate;
  });
  el.loop.addEventListener('click', () => {
    tl.loop = !tl.loop;
    el.loop.setAttribute('aria-pressed', String(tl.loop));
  });
  el.muteAll.addEventListener('click', toggleMuteAll);

  bindDrop();
  bindKeys();
  // タブが隠れるとコマ送りが止まるので、先に止めて位置をそろえる
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && tl.playing) pause();
  });

  // 窓の大きさが変わったら、自動の並べ方を選び直す（隠れているタブが表示されたときも呼ばれる）
  new ResizeObserver(applyLayout).observe(el.wrap);

  layoutSetting = savedLayout();
  refreshStage();
  recomputeTotal();
}
