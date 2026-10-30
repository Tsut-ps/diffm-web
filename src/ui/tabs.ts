// タブ（比較 / 並べて再生）の切り替え。選んだタブは URL のハッシュに残す。

import { byId } from './dom';

export type TabId = 'diff' | 'player';
const TABS: readonly TabId[] = ['diff', 'player'];

const tabEl = (id: TabId) => byId<HTMLButtonElement>(`tab-${id}`);
const panelEl = (id: TabId) => byId(`panel-${id}`);

let onChange: (tab: TabId) => void = () => {};

export function selectTab(id: TabId, focus = false): void {
  for (const t of TABS) {
    const on = t === id;
    tabEl(t).setAttribute('aria-selected', String(on));
    tabEl(t).tabIndex = on ? 0 : -1;
    panelEl(t).hidden = !on;
  }
  document.body.dataset.tab = id;
  const url = new URL(location.href);
  url.hash = id === 'diff' ? '' : id;
  history.replaceState(null, '', url);
  if (focus) tabEl(id).focus();
  onChange(id);
}

/** タブを使えるようにする。最初のタブ（ハッシュで指定があればそれ）で onSelect を呼ぶ。 */
export function initTabs(onSelect: (tab: TabId) => void): void {
  onChange = onSelect;
  for (const t of TABS) {
    tabEl(t).addEventListener('click', () => selectTab(t));
    tabEl(t).addEventListener('keydown', (e) => {
      const i = TABS.indexOf(t);
      const next =
        e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length]
        : e.key === 'ArrowLeft' ? TABS[(i + TABS.length - 1) % TABS.length]
        : e.key === 'Home' ? TABS[0]
        : e.key === 'End' ? TABS[TABS.length - 1]
        : undefined;
      if (!next) return;
      e.preventDefault();
      selectTab(next, true);
    });
  }
  const initial = TABS.find((t) => `#${t}` === location.hash);
  selectTab(initial ?? 'diff');
}
