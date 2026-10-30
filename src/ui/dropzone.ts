// ウィンドウ全体へのファイルのドロップ（どこに落としても受ける）

const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

interface WindowDrop {
  /** 受け付けている間だけ真（タブが隠れているときなどは偽） */
  enabled: () => boolean;
  /** ドラッグ中かどうか。表示の切り替えに使う */
  onActive: (on: boolean) => void;
  onDrop: (files: File[]) => void;
}

export function bindWindowDrop({ enabled, onActive, onDrop }: WindowDrop): void {
  // 子要素をまたぐたびに enter / leave が来るので、数えて外に出たときだけ終える
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!enabled() || !hasFiles(e)) return;
    e.preventDefault();
    depth++;
    onActive(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!enabled() || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!enabled() || !hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) onActive(false);
  });
  window.addEventListener('drop', (e) => {
    if (!enabled() || !hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    onActive(false);
    onDrop([...e.dataTransfer!.files]);
  });
}
