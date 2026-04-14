import { getCurrentWindow } from '@tauri-apps/api/window';
import { configContext } from '../config/ConfigContext';
import type { WaterfallArea } from '../waterfall/WaterfallArea';
import { modeManager } from '../input/ModeManager';
import { sessionManager } from '../session/SessionManager';
import type { SessionSidebar } from '../sidebar/SessionSidebar';
import { workspaceActions } from '../workspace/WorkspaceActions';

interface ActionHandlers {
  waterfallArea: WaterfallArea;
  sidebar: SessionSidebar;
  openSettings: () => void;
  quit: () => void;
}

export class KeybindingManager {
  private handlers: ActionHandlers | null = null;

  init(handlers: ActionHandlers) {
    this.handlers = handlers;
    // Capture phase makes app-level shortcuts available even when an xterm
    // textarea currently owns focus in terminal mode.
    document.addEventListener('keydown', (e) => this.dispatch(e), true);
    // Normal-mode vi keys dispatch this event instead of calling executeAction directly
    document.addEventListener('workspace-action', (e: Event) => {
      this.executeAction((e as CustomEvent<string>).detail);
    });
  }

  private dispatch(e: KeyboardEvent) {
    if (!this.handlers) return;
    if (e.defaultPrevented) return;

    // App-level macOS shortcuts — active anywhere inside this app window,
    // including terminal mode.
    if (e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key === 'q') { e.preventDefault(); this.executeAction('Quit'); return; }
      if (e.key === 'w') { e.preventDefault(); this.executeAction('ClosePane'); return; }
      if (e.key === ',') { e.preventDefault(); this.executeAction('OpenSettings'); return; }
    }

    // Non-mac fallback for settings, also active in terminal mode.
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === ',') {
      e.preventDefault();
      this.executeAction('OpenSettings');
      return;
    }

    // Standard keybindings from config
    const action = this.matchAction(e);
    if (!action) return;

    e.preventDefault();
    e.stopPropagation();
    this.executeAction(action);
  }

  private matchesBindingKey(bindingKey: string, e: KeyboardEvent): boolean {
    if (bindingKey.toLowerCase() === e.key.toLowerCase() || bindingKey === e.code) {
      return true;
    }

    if (bindingKey === '\\') {
      return e.code === 'Backslash'
        || e.code === 'IntlBackslash'
        || e.code === 'IntlYen'
        || e.key === '\\'
        || e.key === '|'
        || e.key === '¥'
        || e.keyCode === 220
        || e.keyCode === 226;
    }

    return false;
  }

  private matchAction(e: KeyboardEvent): string | null {
    const cfg = configContext.get();
    for (const kb of cfg.keybindings) {
      if (!this.matchesBindingKey(kb.key, e)) continue;

      const mods = (kb.mods || '').split('|').map(m => m.trim().toLowerCase());
      const ctrl = mods.includes('control');
      const meta = mods.includes('meta');
      const shift = mods.includes('shift');
      const alt = mods.includes('alt');

      if (ctrl !== e.ctrlKey) continue;
      if (meta !== e.metaKey) continue;
      if (shift !== e.shiftKey) continue;
      if (alt !== e.altKey) continue;

      return kb.action;
    }
    return null;
  }

  private executeAction(action: string) {
    if (!this.handlers) return;
    const { waterfallArea, sidebar, openSettings, quit } = this.handlers;

    switch (action) {
      case 'NewTerminal':
        void workspaceActions.dispatch({ type: 'new' }, { source: 'keyboard' });
        break;
      case 'SplitHorizontal':
        void workspaceActions.dispatch({ type: 'split' }, { source: 'keyboard' });
        break;
      case 'ClosePane': {
        const pane = waterfallArea.getActivePane();
        if (!pane) break;
        const info = pane.getInfo();
        if (info.status === 'running') {
          const ok = confirm(`Close "${info.name}"? A process is still running.`);
          if (!ok) break;
        }
        void workspaceActions.dispatch({ type: 'close', target: String(pane.paneId) }, { source: 'keyboard' });
        modeManager.enterNormal();
        break;
      }
      case 'ToggleSidebar':
        sidebar.toggle();
        break;
      case 'OpenSettings':
        openSettings();
        break;
      case 'ToggleInputMode':
        modeManager.toggle();
        break;
      case 'EnterPane':
        modeManager.enterTerminal();
        break;
      case 'FocusNextRow':
      case 'FocusPrevRow': {
        const activeId = sessionManager.getActivePaneId();
        const rows = waterfallArea.getPanesByDOMRow();
        const currentRowIdx = rows.findIndex(row => row.some(p => p.id === activeId));
        if (currentRowIdx === -1) break;
        const delta = action === 'FocusNextRow' ? 1 : -1;
        const nextRow = rows[currentRowIdx + delta];
        if (nextRow && nextRow.length > 0) {
          // Pick the pane in the target row whose horizontal center is closest
          // to the current active pane's horizontal center.
          const activeEl = activeId != null ? waterfallArea.getPane(activeId)?.el : null;
          let targetId = nextRow[0].id;
          if (activeEl && nextRow.length > 1) {
            const activeRect = activeEl.getBoundingClientRect();
            const activeCenter = activeRect.left + activeRect.width / 2;
            let minDist = Infinity;
            for (const p of nextRow) {
              const el = waterfallArea.getPane(p.id)?.el;
              if (!el) continue;
              const rect = el.getBoundingClientRect();
              const dist = Math.abs((rect.left + rect.width / 2) - activeCenter);
              if (dist < minDist) { minDist = dist; targetId = p.id; }
            }
          }
          void workspaceActions.dispatch({ type: 'focus', target: String(targetId) }, { source: 'keyboard' });
        }
        break;
      }
      case 'FocusNextPane':
      case 'FocusPrevPane': {
        const activeId = sessionManager.getActivePaneId();
        // Use DOM-ordered rows for the same reason as above
        const rows = waterfallArea.getPanesByDOMRow();
        const rowIdx = rows.findIndex(row => row.some(p => p.id === activeId));
        if (rowIdx === -1) break;
        const rowPanes = rows[rowIdx];
        const idx = rowPanes.findIndex(p => p.id === activeId);
        const delta = action === 'FocusNextPane' ? 1 : -1;
        const next = rowPanes[(idx + delta + rowPanes.length) % rowPanes.length];
        if (next) {
          void workspaceActions.dispatch({ type: 'focus', target: String(next.id) }, { source: 'keyboard' });
        }
        break;
      }
      case 'RenameCurrentSession': {
        const pane = waterfallArea.getActivePane();
        if (!pane) break;
        pane.startRename();
        break;
      }
      case 'GroupCurrentSession': {
        const pane = waterfallArea.getActivePane();
        if (!pane) break;
        const group = prompt('Set group:', pane.getInfo().group);
        if (group !== null) {
          void workspaceActions.dispatch({
            type: 'group',
            target: String(pane.paneId),
            group: group.trim() || 'default',
          }, { source: 'keyboard' });
        }
        break;
      }
      case 'IncreaseFontSize':
      case 'DecreaseFontSize':
      case 'ResetFontSize':
        document.dispatchEvent(new CustomEvent('font-size-action', { detail: action }));
        break;
      case 'Copy': {
        const sel = window.getSelection()?.toString();
        if (sel) navigator.clipboard.writeText(sel).catch(console.error);
        break;
      }
      case 'Paste':
        navigator.clipboard.readText().then(text => {
          if (!text) return;
          const activeId = sessionManager.getActivePaneId();
          if (activeId == null) return;
          workspaceActions.dispatch({
            type: 'paste',
            target: String(activeId),
            data: text,
          }, { source: 'keyboard' }).catch(console.error);
        }).catch(console.error);
        break;
      case 'Quit':
        void getCurrentWindow().close();
        quit();
        break;
    }
  }
}

export const keybindingManager = new KeybindingManager();
