import { invoke } from '@tauri-apps/api/core';
import type { InputMode, AgentType } from '../session/types';
import { AGENT_SLASH_COMMANDS } from '../session/types';
import { modeManager } from './ModeManager';
import { agentDetector } from './AgentDetector';
import { PaneSelector } from './PaneSelector';
import { sessionManager } from '../session/SessionManager';
import { aiHandler } from '../ai/ai-handler';
import { planExecutor } from '../ai/plan-executor';
import { suggestName, isSignificantCommand, isDefaultName, markAutoNamed, isAutoNamed } from '../session/AutoNamer';
import { configContext } from '../config/ConfigContext';

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

export class InputBar {
  readonly el: HTMLElement;
  private inputEl!: HTMLInputElement;
  private promptEl!: HTMLElement;
  private modeIndicatorEl!: HTMLElement;
  private logEl!: HTMLElement;
  private autocompleteEl!: HTMLElement;
  private paneSelector: PaneSelector;
  private logExpanded = false;
  private logHideTimer: ReturnType<typeof setTimeout> | null = null;

  // Local command history — navigated by ArrowUp/Down in insert mode
  private cmdHistory: string[] = [];
  private historyIdx = -1;
  private historyDraft = '';

  // Normal mode: gg double-key tracking
  private normalGgPending = false;
  private normalGgTimer: ReturnType<typeof setTimeout> | null = null;

  // Normal mode: inline command sub-state (activated by ':')
  private normalCommandActive = false;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'input-bar-wrapper';

    this.paneSelector = new PaneSelector(
      (paneId) => this.handlePaneSelected(paneId),
      () => this.handleSelectorCancel()
    );

    this.buildDOM();
    container.appendChild(this.el);

    modeManager.onChange((mode) => this.updateMode(mode));
    this.updateMode(modeManager.getMode());
    this.bindKeys();


    // Keep insert-mode prompt fresh whenever the active pane changes or its state changes
    sessionManager.onActiveChange(() => {
      if (modeManager.isInShellMode()) this.refreshInsertPrompt();
    });
    sessionManager.onChange(() => {
      if (modeManager.isInShellMode()) this.refreshInsertPrompt();
    });
  }

  private buildDOM() {
    this.logEl = document.createElement('div');
    this.logEl.className = 'ai-log';

    this.paneSelector.el.className += ' input-bar-selector';

    this.autocompleteEl = document.createElement('div');
    this.autocompleteEl.className = 'input-autocomplete';
    this.autocompleteEl.style.display = 'none';

    const row = document.createElement('div');
    row.className = 'input-bar';

    this.modeIndicatorEl = document.createElement('span');
    this.modeIndicatorEl.className = 'mode-indicator';

    this.promptEl = document.createElement('span');
    this.promptEl.className = 'input-prompt';

    this.inputEl = document.createElement('input');
    this.inputEl.className = 'input-field';
    this.inputEl.type = 'text';
    this.inputEl.spellcheck = false;
    this.inputEl.autocomplete = 'off';

    row.appendChild(this.modeIndicatorEl);
    row.appendChild(this.promptEl);
    row.appendChild(this.inputEl);

    this.el.appendChild(this.logEl);
    this.el.appendChild(this.paneSelector.el);
    this.el.appendChild(this.autocompleteEl);
    this.el.appendChild(row);
  }

  private bindKeys() {
    this.inputEl.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.inputEl.addEventListener('input', () => this.handleInput());
    this.inputEl.addEventListener('paste', (e) => this.handlePaste(e));
    document.addEventListener('keydown', (e) => this.handleGlobalKey(e), true);
    document.addEventListener('focus-inputbar', () => this.inputEl.focus());
  }

  private async handlePaste(e: ClipboardEvent) {
    const mode = modeManager.getMode();
    if (mode.type !== 'insert') return;

    const liveTyping = configContext.get().input.live_typing;
    if (!liveTyping) return; // buffered mode: text sits in field and is sent on Enter

    const text = e.clipboardData?.getData('text') ?? '';
    if (!text) return;

    await this.sendKeyToPTY(text);
    // Don't preventDefault — let browser update the input field for visual feedback
  }

  private handleGlobalKey(e: KeyboardEvent) {
    // Ctrl+\: toggle terminal (raw xterm) ↔ normal
    if (e.ctrlKey && e.key === '\\') {
      e.preventDefault();
      e.stopPropagation();
      modeManager.toggle();
      if (!modeManager.isInPaneMode()) this.inputEl.focus();
      return;
    }

    // In Normal mode, keypresses must reach the input bar regardless of where
    // focus currently is (e.g. after clicking a pane header, sidebar item, etc.).
    // Intercept here (capture phase), refocus, and forward to handleKeyDown.
    const mode = modeManager.getMode();
    const active = document.activeElement;
    const focusInTextEditor = active instanceof HTMLTextAreaElement
      || (active instanceof HTMLInputElement && active !== this.inputEl);
    if (mode.type === 'normal' && active !== this.inputEl && !focusInTextEditor && !this.paneSelector.isOpen()) {
      this.inputEl.focus();
      this.handleKeyDown(e);
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    // ── Pane selector navigation ──────────────────────────────────────
    if (this.paneSelector.isOpen()) {
      if (e.key === 'ArrowUp'   || e.key === 'k') { e.preventDefault(); this.paneSelector.moveUp();   return; }
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); this.paneSelector.moveDown(); return; }
      if (e.key === 'Enter')     { e.preventDefault(); this.paneSelector.confirmSelection(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); this.paneSelector.cancel();           return; }
      return;
    }

    const mode = modeManager.getMode();

    // ── Normal mode (vi normal) ───────────────────────────────────────
    if (mode.type === 'normal') {

      // ── Inline command sub-state (after pressing ':') ─────────────
      if (this.normalCommandActive) {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.exitNormalCommand();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const text = this.inputEl.value.trim();
          this.exitNormalCommand();
          if (text) {
            if (planExecutor.isWaitingForConfirm()) {
              planExecutor.handleConfirm(text).then(msg => {
                if (msg) this.logLine(msg, 'ai-response');
              });
            } else {
              this.submitAI(text);
            }
          }
          return;
        }
        if (e.key === 'ArrowUp')   { e.preventDefault(); this.autocompleteNavigate(-1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); this.autocompleteNavigate(1);  return; }
        if (e.key === 'Tab')       { e.preventDefault(); this.autocompleteAccept();      return; }
        // All other keys type into the input normally
        return;
      }

      // ── Navigation sub-state (default) ────────────────────────────
      e.preventDefault(); // block character input

      if (e.key === 'i') { this.clearNormalGg(); if (sessionManager.getActivePaneId() != null) modeManager.enterInsert(); return; }
      if (e.key === 'a') { this.clearNormalGg(); modeManager.enterAI();     return; }
      if (e.key === ':')    { this.clearNormalGg(); this.enterNormalCommand(); return; }
      if (e.key === '/')    { this.clearNormalGg(); this.inputEl.value = ''; this.paneSelector.open(''); return; }
      if (e.key === 'Escape') { this.clearNormalGg(); return; }

      if (!e.ctrlKey && !e.altKey) {
        if (e.key === 'h' || e.key === 'ArrowLeft')  { this.dispatchWorkspaceAction('FocusPrevPane'); return; }
        if (e.key === 'j' || e.key === 'ArrowDown')  { this.dispatchWorkspaceAction('FocusNextRow');  return; }
        if (e.key === 'k' || e.key === 'ArrowUp')    { this.dispatchWorkspaceAction('FocusPrevRow');  return; }
        if (e.key === 'l' || e.key === 'ArrowRight') { this.dispatchWorkspaceAction('FocusNextPane'); return; }
        if (e.key === 'w') { this.dispatchWorkspaceAction('FocusNextPane'); return; }
        if (e.key === 'W') { this.dispatchWorkspaceAction('FocusPrevPane'); return; }
        if (e.key === 'G') { this.dispatchViScroll('bottom'); return; }
        if (e.key === 'g') {
          if (this.normalGgPending) {
            clearTimeout(this.normalGgTimer!);
            this.normalGgPending = false;
            this.dispatchViScroll('top');
          } else {
            this.normalGgPending = true;
            this.normalGgTimer = setTimeout(() => { this.normalGgPending = false; }, 500);
          }
          return;
        }
        if (e.key === 'n') { this.dispatchWorkspaceAction('NewTerminal');          return; }
        if (e.key === 's') { this.dispatchWorkspaceAction('SplitHorizontal');      return; }
        if (e.key === 'q') { this.dispatchWorkspaceAction('ClosePane');            return; }
        if (e.key === 'b') { this.dispatchWorkspaceAction('ToggleSidebar');        return; }
        if (e.key === 'r') { this.dispatchWorkspaceAction('RenameCurrentSession'); return; }
        if (e.key === 'm') { document.dispatchEvent(new CustomEvent('open-pane-note')); return; }
      }

      if (e.ctrlKey) {
        if (e.key === 'd') { this.dispatchViScroll('halfDown'); return; }
        if (e.key === 'u') { this.dispatchViScroll('halfUp');   return; }
        if (e.key === 'f') { this.dispatchViScroll('pageDown'); return; }
        if (e.key === 'b') { this.dispatchViScroll('pageUp');   return; }
      }

      return;
    }

    // ── AI mode (free-form chat with Workspace AI) ───────────────────
    if (mode.type === 'ai') {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideAutocomplete();
        this.historyIdx = -1;
        modeManager.enterNormal();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.inputEl.value.trim();
        if (text) {
          if (this.cmdHistory.length === 0 || this.cmdHistory[this.cmdHistory.length - 1] !== text) {
            this.cmdHistory.push(text);
          }
          this.historyIdx = -1;
          this.historyDraft = '';
          this.inputEl.value = '';
          this.hideAutocomplete();
          if (planExecutor.isWaitingForConfirm()) {
            planExecutor.handleConfirm(text).then(msg => {
              if (msg) this.logLine(msg, 'ai-response');
            });
          } else {
            this.submitAI(text);
          }
        }
        return;
      }
      if (e.key === 'ArrowUp')   { e.preventDefault(); this.historyNavigate(-1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.historyNavigate(1);  return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (this.autocompleteItems.length > 0) {
          this.autocompleteNavigate(e.shiftKey ? -1 : 1);
        } else {
          this.showAICommandCompletions(this.inputEl.value);
        }
        return;
      }
      return;
    }

    // ── Insert mode (line editor → PTY) ──────────────────────────────
    if (mode.type === 'insert') {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideAutocomplete();
        this.historyIdx = -1;
        modeManager.enterNormal();
        return;
      }

      const liveTyping = configContext.get().input.live_typing;

      if (liveTyping) {
        // ── Live-typing: every keystroke forwarded to PTY immediately ──
        // Printable chars: browser updates input field, we also send to PTY
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
          this.sendKeyToPTY(e.key);
          return; // don't preventDefault — let browser add char to input field
        }
        if (e.key === 'Backspace') {
          this.sendKeyToPTY('\x7f');
          return; // don't preventDefault — let browser remove char from input field
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const text = this.inputEl.value;
          if (text.trim() && (this.cmdHistory.length === 0 || this.cmdHistory[this.cmdHistory.length - 1] !== text)) {
            this.cmdHistory.push(text);
          }
          this.historyIdx = -1;
          this.historyDraft = '';
          this.inputEl.value = '';
          this.sendKeyToPTY('\r');
          return;
        }
        // Arrow keys: clear input (shell will echo new state) + send escape seq
        if (e.key === 'ArrowUp')    { e.preventDefault(); this.inputEl.value = ''; this.sendKeyToPTY('\x1b[A'); return; }
        if (e.key === 'ArrowDown')  { e.preventDefault(); this.inputEl.value = ''; this.sendKeyToPTY('\x1b[B'); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); this.sendKeyToPTY('\x1b[C'); return; }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); this.sendKeyToPTY('\x1b[D'); return; }
        if (e.key === 'Tab')        { e.preventDefault(); this.sendKeyToPTY('\t');      return; }
        if (e.key === 'Delete')     { e.preventDefault(); this.sendKeyToPTY('\x1b[3~'); return; }
        if (e.key === 'Home')       { e.preventDefault(); this.sendKeyToPTY('\x1b[H'); return; }
        if (e.key === 'End')        { e.preventDefault(); this.sendKeyToPTY('\x1b[F'); return; }
        if (e.ctrlKey) {
          const ctrlMap: Record<string, string> = {
            c: '\x03', d: '\x04', a: '\x01', e: '\x05',
            k: '\x0b', u: '\x15', w: '\x17', l: '\x0c', r: '\x12',
          };
          const seq = ctrlMap[e.key.toLowerCase()];
          if (seq) {
            e.preventDefault();
            if (e.key === 'c' || e.key === 'u' || e.key === 'l' || e.key === 'r') {
              this.inputEl.value = ''; // these clear the line in the shell
            }
            this.sendKeyToPTY(seq);
            return;
          }
        }
        return;
      }

      // ── Buffered mode: submit on Enter (default) ───────────────────
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.autocompleteIdx >= 0) {
          this.autocompleteAccept();
        } else {
          this.submitToShell();
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (this.autocompleteItems.length > 0) {
          this.autocompleteNavigate(e.shiftKey ? -1 : 1);
        } else {
          const agent = this.activeAgent();
          if (agent !== 'none') {
            this.showAgentSlashCompletions(agent, this.inputEl.value);
          } else {
            this.triggerShellComplete();
          }
        }
        return;
      }
      if (e.key === 'ArrowUp')   { e.preventDefault(); this.historyNavigate(-1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.historyNavigate(1);  return; }
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        this.sendKeyToPTY('\x03');
        this.inputEl.value = '';
        this.historyIdx = -1;
        this.hideAutocomplete();
        return;
      }
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        this.sendKeyToPTY('\x04');
        return;
      }
      return;
    }

  }

  private clearNormalGg() {
    if (this.normalGgTimer) clearTimeout(this.normalGgTimer);
    this.normalGgPending = false;
    this.normalGgTimer = null;
  }

  private enterNormalCommand() {
    this.normalCommandActive = true;
    this.inputEl.readOnly = false;
    this.promptEl.textContent = ':';
    this.inputEl.placeholder = 'workspace command… (Enter execute, Esc cancel)';
    this.inputEl.focus();
  }

  private exitNormalCommand() {
    this.normalCommandActive = false;
    this.inputEl.value = '';
    this.inputEl.readOnly = true;
    this.hideAutocomplete();
    // Restore normal-mode display
    const pane = sessionManager.getActivePane();
    const name = pane?.name ?? '—';
    this.promptEl.textContent = '';
    this.inputEl.placeholder = `${name}  ·  i: insert  a: AI  /: find  hjkl: nav`;
  }

  private dispatchWorkspaceAction(action: string) {
    document.dispatchEvent(new CustomEvent('workspace-action', { detail: action }));
  }

  private dispatchViScroll(cmd: string) {
    document.dispatchEvent(new CustomEvent('normal-vi-scroll', { detail: { cmd } }));
  }

  private handleInput() {
    const mode = modeManager.getMode();

    // Normal mode navigation state: any character that slipped through gets cleared immediately
    if (mode.type === 'normal' && !this.normalCommandActive) {
      this.inputEl.value = '';
      return;
    }

    const val = this.inputEl.value;

    if (this.paneSelector.isOpen()) {
      this.paneSelector.filter(val.startsWith('/') ? val.slice(1) : val);
      return;
    }

    // ── AI mode input handling ───────────────────────────────────────
    if (mode.type === 'ai') {
      this.updateAutocomplete(val);
      return;
    }

    // ── Insert mode input handling ───────────────────────────────────
    if (mode.type === 'insert') {
      // / is a plain character (e.g. claude slash commands, paths)
      // Show agent slash completions as the user types /cmd
      if (val.startsWith('/')) {
        const agent = this.activeAgent();
        if (agent !== 'none') {
          this.showAgentSlashCompletions(agent, val);
        } else {
          if (this.autocompleteItems.length > 0) this.hideAutocomplete();
        }
        return;
      }
      if (this.autocompleteItems.length > 0) this.hideAutocomplete();
      return;
    }

    // ── Normal mode command sub-state autocomplete ───────────────────
    if (mode.type === 'normal' && this.normalCommandActive) {
      this.updateAutocomplete(val);
    }
  }

  // ── Shell submission ──────────────────────────────────────────────

  private async submitToShell() {
    const text = this.inputEl.value;
    if (!text.trim() && text === '') {
      // Empty Enter still sends newline (e.g. confirms prompts in shell/claude)
      const activeId = sessionManager.getActivePaneId();
      if (activeId == null) return;
      await invoke('pty_write', { args: { pane_id: activeId, data: '\r' } }).catch(console.error);
      return;
    }

    // Push to local history (avoid duplicate consecutive entries)
    if (text.trim() && (this.cmdHistory.length === 0 || this.cmdHistory[this.cmdHistory.length - 1] !== text)) {
      this.cmdHistory.push(text);
    }
    this.historyIdx = -1;
    this.historyDraft = '';

    this.inputEl.value = '';
    this.hideAutocomplete();

    const activeId = sessionManager.getActivePaneId();
    if (activeId == null) return;

    // Auto-name pane only for significant commands (AI agents, editors, interactive sessions).
    // Transient commands (ls, git, cd, npm run…) leave the cwd-derived name unchanged.
    if (isSignificantCommand(text.trim())) {
      const pane = sessionManager.getActivePane();
      if (pane && (isDefaultName(pane.name) || isAutoNamed(pane.id))) {
        const suggested = suggestName(text.trim(), pane.cwd);
        if (suggested) {
          sessionManager.renamePane(activeId, suggested);
          markAutoNamed(activeId);
        }
      }
    }

    await invoke('pty_write', { args: { pane_id: activeId, data: text + '\r' } }).catch(console.error);
    document.dispatchEvent(new CustomEvent('scroll-to-active-pane'));
  }

  private async sendKeyToPTY(data: string) {
    const activeId = sessionManager.getActivePaneId();
    if (activeId == null) return;
    await invoke('pty_write', { args: { pane_id: activeId, data } }).catch(console.error);
  }

  // ── Local command history ─────────────────────────────────────────

  private historyNavigate(dir: number) {
    if (this.cmdHistory.length === 0) return;

    if (this.historyIdx === -1) {
      // Starting to browse — save current draft
      this.historyDraft = this.inputEl.value;
    }

    const newIdx = this.historyIdx + dir;

    if (newIdx >= this.cmdHistory.length) {
      // Past the end — back to live draft
      this.historyIdx = -1;
      this.inputEl.value = this.historyDraft;
    } else if (newIdx < 0) {
      // Already at oldest — do nothing
    } else {
      this.historyIdx = newIdx;
      // History array is oldest-first; show newest first on ArrowUp
      const histPos = this.cmdHistory.length - 1 - this.historyIdx;
      this.inputEl.value = this.cmdHistory[histPos];
    }

    // Move cursor to end of input
    const len = this.inputEl.value.length;
    this.inputEl.setSelectionRange(len, len);
  }

  // ── Agent detection ───────────────────────────────────────────────

  private activeAgent(): AgentType {
    const pane = sessionManager.getActivePane();
    if (!pane) return 'none';
    // Live detector is authoritative; fall back to persisted session value
    const live = agentDetector.getAgent(pane.id);
    return live !== 'none' ? live : pane.agent_type;
  }

  // ── Agent slash completions ───────────────────────────────────────

  private showAgentSlashCompletions(agentType: AgentType, val: string) {
    const commands = AGENT_SLASH_COMMANDS[agentType] ?? [];
    const matches = val ? commands.filter(c => c.startsWith(val)) : commands;
    if (matches.length === 0) { this.hideAutocomplete(); return; }
    this.autocompletePrefix = '';
    this.showCompletions(matches);
  }

  // ── Pane selector callbacks ───────────────────────────────────────

  private handlePaneSelected(paneId: number) {
    this.inputEl.value = '';
    sessionManager.setActivePane(paneId);
    document.dispatchEvent(new CustomEvent('scroll-to-active-pane'));
    this.inputEl.focus();
    modeManager.enterNormal();
  }

  private handleSelectorCancel() {
    this.inputEl.value = '';
    this.inputEl.focus();
  }

  // ── AI submission ─────────────────────────────────────────────────

  private async submitAI(text: string) {
    this.logLine(`❯ ${text}`, 'ai-input');
    const response = await aiHandler.handle(text);
    // If the user switched away from AI mode while waiting, don't pop the log back up.
    if (!response) return;
    const inAI = modeManager.getMode().type === 'ai';
    if (inAI) {
      this.logLine(response, 'ai-response');
    } else {
      // Silently append to log without showing it
      const line = document.createElement('div');
      line.className = 'ai-log-line ai-response';
      line.textContent = response;
      this.logEl.appendChild(line);
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  logLine(text: string, cls = '') {
    const line = document.createElement('div');
    line.className = `ai-log-line ${cls}`;
    line.textContent = text;
    this.logEl.appendChild(line);
    this.logEl.scrollTop = this.logEl.scrollHeight;
    this.showLog();
  }

  private showLog() {
    if (this.logHideTimer) { clearTimeout(this.logHideTimer); this.logHideTimer = null; }
    this.logEl.classList.add('expanded');
    this.logExpanded = true;
  }

  private scheduleHideLog(delayMs = 4000) {
    if (this.logHideTimer) clearTimeout(this.logHideTimer);
    this.logHideTimer = setTimeout(() => {
      this.logEl.classList.remove('expanded');
      this.logExpanded = false;
      this.logHideTimer = null;
    }, delayMs);
  }

  // ── Mode rendering ────────────────────────────────────────────────

  private refreshInsertPrompt() {
    const pane = sessionManager.getActivePane();
    const name = pane?.name ?? 'shell';
    const busy = pane?.status === 'running';
    const agent = pane ? agentDetector.getAgent(pane.id) : 'none';

    const rowCount = sessionManager.getRowCount();
    const rowNum = pane
      ? sessionManager.getPanesByRow().findIndex(r => r.some(p => p.id === pane.id)) + 1
      : 1;

    this.promptEl.textContent = `${name}${busy ? ' ●' : ''} ❯`;
    this.promptEl.title = busy ? `${name} — running` : name;

    let modeText = 'INSERT';
    if (rowCount > 1) modeText += ` ${rowNum}/${rowCount}`;
    if (agent !== 'none') modeText += ` · ${agent}`;
    this.modeIndicatorEl.textContent = modeText;
    this.modeIndicatorEl.className = agent !== 'none'
      ? 'mode-indicator mode-insert mode-insert-agent'
      : 'mode-indicator mode-insert';

    this.inputEl.placeholder = agent !== 'none'
      ? `send to ${agent}… (/ slash cmds, Tab complete, Esc normal)`
      : busy
        ? 'running… (Ctrl+C interrupt, Esc normal)'
        : 'shell input… (Tab complete, Esc normal)';
  }

  private updateMode(mode: InputMode) {
    const prevMode = this.el.dataset.mode;
    this.el.dataset.mode = mode.type;
    document.body.dataset.mode = mode.type;
    this.inputEl.readOnly = false;
    this.hideAutocomplete();

    // Auto-hide log when leaving AI mode (collapse immediately on mode switch)
    if (prevMode === 'ai' && mode.type !== 'ai' && this.logExpanded) {
      this.scheduleHideLog(800);
    }

    // Leaving normal mode always cancels any in-progress command
    if (mode.type !== 'normal' && this.normalCommandActive) {
      this.normalCommandActive = false;
      this.inputEl.value = '';
    }

    switch (mode.type) {
      case 'normal': {
        const pane = sessionManager.getActivePane();
        const name = pane?.name ?? '—';
        this.promptEl.textContent = '';
        this.modeIndicatorEl.textContent = 'NORMAL';
        this.modeIndicatorEl.className = 'mode-indicator mode-normal';
        this.inputEl.placeholder = pane
          ? `${name}  ·  i: insert  a: AI  /: find  m: note  hjkl: nav`
          : 'n: new terminal  a: AI';
        this.inputEl.readOnly = true;
        this.inputEl.focus();
        break;
      }
      case 'ai': {
        this.inputEl.readOnly = false;
        this.promptEl.textContent = 'AI ❯';
        this.modeIndicatorEl.textContent = 'AI';
        this.modeIndicatorEl.className = 'mode-indicator mode-ai';
        this.inputEl.placeholder = planExecutor.isWaitingForConfirm()
          ? 'confirm plan: y to execute, n to cancel…'
          : 'ask workspace AI… (Tab: cmds, ↑↓: history, Esc: normal)';
        this.inputEl.focus();
        // Show log if it has content
        if (this.logEl.children.length > 0) this.showLog();
        break;
      }
      case 'insert': {
        this.inputEl.readOnly = false;
        this.refreshInsertPrompt();
        this.inputEl.focus();
        break;
      }
      case 'terminal': {
        const pane = sessionManager.getPane(mode.paneId);
        this.promptEl.textContent = `[${pane?.name ?? '?'}]`;
        this.modeIndicatorEl.textContent = 'TERMINAL';
        this.modeIndicatorEl.className = 'mode-indicator mode-terminal';
        this.inputEl.placeholder = 'Ctrl+\\ to return to normal';
        this.inputEl.readOnly = true;
        break;
      }
      case 'pane-selector': {
        this.inputEl.readOnly = false;
        this.promptEl.textContent = '/';
        this.modeIndicatorEl.textContent = 'FIND';
        this.modeIndicatorEl.className = 'mode-indicator mode-selector';
        this.inputEl.placeholder = 'fuzzy search sessions…';
        break;
      }
    }
  }

  // ── Autocomplete ──────────────────────────────────────────────────

  private autocompleteItems: string[] = [];
  private autocompleteIdx = -1;
  private autocompletePrefix = '';

  private readonly AI_COMMANDS = [
    'run ', 'list', 'status', 'help', 'split',
    'new ', 'close idle', 'rename ', 'move ',
    'broadcast ', 'close ',
  ];

  private updateAutocomplete(val: string) {
    if (!val) { this.hideAutocomplete(); return; }
    const suggestions = this.AI_COMMANDS.filter(s => s.startsWith(val));
    if (suggestions.length === 0) { this.hideAutocomplete(); return; }
    this.autocompletePrefix = '';
    this.showCompletions(suggestions);
  }

  private showAICommandCompletions(val: string) {
    const matches = val
      ? this.AI_COMMANDS.filter(s => s.startsWith(val))
      : this.AI_COMMANDS;
    if (matches.length === 0) return;
    this.autocompletePrefix = '';
    this.showCompletions(matches);
  }

  private async triggerShellComplete() {
    const input = this.inputEl.value;
    const pane = sessionManager.getActivePane();
    const cwd = pane?.cwd || '~';

    let completions: string[];
    try {
      completions = await invoke<string[]>('shell_complete', { args: { input, cwd } });
    } catch (e) {
      console.error('shell_complete error:', e);
      return;
    }
    if (completions.length === 0) return;

    const lastSpace = input.lastIndexOf(' ');
    const prefix = lastSpace >= 0 ? input.slice(0, lastSpace + 1) : '';
    const currentWord = lastSpace >= 0 ? input.slice(lastSpace + 1) : input;

    if (completions.length === 1) {
      const addSpace = !input.includes(' ') && !completions[0].endsWith('/');
      this.inputEl.value = prefix + completions[0] + (addSpace ? ' ' : '');
      this.hideAutocomplete();
      return;
    }

    const lcp = longestCommonPrefix(completions);
    if (lcp.length > currentWord.length) {
      this.inputEl.value = prefix + lcp;
    }
    this.autocompletePrefix = prefix;
    this.showCompletions(completions);
  }

  private showCompletions(items: string[]) {
    this.autocompleteItems = items;
    this.autocompleteIdx = -1;
    this.autocompleteEl.innerHTML = items.map((s, i) =>
      `<div class="ac-item" data-idx="${i}">${s}</div>`
    ).join('');
    this.autocompleteEl.style.display = 'flex';

    this.autocompleteEl.querySelectorAll('.ac-item').forEach(item => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = parseInt((item as HTMLElement).dataset.idx || '0');
        this.inputEl.value = this.autocompletePrefix + this.autocompleteItems[idx];
        this.hideAutocomplete();
        this.inputEl.focus();
      });
    });
  }

  private autocompleteNavigate(dir: number) {
    if (!this.autocompleteItems.length) return;
    this.autocompleteIdx = Math.max(0, Math.min(this.autocompleteItems.length - 1, this.autocompleteIdx + dir));
    this.autocompleteEl.querySelectorAll('.ac-item').forEach((item, i) => {
      item.classList.toggle('ac-selected', i === this.autocompleteIdx);
    });
  }

  private autocompleteAccept() {
    if (this.autocompleteIdx >= 0 && this.autocompleteItems[this.autocompleteIdx]) {
      this.inputEl.value = this.autocompletePrefix + this.autocompleteItems[this.autocompleteIdx];
    }
    this.hideAutocomplete();
  }

  private hideAutocomplete() {
    this.autocompleteEl.style.display = 'none';
    this.autocompleteItems = [];
    this.autocompleteIdx = -1;
    this.autocompletePrefix = '';
  }

  focus() {
    this.inputEl.focus();
  }
}
