import { invoke } from '@tauri-apps/api/core';
import { TerminalPane } from './TerminalPane';
import { sessionManager } from '../session/SessionManager';
import { modeManager } from '../input/ModeManager';
import { configContext } from '../config/ConfigContext';
import { nameFromCwd, isDefaultName, markAutoNamed, isAutoNamed } from '../session/AutoNamer';

export class WaterfallArea {
  readonly el: HTMLElement;
  private panes: Map<number, TerminalPane> = new Map();
  private rowEls: HTMLElement[] = [];
  private nextPaneId = 1;
  private prevCwd: Map<number, string> = new Map();

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'waterfall-area';
    container.appendChild(this.el);

    // React to session changes — also detect cwd changes for auto-renaming
    sessionManager.onChange((panes, activePaneId) => {
      for (const pane of this.panes.values()) {
        const info = panes.find(p => p.id === pane.paneId);
        if (info) {
          pane.updateInfo(info);

          // If cwd changed and this pane is auto-named, update name to new dir
          const prev = this.prevCwd.get(info.id);
          if (prev !== undefined && prev !== info.cwd && isAutoNamed(info.id)) {
            const newName = nameFromCwd(info.cwd);
            if (newName) sessionManager.renamePane(info.id, newName);
          }
          this.prevCwd.set(info.id, info.cwd);
        }
        pane.setActive(pane.paneId === activePaneId);
      }
    });

    sessionManager.onActiveChange((id) => {
      for (const pane of this.panes.values()) {
        pane.setActive(pane.paneId === id);
      }
    });

    window.addEventListener('resize', () => this.recalcRowHeights());

    // Font size adjustment (Ctrl+Plus / Ctrl+Minus / Ctrl+0)
    let currentFontSize = configContext.get().font.size;
    document.addEventListener('font-size-action', (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      const baseFontSize = configContext.get().font.size;
      if (action === 'ResetFontSize') {
        currentFontSize = baseFontSize;
      } else if (action === 'IncreaseFontSize') {
        currentFontSize = Math.min(currentFontSize + 1, 32);
      } else if (action === 'DecreaseFontSize') {
        currentFontSize = Math.max(currentFontSize - 1, 6);
      }
      for (const pane of this.panes.values()) {
        pane.setFontSize(currentFontSize);
      }
    });

    document.addEventListener('open-pane-note', () => {
      this.getActivePane()?.openNote();
    });

    document.addEventListener('scroll-to-active-pane', () => {
      const activeId = sessionManager.getActivePaneId();
      if (activeId != null) this.scrollToPane(activeId);
    });

    // Normal-mode vi scroll: j/k/gg/G/Ctrl+D/U/F/B dispatch this event
    document.addEventListener('normal-vi-scroll', (e: Event) => {
      const { cmd } = (e as CustomEvent<{ cmd: string }>).detail;
      const pane = this.getActivePane();
      if (!pane) return;
      switch (cmd) {
        case 'lineDown':  pane.scrollBy(1);  break;
        case 'lineUp':    pane.scrollBy(-1); break;
        case 'halfDown':  pane.scrollBy(Math.floor(pane.rows / 2));  break;
        case 'halfUp':    pane.scrollBy(-Math.floor(pane.rows / 2)); break;
        case 'pageDown':  pane.scrollBy(pane.rows);  break;
        case 'pageUp':    pane.scrollBy(-pane.rows); break;
        case 'top':       pane.scrollToTop();    break;
        case 'bottom':    pane.scrollToBottom(); break;
      }
    });
  }

  private recalcRowHeights() {
    const containerH = this.el.clientHeight || (window.innerHeight - 36 - 42);
    const cfg = configContext.get();
    const rowCount = this.rowEls.length;

    let rowH: number;
    if (cfg.waterfall.row_height_mode === 'fixed') {
      rowH = cfg.waterfall.fixed_row_height * 16;
    } else {
      // Two-phase layout:
      //  Phase 1 — rows fit on screen: divide height equally, no scrolling.
      //  Phase 2 — too many rows: each row = full container height, scroll
      //            one row at a time (classic waterfall paging).
      //
      // The threshold is computed from the actual font size so it scales
      // correctly across all screen sizes and resolutions:
      //   threshold = pane header + (MIN_LINES × line height)
      // A row below this height can't display enough useful terminal content.
      const MIN_LINES = 18;                          // minimum useful terminal lines per row
      const PANE_HEADER_H = 28;                      // matches pane header DOM height
      const lineH = cfg.font.size * 1.2;             // xterm default line height ratio
      const threshold = PANE_HEADER_H + Math.ceil(MIN_LINES * lineH);

      const GAP = 4; // matches gap: 4px in .waterfall-area CSS
      const paddingY = cfg.window.padding.y;
      const overhead = paddingY * 2 + (rowCount > 1 ? GAP * (rowCount - 1) : 0);
      const ideal = rowCount > 0 ? Math.floor((containerH - overhead) / rowCount) : containerH;
      // Phase 1: all rows fit — divide evenly, no scrolling needed.
      // Phase 2: too many rows — each row stays at threshold height,
      //          waterfall area scrolls. Window size never changes.
      rowH = ideal >= threshold ? ideal : threshold;
    }

    for (const rowEl of this.rowEls) {
      rowEl.style.height = `${rowH}px`;
    }

    for (const pane of this.panes.values()) {
      pane.fit();
    }
  }

  private createRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'terminal-row';
    this.el.appendChild(row);
    this.rowEls.push(row);
    this.recalcRowHeights();
    return row;
  }

  /** Insert a new row immediately after the row at afterIndex.
   *  Falls back to appending if afterIndex is out of range. */
  private insertRowAfter(afterIndex: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'terminal-row';
    if (afterIndex >= 0 && afterIndex < this.rowEls.length) {
      this.rowEls[afterIndex].insertAdjacentElement('afterend', row);
      this.rowEls.splice(afterIndex + 1, 0, row);
    } else {
      this.el.appendChild(row);
      this.rowEls.push(row);
    }
    this.recalcRowHeights();
    return row;
  }

  /** Find which row index (in rowEls) the active pane is currently in, via DOM. */
  private getActivePaneRowIndex(): number {
    const activeId = sessionManager.getActivePaneId();
    if (activeId != null) {
      const pane = this.panes.get(activeId);
      if (pane) {
        const idx = this.rowEls.indexOf(pane.el.parentElement as HTMLElement);
        if (idx >= 0) return idx;
      }
    }
    return Math.max(0, this.rowEls.length - 1);
  }

  private getOrCreateRow(rowIndex: number): HTMLElement {
    while (this.rowEls.length <= rowIndex) {
      this.createRow();
    }
    return this.rowEls[rowIndex];
  }

  async spawnPane(opts: { newRow: boolean; group?: string; cwd?: string; targetRow?: number; afterPaneId?: number }): Promise<TerminalPane | null> {
    const paneId = this.nextPaneId++;
    const cfg = configContext.get();

    // Inherit cwd from active pane for both new terminals and splits (unless explicitly overridden)
    const inheritedCwd = opts.cwd ?? sessionManager.getActivePane()?.cwd;

    let row: HTMLElement;
    let targetRowIndex: number;
    if (opts.newRow) {
      // Insert new row immediately after the active pane's row
      const activeRowIdx = this.getActivePaneRowIndex();
      row = this.insertRowAfter(activeRowIdx);
      targetRowIndex = this.rowEls.indexOf(row);
    } else {
      targetRowIndex = opts.targetRow ?? Math.max(0, this.rowEls.length - 1);
      row = this.getOrCreateRow(targetRowIndex);
    }

    const charW = cfg.font.size * 0.6;
    const charH = cfg.font.size * 1.2;
    const paneHeaderH = 28;
    const containerW = this.el.clientWidth || window.innerWidth;
    const containerH = this.el.clientHeight || (window.innerHeight - 78);
    const availW = containerW - 24;
    const availH = containerH - paneHeaderH - 12;
    const estCols = Math.max(Math.floor(availW / charW), 80);
    const estRows = Math.max(Math.floor(availH / charH), 24);

    try {
      await invoke('pty_spawn', {
        args: {
          pane_id: paneId,
          cwd: inheritedCwd || null,
          cols: estCols,
          rows: estRows,
          new_row: opts.newRow,
          target_row: targetRowIndex,
        }
      });
    } catch (e) {
      console.error('Failed to spawn PTY:', e);
      return null;
    }

    // Get pane info from session manager
    const allPanes = sessionManager.getAllPanes();
    const info = allPanes.find(p => p.id === paneId) || {
      id: paneId,
      name: `shell-${paneId}`,
      group: opts.group || 'default',
      note: '',
      status: 'idle' as const,
      cwd: opts.cwd || '~',
      pty_pid: 0,
      agent_type: 'none' as const,
      row_index: targetRowIndex,
      pane_index: 0,
    };

    const pane = new TerminalPane(info, (id, prevRow) => this.handlePaneClose(id, prevRow));
    this.panes.set(paneId, pane);
    // Insert after the active pane when splitting, otherwise append to end of row.
    // FitAddon needs the element in DOM before fit() is called.
    const afterEl = opts.afterPaneId != null
      ? this.panes.get(opts.afterPaneId)?.el ?? null
      : null;
    if (afterEl && afterEl.parentElement === row) {
      afterEl.insertAdjacentElement('afterend', pane.el);
    } else {
      row.appendChild(pane.el);
    }

    // Register pty-data and pty-closed listeners now, with await, so the
    // pty-closed handler is guaranteed to be active before we return.
    // If the PTY exits before this resolves, the event is queued by Tauri
    // and delivered once the listener is registered — no zombie sessions.
    await pane.subscribeToEvents();

    // Fit after browser has laid out the element
    requestAnimationFrame(() => {
      pane.fit();
      if (configContext.get().waterfall.new_pane_focus) {
        sessionManager.setActivePane(paneId);
        // Preserve Normal/Insert; Terminal/AI/selector don't apply to a fresh pane.
        const cur = modeManager.getMode().type;
        if (cur === 'insert') {
          modeManager.enterInsert();
        } else {
          modeManager.enterNormal();
        }
      }
      // Auto-name from cwd if still on default name
      const spawned = sessionManager.getPane(paneId);
      if (spawned) {
        this.prevCwd.set(paneId, spawned.cwd);
        if (isDefaultName(spawned.name)) {
          const cwdName = nameFromCwd(spawned.cwd);
          if (cwdName) {
            sessionManager.renamePane(paneId, cwdName);
            markAutoNamed(paneId);
          }
        }
      }
    });

    setTimeout(() => {
      pane.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);

    return pane;
  }

  private handlePaneClose(id: number, prevRow: HTMLElement | null) {
    const fallback = this.pickFallbackPane(id, prevRow);

    this.panes.delete(id);
    this.prevCwd.delete(id);
    // Remove empty rows
    this.rowEls = this.rowEls.filter(row => {
      if (row.children.length === 0) {
        row.remove();
        return false;
      }
      return true;
    });
    this.recalcRowHeights();

    if (this.panes.size === 0) {
      modeManager.enterNormal();
    } else if (fallback != null) {
      sessionManager.setActivePane(fallback);
      this.scrollToPane(fallback);
      // If we were in Terminal mode, transfer it to the new active pane.
      if (modeManager.getMode().type === 'terminal') {
        modeManager.enterTerminal(fallback);
      }
    }
  }

  /** Return the best pane to focus after `closedId` is removed.
   *  Prefers a sibling in the same row, then the preceding row, then any. */
  private pickFallbackPane(closedId: number, prevRow: HTMLElement | null): number | null {
    if (prevRow) {
      // Prefer sibling still in the same row
      for (const pane of this.panes.values()) {
        if (pane.paneId !== closedId && pane.el.parentElement === prevRow) {
          return pane.paneId;
        }
      }
      // Prefer pane in the preceding DOM row
      const rowIdx = this.rowEls.indexOf(prevRow);
      if (rowIdx > 0) {
        const aboveRow = this.rowEls[rowIdx - 1];
        for (const pane of this.panes.values()) {
          if (pane.paneId !== closedId && pane.el.parentElement === aboveRow) {
            return pane.paneId;
          }
        }
      }
      // Prefer pane in the following DOM row
      const rowIdxFwd = this.rowEls.indexOf(prevRow);
      if (rowIdxFwd >= 0 && rowIdxFwd < this.rowEls.length - 1) {
        const belowRow = this.rowEls[rowIdxFwd + 1];
        for (const pane of this.panes.values()) {
          if (pane.paneId !== closedId && pane.el.parentElement === belowRow) {
            return pane.paneId;
          }
        }
      }
    }
    // Last resort: any remaining pane
    for (const pane of this.panes.values()) {
      if (pane.paneId !== closedId) return pane.paneId;
    }
    return null;
  }

  getPane(id: number): TerminalPane | undefined {
    return this.panes.get(id);
  }

  getAllPanes(): TerminalPane[] {
    return Array.from(this.panes.values());
  }

  getActivePane(): TerminalPane | undefined {
    const activeId = sessionManager.getActivePaneId();
    return activeId != null ? this.panes.get(activeId) : undefined;
  }

  scrollToPane(id: number) {
    const pane = this.panes.get(id);
    if (pane) {
      pane.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  splitCurrentRow() {
    const targetRow = this.getActivePaneRowIndex();
    const afterPaneId = sessionManager.getActivePaneId() ?? undefined;
    this.spawnPane({ newRow: false, targetRow, afterPaneId });
  }

  /** Returns panes grouped by row in DOM visual order.
   *  Use this for navigation instead of sessionManager.getPanesByRow(),
   *  because row_index from Rust reflects spawn order, not DOM insertion order. */
  getPanesByDOMRow(): { id: number }[][] {
    return this.rowEls
      .map(rowEl =>
        Array.from(rowEl.children)
          .map(child => {
            for (const [id, pane] of this.panes) {
              if (pane.el === child) return { id };
            }
            return null;
          })
          .filter((p): p is { id: number } => p !== null)
      )
      .filter(row => row.length > 0);
  }
}
