import { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from './vendor/mediabunny.min.mjs';
import { pairByIndex, pairByTime } from './pairing.js';
import { meanLumaDiff, renderDiff, findRanges, resolveMode, compareInfo } from './diff.js';
import { drawChart, pickIndex } from './chart.js';
import { makeZip } from './zip.js';

const $ = (id) => document.getElementById(id);
const MAX_LISTED = 200;
// 1辺の上限（px）。これを超える動画はメモリ不足でタブが落ちうるため、読み込み時に拒否する。
const MAX_SIDE = 4096;

const state = {
  A: null, // { file, input, track, codec, w, h, fps, duration, first }
  B: null,
  running: false,
  stop: false,
  run: null, // { vals, tsA, tsB, qA, qB, w, h, sinkA, sinkB, mode, gain, expected, selected, hover, layout, finished }
};

const els = {
  canvases: { A: $('cA'), B: $('cB'), D: $('cD') },
  chart: $('chart'),
};

// ---------- 小さなユーティリティ ----------

const fmt = new Intl.NumberFormat('ja-JP');
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const yieldToUI = () =>
  globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r));

function showError(message) {
  const el = $('error');
  el.textContent = message ?? '';
  el.hidden = !message;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- 動画の読み込み ----------

function setMeta(slot, text, bad = false) {
  const el = $('meta' + slot);
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

// 枠ごとの読み込み世代。新しいファイルが選ばれたら、古い読み込みの結果は捨てる。
const loadGen = { A: 0, B: 0 };

async function setFile(slot, file) {
  if (state.running) return;
  const gen = ++loadGen[slot];
  const isStale = () => gen !== loadGen[slot];
  state[slot]?.input.dispose();
  state[slot] = null;
  resetRun();
  showError('');
  $('name' + slot).textContent = file.name;
  document.querySelector(`.slot[data-slot="${slot}"]`).classList.add('loaded');
  setMeta(slot, '読み込み中…');
  refreshWarnings();

  let input = null;
  try {
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('このブラウザは WebCodecs に対応していません。最新の Chrome / Edge / Safari / Firefox を使ってください。');
    }
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (isStale()) return input.dispose();
    if (!track) throw new Error('映像トラックが見つかりません。');

    // 解像度は重い処理（全パケットの走査）の前に確かめる
    const [cw, ch] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
    if (isStale()) return input.dispose();
    if (!(cw > 0 && ch > 0)) throw new Error('解像度を読み取れません。');
    if (cw > MAX_SIDE || ch > MAX_SIDE) {
      throw new Error(`解像度 ${cw}×${ch} は上限（1辺 ${MAX_SIDE}px）を超えているため、比較できません。`);
    }

    const [codec, canDecode, w, h, first, duration, stats] = await Promise.all([
      track.getCodec(),
      track.canDecode(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getFirstTimestamp(),
      track.computeDuration(),
      track.computePacketStats(300),
    ]);
    if (isStale()) return input.dispose();
    if (!canDecode) {
      throw new Error(`このブラウザは ${codec ?? '不明な'} 形式の映像をデコードできません。`);
    }
    const fps = stats.averagePacketRate;
    if (!(fps > 0 && duration > 0)) throw new Error('フレームレートや長さを読み取れません。');
    state[slot] = { file, input, track, codec, w, h, fps, duration, first };
    setMeta(slot, `${w}×${h} · ${num(fps)} fps · ${num(duration)} 秒 · ${codec}`);
  } catch (e) {
    if (input && !input.disposed) input.dispose();
    if (isStale()) return;
    console.error(e);
    setMeta(slot, e.message ?? String(e), true);
  }
  refreshWarnings();
}

function refreshWarnings() {
  const list = $('warnings');
  list.replaceChildren();
  const { A, B } = state;
  if (A && B) {
    const mode = resolveMode($('mode').value, A, B);
    for (const msg of compareInfo(A, B, mode)) {
      const li = document.createElement('li');
      li.textContent = msg;
      list.append(li);
    }
    $('status').textContent = '開始を押すと比較します。';
  }
  syncButtons();
}

function syncButtons() {
  $('start').disabled = state.running || !(state.A && state.B);
  $('stop').disabled = !state.running;
  for (const id of ['fileA', 'fileB', 'mode', 'scale', 'interval', 'gain']) $(id).disabled = state.running;
  const done = !!state.run && state.run.vals.length > 0 && !state.running;
  $('exportCsv').disabled = !done;
  $('exportImages').disabled = !done || currentRanges().length === 0;
}

for (const slot of ['A', 'B']) {
  const root = document.querySelector(`.slot[data-slot="${slot}"]`);
  $('file' + slot).addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) setFile(slot, f);
    e.target.value = '';
  });
  root.addEventListener('dragover', (e) => {
    e.preventDefault();
    root.classList.add('dragging');
  });
  root.addEventListener('dragleave', () => root.classList.remove('dragging'));
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(slot, f);
  });
}
$('mode').addEventListener('change', refreshWarnings);

// ---------- 比較の実行 ----------

function resetRun() {
  const run = state.run;
  state.run = null;
  if (run) {
    run.sinkA = run.sinkB = null;
  }
  $('ranges').replaceChildren();
  $('bar').value = 0;
  $('capA').textContent = 'A';
  $('capB').textContent = 'B';
  $('capD').textContent = '差分';
  drawGraph();
  syncButtons();
}

function currentThreshold() {
  const v = Number($('threshold').value);
  return Number.isFinite(v) ? v : 0;
}

function currentRanges() {
  return state.run ? findRanges(state.run.vals, currentThreshold()) : [];
}

function summary(run) {
  const n = run.vals.length;
  if (n === 0) return '';
  let max = -1;
  let maxAt = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += run.vals[i];
    if (run.vals[i] > max) {
      max = run.vals[i];
      maxAt = i;
    }
  }
  return `平均 ${num(sum / n)} · 最大 ${num(max)}（#${maxAt}）`;
}

async function start() {
  if (state.running || !state.A || !state.B) return;
  const { A, B } = state;
  resetRun();
  showError('');

  const mode = resolveMode($('mode').value, A, B);
  const scale = Number($('scale').value) || 1;
  const w = Math.max(2, Math.round(A.w * scale));
  const h = Math.max(2, Math.round(A.h * scale));
  const interval = Math.max(1, Math.floor(Number($('interval').value)) || 30);
  const gain = Number($('gain').value) || 1;

  for (const c of Object.values(els.canvases)) {
    c.width = w;
    c.height = h;
  }
  const ctxA = els.canvases.A.getContext('2d', { willReadFrequently: true });
  const ctxB = els.canvases.B.getContext('2d', { willReadFrequently: true });
  const ctxD = els.canvases.D.getContext('2d');
  const outImage = ctxD.createImageData(w, h);

  const expected = Math.floor(
    mode === 'time' ? A.duration * A.fps : Math.min(A.duration * A.fps, B.duration * B.fps),
  );
  const run = {
    vals: [], tsA: [], tsB: [], qA: [], qB: [], w, h, mode, gain, expected,
    sinkA: new VideoSampleSink(A.track),
    sinkB: new VideoSampleSink(B.track),
    selected: -1, hover: -1, layout: null, finished: false,
  };
  state.run = run;
  state.running = true;
  state.stop = false;
  syncButtons();

  const pairs =
    mode === 'time'
      ? pairByTime(run.sinkA.samples(), run.sinkB.samples(), A.first, B.first)
      : pairByIndex(run.sinkA.samples(), run.sinkB.samples());

  const t0 = performance.now();
  let lastUi = t0;
  const query = (s) => s.timestamp + (s.duration > 0 ? s.duration / 2 : 1e-6);

  try {
    for await (const { index, a, b } of pairs) {
      a.draw(ctxA, 0, 0, w, h);
      b.draw(ctxB, 0, 0, w, h);
      const da = ctxA.getImageData(0, 0, w, h).data;
      const db = ctxB.getImageData(0, 0, w, h).data;

      run.vals.push(meanLumaDiff(da, db));
      run.tsA.push(a.timestamp);
      run.tsB.push(b.timestamp);
      run.qA.push(query(a));
      run.qB.push(query(b));

      if (index % interval === 0) {
        renderDiff(da, db, outImage.data, gain);
        ctxD.putImageData(outImage, 0, 0);
        const last = run.vals.length - 1;
        $('capA').textContent = `A · #${last} · ${num(a.timestamp, 3)} s`;
        $('capB').textContent = `B · #${last} · ${num(b.timestamp, 3)} s`;
        $('capD').textContent = `差分 · ${num(run.vals[last])}`;
        refreshResults();
      }

      const now = performance.now();
      if (now - lastUi > 120) {
        const n = run.vals.length;
        const fps = n / ((now - t0) / 1000);
        $('bar').value = expected > 0 ? Math.min(1, n / expected) : 0;
        $('status').textContent =
          `処理中 ${fmt.format(n)}${expected ? ` / 約 ${fmt.format(expected)}` : ''} フレーム · ${num(fps, 1)} fps`;
        lastUi = now;
        await yieldToUI();
      }
      if (state.stop) break;
    }
    if (run.vals.length === 0) throw new Error('比較できるフレームがありませんでした。');
  } catch (e) {
    console.error(e);
    showError(`エラー: ${e.message ?? e}`);
  } finally {
    run.finished = true;
    state.running = false;
    $('bar').value = run.vals.length ? 1 : 0;
    const secs = (performance.now() - t0) / 1000;
    $('status').textContent =
      `${state.stop ? '停止' : '完了'} ${fmt.format(run.vals.length)} フレーム · ${summary(run)} · ${num(secs, 1)} 秒`;
    refreshResults();
    syncButtons();
  }
}

// ---------- グラフと結果リスト ----------

function drawGraph() {
  const run = state.run;
  const layout = drawChart(els.chart, {
    values: run?.vals ?? [],
    expectedTotal: run?.expected ?? 0,
    threshold: currentThreshold(),
    selected: run?.selected ?? -1,
    hover: run?.hover ?? -1,
  });
  if (run) run.layout = layout;
}

function refreshResults() {
  drawGraph();
  const run = state.run;
  const list = $('ranges');
  list.replaceChildren();
  if (!run) return;
  const ranges = currentRanges();
  for (const r of ranges.slice(0, MAX_LISTED)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const span = r.start === r.end ? `#${r.start}` : `#${r.start}–${r.end}（${r.end - r.start + 1} フレーム）`;
    btn.textContent = `${span} · ピーク ${num(run.vals[r.peak])} @ #${r.peak} · ${num(run.tsA[r.peak], 2)} s`;
    btn.setAttribute('aria-current', String(run.selected === r.peak));
    btn.addEventListener('click', () => inspect(r.peak));
    li.append(btn);
    list.append(li);
  }
  if (ranges.length > MAX_LISTED) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `ほか ${fmt.format(ranges.length - MAX_LISTED)} 区間（ZIP には全区間を含めます）`;
    list.append(li);
  }
  syncButtons();
}

$('threshold').addEventListener('input', refreshResults);
window.addEventListener('resize', drawGraph);

// グラフの操作: ホバーで値、クリックでそのフレームを表示
const tip = $('tip');
els.chart.addEventListener('pointermove', (e) => {
  const run = state.run;
  if (!run || run.vals.length === 0) return;
  const rect = els.chart.getBoundingClientRect();
  const i = pickIndex(run.layout, run.vals, e.clientX - rect.left);
  if (i < 0) return;
  run.hover = i;
  drawGraph();
  tip.hidden = false;
  tip.textContent = `#${i} · ${num(run.tsA[i], 3)} s · 差分 ${num(run.vals[i])}`;
  const host = els.chart.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX - host.left + 12, host.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${e.clientY - host.top - 30}px`;
});
els.chart.addEventListener('pointerleave', () => {
  tip.hidden = true;
  if (state.run) {
    state.run.hover = -1;
    drawGraph();
  }
});
els.chart.addEventListener('click', (e) => {
  const run = state.run;
  if (!run) return;
  const rect = els.chart.getBoundingClientRect();
  const i = pickIndex(run.layout, run.vals, e.clientX - rect.left);
  if (i >= 0) inspect(i);
});

// ---------- 任意フレームの再表示 / 書き出し ----------

let inspectToken = 0;

/** i 番目のペアを再デコードして A / B / 差分に描く（記録したタイムスタンプで取得するので、ずれない）。 */
async function fetchPair(run, i) {
  const [a, b] = await Promise.all([run.sinkA.getSample(run.qA[i]), run.sinkB.getSample(run.qB[i])]);
  if (!a || !b) {
    a?.close();
    b?.close();
    throw new Error(`#${i} のフレームを取得できませんでした。`);
  }
  return { a, b };
}

function paint(run, a, b, ctxA, ctxB, ctxD) {
  a.draw(ctxA, 0, 0, run.w, run.h);
  b.draw(ctxB, 0, 0, run.w, run.h);
  const da = ctxA.getImageData(0, 0, run.w, run.h).data;
  const db = ctxB.getImageData(0, 0, run.w, run.h).data;
  const out = ctxD.createImageData(run.w, run.h);
  renderDiff(da, db, out.data, run.gain);
  ctxD.putImageData(out, 0, 0);
  return meanLumaDiff(da, db);
}

async function inspect(i) {
  const run = state.run;
  if (!run || state.running || !run.sinkA) return;
  const token = ++inspectToken;
  run.selected = i;
  refreshResults();
  try {
    const { a, b } = await fetchPair(run, i);
    try {
      if (token !== inspectToken) return;
      const v = paint(
        run, a, b,
        els.canvases.A.getContext('2d', { willReadFrequently: true }),
        els.canvases.B.getContext('2d', { willReadFrequently: true }),
        els.canvases.D.getContext('2d'),
      );
      $('capA').textContent = `A · #${i} · ${num(a.timestamp, 3)} s`;
      $('capB').textContent = `B · #${i} · ${num(b.timestamp, 3)} s`;
      $('capD').textContent = `差分 · ${num(v)}`;
    } finally {
      a.close();
      b.close();
    }
  } catch (e) {
    showError(`エラー: ${e.message ?? e}`);
  }
}

async function exportImages() {
  const run = state.run;
  if (!run || state.running) return;
  const ranges = currentRanges();
  if (!ranges.length) return;
  const btn = $('exportImages');
  btn.disabled = true;
  showError('');
  const canvas = new OffscreenCanvas(run.w, run.h);
  const ctxA = new OffscreenCanvas(run.w, run.h).getContext('2d', { willReadFrequently: true });
  const ctxB = new OffscreenCanvas(run.w, run.h).getContext('2d', { willReadFrequently: true });
  const ctxD = canvas.getContext('2d');
  const sheet = new OffscreenCanvas(run.w * 3, run.h);
  const sctx = sheet.getContext('2d');
  const entries = [];

  try {
    for (const [k, r] of ranges.entries()) {
      $('status').textContent = `画像を書き出し中 ${k + 1} / ${ranges.length}`;
      const { a, b } = await fetchPair(run, r.peak);
      try {
        const v = paint(run, a, b, ctxA, ctxB, ctxD);
        sctx.drawImage(ctxA.canvas, 0, 0);
        sctx.drawImage(ctxB.canvas, run.w, 0);
        sctx.drawImage(ctxD.canvas, run.w * 2, 0);
        const blob = await sheet.convertToBlob({ type: 'image/png' });
        const name = `${String(k + 1).padStart(4, '0')}_f${r.peak}_t${num(run.tsA[r.peak], 2)}s_d${num(v)}.png`;
        entries.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
      } finally {
        a.close();
        b.close();
      }
    }
    download(makeZip(entries), 'diffm-over.zip');
    $('status').textContent = `${entries.length} 枚を diffm-over.zip に保存しました（左から A | B | 差分）。`;
  } catch (e) {
    console.error(e);
    showError(`エラー: ${e.message ?? e}`);
  } finally {
    syncButtons();
  }
}

function exportCsv() {
  const run = state.run;
  if (!run) return;
  const rows = ['frame,time_a,time_b,diff'];
  for (let i = 0; i < run.vals.length; i++) {
    rows.push(`${i},${run.tsA[i]},${run.tsB[i]},${run.vals[i]}`);
  }
  download(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), 'diffm.csv');
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => {
  state.stop = true;
});
$('exportImages').addEventListener('click', exportImages);
$('exportCsv').addEventListener('click', exportCsv);

drawGraph();
