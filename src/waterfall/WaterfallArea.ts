import { invoke } from '@tauri-apps/api/core';
import { TerminalPane } from './TerminalPane';
import { sessionManager } from '../session/SessionManager';
import { modeManager } from '../input/ModeManager';
import { configContext } from '../config/ConfigContext';
import { nameFromCwd, isDefaultName, markAutoNamed, isAutoNamed } from '../session/AutoNamer';
import { hintManager } from '../hints/HintManager';

const WATERFALL_ROW_GAP = 5;
const PANE_HEADER_HEIGHT = 30;
const ROW_BORDER_Y = 2;
const TERM_PADDING_X = 8;
const TERM_PADDING_Y = 8;
const PANE_RESIZE_HANDLE_WIDTH = 6;
const MIN_PTY_COLS = 20;
const MIN_PTY_ROWS = 8;
type WorkspaceScrollModifier = 'meta' | 'control' | 'alt' | 'shift' | 'disabled';

export class WaterfallArea {
  readonly el: HTMLElement;
  private panes: Map<number, TerminalPane> = new Map();
  private rowEls: HTMLElement[] = [];
  private rowNotes: Map<HTMLElement, string> = new Map();
  private layoutObserver: ResizeObserver;
  private scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextPaneId = 1;
  private prevCwd: Map<number, string> = new Map();
  private lastPointerPos: { x: number; y: number } | null = null;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'waterfall-area';
    container.appendChild(this.el);
    this.layoutObserver = new ResizeObserver(() => this.recalcRowHeights());
    this.layoutObserver.observe(this.el);
    this.el.addEventListener('scroll', () => this.scheduleEdgeSettle(), { passive: true });

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

    document.addEventListener('mousemove', (e) => {
      this.lastPointerPos = { x: e.clientX, y: e.clientY };
      if (this.isWorkspaceScrollModifierHeld(e)) {
        this.syncHoveredPaneFromPointer();
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
      if (this.isWorkspaceScrollModifierHeld(e)) {
        this.syncHoveredPaneFromPointer();
      }
    }, true);

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
      const activeId = sessionManager.getActivePaneId();
      if (activeId == null) return;
      const pane = this.panes.get(activeId);
      if (!pane) return;
      const rowEl = pane.el.parentElement as HTMLElement;
      this.openRowNote(rowEl);
    });

    document.addEventListener('scroll-to-active-pane', () => {
      const activeId = sessionManager.getActivePaneId();
      if (activeId != null) this.scrollToPane(activeId);
    });
    document.addEventListener('workspace-wheel-scroll', (e: Event) => {
      const { deltaPixels, paneId, clientX, clientY } = (e as CustomEvent<{
        deltaPixels: number;
        paneId?: number;
        clientX?: number;
        clientY?: number;
      }>).detail;
      this.routeWorkspaceWheel(deltaPixels, paneId, clientX, clientY);
    });

    // Normal-mode vi scroll: j/k/gg/G/Ctrl+D/U/F/B dispatch this event
    document.addEventListener('normal-vi-scroll', (e: Event) => {
      const { cmd } = (e as CustomEvent<{ cmd: string }>).detail;
      switch (cmd) {
        case 'top':
          this.jumpWorkspaceBoundary('top');
          return;
        case 'bottom':
          this.jumpWorkspaceBoundary('bottom');
          return;
      }

      const pane = this.getActivePane();
      if (!pane) return;
      switch (cmd) {
        case 'lineDown':  pane.scrollBy(1);  break;
        case 'lineUp':    pane.scrollBy(-1); break;
        case 'halfDown':  pane.scrollBy(Math.floor(pane.rows / 2));  break;
        case 'halfUp':    pane.scrollBy(-Math.floor(pane.rows / 2)); break;
        case 'pageDown':  pane.scrollBy(pane.rows);  break;
        case 'pageUp':    pane.scrollBy(-pane.rows); break;
      }
    });
  }

  private jumpWorkspaceBoundary(direction: 'top' | 'bottom') {
    const targetPaneId = this.pickBoundaryPane(direction);
    if (targetPaneId != null && sessionManager.getActivePaneId() !== targetPaneId) {
      void sessionManager.setActivePane(targetPaneId);
    }
    if (direction === 'top') this.scrollWorkspaceToTop();
    else this.scrollWorkspaceToBottom();
  }

  private pickBoundaryPane(direction: 'top' | 'bottom'): number | null {
    const rows = this.getPanesByDOMRow();
    if (rows.length === 0) return null;
    const targetRow = direction === 'top' ? rows[0] : rows[rows.length - 1];
    if (!targetRow || targetRow.length === 0) return null;

    const activeId = sessionManager.getActivePaneId();
    const activeEl = activeId != null ? this.getPane(activeId)?.el ?? null : null;
    if (!activeEl || targetRow.length === 1) return targetRow[0].id;

    const activeRect = activeEl.getBoundingClientRect();
    const activeCenter = activeRect.left + activeRect.width / 2;
    let targetId = targetRow[0].id;
    let minDist = Infinity;
    for (const pane of targetRow) {
      const el = this.getPane(pane.id)?.el;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const dist = Math.abs((rect.left + rect.width / 2) - activeCenter);
      if (dist < minDist) {
        minDist = dist;
        targetId = pane.id;
      }
    }
    return targetId;
  }

  private scrollWorkspaceToTop() {
    this.el.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private scrollWorkspaceToBottom() {
    const maxScrollTop = Math.max(this.el.scrollHeight - this.el.clientHeight, 0);
    this.el.scrollTo({ top: maxScrollTop, behavior: 'smooth' });
  }

  private recalcRowHeights() {
    const bottomOcclusion = this.getBottomOcclusion();
    this.el.style.setProperty('--workspace-bottom-safe-gap', `${bottomOcclusion}px`);
    const containerH = this.el.clientHeight || (window.innerHeight - 36 - 42);
    const cfg = configContext.get();
    const rowCount = this.rowEls.length;

    let rowHeight: number;
    if (cfg.waterfall.row_height_mode === 'fixed') {
      rowHeight = cfg.waterfall.fixed_row_height * 16;
    } else {
      // Two-phase layout:
      // Phase 1: rows fit on screen, divide height evenly.
      // Phase 2: rows stop shrinking once they hit the minimum useful height;
      // the workspace remains scrollable in a classic waterfall layout.
      const MIN_LINES = 18;
      const paneChromeH = PANE_HEADER_HEIGHT + ROW_BORDER_Y + TERM_PADDING_Y;
      const lineH = cfg.font.size * 1.2;
      const threshold = paneChromeH + Math.ceil(MIN_LINES * lineH);
      const overhead = cfg.window.padding.y * 2 + (rowCount > 1 ? WATERFALL_ROW_GAP * (rowCount - 1) : 0);
      const idealOuterHeight = rowCount > 0 ? Math.floor((containerH - overhead) / rowCount) : containerH;
      rowHeight = idealOuterHeight >= threshold ? idealOuterHeight : threshold;
    }

    for (const rowEl of this.rowEls) {
      rowEl.style.height = `${rowHeight}px`;
    }

    for (const pane of this.panes.values()) {
      pane.fit();
    }
  }

  private scrollRowWindowIntoView(rowEl: HTMLElement, behavior: ScrollBehavior = 'smooth') {
    const bottomOcclusion = this.getBottomOcclusion();
    this.el.style.setProperty('--workspace-bottom-safe-gap', `${bottomOcclusion}px`);
    if (this.el.scrollHeight <= this.el.clientHeight + 1) {
      rowEl.scrollIntoView({ behavior, block: 'nearest' });
      return;
    }

    const targetIndex = this.rowEls.indexOf(rowEl);
    if (targetIndex < 0) {
      rowEl.scrollIntoView({ behavior, block: 'nearest' });
      return;
    }

    const paddingY = configContext.get().window.padding.y;
    const visibleH = Math.max(this.el.clientHeight - paddingY * 2, 1);
    const rowHeight = Math.max(
      rowEl.getBoundingClientRect().height || rowEl.clientHeight || Math.round(parseFloat(rowEl.style.height || '0')),
      1,
    );
    const rowsPerViewport = Math.max(1, Math.floor((visibleH + WATERFALL_ROW_GAP) / (rowHeight + WATERFALL_ROW_GAP)));
    const maxStart = Math.max(this.rowEls.length - rowsPerViewport, 0);
    const startIndex = Math.min(Math.max(targetIndex - rowsPerViewport + 1, 0), maxStart);
    const top = Math.max(this.rowEls[startIndex].offsetTop - paddingY, 0);
    this.el.scrollTo({ top, behavior });
  }

  private getBottomOcclusion(): number {
    if (!this.isCompactMode()) return 0;
    const inputBarEl = document.querySelector('.input-bar-wrapper') as HTMLElement | null;
    if (!inputBarEl) return 0;
    const overlap = Math.ceil(this.el.getBoundingClientRect().bottom - inputBarEl.getBoundingClientRect().top);
    return Math.max(overlap, 0);
  }

  private isCompactMode(): boolean {
    return !!configContext.get().window.compact_mode;
  }

  private shouldSnapRows(): boolean {
    return this.isCompactMode() || !!configContext.get().waterfall.scroll_snap;
  }

  private shouldAutoSettleRows(): boolean {
    const cfg = configContext.get();
    return !!cfg.waterfall.scroll_snap;
  }

  private scheduleEdgeSettle() {
    if (!this.shouldAutoSettleRows()) return;
    if (this.scrollSettleTimer) clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = setTimeout(() => {
      this.scrollSettleTimer = null;
      this.snapScrollToNearestRow();
    }, 80);
  }

  private snapScrollToNearestRow() {
    if (this.rowEls.length === 0) return;
    const maxScrollTop = Math.max(this.el.scrollHeight - this.el.clientHeight, 0);
    if (maxScrollTop <= 0) return;
    const snapPoints = this.getRowSnapPoints();
    const currentTop = this.el.scrollTop;
    let targetTop = snapPoints[0];
    let minDist = Math.abs(currentTop - targetTop);
    for (let i = 1; i < snapPoints.length; i += 1) {
      const dist = Math.abs(currentTop - snapPoints[i]);
      if (dist < minDist) {
        minDist = dist;
        targetTop = snapPoints[i];
      }
    }
    if (Math.abs(targetTop - currentTop) > 1) {
      this.el.scrollTo({ top: targetTop, behavior: 'auto' });
    }
  }

  private getRowSnapPoints(): number[] {
    const maxScrollTop = Math.max(this.el.scrollHeight - this.el.clientHeight, 0);
    const paddingY = configContext.get().window.padding.y;
    return this.rowEls
      .map(rowEl => Math.max(rowEl.offsetTop - paddingY, 0))
      .concat(maxScrollTop);
  }

  private routeWorkspaceWheel(deltaPixels: number, paneId?: number, clientX?: number, clientY?: number) {
    if (deltaPixels === 0) return;
    const hoveredPaneId = this.syncHoveredPaneFromPointer(clientX, clientY);
    const targetPaneId = hoveredPaneId ?? paneId;
    if (targetPaneId != null && Number.isFinite(targetPaneId) && sessionManager.getActivePaneId() !== targetPaneId) {
      void sessionManager.setActivePane(targetPaneId);
    }

    const scaledDelta = deltaPixels * Math.max(1, configContext.get().scrolling.multiplier || 1);
    this.el.scrollBy({ top: scaledDelta, behavior: 'auto' });
    if (this.lastPointerPos) {
      requestAnimationFrame(() => {
        this.syncHoveredPaneFromPointer(this.lastPointerPos?.x, this.lastPointerPos?.y);
      });
    }
  }

  private normalizeScrollModifier(value: string | null | undefined): WorkspaceScrollModifier {
    const normalized = (value ?? '').toLowerCase();
    switch (normalized) {
      case 'meta':
      case 'control':
      case 'alt':
      case 'shift':
      case 'disabled':
        return normalized as WorkspaceScrollModifier;
      default:
        return 'meta';
    }
  }

  private shouldRouteWheelToWorkspace(e: WheelEvent): boolean {
    switch (this.normalizeScrollModifier(configContext.get().input.workspace_scroll_modifier)) {
      case 'meta':
        return e.metaKey;
      case 'control':
        return e.ctrlKey;
      case 'alt':
        return e.altKey;
      case 'shift':
        return e.shiftKey;
      case 'disabled':
      default:
        return false;
    }
  }

  private isWorkspaceScrollModifierHeld(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
    switch (this.normalizeScrollModifier(configContext.get().input.workspace_scroll_modifier)) {
      case 'meta':
        return e.metaKey;
      case 'control':
        return e.ctrlKey;
      case 'alt':
        return e.altKey;
      case 'shift':
        return e.shiftKey;
      case 'disabled':
      default:
        return false;
    }
  }

  private syncHoveredPaneFromPointer(x = this.lastPointerPos?.x, y = this.lastPointerPos?.y): number | null {
    if (x == null || y == null) return null;
    this.lastPointerPos = { x, y };
    const paneId = this.pickPaneFromPoint(x, y);
    if (paneId != null && Number.isFinite(paneId) && sessionManager.getActivePaneId() !== paneId) {
      void sessionManager.setActivePane(paneId);
    }
    return paneId != null && Number.isFinite(paneId) ? paneId : null;
  }

  private pickPaneFromPoint(x: number, y: number): number | null {
    const hovered = document.elementFromPoint(x, y) as HTMLElement | null;
    const hoveredPaneId = this.paneIdFromElement(hovered?.closest('.terminal-pane') as HTMLElement | null);
    if (hoveredPaneId != null) return hoveredPaneId;

    const containerRect = this.el.getBoundingClientRect();
    if (x < containerRect.left || x > containerRect.right || y < containerRect.top || y > containerRect.bottom) {
      return null;
    }

    let targetRow: HTMLElement | null = null;
    let bestVerticalDistance = Infinity;
    for (const rowEl of this.rowEls) {
      const rowRect = rowEl.getBoundingClientRect();
      if (rowRect.bottom < containerRect.top || rowRect.top > containerRect.bottom) continue;
      const verticalDistance = y < rowRect.top ? rowRect.top - y : y > rowRect.bottom ? y - rowRect.bottom : 0;
      if (verticalDistance < bestVerticalDistance) {
        bestVerticalDistance = verticalDistance;
        targetRow = rowEl;
        if (verticalDistance === 0) break;
      }
    }
    return targetRow ? this.pickPaneInRow(targetRow, x) : null;
  }

  private pickPaneInRow(rowEl: HTMLElement, x: number): number | null {
    const paneEls = Array.from(rowEl.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('terminal-pane'));
    if (paneEls.length === 0) return null;

    for (const paneEl of paneEls) {
      const rect = paneEl.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right) {
        const paneId = this.paneIdFromElement(paneEl);
        if (paneId != null) return paneId;
      }
    }

    let targetPaneId = this.paneIdFromElement(paneEls[0]);
    let bestHorizontalDistance = Infinity;
    for (const paneEl of paneEls) {
      const rect = paneEl.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const distance = Math.abs(center - x);
      if (distance < bestHorizontalDistance) {
        bestHorizontalDistance = distance;
        targetPaneId = this.paneIdFromElement(paneEl);
      }
    }
    return targetPaneId;
  }

  private paneIdFromElement(paneEl: HTMLElement | null): number | null {
    const paneId = paneEl?.dataset.paneId ? Number(paneEl.dataset.paneId) : null;
    return paneId != null && Number.isFinite(paneId) ? paneId : null;
  }

  private wheelDeltaToPixels(e: WheelEvent): number {
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return e.deltaY * configContext.get().font.size * 1.2;
    }
    if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return e.deltaY * (this.el.clientHeight || window.innerHeight);
    }
    return e.deltaY;
  }

  private handleRowWheel(e: WheelEvent) {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target) return;

    // Terminal content has its own explicit wheel routing in TerminalPane.
    // Still cancel the browser's default scroll-chain here so workspace
    // scrolling can never leak through when the terminal is at an edge.
    if (target.closest('.term-container') || target.closest('.xterm')) {
      if (!this.shouldRouteWheelToWorkspace(e)) {
        e.preventDefault();
      }
      return;
    }

    const deltaPixels = this.wheelDeltaToPixels(e);
    if (deltaPixels === 0) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (this.shouldRouteWheelToWorkspace(e)) {
      const paneEl = target.closest('.terminal-pane') as HTMLElement | null;
      const paneId = paneEl?.dataset.paneId ? Number(paneEl.dataset.paneId) : null;
      hintManager.record({ type: 'workspace-scroll-used' });
      document.dispatchEvent(new CustomEvent('workspace-scroll-used'));
      e.preventDefault();
      e.stopPropagation();
      this.routeWorkspaceWheel(deltaPixels, paneId ?? undefined, e.clientX, e.clientY);
      return;
    }

    const noteTextarea = target.closest('.row-note-textarea') as HTMLTextAreaElement | null;
    if (noteTextarea) {
      e.preventDefault();
      e.stopPropagation();
      noteTextarea.scrollTop += deltaPixels;
      return;
    }

    // Pane headers, resize handles, note chrome, and row background should
    // never scroll the outer workspace unless the modifier is held.
    e.preventDefault();
    e.stopPropagation();
  }

  private attachRowInteractions(row: HTMLElement) {
    row.addEventListener('wheel', (e) => this.handleRowWheel(e), { passive: false, capture: true });
  }

  private createRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'terminal-row';
    this.attachRowInteractions(row);
    this.el.appendChild(row);
    this.rowEls.push(row);
    this.attachRowNote(row);
    this.recalcRowHeights();
    return row;
  }

  /** Insert a new row immediately after the row at afterIndex.
   *  Falls back to appending if afterIndex is out of range. */
  private insertRowAfter(afterIndex: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'terminal-row';
    this.attachRowInteractions(row);
    if (afterIndex >= 0 && afterIndex < this.rowEls.length) {
      this.rowEls[afterIndex].insertAdjacentElement('afterend', row);
      this.rowEls.splice(afterIndex + 1, 0, row);
    } else {
      this.el.appendChild(row);
      this.rowEls.push(row);
    }
    this.attachRowNote(row);
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

    const existingTermCount = this.getTerminalPanes(row).length;
    const { cols: estCols, rows: estRows } = this.estimatePaneSize(
      row,
      opts.newRow ? 1 : existingTermCount + 1,
    );

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
    this.refreshRowLayout(row);

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
      this.scrollRowWindowIntoView(row, 'smooth');
    }, 50);

    return pane;
  }

  private handlePaneClose(id: number, prevRow: HTMLElement | null) {
    const fallback = this.pickFallbackPane(id, prevRow);

    this.panes.delete(id);
    this.prevCwd.delete(id);
    // Remove empty rows; sync resize handles on rows that still have panes
    this.rowEls = this.rowEls.filter(row => {
      const termPanes = this.getTerminalPanes(row);
      if (termPanes.length === 0) {
        this.rowNotes.delete(row);
        row.remove();
        return false;
      }
      this.refreshRowLayout(row);
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
      const rowEl = pane.el.parentElement as HTMLElement | null;
      if (rowEl?.classList.contains('terminal-row') && this.shouldSnapRows()) {
        this.scrollRowWindowIntoView(rowEl, 'smooth');
      } else {
        pane.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
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
          .filter(c => (c as HTMLElement).classList.contains('terminal-pane'))
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

  getRowNote(rowEl: HTMLElement): string {
    return this.rowNotes.get(rowEl) ?? '';
  }

  setRowNote(rowEl: HTMLElement, text: string) {
    this.rowNotes.set(rowEl, text);
    this._syncNoteBtn(rowEl, text);
    const existing = rowEl.querySelector('.row-note-pane') as HTMLElement | null;
    if (existing) {
      const ta = existing.querySelector('.row-note-textarea') as HTMLTextAreaElement;
      if (ta && ta.value !== text) ta.value = text;
    } else if (text.trim().length > 0) {
      // Auto-open the note pane when restoring content.
      this.openRowNote(rowEl);
    }
  }

  /** Returns rows with their note text, for snapshot building. */
  getRowsWithNotes(): { rowEl: HTMLElement; note: string; panes: { id: number }[] }[] {
    return this.rowEls.map(rowEl => ({
      rowEl,
      note: this.rowNotes.get(rowEl) ?? '',
      panes: Array.from(rowEl.children)
        .filter(c => (c as HTMLElement).classList.contains('terminal-pane'))
        .map(child => {
          for (const [id, pane] of this.panes) {
            if (pane.el === child) return { id };
          }
          return null;
        })
        .filter((p): p is { id: number } => p !== null),
    })).filter(r => r.panes.length > 0);
  }

  private attachRowNote(rowEl: HTMLElement) {
    this.rowNotes.set(rowEl, '');
    const btn = document.createElement('button');
    btn.className = 'row-note-toggle';
    btn.title = 'Toggle note (m)';
    btn.textContent = '✎';
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleRowNote(rowEl);
    });
    rowEl.appendChild(btn);
  }

  toggleRowNote(rowEl: HTMLElement) {
    const existing = rowEl.querySelector('.row-note-pane') as HTMLElement | null;
    existing ? this._closeNotePaneEl(rowEl, existing) : this.openRowNote(rowEl);
  }

  openRowNote(rowEl: HTMLElement) {
    if (rowEl.querySelector('.row-note-pane')) {
      // Already open — just focus the textarea
      (rowEl.querySelector('.row-note-textarea') as HTMLTextAreaElement)?.focus();
      return;
    }

    const noteWidth = configContext.get().waterfall.note_width ?? 280;

    const pane = document.createElement('div');
    pane.className = 'row-note-pane';
    pane.style.flex = `0 0 ${noteWidth}px`;
    pane.innerHTML = `
      <div class="row-note-header">
        <span class="row-note-title">note</span>
        <span class="row-note-spacer"></span>
        <button class="row-note-close" tabindex="-1">✕</button>
      </div>
      <div class="row-note-body">
        <textarea class="row-note-textarea" placeholder="Add a note…" spellcheck="false"></textarea>
      </div>`;

    // Keep notes pinned at the far right edge of the row.
    const handle = this._createResizeHandle('note');
    rowEl.appendChild(handle);
    rowEl.appendChild(pane);
    this.refreshRowLayout(rowEl);
    this.recalcRowHeights();

    const ta = pane.querySelector('.row-note-textarea') as HTMLTextAreaElement;
    ta.value = this.rowNotes.get(rowEl) ?? '';
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    ta.addEventListener('input', () => {
      this.rowNotes.set(rowEl, ta.value);
      this._syncNoteBtn(rowEl, ta.value);
    });

    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this._closeNotePaneEl(rowEl, pane);
    });

    pane.querySelector('.row-note-close')?.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this._closeNotePaneEl(rowEl, pane);
    });

    pane.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  private _closeNotePaneEl(rowEl: HTMLElement, pane: HTMLElement) {
    const ta = pane.querySelector('.row-note-textarea') as HTMLTextAreaElement;
    const text = ta?.value ?? '';
    this.rowNotes.set(rowEl, text);
    this._syncNoteBtn(rowEl, text);
    // Keep the pane visible if it has content — only truly close when empty.
    if (text.trim().length > 0) {
      document.dispatchEvent(new CustomEvent('focus-inputbar'));
      return;
    }
    // Remove associated resize handle (immediately preceding sibling)
    const prev = pane.previousElementSibling;
    if (prev?.classList.contains('pane-resize-handle')) prev.remove();
    pane.remove();
    this.refreshRowLayout(rowEl);
    this.recalcRowHeights();
    document.dispatchEvent(new CustomEvent('focus-inputbar'));
  }

  private _syncNoteBtn(rowEl: HTMLElement, text: string) {
    rowEl.dataset.hasNote = text.trim().length > 0 ? 'true' : '';
  }

  private getTerminalPanes(rowEl: HTMLElement): HTMLElement[] {
    return Array.from(rowEl.children).filter(
      c => (c as HTMLElement).classList.contains('terminal-pane')
    ) as HTMLElement[];
  }

  private refreshRowLayout(rowEl: HTMLElement) {
    for (const pane of this.getTerminalPanes(rowEl)) {
      pane.style.flex = '1 1 0';
    }
    this._syncPaneResizeHandles(rowEl);
  }

  private estimatePaneSize(rowEl: HTMLElement, nextTerminalCount: number): { cols: number; rows: number } {
    const cfg = configContext.get();
    const charW = Math.max(cfg.font.size * 0.6, 1);
    const charH = Math.max(cfg.font.size * 1.2, 1);
    const notePane = rowEl.querySelector('.row-note-pane') as HTMLElement | null;
    const noteWidth = notePane
      ? Math.round(notePane.getBoundingClientRect().width) || (cfg.waterfall.note_width ?? 0)
      : 0;
    const handleCount = Math.max(0, nextTerminalCount - 1) + (notePane ? 1 : 0);
    const rowWidth = rowEl.clientWidth || this.el.clientWidth || window.innerWidth;
    const fallbackRowCount = Math.max(this.rowEls.length, 1);
    const fallbackGap = fallbackRowCount > 1 ? WATERFALL_ROW_GAP * (fallbackRowCount - 1) : 0;
    const fallbackOuterHeight = Math.round(parseFloat(rowEl.style.height || '0'))
      || Math.max(Math.floor((this.el.clientHeight - fallbackGap) / fallbackRowCount), 1);
    const rowInnerHeight = rowEl.clientHeight
      || Math.max(fallbackOuterHeight - ROW_BORDER_Y, 1);
    const paneWidth = Math.max(
      Math.floor((rowWidth - noteWidth - handleCount * PANE_RESIZE_HANDLE_WIDTH) / Math.max(nextTerminalCount, 1)),
      1,
    );
    const termWidth = Math.max(paneWidth - TERM_PADDING_X, 1);
    const termHeight = Math.max(rowInnerHeight - PANE_HEADER_HEIGHT - TERM_PADDING_Y, 1);

    return {
      cols: Math.max(Math.floor(termWidth / charW), MIN_PTY_COLS),
      rows: Math.max(Math.floor(termHeight / charH), MIN_PTY_ROWS),
    };
  }

  /** Create a drag-resize handle element.
   *
   *  'note'  — sits left of the note pane; dragging it resizes the note pane
   *            AND the immediately adjacent terminal pane to its left so the
   *            row never overflows.
   *  'pane'  — sits between two terminal panes; dragging resizes both.
   *
   *  Widths are captured at mousedown from the live layout, so this is
   *  safe to call before or after the browser has performed layout.
   */
  private _createResizeHandle(role: 'note' | 'pane'): HTMLElement {
    const handle = document.createElement('div');
    handle.className = 'pane-resize-handle';
    handle.dataset.role = role;

    handle.addEventListener('mousedown', (startEvt) => {
      startEvt.preventDefault();
      startEvt.stopPropagation();

      const startX = startEvt.clientX;
      const minWidth = configContext.get().waterfall.pane_min_width ?? 150;

      if (role === 'note') {
        // Note pane is to the RIGHT of this handle.
        // The terminal pane immediately to the LEFT absorbs the size change.
        const notePane = handle.nextElementSibling as HTMLElement | null;
        const termPane = handle.previousElementSibling as HTMLElement | null;
        if (!notePane || !termPane) return;

        // Capture current widths from live layout
        const startNoteW = notePane.getBoundingClientRect().width;
        const startTermW = termPane.getBoundingClientRect().width;
        const total = startNoteW + startTermW;

        // Pin both to explicit px so flex: 1 doesn't resist the drag
        notePane.style.flex = `0 0 ${startNoteW}px`;
        termPane.style.flex = `0 0 ${startTermW}px`;

        const onMove = (e: MouseEvent) => {
          // Dragging right grows the terminal and shrinks the note, while
          // keeping the pair width constant so the row never leaves a gap.
          const delta = e.clientX - startX;
          const newTermW = Math.max(minWidth, Math.min(total - minWidth, Math.round(startTermW + delta)));
          const newNoteW = total - newTermW;
          termPane.style.flex = `0 0 ${newTermW}px`;
          notePane.style.flex = `0 0 ${newNoteW}px`;
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          for (const p of this.panes.values()) p.fit();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      } else {
        // Between two terminal panes
        const leftPane = handle.previousElementSibling as HTMLElement | null;
        const rightPane = handle.nextElementSibling as HTMLElement | null;
        if (!leftPane || !rightPane) return;

        // Capture current widths from live layout
        const startLeftW = leftPane.getBoundingClientRect().width;
        const startRightW = rightPane.getBoundingClientRect().width;
        const total = startLeftW + startRightW;

        // Pin both to explicit px
        leftPane.style.flex = `0 0 ${startLeftW}px`;
        rightPane.style.flex = `0 0 ${startRightW}px`;

        const onMove = (e: MouseEvent) => {
          const delta = e.clientX - startX;
          const newLeftW = Math.max(minWidth, Math.min(total - minWidth, Math.round(startLeftW + delta)));
          const newRightW = total - newLeftW;
          leftPane.style.flex = `0 0 ${newLeftW}px`;
          rightPane.style.flex = `0 0 ${newRightW}px`;
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          for (const p of this.panes.values()) p.fit();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }
    });

    return handle;
  }

  /** Insert pane-to-pane resize handles between all terminal panes in a row.
   *  Does NOT set explicit widths — panes keep flex: 1 until the user drags. */
  private _syncPaneResizeHandles(rowEl: HTMLElement) {
    // Remove existing pane-to-pane handles
    rowEl.querySelectorAll('.pane-resize-handle[data-role="pane"]').forEach(h => h.remove());

    const termPanes = this.getTerminalPanes(rowEl);

    if (termPanes.length < 2) return;

    // Insert a handle before each terminal pane except the first
    for (let i = 1; i < termPanes.length; i++) {
      const handle = this._createResizeHandle('pane');
      rowEl.insertBefore(handle, termPanes[i]);
    }
  }
}
