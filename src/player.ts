// 並べて再生: 複数の動画を、1本の共通タイムラインで同時に再生する。
// 共通の時刻 t を持ち、各動画の再生位置を「t − その動画の開始ズレ」に合わせる。

import './player.css';
import { byId } from './ui/dom';
import { bindWindowDrop } from './ui/dropzone';
import { clamp, formatTime, isVideoFile } from './lib/util';

/** コマ送りの幅（秒） */
const FRAME = 1 / 30;
/** 再生中に、これ以上ズレた動画だけ位置を合わせ直す（秒） */
const TOL = 0.2;
const LAYOUT_KEY = 'diffm-player-layout';
/** 動画の枠の見出しのおおよその高さ（px）。自動の並べ方の見積もりに使う */
const CAPTION_HEIGHT = 42;
const STAGE_GAP = 12;

type Layout = 'h' | 'v';
/** 並べ方の設定。auto は画面と動画の形から選ぶ */
type LayoutSetting = Layout | 'auto';

interface Clip {
  file: File;
  url: string;
  /** 開始ズレ（秒）。プラスで遅らせる */
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
  count: byId('pl-count'),
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
    const cellH = (layout === 'h' ? height : (height - STAGE_GAP * (n - 1)) / n) - CAPTION_HEIGHT;
    return ratios.reduce((sum, r) => sum + fittedArea(cellW, cellH, r), 0);
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
  el.count.textContent = `${n}本`;
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

/** 全クリップを共通の時刻 tl.t に合わせる。force なら、ズレの大小に関わらず位置を合わせ直す。 */
function applyTime(force: boolean): void {
  for (const c of clips) {
    const { video: v, duration: d } = c;
    if (!Number.isFinite(d)) continue;
    const target = tl.t - c.offset;
    const inRange = target >= 0 && target < d;
    if (tl.playing && inRange) {
      if (v.paused) {
        if (force || Math.abs(v.currentTime - target) > 0.05) v.currentTime = target;
        v.play().catch(onPlayBlocked);
      } else if (!v.seeking && Math.abs(v.currentTime - target) > TOL) {
        v.currentTime = target;
      }
    } else {
      if (!v.paused) v.pause();
      const pos = clamp(target, 0, d);
      if (force || (!v.seeking && Math.abs(v.currentTime - pos) > 0.03)) v.currentTime = pos;
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
  last = performance.now();
  applyTime(true);
  paintPlayState();
}

function pause(): void {
  tl.playing = false;
  for (const c of clips) c.video.pause();
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
  if (tl.playing) {
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
  offsetInput.setAttribute('aria-label', `${file.name} の開始位置（秒）`);
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
 * startAt（秒）を渡すと、全動画の読み込み後にその位置へ移る。
 */
export function addVideos(list: Iterable<File>, startAt?: number): void {
  const all = [...list];
  const files = all.filter(isVideoFile);
  if (!files.length) {
    toast('動画ファイルが見つかりませんでした。');
    return;
  }
  if (tl.playing) pause();
  for (const f of files) if (!clips.some((c) => c.file === f)) addClip(f);
  refreshStage();
  syncMuteUI();
  if (startAt !== undefined) {
    pendingStart = Math.max(0, startAt);
    applyPendingStart();
  }
  if (files.length < all.length) toast(`${all.length - files.length}件は動画ではないため無視しました。`);
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
    onDrop: (files) => addVideos(files),
  });
}

function bindKeys(): void {
  window.addEventListener('keydown', (e) => {
    if (!active || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (target?.closest('[role="tablist"]')) return;
    switch (e.key) {
      case ' ':
        if (tag === 'BUTTON') return;
        e.preventDefault();
        toggle();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seek(tl.t - (e.shiftKey ? 1 : 5));
        break;
      case 'ArrowRight':
        e.preventDefault();
        seek(tl.t + (e.shiftKey ? 1 : 5));
        break;
      case ',':
        step(-1);
        break;
      case '.':
        step(1);
        break;
      case 'Home':
        seek(0);
        break;
      case 'a':
      case 'A':
        setLayout('auto');
        break;
      case 'h':
      case 'H':
        setLayout('h');
        break;
      case 'v':
      case 'V':
        setLayout('v');
        break;
      case 'm':
      case 'M':
        toggleMuteAll();
        break;
    }
  });
}

export function initPlayer(): void {
  byId('pl-add').addEventListener('click', () => el.file.click());
  byId('pl-pick').addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => {
    addVideos(el.file.files ?? []);
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
