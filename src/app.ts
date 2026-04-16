import { getCurrentWindow } from '@tauri-apps/api/window';
import { sessionManager } from './session/SessionManager';
import { sessionObserver } from './session/SessionObserver';
import { configContext } from './config/ConfigContext';
import { WaterfallArea } from './waterfall/WaterfallArea';
import { InputBar } from './input/InputBar';
import { SessionSidebar } from './sidebar/SessionSidebar';
import { keybindingManager } from './keybindings/KeybindingManager';
import { modeManager } from './input/ModeManager';
import { setPlanLogFn } from './ai/plan-executor';
import { SettingsPanel } from './settings/SettingsPanel';
import { OnboardingOverlay } from './help/OnboardingOverlay';
import { transport } from './transport';
import { workspaceActions } from './workspace/WorkspaceActions';
import { setWorkspaceLayoutReader } from './workspace/WorkspaceState';
import type { PaneNameSource } from './session/types';

interface PaneSnapshot {
  name: string;
  group: string;
  note: string;
  cwd: string;
  tmux_session?: string | null;
  name_source?: PaneNameSource;
  row_index: number;
  pane_index: number;
  is_active: boolean;
}

interface WorkspaceSnapshot {
  version: number;
  panes: PaneSnapshot[];
}

interface TmuxDiscoveredSession {
  name: string;
  created: number;
  path: string;
  attached: boolean;
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
  sessionObserver.init();

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
  setPlanLogFn((text, cls) => inputBar.logLine(text, cls));
  setWorkspaceLayoutReader(waterfallArea);
  workspaceActions.configure({
    session: sessionManager,
    terminal: {
      write: (paneId, data) => transport.send('pty_write', { args: { pane_id: paneId, data } }),
    },
    layout: {
      spawnPane: async (opts) => {
        const pane = await waterfallArea.spawnPane(opts);
        return pane ? { paneId: pane.paneId } : null;
      },
      splitCurrentRow: () => waterfallArea.splitCurrentRow(),
      closePane: async (paneId) => {
        const pane = waterfallArea.getPane(paneId);
        if (pane) await pane.destroy();
      },
    },
    viewport: {
      scrollToPane: (paneId) => waterfallArea.scrollToPane(paneId),
    },
  });

  // Header buttons
  header.querySelector('#btn-new')?.addEventListener('click', () => {
    void workspaceActions.dispatch({ type: 'new' }, { source: 'ui' });
  });
  header.querySelector('#btn-split')?.addEventListener('click', () => {
    void workspaceActions.dispatch({ type: 'split' }, { source: 'ui' });
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
      transport.send('window_set_traffic_lights_hidden', { hidden: compact }).catch(() => {});
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
  const performShutdown = async () => {
    if (!configContext.get().persistence.restore_workspace_on_launch) {
      await transport.send('app_exit');
      return;
    }
    try {
      const snapshot = buildSnapshot(waterfallArea);
      await transport.send('workspace_snapshot_save', { snapshot });
    } catch (e) {
      console.error('Failed to save workspace snapshot:', e);
    }
    // Command the backend to exit after saving
    await transport.send('app_exit').catch(() => {});
  };

  appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    await performShutdown();
  });

  transport.listen('app:request_exit', async () => {
    await performShutdown();
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
  const restoredSessions = new Set<string>();
  if (configContext.get().persistence.restore_workspace_on_launch) {
    try {
      const snapshot = await transport.send<WorkspaceSnapshot | null>('workspace_snapshot_load');
      console.log('[restore] snapshot loaded:', snapshot);
      if (snapshot && snapshot.panes.length > 0) {
        await restoreSnapshot(snapshot, waterfallArea);
        restored = true;
        for (const p of snapshot.panes) {
          if (p.tmux_session) restoredSessions.add(p.tmux_session);
        }
        console.log('[restore] done, panes:', snapshot.panes.length);
      }
    } catch (e) {
      console.error('[restore] failed:', e);
    }
  } else {
    console.log('[restore] skipped: restore_workspace_on_launch=false');
  }

  // Discovery: attach to live tmux sessions not in the snapshot. Multi-client
  // attach is allowed; another fluxtty mirroring the session is by design.
  let discoveredCount = 0;
  if (configContext.get().tmux.enabled) {
    try {
      const discovered = await transport.send<TmuxDiscoveredSession[]>('tmux_list_sessions');
      const extras = discovered.filter(s => !restoredSessions.has(s.name));
      console.log(`[discover] tmux returned ${discovered.length} sessions, ${extras.length} not in snapshot`);
      for (const s of extras) {
        const pane = await waterfallArea.spawnPane({
          newRow: true,
          atBottom: true,
          tmuxSession: s.name,
          cwd: s.path || undefined,
        });
        if (pane) discoveredCount++;
      }
    } catch (e) {
      console.error('[discover] tmux_list_sessions failed:', e);
    }
  }

  if (!restored && discoveredCount === 0) {
    await waterfallArea.spawnPane({ newRow: true });
  }

  // Live snapshot save: without this, a second fluxtty instance opened
  // mid-session would only see the last on-exit snapshot, not current state.
  if (configContext.get().persistence.restore_workspace_on_launch) {
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    sessionManager.onChange(() => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
          const snapshot = buildSnapshot(waterfallArea);
          void transport.send('workspace_snapshot_save', { snapshot }).catch((e) => {
            console.error('[snapshot] live save failed:', e);
          });
        } catch (e) {
          console.error('[snapshot] live save build failed:', e);
        }
      }, 500);
    });
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
        tmux_session: info.tmux_session ?? null,
        name_source: info.name_source,
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
  // Collect notes keyed by domRowIdx — applied after all panes in the row are
  // spawned so the note pane is always appended last (i.e. stays at far right).
  const pendingNotes = new Map<number, string>();

  for (const snap of sorted) {
    const isNewRow = snap.row_index !== lastRowIndex;
    if (isNewRow) {
      lastRowIndex = snap.row_index;
      domRowIdx++;
    }

    console.log(`[restore] spawning pane row=${snap.row_index} isNewRow=${isNewRow} cwd=${snap.cwd}`);
    // atBottom for newRow: snapshot iterates in row_index order, so each new
    // row should append to the end. Using getActivePaneRowIndex() races with
    // the async setActivePane IPC and shuffles row order.
    const pane = await waterfallArea.spawnPane({
      newRow: isNewRow,
      atBottom: isNewRow,
      cwd: snap.cwd,
      group: snap.group,
      tmuxSession: snap.tmux_session ?? null,
      targetRow: isNewRow ? undefined : domRowIdx,
    });
    if (!pane) { console.warn('[restore] spawnPane returned null, skipping'); continue; }

    // Restore metadata that the PTY spawn doesn't carry.
    const renames: Promise<void>[] = [];
    if (snap.name) renames.push(sessionManager.renamePane(pane.paneId, snap.name, snap.name_source ?? 'manual').catch(console.error));
    if (snap.group && snap.group !== 'default') {
      renames.push(sessionManager.setPaneGroup(pane.paneId, snap.group).catch(console.error));
    }
    await Promise.all(renames);

    // Queue row note (stored only on the first pane per row) for later so that
    // all terminal panes in the row are in the DOM before the note pane is
    // appended — keeping the note pinned at the far right.
    if (snap.pane_index === 0 && snap.note) {
      pendingNotes.set(domRowIdx, snap.note);
    }

    if (snap.is_active) {
      await sessionManager.setActivePane(pane.paneId);
    }
  }

  // Apply row notes now that every pane has been spawned.
  for (const [rowIdx, note] of pendingNotes) {
    const rowEls = waterfallArea.getRowsWithNotes();
    const rowData = rowEls[rowIdx];
    if (rowData) waterfallArea.setRowNote(rowData.rowEl, note);
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
