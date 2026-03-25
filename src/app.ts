import { getCurrentWindow } from '@tauri-apps/api/window';
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
  keybindingManager.init({
    waterfallArea,
    sidebar,
    quit: () => void getCurrentWindow().close(),
  });


  // Session count in header
  sessionManager.onChange((panes) => {
    const countEl = header.querySelector('.header-session-count');
    if (countEl) {
      const running = panes.filter(p => p.status === 'running').length;
      countEl.textContent = `${panes.length} sessions · ${running} running`;
    }
  });

  // Spawn initial pane
  await waterfallArea.spawnPane({ newRow: true });

  // Ensure AI input bar has focus after everything loads.
  // Must be after spawnPane so any term.focus() side effects are overridden.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      inputBar.focus();
    });
  });
}

function buildHeader(): HTMLElement {
  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
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
