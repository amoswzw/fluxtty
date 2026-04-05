import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { sessionManager } from './session/SessionManager';
import { configContext } from './config/ConfigContext';
import { WaterfallArea } from './waterfall/WaterfallArea';
import { InputBar } from './input/InputBar';
import { SessionSidebar } from './sidebar/SessionSidebar';
import { keybindingManager } from './keybindings/KeybindingManager';
import { modeManager } from './input/ModeManager';
import { setWaterfallArea } from './ai/ai-handler';
import { setPlanWaterfallArea, setPlanLogFn } from './ai/plan-executor';
import { SettingsPanel } from './settings/SettingsPanel';

interface PaneSnapshot {
  name: string;
  group: string;
  note: string;
  cwd: string;
  row_index: number;
  pane_index: number;
  is_active: boolean;
}

interface WorkspaceSnapshot {
  version: number;
  panes: PaneSnapshot[];
}

export async function initApp(root: HTMLElement) {
  // Detect platform and tag <html> so CSS can apply platform-specific rules
  const ua = navigator.userAgent;
  if (ua.includes('Macintosh'))  document.documentElement.classList.add('platform-macos');
  else if (ua.includes('Windows')) document.documentElement.classList.add('platform-windows');
  else                             document.documentElement.classList.add('platform-linux');

  // Init config first
  await configContext.init();
  await sessionManager.init();

  // Preload bundled symbol font before any xterm.js terminal is created.
  // xterm.js builds its glyph atlas on first render — if the @font-face font
  // hasn't finished downloading by then, PUA characters fall back to U+FFFD.
  await document.fonts.load('normal 16px "Symbols Nerd Font Mono"').catch(() => {});

  // Build layout
  const appEl = document.createElement('div');
  appEl.className = 'app';
  root.appendChild(appEl);

  // Header
  const header = buildHeader();
  appEl.appendChild(header);

  // Main area (sidebar + waterfall)
  const mainEl = document.createElement('div');
  mainEl.className = 'app-main';
  appEl.appendChild(mainEl);

  // Sidebar (hidden by default)
  const sidebar = new SessionSidebar();
  mainEl.appendChild(sidebar.el);

  // Waterfall
  const waterfallArea = new WaterfallArea(mainEl);

  // Settings panel
  const settingsPanel = new SettingsPanel();
  appEl.appendChild(settingsPanel.el);

  // Input bar
  const inputBar = new InputBar(appEl);

  // Wire up cross-module references
  sidebar.setWaterfallArea(waterfallArea);
  setWaterfallArea(waterfallArea);
  setPlanWaterfallArea(waterfallArea);
  setPlanLogFn((text, cls) => inputBar.logLine(text, cls));

  // Header buttons
  header.querySelector('#btn-new')?.addEventListener('click', () => {
    waterfallArea.spawnPane({ newRow: true });
  });
  header.querySelector('#btn-split')?.addEventListener('click', () => {
    waterfallArea.splitCurrentRow();
  });
  header.querySelector('#btn-sessions')?.addEventListener('click', () => {
    sidebar.toggle();
  });
  header.querySelector('#btn-settings')?.addEventListener('click', () => {
    settingsPanel.toggle();
  });

  // Ctrl+, opens settings
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); settingsPanel.toggle(); }
  });

  // Wire mode changes → terminal focus/unfocus
  // Only terminal mode gives xterm raw keyboard; all other modes use the input bar.
  modeManager.onChange((mode) => {
    const allPanes = waterfallArea.getAllPanes();
    if (mode.type === 'terminal') {
      const pane = waterfallArea.getPane(mode.paneId);
      allPanes.forEach(p => p.exitDirectMode());
      pane?.enterDirectMode();
    } else {
      allPanes.forEach(p => p.exitDirectMode());
    }
  });

  // Keybindings
  const appWindow = getCurrentWindow();
  keybindingManager.init({
    waterfallArea,
    sidebar,
    quit: () => void appWindow.close(),
  });

  // ── Persistence: save snapshot on close, then truly exit ────────────────
  // event.preventDefault() lets the async save finish before the app exits.
  // appWindow.destroy() is used for the final close so it doesn't re-fire
  // onCloseRequested (unlike appWindow.close()).
  appWindow.onCloseRequested(async (event) => {
    if (!configContext.get().persistence.keep_alive) return;
    event.preventDefault();
    try {
      const snapshot = buildSnapshot(waterfallArea);
      await invoke('workspace_snapshot_save', { snapshot });
    } catch (e) {
      console.error('Failed to save workspace snapshot:', e);
    }
    void appWindow.destroy();
  });

  // Session count in header
  sessionManager.onChange((panes) => {
    const countEl = header.querySelector('.header-session-count');
    if (countEl) {
      const running = panes.filter(p => p.status === 'running').length;
      countEl.textContent = `${panes.length} sessions · ${running} running`;
    }
  });

  // ── Persistence: restore snapshot or spawn a fresh pane ─────────────────
  let restored = false;
  if (configContext.get().persistence.keep_alive) {
    try {
      const snapshot = await invoke<WorkspaceSnapshot | null>('workspace_snapshot_load');
      console.log('[restore] snapshot loaded:', snapshot);
      if (snapshot && snapshot.panes.length > 0) {
        await restoreSnapshot(snapshot, waterfallArea);
        restored = true;
        console.log('[restore] done, panes:', snapshot.panes.length);
      }
    } catch (e) {
      console.error('[restore] failed:', e);
    }
  } else {
    console.log('[restore] skipped: keep_alive=false');
  }
  if (!restored) {
    await waterfallArea.spawnPane({ newRow: true });
  }

  // Ensure AI input bar has focus after everything loads.
  // Must be after spawnPane so any term.focus() side effects are overridden.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      inputBar.focus();
    });
  });
}

// ── Snapshot helpers ──────────────────────────────────────────────────────

/** Build a snapshot from the current DOM layout order (ground truth for visual position). */
function buildSnapshot(waterfallArea: WaterfallArea): WorkspaceSnapshot {
  const activeId = sessionManager.getActivePaneId();
  const domRows = waterfallArea.getPanesByDOMRow();
  const panes: PaneSnapshot[] = [];
  for (let rowIdx = 0; rowIdx < domRows.length; rowIdx++) {
    const row = domRows[rowIdx];
    for (let paneIdx = 0; paneIdx < row.length; paneIdx++) {
      const info = sessionManager.getPane(row[paneIdx].id);
      if (!info) continue;
      panes.push({
        name: info.name,
        group: info.group,
        note: info.note,
        cwd: info.cwd,
        row_index: rowIdx,
        pane_index: paneIdx,
        is_active: info.id === activeId,
      });
    }
  }
  return { version: 1, panes };
}

/** Restore a saved snapshot: spawn panes in the saved row/pane order, then
 *  apply saved names, groups, and notes. */
async function restoreSnapshot(snapshot: WorkspaceSnapshot, waterfallArea: WaterfallArea): Promise<void> {
  // Sort by row first, then by pane position within the row.
  const sorted = [...snapshot.panes].sort((a, b) =>
    a.row_index !== b.row_index ? a.row_index - b.row_index : a.pane_index - b.pane_index
  );

  let lastRowIndex = -1;
  let domRowIdx = -1;

  for (const snap of sorted) {
    const isNewRow = snap.row_index !== lastRowIndex;
    if (isNewRow) {
      lastRowIndex = snap.row_index;
      domRowIdx++;
    }

    console.log(`[restore] spawning pane row=${snap.row_index} isNewRow=${isNewRow} cwd=${snap.cwd}`);
    const pane = await waterfallArea.spawnPane({
      newRow: isNewRow,
      cwd: snap.cwd,
      group: snap.group,
      targetRow: isNewRow ? undefined : domRowIdx,
    });
    if (!pane) { console.warn('[restore] spawnPane returned null, skipping'); continue; }

    // Restore metadata that the PTY spawn doesn't carry.
    const renames: Promise<void>[] = [];
    if (snap.name) renames.push(sessionManager.renamePane(pane.paneId, snap.name).catch(console.error));
    if (snap.note) renames.push(sessionManager.setPaneNote(pane.paneId, snap.note).catch(console.error));
    if (snap.group && snap.group !== 'default') {
      renames.push(sessionManager.setPaneGroup(pane.paneId, snap.group).catch(console.error));
    }
    await Promise.all(renames);

    if (snap.is_active) {
      await sessionManager.setActivePane(pane.paneId);
    }
  }
}

function buildHeader(): HTMLElement {
  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <div class="header-traffic-lights"></div>
    <div class="header-logo">fluxtty</div>
    <div class="header-session-count">0 sessions</div>
    <div class="header-spacer"></div>
    <button class="header-btn" id="btn-new" title="New terminal (Ctrl+N)">+ New</button>
    <button class="header-btn" id="btn-split" title="Split (Ctrl+H)">Split</button>
    <button class="header-btn" id="btn-sessions" title="Sessions (Ctrl+B)">Sessions</button>
    <button class="header-btn" id="btn-settings" title="Settings (Ctrl+,)">Settings</button>
  `;
  return header;
}
