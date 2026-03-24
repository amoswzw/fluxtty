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

export class TerminalPane {
  readonly el: HTMLElement;
  readonly paneId: number;
  private term: Terminal;
  private fitAddon: FitAddon;
  private unlisten: UnlistenFn | null = null;
  private unlistenClose: UnlistenFn | null = null;
  private resizeObserver: ResizeObserver;
  private onClose: (id: number) => void;
  private info: PaneInfo;


  constructor(info: PaneInfo, onClose: (id: number) => void) {
    this.paneId = info.id;
    this.info = info;
    this.onClose = onClose;

    this.el = this.buildDOM();

    const cfg = configContext.get();
    this.term = new Terminal({
      theme: configContext.getXtermTheme(cfg),
      fontFamily: cfg.font.normal.family + ", 'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize: cfg.font.size,
      cursorBlink: cfg.cursor.blinking,
      cursorStyle: cfg.cursor.style.toLowerCase() as 'block' | 'underline' | 'bar',
      scrollback: cfg.scrolling.history,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());

    // Vi scroll mode: intercept keys before they reach the PTY
    this.term.attachCustomKeyEventHandler((e) => this.handleViKey(e));

    const termContainer = this.el.querySelector('.term-container') as HTMLElement;
    this.term.open(termContainer);
    // fit() is intentionally NOT called here — the element is not yet in the DOM.
    // WaterfallArea calls fit() after appendChild.

    // Handle user input → send to PTY
    this.term.onData((data) => {
      invoke('pty_write', { args: { pane_id: this.paneId, data } }).catch(console.error);
    });

    // Handle resize
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(termContainer);

    // Subscribe to PTY data events
    this.subscribeToEvents();

    // Config changes
    configContext.onChange((cfg) => {
      this.term.options.theme = configContext.getXtermTheme(cfg);
      this.term.options.fontSize = cfg.font.size;
      this.term.options.fontFamily = cfg.font.normal.family + ", 'JetBrains Mono', 'Fira Code', Consolas, monospace";
      this.term.refresh(0, this.term.rows - 1);
      this.fitAddon.fit();
    });

    // Close button
    this.el.querySelector('.pane-close')?.addEventListener('click', () => {
      this.destroy();
    });

    // Click anywhere on pane → set active and enter terminal mode.
    // xterm.js captures focus on click regardless; sync modeManager to match.
    this.el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.pane-close')) return;
      sessionManager.setActivePane(this.paneId);
      modeManager.enterTerminal(this.paneId);
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
        <button class="pane-note-btn" tabindex="-1" title="Note (m)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <line x1="3" y1="4" x2="9" y2="4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
            <line x1="3" y1="6.5" x2="9" y2="6.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
            <line x1="3" y1="9" x2="6.5" y2="9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="pane-close" tabindex="-1">✕</button>
      </div>
      <div class="pane-note-strip" style="display:none">
        <textarea class="pane-note-textarea" placeholder="Add a note… (Esc to save)" spellcheck="false" readonly></textarea>
      </div>
      <div class="term-container"></div>
    `;

    // Populate user-controlled fields safely
    (el.querySelector('.pane-name') as HTMLElement).textContent = this.info.name;
    (el.querySelector('.pane-group-badge') as HTMLElement).textContent =
      this.info.group !== 'default' ? this.info.group : '';
    const cwdEl = el.querySelector('.pane-cwd') as HTMLElement;
    cwdEl.textContent = this.shortenPath(this.info.cwd);
    cwdEl.setAttribute('title', this.info.cwd);

    const noteBtn   = el.querySelector('.pane-note-btn')     as HTMLButtonElement;
    const noteStrip = el.querySelector('.pane-note-strip')   as HTMLElement;
    const noteTA    = el.querySelector('.pane-note-textarea') as HTMLTextAreaElement;

    noteTA.value = this.info.note ?? '';
    this.syncNoteUI(noteBtn, noteStrip, noteTA.value, false);

    noteBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      noteStrip.classList.contains('editing')
        ? this.closeNoteEditor(noteBtn, noteStrip, noteTA)
        : this.openNoteEditor(noteBtn, noteStrip, noteTA);
    });

    // Click the read-only strip to edit
    noteStrip.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (!noteStrip.classList.contains('editing')) {
        this.openNoteEditor(noteBtn, noteStrip, noteTA);
      }
    });

    noteTA.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeNoteEditor(noteBtn, noteStrip, noteTA);
    });

    noteTA.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement !== noteTA) {
          this.closeNoteEditor(noteBtn, noteStrip, noteTA);
        }
      }, 120);
    });

    return el;
  }

  openNote() {
    const noteBtn   = this.el.querySelector('.pane-note-btn')     as HTMLButtonElement;
    const noteStrip = this.el.querySelector('.pane-note-strip')   as HTMLElement;
    const noteTA    = this.el.querySelector('.pane-note-textarea') as HTMLTextAreaElement;
    this.openNoteEditor(noteBtn, noteStrip, noteTA);
  }

  private openNoteEditor(btn: HTMLButtonElement, strip: HTMLElement, ta: HTMLTextAreaElement) {
    strip.style.display = 'flex';
    strip.classList.add('editing');
    ta.readOnly = false;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    btn.classList.add('has-note');
    this.fit();
  }

  private closeNoteEditor(btn: HTMLButtonElement, strip: HTMLElement, ta: HTMLTextAreaElement) {
    strip.classList.remove('editing');
    ta.readOnly = true;
    const hasContent = ta.value.trim().length > 0;
    strip.style.display = hasContent ? 'flex' : 'none';
    btn.classList.toggle('has-note', hasContent);
    sessionManager.setPaneNote(this.paneId, ta.value).catch(console.error);
    this.fit();
    // Return focus to the InputBar so Normal mode keys work immediately
    document.dispatchEvent(new CustomEvent('focus-inputbar'));
  }

  private syncNoteUI(btn: HTMLButtonElement, strip: HTMLElement, text: string, editing: boolean) {
    const hasContent = text.trim().length > 0;
    strip.style.display = (hasContent || editing) ? 'flex' : 'none';
    strip.classList.toggle('editing', editing);
    btn.classList.toggle('has-note', hasContent);
  }

  private shortenPath(p: string): string {
    const home = '/Users/';
    if (p.startsWith(home)) return '~/' + p.slice(home.indexOf('/', home.length - 1) + 1 || home.length);
    return p.length > 30 ? '…' + p.slice(-28) : p;
  }

  private async subscribeToEvents() {
    this.unlisten = await listen<{ pane_id: number; data: string }>(
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
    );

    // When agent is detected, update session info.
    // InputBar refreshes automatically via sessionManager.onChange listener.
    agentDetector.onAgentChange(this.paneId, (agent) => {
      sessionManager.setPaneAgent(this.paneId, agent);
    });

    this.unlistenClose = await listen(`pty-closed-${this.paneId}`, () => {
      this.term.write('\r\n\x1b[33m[Process exited]\x1b[0m\r\n');
    });
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

    // Sync note strip (don't overwrite textarea while user is actively editing)
    const noteBtn   = this.el.querySelector('.pane-note-btn')     as HTMLButtonElement;
    const noteStrip = this.el.querySelector('.pane-note-strip')   as HTMLElement;
    const noteTA    = this.el.querySelector('.pane-note-textarea') as HTMLTextAreaElement;
    if (!noteStrip.classList.contains('editing')) {
      noteTA.value = info.note ?? '';
      this.syncNoteUI(noteBtn, noteStrip, info.note ?? '', false);
    }
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
    this.resizeObserver.disconnect();
    if (this.unlisten) this.unlisten();
    if (this.unlistenClose) this.unlistenClose();
    this.term.dispose();
    this.el.remove();
    await invoke('pty_kill', { paneId: this.paneId });
    this.onClose(this.paneId);
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

  // All keys in terminal mode pass through to the PTY.
  // Scrolling is handled from Normal mode (j/k/gg/G/Ctrl+D/U/F/B).
  private handleViKey(_e: KeyboardEvent): boolean {
    return true;
  }

}
