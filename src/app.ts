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
import { OnboardingOverlay } from './help/OnboardingOverlay';

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
  const isMac = ua.includes('Macintosh');
  if (isMac)  document.documentElement.classList.add('platform-macos');
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
  const header = buildHeader(isMac);
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

  // Guide / onboarding overlay
  const onboardingOverlay = new OnboardingOverlay(isMac);
  appEl.appendChild(onboardingOverlay.el);

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
  header.querySelector('#btn-help')?.addEventListener('click', () => {
    onboardingOverlay.showCheatSheet();
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

  // Compact mode: hide/show macOS traffic-light buttons via native NSWindow API.
  // CSS cannot cover native controls; this uses objc FFI to setHidden on each button.
  if (isMac) {
    const applyTrafficLights = (compact: boolean) => {
      invoke('window_set_traffic_lights_hidden', { hidden: compact }).catch(() => {});
    };
    applyTrafficLights(configContext.get().window.compact_mode);
    configContext.onChange((cfg) => applyTrafficLights(cfg.window.compact_mode));
  }

  // Keybindings
  const appWindow = getCurrentWindow();
  const syncWindowChromeState = async () => {
    if (!isMac) return;
    const fullscreen = await appWindow.isFullscreen().catch(() => false);
    document.documentElement.classList.toggle('window-fullscreen', fullscreen);
  };
  void syncWindowChromeState();
  void appWindow.onResized(() => { void syncWindowChromeState(); });

  keybindingManager.init({
    waterfallArea,
    sidebar,
    openSettings: () => settingsPanel.toggle(),
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
    try {
      await appWindow.destroy();
    } catch (e) {
      console.error('Failed to destroy window:', e);
      // Last resort: try close() which will re-emit closeRequested,
      // but at this point keep_alive check will still pass — so guard
      // against infinite loop by temporarily relying on the OS to close.
      await appWindow.close().catch(() => {});
    }
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

  requestAnimationFrame(() => {
    onboardingOverlay.showQuickStartIfNeeded(restored);
  });
}

// ── Snapshot helpers ──────────────────────────────────────────────────────

/** Build a snapshot from the current DOM layout order (ground truth for visual position).
 *
 *  Reads info from TerminalPane.getInfo() rather than sessionManager to avoid a
 *  race where Rust kills PTYs during shutdown and fires session:changed (clearing
 *  sessionManager.panes) before onCloseRequested fires. */
function buildSnapshot(waterfallArea: WaterfallArea): WorkspaceSnapshot {
  const activeId = sessionManager.getActivePaneId();
  const rows = waterfallArea.getRowsWithNotes();
  const panes: PaneSnapshot[] = [];
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const { note: rowNote, panes: rowPanes } = rows[rowIdx];
    for (let paneIdx = 0; paneIdx < rowPanes.length; paneIdx++) {
      const pane = waterfallArea.getPane(rowPanes[paneIdx].id);
      if (!pane) continue;
      const info = pane.getInfo();
      panes.push({
        name: info.name,
        group: info.group,
        // Store row note only on first pane in row; other panes leave it empty.
        note: paneIdx === 0 ? rowNote : '',
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
    if (snap.group && snap.group !== 'default') {
      renames.push(sessionManager.setPaneGroup(pane.paneId, snap.group).catch(console.error));
    }
    await Promise.all(renames);

    // Restore row note (stored only on the first pane per row).
    if (snap.pane_index === 0 && snap.note) {
      const rowEls = waterfallArea.getRowsWithNotes();
      const rowData = rowEls[domRowIdx];
      if (rowData) waterfallArea.setRowNote(rowData.rowEl, snap.note);
    }

    if (snap.is_active) {
      await sessionManager.setActivePane(pane.paneId);
    }
  }
}

function buildHeader(isMac: boolean): HTMLElement {
  const settingsShortcut = isMac ? 'Cmd+,' : 'Ctrl+,';
  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <div class="header-traffic-lights"></div>
    <div class="header-logo">fluxtty</div>
    <div class="header-session-count">0 sessions</div>
    <div class="header-spacer"></div>
    <button class="header-btn" id="btn-new" title="New terminal (Ctrl+N)">＋ New</button>
    <button class="header-btn" id="btn-split" title="Split (Ctrl+H)">⊟ Split</button>
    <button class="header-btn" id="btn-sessions" title="Sessions (Ctrl+B)">≡ Sessions</button>
    <button class="header-btn" id="btn-help" title="Quick start and shortcuts">? Help</button>
    <button class="header-btn" id="btn-settings" title="Settings (${settingsShortcut})">⚙ Settings</button>
  `;
  return header;
}
