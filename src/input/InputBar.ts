import type { InputMode, AgentType } from '../session/types';
import { AGENT_SLASH_COMMANDS } from '../session/types';
import { modeManager } from './ModeManager';
import { agentDetector } from './AgentDetector';
import { PaneSelector } from './PaneSelector';
import { sessionManager } from '../session/SessionManager';
import { aiHandler } from '../ai/ai-handler';
import { planExecutor } from '../ai/plan-executor';
import { configContext } from '../config/ConfigContext';
import { hintManager, type ActiveHint } from '../hints/HintManager';
import { transport } from '../transport';
import { workspaceActions } from '../workspace/WorkspaceActions';

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

function isEditableElement(el: Element | null): boolean {
  if (isXtermHelperInput(el)) return false;
  return el instanceof HTMLTextAreaElement
    || el instanceof HTMLInputElement
    || (el instanceof HTMLElement && el.isContentEditable);
}

function isXtermHelperInput(el: Element | null): boolean {
  if (!(el instanceof HTMLTextAreaElement)) return false;
  return el.classList.contains('xterm-helper-textarea');
}

function splitShellInputForCompletion(input: string): { prefix: string; currentWord: string } {
  let tokenStart = 0;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      tokenStart = i + 1;
    }
  }

  return {
    prefix: input.slice(0, tokenStart),
    currentWord: input.slice(tokenStart),
  };
}

export class InputBar {
  readonly el: HTMLElement;
  private inputEl!: HTMLInputElement;
  private promptEl!: HTMLElement;
  private modeIndicatorEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private hintBadgeEl!: HTMLElement;
  private hintTextEl!: HTMLElement;
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
  private isComposing = false;
  private compositionJustEnded = false;
  private liveTypingMirrorSynced = true;

  // Normal mode: inline command sub-state (activated by ':')
  private normalCommandActive = false;
  private lastModeType: InputMode['type'] | null = null;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'input-bar-wrapper';

    this.paneSelector = new PaneSelector(
      (paneId) => this.handlePaneSelected(paneId),
      () => this.handleSelectorCancel()
    );

    this.buildDOM();
    container.appendChild(this.el);

    hintManager.onChange((hint) => this.renderHint(hint));
    modeManager.onChange((mode) => {
      this.updateMode(mode);
      hintManager.record({ type: 'mode-changed', mode: mode.type, prevMode: this.lastModeType });
      this.lastModeType = mode.type;
    });
    const initialMode = modeManager.getMode();
    this.updateMode(initialMode);
    hintManager.record({ type: 'mode-changed', mode: initialMode.type, prevMode: null });
    this.lastModeType = initialMode.type;
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

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'input-hint';

    this.hintBadgeEl = document.createElement('span');
    this.hintBadgeEl.className = 'input-hint-badge';
    this.hintBadgeEl.textContent = 'Hint';

    this.hintTextEl = document.createElement('div');
    this.hintTextEl.className = 'input-hint-text';

    const hintCloseBtn = document.createElement('button');
    hintCloseBtn.className = 'input-hint-close';
    hintCloseBtn.type = 'button';
    hintCloseBtn.textContent = '✕';
    hintCloseBtn.title = 'Dismiss hint';
    hintCloseBtn.addEventListener('click', () => hintManager.dismissActive());

    this.hintEl.appendChild(this.hintBadgeEl);
    this.hintEl.appendChild(this.hintTextEl);
    this.hintEl.appendChild(hintCloseBtn);
    this.hintEl.addEventListener('mouseenter', () => hintManager.pauseActive());
    this.hintEl.addEventListener('mouseleave', () => hintManager.resumeActive());

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
    this.el.appendChild(this.hintEl);
    this.el.appendChild(row);
  }

  private bindKeys() {
    this.inputEl.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.inputEl.addEventListener('input', () => this.handleInput());
    this.inputEl.addEventListener('paste', (e) => this.handlePaste(e));
    this.inputEl.addEventListener('compositionstart', () => {
      this.isComposing = true;
    });
    this.inputEl.addEventListener('compositionend', (e) => this.handleCompositionEnd(e));
    // Single capture-phase listener on window (fires before document listeners,
    // including KeybindingManager). The document listener that was here is
    // redundant: after window's handler calls inputEl.focus(), the document
    // handler always sees active === inputEl and skips.
    window.addEventListener('keydown', (e) => this.handleGlobalKey(e), true);
    document.addEventListener('focus-inputbar', () => this.inputEl.focus());
  }

  private handleCompositionEnd(e: CompositionEvent) {
    this.isComposing = false;
    this.compositionJustEnded = true;
    const mode = modeManager.getMode();
    if (mode.type !== 'insert') return;
    if (!configContext.get().input.live_typing) return;
    if (!e.data) return;
    void this.sendKeyToPTY(e.data);
    if (!this.liveTypingMirrorSynced) {
      queueMicrotask(() => {
        if (!this.liveTypingMirrorSynced) this.inputEl.value = '';
      });
    }
  }

  private async handlePaste(e: ClipboardEvent) {
    const mode = modeManager.getMode();
    if (mode.type !== 'insert') return;

    const liveTyping = configContext.get().input.live_typing;
    if (!liveTyping) return; // buffered mode: text sits in field and is sent on Enter

    const text = e.clipboardData?.getData('text') ?? '';
    if (!text) return;

    if (!this.liveTypingMirrorSynced) e.preventDefault();
    await this.sendKeyToPTY(text);
    // Don't preventDefault — let browser update the input field for visual feedback
  }

  private markLiveTypingMirrorUnsynced() {
    this.liveTypingMirrorSynced = false;
    this.hideAutocomplete();
    this.inputEl.value = '';
  }

  private resetLiveTypingMirror() {
    this.liveTypingMirrorSynced = true;
    this.hideAutocomplete();
    this.inputEl.value = '';
  }

  private handleGlobalKey(e: KeyboardEvent) {
    // In Normal mode, keypresses must reach the input bar regardless of where
    // focus currently is (e.g. after clicking a pane header, sidebar item, etc.).
    // Intercept here (capture phase), refocus, and forward to handleKeyDown.
    const mode = modeManager.getMode();
    const active = document.activeElement;
    const target = e.target instanceof Element ? e.target : null;
    const focusInTextEditor = isEditableElement(active) || isEditableElement(target);
    if (active !== this.inputEl && !focusInTextEditor && !this.paneSelector.isOpen()) {
      if (mode.type === 'normal') {
        // Meta-modified keys are global app shortcuts (Quit, Settings, ClosePane…)
        // handled by KeybindingManager. Don't intercept them here — KeybindingManager
        // runs its own document capture listener AFTER this window listener, and it
        // checks e.defaultPrevented. If we call handleKeyDown first it calls
        // e.preventDefault() and KeybindingManager silently skips the shortcut.
        if (e.metaKey) return;
        this.inputEl.focus();
        this.handleKeyDown(e);
      } else if (mode.type === 'insert') {
        // Focus was stolen (e.g. clicking a close button). Re-anchor to inputEl
        // and forward the keystroke so nothing is lost.
        this.inputEl.focus();
        this.handleKeyDown(e);
      }
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    // After compositionend, the IME-confirming key (e.g. space, number) fires a
    // keydown with isComposing=false. Swallow single printable keys here to
    // prevent phantom spaces or digits from appearing in the input or being
    // forwarded to the PTY.
    if (this.compositionJustEnded && !e.isComposing) {
      this.compositionJustEnded = false;
      if (e.key.length === 1) {
        e.preventDefault();
        return;
      }
    } else {
      this.compositionJustEnded = false;
    }

    const composing = e.isComposing || this.isComposing;

    // ── Pane selector navigation ──────────────────────────────────────
    if (this.paneSelector.isOpen()) {
      if (composing) return;
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
        if (composing) return;
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
      if (e.key === '/')    { this.clearNormalGg(); this.inputEl.value = ''; modeManager.enterPaneSelector(); return; }
      if (e.key === 'Escape') { this.clearNormalGg(); return; }

      if (!e.ctrlKey && !e.altKey) {
        if (e.key === 'h' || e.key === 'ArrowLeft')  { this.noteNormalShortcut('h'); this.dispatchWorkspaceAction('FocusPrevPane'); return; }
        if (e.key === 'j' || e.key === 'ArrowDown')  { this.noteNormalShortcut('j'); this.dispatchWorkspaceAction('FocusNextRow');  return; }
        if (e.key === 'k' || e.key === 'ArrowUp')    { this.noteNormalShortcut('k'); this.dispatchWorkspaceAction('FocusPrevRow');  return; }
        if (e.key === 'l' || e.key === 'ArrowRight') { this.noteNormalShortcut('l'); this.dispatchWorkspaceAction('FocusNextPane'); return; }
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
        if (e.key === 'n') { this.noteNormalShortcut('n'); this.dispatchWorkspaceAction('NewTerminal');          return; }
        if (e.key === 's') { this.noteNormalShortcut('s'); this.dispatchWorkspaceAction('SplitHorizontal');      return; }
        if (e.key === 'q') { this.noteNormalShortcut('q'); this.dispatchWorkspaceAction('ClosePane');            return; }
        if (e.key === 'b') { this.dispatchWorkspaceAction('ToggleSidebar');        return; }
        if (e.key === 'r') { this.noteNormalShortcut('r'); this.dispatchWorkspaceAction('RenameCurrentSession'); return; }
        if (e.key === 'm') { this.noteNormalShortcut('m'); document.dispatchEvent(new CustomEvent('open-pane-note')); return; }
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
      if (composing) return;
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
      if (composing) return;
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
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
          if (!this.liveTypingMirrorSynced) e.preventDefault();
          this.sendKeyToPTY(e.key);
          return;
        }
        if (e.key === 'Backspace') {
          if (!this.liveTypingMirrorSynced) e.preventDefault();
          this.sendKeyToPTY('\x7f');
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (this.autocompleteIdx >= 0 && this.liveTypingMirrorSynced) {
            this.autocompleteAccept();
            return;
          }
          const text = this.liveTypingMirrorSynced ? this.inputEl.value : '';
          const activeId = sessionManager.getActivePaneId();
          if (text.trim() && (this.cmdHistory.length === 0 || this.cmdHistory[this.cmdHistory.length - 1] !== text)) {
            this.cmdHistory.push(text);
          }
          this.historyIdx = -1;
          this.historyDraft = '';
          this.resetLiveTypingMirror();
          this.sendKeyToPTY('\r');
          document.dispatchEvent(new CustomEvent('scroll-to-active-pane'));
          if (activeId != null) this.notifyInsertCommandSubmitted(text, activeId);
          return;
        }
        if (e.key === 'ArrowUp')    { e.preventDefault(); this.markLiveTypingMirrorUnsynced(); this.sendKeyToPTY('\x1b[A'); return; }
        if (e.key === 'ArrowDown')  { e.preventDefault(); this.markLiveTypingMirrorUnsynced(); this.sendKeyToPTY('\x1b[B'); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); this.markLiveTypingMirrorUnsynced(); this.sendKeyToPTY('\x1b[C'); return; }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); this.markLiveTypingMirrorUnsynced(); this.sendKeyToPTY('\x1b[D'); return; }
        if (e.key === 'Tab') {
          e.preventDefault();
          if (!this.liveTypingMirrorSynced) {
            this.hideAutocomplete();
            this.sendKeyToPTY('\t');
            return;
          }
          if (this.autocompleteItems.length > 0) {
            this.autocompleteNavigate(e.shiftKey ? -1 : 1);
          } else {
            const agent = this.activeAgent();
            if (this.inputEl.value.startsWith('/') && agent !== 'none') {
              this.showAgentSlashCompletions(agent, this.inputEl.value, true);
            } else {
              void this.triggerShellComplete(true);
            }
          }
          return;
        }
        if (e.key === 'Delete')     { e.preventDefault(); this.markLiveTypingMirrorUnsynced(); this.sendKeyToPTY('\x1b[3~'); return; }
        if (e.key === 'Home')       { e.preventDefault(); this.markLiveTypingMirrorUnsynced(); this.sendKeyToPTY('\x1b[H'); return; }
        if (e.key === 'End')        { e.preventDefault(); this.markLiveTypingMirrorUnsynced(); this.sendKeyToPTY('\x1b[F'); return; }
        if (e.ctrlKey) {
          const ctrlMap: Record<string, string> = {
            c: '\x03', d: '\x04', a: '\x01', e: '\x05',
            k: '\x0b', u: '\x15', w: '\x17', l: '\x0c', r: '\x12',
          };
          const seq = ctrlMap[e.key.toLowerCase()];
          if (seq) {
            e.preventDefault();
            if (e.key.toLowerCase() === 'c') {
              this.resetLiveTypingMirror();
            } else {
              this.markLiveTypingMirrorUnsynced();
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

  private notifyInsertCommandSubmitted(text: string, paneId: number) {
    const trimmed = text.trim();
    if (!trimmed) return;
    document.dispatchEvent(new CustomEvent('insert-command-submitted', {
      detail: { text: trimmed, paneId },
    }));
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
      if (configContext.get().input.live_typing && !this.liveTypingMirrorSynced) {
        if (val) this.inputEl.value = '';
        if (this.autocompleteItems.length > 0) this.hideAutocomplete();
        return;
      }
      // / is a plain character (e.g. claude slash commands, paths)
      // Show agent slash completions as the user types /cmd
      if (val.startsWith('/')) {
        const agent = this.activeAgent();
        if (agent !== 'none') {
          this.showAgentSlashCompletions(agent, val, !!configContext.get().input.live_typing);
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
    if (!text.trim()) {
      // Empty Enter still sends newline (e.g. confirms prompts in shell/claude)
      const activeId = sessionManager.getActivePaneId();
      if (activeId == null) return;
      await workspaceActions.dispatch({ type: 'write', target: String(activeId), data: '\r' }, { source: 'ui' }).catch(console.error);
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

    await workspaceActions.dispatch({ type: 'run', target: String(activeId), cmd: text }, { source: 'ui' }).catch(console.error);
    document.dispatchEvent(new CustomEvent('scroll-to-active-pane'));
    this.notifyInsertCommandSubmitted(text, activeId);
  }

  private async sendKeyToPTY(data: string) {
    const activeId = sessionManager.getActivePaneId();
    if (activeId == null) return;
    await workspaceActions.dispatch({ type: 'write', target: String(activeId), data }, { source: 'ui' }).catch(console.error);
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

  private showAgentSlashCompletions(agentType: AgentType, val: string, syncToPty = false) {
    const commands = AGENT_SLASH_COMMANDS[agentType] ?? [];
    const matches = val ? commands.filter(c => c.startsWith(val)) : commands;
    if (matches.length === 0) { this.hideAutocomplete(); return; }
    this.autocompletePrefix = '';
    this.autocompleteCurrentWord = val;
    this.autocompleteSyncToPty = syncToPty;
    this.showCompletions(matches);
  }

  // ── Pane selector callbacks ───────────────────────────────────────

  private handlePaneSelected(paneId: number) {
    this.inputEl.value = '';
    void workspaceActions.dispatch({ type: 'focus', target: String(paneId) }, { source: 'ui' });
    this.inputEl.focus();
    modeManager.enterNormal();
  }

  private handleSelectorCancel() {
    this.inputEl.value = '';
    modeManager.enterNormal();
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

  private renderHint(hint: ActiveHint | null) {
    if (!hint) {
      this.hintEl.classList.remove('visible');
      this.hintTextEl.replaceChildren();
      return;
    }
    this.hintTextEl.replaceChildren(...this.renderHintNodes(hint.text));
    this.hintEl.classList.add('visible');
  }

  private noteNormalShortcut(key: string) {
    hintManager.record({ type: 'normal-shortcut-used', key });
  }

  private renderHintNodes(text: string): Node[] {
    const parts = text.split(/(`[^`]+`)/g).filter(Boolean);
    return parts.map(part => {
      if (part.startsWith('`') && part.endsWith('`')) {
        const keycap = document.createElement('kbd');
        keycap.className = 'hint-keycap';
        keycap.textContent = part.slice(1, -1);
        return keycap;
      }
      return document.createTextNode(part);
    });
  }

  // ── Mode rendering ────────────────────────────────────────────────

  private refreshInsertPrompt() {
    const pane = sessionManager.getActivePane();
    const name = pane?.name ?? 'shell';
    const busy = pane?.status === 'running';
    const agent = pane ? agentDetector.getAgent(pane.id) : 'none';

    this.promptEl.textContent = `${name}${busy ? ' ●' : ''} ❯`;
    this.promptEl.title = busy ? `${name} — running` : name;

    let modeText = 'INSERT';
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

    // Keep pane selector in sync with mode state.
    if (mode.type === 'pane-selector') {
      if (!this.paneSelector.isOpen()) this.paneSelector.open('');
    } else {
      // Close without firing the cancel callback (which would re-enter normal).
      if (this.paneSelector.isOpen()) this.paneSelector.close();
    }

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
        if (configContext.get().input.live_typing && !this.liveTypingMirrorSynced) {
          this.resetLiveTypingMirror();
        }
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
  private autocompleteCurrentWord = '';
  private autocompleteSyncToPty = false;

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
    this.autocompleteCurrentWord = val;
    this.autocompleteSyncToPty = false;
    this.showCompletions(suggestions);
  }

  private showAICommandCompletions(val: string) {
    const matches = val
      ? this.AI_COMMANDS.filter(s => s.startsWith(val))
      : this.AI_COMMANDS;
    if (matches.length === 0) return;
    this.autocompletePrefix = '';
    this.autocompleteCurrentWord = val;
    this.autocompleteSyncToPty = false;
    this.showCompletions(matches);
  }

  private async triggerShellComplete(syncToPty = false) {
    const input = this.inputEl.value;
    const pane = sessionManager.getActivePane();
    const cwd = pane?.cwd || '~';

    let completions: string[];
    try {
      completions = await transport.send<string[]>('shell_complete', { args: { input, cwd } });
    } catch (e) {
      console.error('shell_complete error:', e);
      return;
    }
    if (completions.length === 0) {
      if (syncToPty) await this.sendKeyToPTY('\t');
      return;
    }

    const { prefix, currentWord } = splitShellInputForCompletion(input);
    let visibleWord = currentWord;

    if (completions.length === 1) {
      const addSpace = prefix.length === 0 && !completions[0].endsWith('/');
      this.inputEl.value = prefix + completions[0] + (addSpace ? ' ' : '');
      if (syncToPty) this.syncCompletionToPTY(currentWord, completions[0], addSpace);
      this.hideAutocomplete();
      return;
    }

    const lcp = longestCommonPrefix(completions);
    if (lcp.length > currentWord.length) {
      this.inputEl.value = prefix + lcp;
      visibleWord = lcp;
      if (syncToPty) this.syncCompletionToPTY(currentWord, lcp);
    }
    this.autocompletePrefix = prefix;
    this.autocompleteCurrentWord = visibleWord;
    this.autocompleteSyncToPty = syncToPty;
    this.showCompletions(completions);
  }

  private syncCompletionToPTY(currentWord: string, completedWord: string, addTrailingSpace = false) {
    if (!completedWord.startsWith(currentWord)) return;
    const delta = completedWord.slice(currentWord.length) + (addTrailingSpace ? ' ' : '');
    if (!delta) return;
    void this.sendKeyToPTY(delta);
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
        if (this.autocompleteSyncToPty) {
          this.syncCompletionToPTY(this.autocompleteCurrentWord, this.autocompleteItems[idx]);
        }
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
      if (this.autocompleteSyncToPty) {
        this.syncCompletionToPTY(this.autocompleteCurrentWord, this.autocompleteItems[this.autocompleteIdx]);
      }
    }
    this.hideAutocomplete();
  }

  private hideAutocomplete() {
    this.autocompleteEl.style.display = 'none';
    this.autocompleteItems = [];
    this.autocompleteIdx = -1;
    this.autocompletePrefix = '';
    this.autocompleteCurrentWord = '';
    this.autocompleteSyncToPty = false;
  }

  focus() {
    this.inputEl.focus();
  }
}
