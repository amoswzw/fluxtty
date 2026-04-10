import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { PaneInfo } from '../session/types';
import { configContext } from '../config/ConfigContext';
import { sessionManager } from '../session/SessionManager';
import { agentDetector } from '../input/AgentDetector';
import { modeManager } from '../input/ModeManager';
import { unmarkAutoNamed } from '../session/AutoNamer';
import { hintManager } from '../hints/HintManager';

// ── Module-level floating context menu (one singleton shared across panes) ──
let _ctxMenu: HTMLElement | null = null;
type WorkspaceScrollModifier = 'meta' | 'control' | 'alt' | 'shift' | 'disabled';

function getCtxMenu(): HTMLElement {
  if (!_ctxMenu) {
    _ctxMenu = document.createElement('div');
    _ctxMenu.className = 'pane-ctx-menu';
    _ctxMenu.style.display = 'none';
    document.body.appendChild(_ctxMenu);
    document.addEventListener('mousedown', (e) => {
      if (!_ctxMenu?.contains(e.target as Node)) _ctxMenu!.style.display = 'none';
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') _ctxMenu!.style.display = 'none';
    }, true);
  }
  return _ctxMenu;
}

function showCtxMenu(x: number, y: number, items: Array<{ label: string; action: () => void; danger?: boolean }>) {
  const menu = getCtxMenu();
  menu.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (item.danger ? ' ctx-danger' : '');
    btn.textContent = item.label;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      menu.style.display = 'none';
      item.action();
    });
    menu.appendChild(btn);
  }
  menu.style.display = 'flex';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth)  menu.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;
  });
}

export class TerminalPane {
  readonly el: HTMLElement;
  readonly paneId: number;
  private term: Terminal;
  private fitAddon: FitAddon;
  private termContainer!: HTMLElement;
  private termViewport: HTMLElement | null = null;
  private unlisten: UnlistenFn | null = null;
  private unlistenClose: UnlistenFn | null = null;
  private resizeObserver: ResizeObserver;
  private onClose: (id: number, prevRow: HTMLElement | null) => void;
  private destroyed = false;
  private info: PaneInfo;
  private workspaceScrollModifier: WorkspaceScrollModifier;


  constructor(info: PaneInfo, onClose: (id: number, prevRow: HTMLElement | null) => void) {
    this.paneId = info.id;
    this.info = info;
    this.onClose = onClose;

    this.el = this.buildDOM();

    const cfg = configContext.get();
    this.workspaceScrollModifier = this.normalizeScrollModifier(cfg.input.workspace_scroll_modifier);
    this.term = new Terminal({
      theme: configContext.getXtermTheme(cfg),
      fontFamily: `'${cfg.font.family}', 'Symbols Nerd Font Mono', 'JetBrains Mono', 'Fira Code', Consolas, monospace`,
      fontSize: cfg.font.size,
      cursorBlink: cfg.cursor.blinking,
      cursorStyle: cfg.cursor.style.toLowerCase() as 'block' | 'underline' | 'bar',
      cursorInactiveStyle: 'none',
      scrollback: cfg.scrolling.history,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());

    // Vi scroll mode: intercept keys before they reach the PTY
    this.term.attachCustomKeyEventHandler((e) => this.handleViKey(e));

    this.termContainer = this.el.querySelector('.term-container') as HTMLElement;
    this.term.open(this.termContainer);
    this.termViewport = this.termContainer.querySelector('.xterm-viewport');
    this.term.blur(); // no cursor until Terminal mode is entered via enterDirectMode()
    // fit() is intentionally NOT called here — the element is not yet in the DOM.
    // WaterfallArea calls fit() after appendChild.

    // Handle user input → send to PTY
    this.term.onData((data) => {
      invoke('pty_write', { args: { pane_id: this.paneId, data } }).catch(console.error);
    });

    // Handle resize
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.termContainer);
    this.termContainer.addEventListener('wheel', this.handleContainerWheel, { passive: false, capture: true });
    this.term.attachCustomWheelEventHandler(this.handleWheel);

    // subscribeToEvents() is NOT called here — WaterfallArea.spawnPane awaits
    // it explicitly so the pty-closed listener is registered before returning.

    // Config changes
    configContext.onChange((cfg) => {
      this.workspaceScrollModifier = this.normalizeScrollModifier(cfg.input.workspace_scroll_modifier);
      this.term.options.theme       = configContext.getXtermTheme(cfg);
      this.term.options.fontSize    = cfg.font.size;
      this.term.options.fontFamily  = `'${cfg.font.family}', 'Symbols Nerd Font Mono', 'JetBrains Mono', 'Fira Code', Consolas, monospace`;
      this.term.options.cursorBlink = cfg.cursor.blinking;
      this.term.options.cursorStyle = cfg.cursor.style.toLowerCase() as 'block' | 'underline' | 'bar';
      this.term.refresh(0, this.term.rows - 1);
      this.fitAddon.fit();
    });

    // Close button
    this.el.querySelector('.pane-close')?.addEventListener('click', () => {
      this.destroy();
    });

    // Click on pane header → set active only (no mode change).
    // Click on terminal content → set active and enter Insert mode so the
    // input bar is ready. Raw Terminal mode (Ctrl+\) is still entered explicitly.
    this.el.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pane-close')) return;
      sessionManager.setActivePane(this.paneId);
      if (!target.closest('.pane-header')) {
        modeManager.enterTerminal(this.paneId);
      }
    });
  }

  private buildDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'terminal-pane';
    el.dataset.paneId = String(this.paneId);

    // Build static structure with innerHTML (no user data here), then
    // set user-controlled values via textContent/setAttribute to prevent XSS.
    el.innerHTML = `
      <div class="pane-header">
        <span class="pane-status-dot"></span>
        <span class="pane-name"></span>
        <span class="pane-group-badge"></span>
        <span class="pane-agent-badge"></span>
        <span class="pane-spacer"></span>
        <span class="pane-cwd"></span>
        <button class="pane-close" tabindex="-1">✕</button>
      </div>
      <div class="term-container"></div>
    `;

    // Populate user-controlled fields safely
    const nameEl2 = el.querySelector('.pane-name') as HTMLElement;
    nameEl2.textContent = this.info.name;
    // Double-click pane name → inline rename
    nameEl2.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startInlineRename(nameEl2);
    });
    // Right-click pane header → context menu
    const header = el.querySelector('.pane-header') as HTMLElement;
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e.clientX, e.clientY, [
        {
          label: 'Enter Insert Mode',
          action: () => { sessionManager.setActivePane(this.paneId); modeManager.enterInsert(); },
        },
        {
          label: 'Split Row',
          action: () => document.dispatchEvent(new CustomEvent('workspace-action', { detail: 'SplitHorizontal' })),
        },
        {
          label: 'Rename…',
          action: () => {
            const nameEl = this.el.querySelector('.pane-name') as HTMLElement;
            this.startInlineRename(nameEl);
          },
        },
        { label: 'Note…', action: () => document.dispatchEvent(new CustomEvent('open-pane-note')) },
        { label: 'Close', action: () => this.destroy(), danger: true },
      ]);
    });
    (el.querySelector('.pane-group-badge') as HTMLElement).textContent =
      this.info.group !== 'default' ? this.info.group : '';
    const cwdEl = el.querySelector('.pane-cwd') as HTMLElement;
    cwdEl.textContent = this.shortenPath(this.info.cwd);
    cwdEl.setAttribute('title', this.info.cwd);

    return el;
  }

  private shortenPath(p: string): string {
    const home = '/Users/';
    if (p.startsWith(home)) return '~/' + p.slice(home.indexOf('/', home.length - 1) + 1 || home.length);
    return p.length > 30 ? '…' + p.slice(-28) : p;
  }

  async subscribeToEvents() {
    // Register both listeners in parallel so a fast-exiting PTY can't fire
    // pty-closed before the listener is registered.
    const [unlistenData, unlistenClose] = await Promise.all([
      listen<{ pane_id: number; data: string }>(
        `pty-data-${this.paneId}`,
        (event) => {
          const data = event.payload.data;
          this.term.write(data);
          // Feed to agent detector
          agentDetector.addOutput(this.paneId, data);
          // Auto-switch mode based on alternate screen escape sequences.
          // Three variants cover all curses/terminfo generations:
          //   ?1049h/l — modern (vim, neovim, htop, btop, lazygit, ranger, fzf, less, man, tig…)
          //   ?1047h/l — older ncurses programs
          //   ?47h/l   — original xterm alternate screen (mutt legacy, etc.)
          // Only act when this is the active pane.
          if (sessionManager.getActivePaneId() === this.paneId) {
            const entersAltScreen =
              data.includes('\x1b[?1049h') ||
              data.includes('\x1b[?1047h') ||
              data.includes('\x1b[?47h');
            const leavesAltScreen =
              data.includes('\x1b[?1049l') ||
              data.includes('\x1b[?1047l') ||
              data.includes('\x1b[?47l');
            if (entersAltScreen && modeManager.isInShellMode()) {
              modeManager.enterTerminal(this.paneId);
            } else if (leavesAltScreen && modeManager.isInPaneMode()) {
              modeManager.enterInsert();
            }
          }
        }
      ),
      listen(`pty-closed-${this.paneId}`, () => {
        this.term.write('\r\n\x1b[33m[Process exited]\x1b[0m\r\n');
        setTimeout(() => this.destroy(), 300);
      }),
    ]);

    this.unlisten = unlistenData;
    this.unlistenClose = unlistenClose;

    // When agent is detected, update session info.
    // InputBar refreshes automatically via sessionManager.onChange listener.
    agentDetector.onAgentChange(this.paneId, (agent) => {
      sessionManager.setPaneAgent(this.paneId, agent);
    });
  }

  /** Begin inline rename on the pane name element. */
  startInlineRename(nameEl: HTMLElement) {
    if (nameEl.contentEditable === 'true') return; // already editing
    const original = this.info.name;
    nameEl.contentEditable = 'true';
    nameEl.classList.add('renaming');
    nameEl.focus();
    // Select all text
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const commit = () => {
      const newName = (nameEl.textContent ?? '').trim();
      nameEl.contentEditable = 'false';
      nameEl.classList.remove('renaming');
      if (newName && newName !== original) {
        sessionManager.renamePane(this.paneId, newName);
        unmarkAutoNamed(this.paneId);
      } else {
        nameEl.textContent = original; // revert if empty or unchanged
      }
    };

    const cleanup = () => {
      nameEl.removeEventListener('keydown', onKey);
      nameEl.removeEventListener('blur', onBlur);
    };
    const onKey = (e: KeyboardEvent) => {
      // Always stop propagation so Normal-mode handlers don't see these keystrokes.
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); cleanup(); commit(); }
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        nameEl.textContent = original;
        nameEl.contentEditable = 'false';
        nameEl.classList.remove('renaming');
      }
    };
    const onBlur = () => { cleanup(); commit(); };
    nameEl.addEventListener('keydown', onKey);
    nameEl.addEventListener('blur', onBlur);
  }

  /** Public entry point for external callers (keybinding manager). */
  startRename() {
    const nameEl = this.el.querySelector('.pane-name') as HTMLElement;
    this.startInlineRename(nameEl);
  }

  updateInfo(info: PaneInfo) {
    this.info = info;
    const nameEl = this.el.querySelector('.pane-name') as HTMLElement;
    const groupEl = this.el.querySelector('.pane-group-badge') as HTMLElement;
    const cwdEl = this.el.querySelector('.pane-cwd') as HTMLElement;
    const dotEl = this.el.querySelector('.pane-status-dot') as HTMLElement;
    const agentEl = this.el.querySelector('.pane-agent-badge') as HTMLElement;

    nameEl.textContent = info.name;
    groupEl.textContent = info.group !== 'default' ? info.group : '';
    cwdEl.textContent = this.shortenPath(info.cwd);
    cwdEl.title = info.cwd;
    dotEl.dataset.status = info.status;
    agentEl.textContent = info.agent_type !== 'none' ? info.agent_type : '';
    agentEl.dataset.agent = info.agent_type;
  }

  setActive(active: boolean) {
    // Only visual highlight — do NOT steal keyboard focus.
    // Focus is granted explicitly by enterDirectMode() only.
    this.el.classList.toggle('active', active);
  }

  // Called by ModeManager: allow direct input to this pane
  enterDirectMode() {
    this.el.classList.add('direct-mode');
    this.term.focus();
  }

  // Called by ModeManager: pane goes to read-display-only
  exitDirectMode() {
    this.el.classList.remove('direct-mode');
    this.term.blur();
  }

  // Write data directly to PTY (for Workspace AI dispatch)
  async writeCommand(cmd: string) {
    await invoke('pty_write', { args: { pane_id: this.paneId, data: cmd + '\r' } });
  }

  fit() {
    try {
      this.fitAddon.fit();
      const { cols, rows } = this.term;
      invoke('pty_resize', { args: { pane_id: this.paneId, cols, rows } }).catch(console.error);
    } catch (_) {}
  }

  focus() {
    this.term.focus();
  }

  setFontSize(size: number) {
    this.term.options.fontSize = size;
    this.fitAddon.fit();
    const { cols, rows } = this.term;
    invoke('pty_resize', { args: { pane_id: this.paneId, cols, rows } }).catch(console.error);
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.termContainer.removeEventListener('wheel', this.handleContainerWheel, true);
    if (this.unlisten) this.unlisten();
    if (this.unlistenClose) this.unlistenClose();
    this.term.dispose();
    const prevRow = this.el.parentElement as HTMLElement | null;  // capture before removal
    this.el.remove();
    await invoke('pty_kill', { paneId: this.paneId });
    this.onClose(this.paneId, prevRow);
  }

  get rows(): number {
    return this.term.rows;
  }

  scrollBy(lines: number) {
    this.term.scrollLines(lines);
  }

  scrollToTop() {
    this.term.scrollToTop();
  }

  scrollToBottom() {
    this.term.scrollToBottom();
  }

  getInfo(): PaneInfo {
    return this.info;
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
    switch (this.workspaceScrollModifier) {
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

  private wheelDeltaToPixels(e: WheelEvent): number {
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return e.deltaY * this.term.options.fontSize! * 1.2;
    }
    if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      const workspace = this.el.closest('.waterfall-area') as HTMLElement | null;
      return e.deltaY * (workspace?.clientHeight || window.innerHeight);
    }
    return e.deltaY;
  }

  private scrollTerminalViewport(deltaPixels: number) {
    const viewport = this.termViewport ?? this.termContainer.querySelector('.xterm-viewport');
    if (viewport instanceof HTMLElement) {
      this.termViewport = viewport;
      viewport.scrollTop += deltaPixels;
      return;
    }
    const approxLineHeight = Math.max(1, (this.term.options.fontSize ?? 13) * 1.2);
    const lines = deltaPixels / approxLineHeight;
    if (Math.abs(lines) < 1) {
      this.term.scrollLines(deltaPixels > 0 ? 1 : -1);
      return;
    }
    this.term.scrollLines(lines > 0 ? Math.floor(lines) : Math.ceil(lines));
  }

  private routeWheel(e: WheelEvent, source: 'container' | 'xterm'): boolean {
    const deltaPixels = this.wheelDeltaToPixels(e);
    if (deltaPixels === 0) {
      return false;
    }

    const workspace = this.el.closest('.waterfall-area') as HTMLElement | null;
    if (this.shouldRouteWheelToWorkspace(e)) {
      if (!workspace) return false;
      hintManager.record({ type: 'workspace-scroll-used' });
      document.dispatchEvent(new CustomEvent('workspace-scroll-used'));
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('workspace-wheel-scroll', {
        detail: {
          deltaPixels,
          paneId: this.paneId,
          clientX: e.clientX,
          clientY: e.clientY,
        },
      }));
      return false;
    }

    // Leave alternate-screen apps (vim, tmux full-screen UIs, etc.) on xterm's
    // native path so wheel input still reaches the PTY as expected, but only
    // when the event actually occurred inside xterm's own DOM. Container
    // padding/edges should never leak out to the workspace.
    if (this.term.buffer.active.type === 'alternate') {
      if (source === 'xterm') {
        return true;
      }
      e.preventDefault();
      e.stopPropagation();
      return false;
    }

    hintManager.record({ type: 'terminal-wheel', withModifier: false });
    e.preventDefault();
    e.stopPropagation();
    this.scrollTerminalViewport(deltaPixels);
    return false;
  }

  private handleContainerWheel = (e: WheelEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    const inXterm = !!target?.closest('.xterm');

    // Full-screen terminal apps should keep xterm's native wheel handling so
    // scroll is translated into PTY input. Everything else inside the terminal
    // container is handled here first so it can never leak to the workspace.
    if (inXterm && this.term.buffer.active.type === 'alternate' && !this.shouldRouteWheelToWorkspace(e)) {
      return;
    }

    this.routeWheel(e, inXterm ? 'xterm' : 'container');
  };

  private handleWheel = (e: WheelEvent): boolean => {
    return this.routeWheel(e, 'xterm');
  };

  // All keys in terminal mode pass through to the PTY.
  private handleViKey(_e: KeyboardEvent): boolean {
    return true;
  }

}
