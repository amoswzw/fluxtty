import { invoke } from '@tauri-apps/api/core';
import { configContext } from '../config/ConfigContext';
import { llmClient } from '../ai/llm-client';

// ── helpers ───────────────────────────────────────────────────────────────────

function deepClone<T>(o: T): T { return JSON.parse(JSON.stringify(o)); }

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
function setPath(obj: any, path: string, value: any) {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => o[k], obj);
  if (target != null) target[last] = value;
}

function bindValuePreview(el: HTMLElement, apply: () => void) {
  el.addEventListener('input', apply);
  el.addEventListener('change', apply);

  if (el instanceof HTMLInputElement && el.type === 'color') {
    let pollTimer: number | null = null;
    let stopTimer: number | null = null;
    let lastValue = el.value;

    const cancelStopTimer = () => {
      if (stopTimer != null) { window.clearTimeout(stopTimer); stopTimer = null; }
    };
    const stopPolling = () => {
      cancelStopTimer();
      if (pollTimer != null) { window.clearInterval(pollTimer); pollTimer = null; }
    };
    const pollValue = () => {
      if (el.value !== lastValue) { lastValue = el.value; apply(); stopPolling(); }
    };
    const startPolling = () => {
      cancelStopTimer();
      if (el.value !== lastValue) { lastValue = el.value; apply(); return; }
      if (pollTimer == null) pollTimer = window.setInterval(pollValue, 80);
      stopTimer = window.setTimeout(stopPolling, 20_000);
    };

    el.addEventListener('pointerdown', startPolling);
    el.addEventListener('click', startPolling);
    el.addEventListener('focus', startPolling);
    el.addEventListener('blur', () => {
      if (pollTimer == null) return;
      cancelStopTimer();
      stopTimer = window.setTimeout(() => { pollValue(); stopPolling(); }, 1000);
    });
  }
}

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function syncThemePreview(preview: HTMLElement, cfg: any) {
  (preview.querySelector('.st-theme-preview-terminal') as HTMLElement).style.background = cfg.colors.primary.background;
  (preview.querySelector('.st-theme-preview-terminal') as HTMLElement).style.color = cfg.colors.primary.foreground;
  (preview.querySelector('.st-theme-preview-terminal') as HTMLElement).style.borderColor = cfg.colors.normal.blue;
  (preview.querySelector('.st-theme-preview-header') as HTMLElement).style.background = cfg.colors.normal.black;
  (preview.querySelector('.st-theme-preview-green') as HTMLElement).style.color = cfg.colors.normal.green;
  (preview.querySelector('.st-theme-preview-blue') as HTMLElement).style.color = cfg.colors.normal.blue;
  (preview.querySelector('.st-theme-preview-red') as HTMLElement).style.color = cfg.colors.normal.red;
  (preview.querySelector('.st-theme-preview-yellow') as HTMLElement).style.color = cfg.colors.normal.yellow;
}

// ── field / section types ─────────────────────────────────────────────────────

type FType = 'text' | 'number' | 'checkbox' | 'color' | 'select' | 'textarea' | 'fontfamily' | 'combobox';

interface F {
  path: string;
  label: string;
  type: FType;
  opts?: string[];          // for select / combobox suggestions
  min?: number; max?: number; step?: number;
  desc?: string;
  read?: (v: any) => string;
  write?: (s: string) => any;
}

type CustomRenderer = (cfg: any, el: HTMLElement, dirty: () => void) => void;

interface SectionGroup {
  label: string;
  fields?: F[];
  custom?: CustomRenderer;
}

interface Section {
  id: string;
  label: string;
  groups?: SectionGroup[];
  fields?: F[];             // flat list (no sub-headings)
  custom?: CustomRenderer;  // fully custom renderer
}

// ── constants ─────────────────────────────────────────────────────────────────

const ACTIONS = [
  'NewTerminal','SplitHorizontal','ClosePane','ToggleSidebar','ToggleInputMode',
  'EnterPane',
  'FocusPrevRow','FocusNextRow','FocusNextPane','FocusPrevPane',
  'RenameCurrentSession','GroupCurrentSession',
  'Quit','Copy','Paste','IncreaseFontSize','DecreaseFontSize','ResetFontSize',
  'OpenSettings',
];

const MOD_KEYS = ['Control', 'Shift', 'Alt'] as const;
type ModKey = typeof MOD_KEYS[number];
function formatMods(mods: Set<ModKey>): string | undefined {
  const ordered = MOD_KEYS.filter(m => mods.has(m));
  return ordered.length ? ordered.join('|') : undefined;
}
function kbLabel(key: string, mods: string | undefined): string {
  const parts: string[] = [];
  if (mods) for (const m of mods.split('|').map(s => s.trim())) {
    if (m.toLowerCase() === 'control') parts.push('Ctrl');
    else if (m) parts.push(m);
  }
  parts.push(key);
  return parts.join('+');
}

const KNOWN_PROVIDERS = [
  '',             // auto-detect from model name
  'anthropic',
  'openai',
  'google',
  'ollama',
  'claude-cli',
];

const KNOWN_MODELS = [
  'none',
  'claude-cli',
  // Anthropic
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  // OpenAI
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o3-mini',
  'o4-mini',
  // Google
  'gemini-2.0-flash',
  'gemini-2.5-pro',
  'gemini-1.5-pro',
  // Ollama (common local models)
  'ollama/llama3',
  'ollama/llama3.1',
  'ollama/mistral',
  'ollama/qwen2.5',
  'ollama/deepseek-r1',
  'ollama/phi4',
];

const KNOWN_THEMES = ['', 'default-dark', 'catppuccin-mocha', 'gruvbox-dark', 'solarized-dark'];

interface ThemeColors {
  primary: { background: string; foreground: string };
  cursor:  { text: string; cursor: string };
  normal:  Record<string, string>;
  bright:  Record<string, string>;
}

const THEME_PRESETS: Record<string, ThemeColors> = {
  'default-dark': {
    primary: { background: '#0d1117', foreground: '#e6edf3' },
    cursor:  { text: '#0d1117', cursor: '#e6edf3' },
    normal:  { black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#388bfd', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4' },
    bright:  { black: '#6e7681', red: '#ffa198', green: '#56d364', yellow: '#e3b341', blue: '#79c0ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#f0f6fc' },
  },
  'catppuccin-mocha': {
    primary: { background: '#1e1e2e', foreground: '#cdd6f4' },
    cursor:  { text: '#1e1e2e', cursor: '#f5e0dc' },
    normal:  { black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de' },
    bright:  { black: '#585b70', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#a6adc8' },
  },
  'gruvbox-dark': {
    primary: { background: '#282828', foreground: '#ebdbb2' },
    cursor:  { text: '#282828', cursor: '#ebdbb2' },
    normal:  { black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984' },
    bright:  { black: '#928374', red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', magenta: '#d3869b', cyan: '#8ec07c', white: '#ebdbb2' },
  },
  'solarized-dark': {
    primary: { background: '#002b36', foreground: '#839496' },
    cursor:  { text: '#002b36', cursor: '#839496' },
    normal:  { black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5' },
    bright:  { black: '#002b36', red: '#cb4b16', green: '#586e75', yellow: '#657b83', blue: '#839496', magenta: '#6c71c4', cyan: '#93a1a1', white: '#fdf6e3' },
  },
};

const FALLBACK_FONTS = [
  'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Cascadia Mono',
  'Source Code Pro', 'Hack', 'Inconsolata', 'Iosevka', 'Victor Mono',
  'Menlo', 'Monaco', 'SF Mono', 'Consolas', 'Courier New',
  'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono',
  'Noto Sans Mono', 'IBM Plex Mono', 'Roboto Mono', 'Anonymous Pro',
];

let _fontFamiliesPromise: Promise<string[]> | null = null;
function getFontFamilies(): Promise<string[]> {
  if (!_fontFamiliesPromise) {
    _fontFamiliesPromise = (async () => {
      try {
        const fonts: Array<{ family: string }> = await (window as any).queryLocalFonts();
        return [...new Set(fonts.map(f => f.family))].sort();
      } catch {
        return FALLBACK_FONTS;
      }
    })();
  }
  return _fontFamiliesPromise;
}


// ── colors custom renderer (reused inside Appearance tab) ─────────────────────

function renderColorsSection(cfg: any, el: HTMLElement, dirty: () => void) {
  let activeThemeSel: HTMLSelectElement | null = null;
  let activePreview: HTMLElement | null = null;

  const applyColor = (path: string, normalized: string, swatchEl: HTMLElement, hexEl: HTMLInputElement) => {
    swatchEl.style.background = normalized;
    hexEl.value = normalized;
    setPath(cfg, path, normalized);
    cfg.colors.theme = null;
    if (activeThemeSel) activeThemeSel.value = '';
    if (activePreview) syncThemePreview(activePreview, cfg);
    dirty();
  };

  const renderAll = () => {
    el.innerHTML = '';

    // Theme preset
    const presetRow = document.createElement('div');
    presetRow.className = 'st-field';
    const presetLbl = document.createElement('label');
    presetLbl.className = 'st-label';
    presetLbl.textContent = 'Theme preset';
    const presetDesc = document.createElement('span');
    presetDesc.className = 'st-desc';
    presetDesc.textContent = 'Selects a preset and fills colors below';
    presetLbl.appendChild(presetDesc);
    const themeSel = document.createElement('select');
    themeSel.className = 'st-input';
    activeThemeSel = themeSel;
    for (const t of KNOWN_THEMES) {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t || '(custom)';
      if ((cfg.colors.theme || '') === t) opt.selected = true;
      themeSel.appendChild(opt);
    }
    themeSel.addEventListener('change', () => {
      const preset = THEME_PRESETS[themeSel.value];
      if (preset) {
        Object.assign(cfg.colors.primary, preset.primary);
        Object.assign(cfg.colors.cursor,  preset.cursor);
        Object.assign(cfg.colors.normal,  preset.normal);
        Object.assign(cfg.colors.bright,  preset.bright);
      }
      cfg.colors.theme = themeSel.value || null;
      dirty();
      renderAll();
    });
    presetRow.appendChild(presetLbl);
    presetRow.appendChild(themeSel);
    el.appendChild(presetRow);

    const preview = document.createElement('div');
    preview.className = 'st-theme-preview';
    preview.innerHTML = `
      <div class="st-theme-preview-title">Live preview</div>
      <div class="st-theme-preview-terminal">
        <div class="st-theme-preview-header">~/workspace/fluxtty</div>
        <div class="st-theme-preview-body">
          <span class="st-theme-preview-green">✓ build passed</span>
          <span class="st-theme-preview-blue">src/</span>
          <span class="st-theme-preview-red">error.log</span>
          <span class="st-theme-preview-yellow">warning.txt</span>
        </div>
      </div>
    `;
    activePreview = preview;
    syncThemePreview(preview, cfg);
    el.appendChild(preview);

    const group = (title: string, fields: Array<[string, string]>, desc?: string) => {
      const wrap = document.createElement('div');
      wrap.className = 'st-color-group';
      const titleEl = document.createElement('div');
      titleEl.className = 'st-color-group-title';
      titleEl.textContent = title;
      wrap.appendChild(titleEl);
      if (desc) {
        const descEl = document.createElement('div');
        descEl.className = 'st-color-group-desc';
        descEl.textContent = desc;
        wrap.appendChild(descEl);
      }
      const grid = document.createElement('div');
      grid.className = 'st-color-grid';

      for (const [path, label] of fields) {
        const item = document.createElement('div');
        item.className = 'st-color-item';
        const controls = document.createElement('div');
        controls.className = 'st-color-controls';
        const initColor = normalizeHexColor(String(getPath(cfg, path) || '#000000')) || '#000000';

        const swatch = document.createElement('div');
        swatch.className = 'st-color-swatch';
        swatch.style.background = initColor;

        const hex = document.createElement('input');
        hex.type = 'text';
        hex.className = 'st-color-code';
        hex.spellcheck = false;
        hex.value = initColor;

        swatch.addEventListener('click', () => { hex.focus(); hex.select(); });
        hex.addEventListener('input', () => {
          const n = normalizeHexColor(hex.value);
          if (n) applyColor(path, n, swatch, hex);
        });
        hex.addEventListener('change', () => {
          const n = normalizeHexColor(hex.value);
          if (n) applyColor(path, n, swatch, hex);
        });
        hex.addEventListener('blur', () => {
          const n = normalizeHexColor(hex.value);
          if (!n) {
            const cfgVal = normalizeHexColor(String(getPath(cfg, path))) ?? initColor;
            hex.value = cfgVal;
            swatch.style.background = cfgVal;
          }
        });

        controls.appendChild(swatch);
        controls.appendChild(hex);
        item.appendChild(controls);
        item.appendChild(document.createTextNode(label));
        grid.appendChild(item);
      }
      wrap.appendChild(grid);
      return wrap;
    };

    const COLOR_NAMES = ['Black','Red','Green','Yellow','Blue','Magenta','Cyan','White'];
    el.appendChild(group('Background & text', [
      ['colors.primary.background', 'Background'],
      ['colors.primary.foreground', 'Foreground'],
      ['colors.cursor.cursor',      'Cursor'],
      ['colors.cursor.text',        'Cursor text'],
    ], 'Terminal background, default text color, and cursor appearance'));
    el.appendChild(group('ANSI colors',
      COLOR_NAMES.map(n => [`colors.normal.${n.toLowerCase()}`, n] as [string, string]),
      'The 8 standard ANSI colors used by shell programs'));
    el.appendChild(group('ANSI colors (bright)',
      COLOR_NAMES.map(n => [`colors.bright.${n.toLowerCase()}`, `Bright ${n}`] as [string, string]),
      'Bold / high-intensity variants of the 8 ANSI colors'));
  };

  renderAll();
}

// ── section definitions ───────────────────────────────────────────────────────

const SECTIONS: Section[] = [

  // ── General ────────────────────────────────────────────────────────────────
  {
    id: 'general',
    label: 'General',
    groups: [
      {
        label: 'Window',
        fields: [
          { path: 'window.padding.x',    label: 'Padding X',     type: 'number', min: 0, max: 80 },
          { path: 'window.padding.y',    label: 'Padding Y',     type: 'number', min: 0, max: 80 },
          { path: 'window.decorations',  label: 'Decorations',   type: 'select', opts: ['full','none','transparent','buttonless'] },
          { path: 'window.startup_mode', label: 'Startup mode',  type: 'select', opts: ['windowed','maximized','fullscreen','simpleFullscreen'] },
        ],
      },
      {
        label: 'Shell & Sessions',
        fields: [
          { path: 'shell.program', label: 'Shell program', type: 'text', desc: 'e.g. /bin/zsh' },
          {
            path: 'shell.args', label: 'Shell args', type: 'textarea',
            desc: 'One argument per line',
            read: (v: string[]) => v.join('\n'),
            write: (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean),
          },
          { path: 'session_defaults.group', label: 'Default group', type: 'text' },
          { path: 'session_defaults.shell', label: 'Session shell override', type: 'text', desc: 'Optional per-session shell (overrides shell.program)' },
        ],
      },
      {
        label: 'Persistence',
        fields: [
          { path: 'persistence.keep_alive',              label: 'Keep alive',              type: 'checkbox', desc: 'PTYs keep running after window close' },
          { path: 'persistence.tray_icon',               label: 'Tray icon',               type: 'checkbox' },
          { path: 'persistence.disk_state_path',         label: 'State file path',         type: 'text' },
          { path: 'persistence.scrollback_lines',        label: 'Scrollback lines saved',  type: 'number', min: 0, max: 100000, step: 500 },
          { path: 'persistence.save_scrollback_on_exit', label: 'Save scrollback on exit', type: 'checkbox' },
        ],
      },
    ],
  },

  // ── Appearance ─────────────────────────────────────────────────────────────
  {
    id: 'appearance',
    label: 'Appearance',
    groups: [
      {
        label: 'Colors',
        custom: renderColorsSection,
      },
      {
        label: 'Font',
        fields: [
          { path: 'font.family', label: 'Family', type: 'fontfamily' },
          { path: 'font.size',   label: 'Size',   type: 'number', min: 6, max: 32, step: 0.5 },
          { path: 'font.builtin_box_drawing', label: 'Builtin box drawing', type: 'checkbox' },
        ],
      },
      {
        label: 'Cursor',
        fields: [
          { path: 'cursor.style',    label: 'Style',    type: 'select', opts: ['Block','Underline','Bar'] },
          { path: 'cursor.blinking', label: 'Blinking', type: 'checkbox' },
        ],
      },
    ],
  },

  // ── Terminal ───────────────────────────────────────────────────────────────
  {
    id: 'terminal',
    label: 'Terminal',
    groups: [
      {
        label: 'Scrolling',
        fields: [
          { path: 'scrolling.history',    label: 'Scrollback lines',  type: 'number', min: 100, max: 100000, step: 1000 },
          { path: 'scrolling.multiplier', label: 'Scroll multiplier', type: 'number', min: 1, max: 20 },
        ],
      },
      {
        label: 'Input',
        fields: [
          {
            path: 'input.live_typing', label: 'Live typing', type: 'checkbox',
            desc: 'Forward each keystroke to the PTY immediately — shell handles line editing and history',
          },
        ],
      },
      {
        label: 'Layout (Waterfall)',
        fields: [
          { path: 'waterfall.row_height_mode',  label: 'Row height mode',  type: 'select', opts: ['viewport','fixed'] },
          { path: 'waterfall.fixed_row_height', label: 'Fixed row height', type: 'number', min: 10, max: 200, desc: 'rows (used when mode = fixed)' },
          { path: 'waterfall.scroll_snap',      label: 'Scroll snap',      type: 'checkbox' },
          { path: 'waterfall.new_pane_focus',   label: 'Focus new pane',   type: 'checkbox' },
        ],
      },
    ],
  },

  // ── Keybindings ────────────────────────────────────────────────────────────
  {
    id: 'keybindings',
    label: 'Keybindings',
    custom(cfg, el, dirty) {
      const kbs: Array<{ key: string; mods?: string; action: string }> = cfg.keybindings;

      const rebuildTable = () => {
        tableBody.innerHTML = '';
        kbs.forEach((kb, i) => {
          const tr = document.createElement('tr');

          // Key recorder cell
          const keyTd = document.createElement('td');
          const recBtn = document.createElement('button');
          recBtn.className = 'st-kb-rec';
          recBtn.textContent = kbLabel(kb.key, kb.mods);

          let recording = false;
          let abortCtrl: AbortController | null = null;

          const stopRecording = () => {
            recording = false;
            recBtn.classList.remove('recording');
            abortCtrl?.abort();
            abortCtrl = null;
          };

          recBtn.addEventListener('click', () => {
            if (recording) { stopRecording(); return; }
            recording = true;
            recBtn.classList.add('recording');
            recBtn.textContent = 'Press a key…';
            abortCtrl = new AbortController();
            const { signal } = abortCtrl;

            window.addEventListener('keydown', (e: KeyboardEvent) => {
              if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
              e.preventDefault(); e.stopPropagation();
              const mods = new Set<ModKey>();
              if (e.ctrlKey)  mods.add('Control');
              if (e.shiftKey) mods.add('Shift');
              if (e.altKey)   mods.add('Alt');
              kbs[i].key  = e.key.length === 1 ? e.key.toUpperCase() : e.key;
              kbs[i].mods = formatMods(mods);
              recBtn.textContent = kbLabel(kbs[i].key, kbs[i].mods);
              dirty();
              stopRecording();
            }, { signal, capture: true });

            window.addEventListener('mousedown', (e: MouseEvent) => {
              if (e.target !== recBtn) stopRecording();
            }, { signal, capture: true });
          });

          keyTd.appendChild(recBtn);
          tr.appendChild(keyTd);

          // Action selector
          const actionTd = document.createElement('td');
          const actionSel = document.createElement('select');
          actionSel.className = 'st-input';
          for (const a of ACTIONS) {
            const opt = document.createElement('option');
            opt.value = opt.textContent = a;
            if (a === kb.action) opt.selected = true;
            actionSel.appendChild(opt);
          }
          actionSel.addEventListener('change', () => { kbs[i].action = actionSel.value; dirty(); });
          actionTd.appendChild(actionSel);
          tr.appendChild(actionTd);

          // Delete button
          const delTd = document.createElement('td');
          const delBtn = document.createElement('button');
          delBtn.className = 'st-kb-del';
          delBtn.textContent = '✕';
          delBtn.addEventListener('click', () => {
            kbs.splice(i, 1);
            cfg.keybindings = kbs;
            dirty();
            rebuildTable();
          });
          delTd.appendChild(delBtn);
          tr.appendChild(delTd);

          tableBody.appendChild(tr);
        });
      };

      const table = document.createElement('table');
      table.className = 'st-kb-table';
      table.innerHTML = `<thead><tr><th>Shortcut</th><th>Action</th><th></th></tr></thead>`;
      table.querySelector('thead')!.style.cssText = 'font-size: 0.85em; opacity: 0.7;';
      const tableBody = document.createElement('tbody');
      table.appendChild(tableBody);
      el.appendChild(table);
      rebuildTable();

      const addBtn = document.createElement('button');
      addBtn.className = 'st-btn-add';
      addBtn.textContent = '+ Add binding';
      addBtn.addEventListener('click', () => {
        kbs.push({ key: 'N', mods: 'Control', action: 'NewTerminal' });
        cfg.keybindings = kbs;
        dirty();
        rebuildTable();
      });
      el.appendChild(addBtn);
    },
  },

  // ── AI ─────────────────────────────────────────────────────────────────────
  {
    id: 'ai',
    label: 'AI',
    groups: [
      {
        label: 'Model',
        custom: (cfg, el, dirty) => {
          const wai = cfg.workspace_ai;

          function rebuild() {
            el.innerHTML = '';
            const model: string = wai.model ?? 'none';
            const isNone = !model || model === 'none';
            const isCli = model === 'claude-cli';
            const needsKey = !isNone && !isCli;

            // ── Model ────────────────────────────────────────────────────
            const modelRow = document.createElement('div');
            modelRow.className = 'st-field';
            const modelLabel = document.createElement('label');
            modelLabel.className = 'st-label';
            modelLabel.textContent = 'Model';
            const modelDesc = document.createElement('span');
            modelDesc.className = 'st-desc';
            modelDesc.textContent = 'claude-sonnet-4-6 · gpt-4o · gemini-2.0-flash · ollama/llama3 · claude-cli';
            modelLabel.appendChild(modelDesc);
            modelRow.appendChild(modelLabel);

            const listId = 'st-dl-model';
            const modelInp = document.createElement('input');
            modelInp.type = 'text';
            modelInp.className = 'st-input';
            modelInp.value = model;
            modelInp.setAttribute('list', listId);
            const dl = document.createElement('datalist');
            dl.id = listId;
            for (const m of KNOWN_MODELS) {
              const o = document.createElement('option');
              o.value = m;
              dl.appendChild(o);
            }
            modelInp.addEventListener('change', () => {
              wai.model = modelInp.value.trim() || 'none';
              dirty();
              rebuild();
            });
            modelRow.appendChild(modelInp);
            modelRow.appendChild(dl);
            el.appendChild(modelRow);

            if (isCli) {
              // claude-cli note
              const note = document.createElement('div');
              note.className = 'st-field st-info-note';
              note.textContent = 'claude-cli runs the `claude` CLI installed on your system. No API key needed — uses your existing Claude Code login.';
              el.appendChild(note);
            }

            // ── Provider (hidden for claude-cli / none) ───────────────
            if (!isNone && !isCli) {
              const provRow = document.createElement('div');
              provRow.className = 'st-field';
              const provLabel = document.createElement('label');
              provLabel.className = 'st-label';
              provLabel.textContent = 'Provider';
              const provDesc = document.createElement('span');
              provDesc.className = 'st-desc';
              provDesc.textContent = 'Leave blank to auto-detect (claude-* → anthropic, gpt-* → openai, etc.)';
              provLabel.appendChild(provDesc);
              provRow.appendChild(provLabel);
              const provSel = document.createElement('select');
              provSel.className = 'st-input';
              for (const p of KNOWN_PROVIDERS.filter(p => p !== 'claude-cli')) {
                const o = document.createElement('option');
                o.value = p;
                o.textContent = p || '(auto-detect)';
                if ((wai.provider ?? '') === p) o.selected = true;
                provSel.appendChild(o);
              }
              provSel.addEventListener('change', () => {
                wai.provider = provSel.value || null;
                dirty();
              });
              provRow.appendChild(provSel);
              el.appendChild(provRow);
            }

            // ── API key env var (hidden for claude-cli / none) ────────
            if (needsKey) {
              const keyRow = document.createElement('div');
              keyRow.className = 'st-field';
              const keyLabel = document.createElement('label');
              keyLabel.className = 'st-label';
              keyLabel.textContent = 'API key env var';
              const keyDesc = document.createElement('span');
              keyDesc.className = 'st-desc';
              keyDesc.textContent = 'Environment variable holding your API key (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY)';
              keyLabel.appendChild(keyDesc);
              keyRow.appendChild(keyLabel);
              const keyInp = document.createElement('input');
              keyInp.type = 'text';
              keyInp.className = 'st-input';
              keyInp.value = wai.api_key_env ?? '';
              keyInp.placeholder = 'ANTHROPIC_API_KEY';
              keyInp.addEventListener('input', () => { wai.api_key_env = keyInp.value; dirty(); });
              keyRow.appendChild(keyInp);
              el.appendChild(keyRow);
            }

            // ── Base URL (hidden for claude-cli / none) ────────────────
            if (!isNone && !isCli) {
              const urlRow = document.createElement('div');
              urlRow.className = 'st-field';
              const urlLabel = document.createElement('label');
              urlLabel.className = 'st-label';
              urlLabel.textContent = 'Base URL';
              const urlDesc = document.createElement('span');
              urlDesc.className = 'st-desc';
              urlDesc.textContent = 'Override API endpoint — required for Ollama (http://localhost:11434) or OpenAI-compatible servers';
              urlLabel.appendChild(urlDesc);
              urlRow.appendChild(urlLabel);
              const urlInp = document.createElement('input');
              urlInp.type = 'text';
              urlInp.className = 'st-input';
              urlInp.value = wai.base_url ?? '';
              urlInp.placeholder = 'http://localhost:11434';
              urlInp.addEventListener('input', () => { wai.base_url = urlInp.value || null; dirty(); });
              urlRow.appendChild(urlInp);
              el.appendChild(urlRow);
            }

            // ── Test button ────────────────────────────────────────────
            if (!isNone) {
              const testRow = document.createElement('div');
              testRow.className = 'st-field';
              testRow.appendChild(document.createElement('span')); // spacer
              const testBtn = document.createElement('button');
              testBtn.className = 'settings-btn';
              testBtn.textContent = 'Test connection';
              const testStatus = document.createElement('span');
              testStatus.className = 'st-test-status';
              testBtn.addEventListener('click', async () => {
                testBtn.disabled = true;
                testBtn.textContent = 'Testing…';
                testStatus.textContent = '';
                testStatus.className = 'st-test-status';
                try {
                  const reply = await llmClient.complete(
                    [{ role: 'user', content: 'Reply with exactly: ok' }],
                    cfg,
                  );
                  testStatus.textContent = reply ? `✓ ${reply.slice(0, 80)}` : '✓ Connected (empty response)';
                  testStatus.className = 'st-test-status ok';
                } catch (e) {
                  testStatus.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
                  testStatus.className = 'st-test-status err';
                } finally {
                  testBtn.disabled = false;
                  testBtn.textContent = 'Test connection';
                }
              });
              testRow.appendChild(testBtn);
              testRow.appendChild(testStatus);
              el.appendChild(testRow);
            }
          }

          rebuild();
        },
      },
      {
        label: 'Behavior',
        fields: [
          {
            path: 'workspace_ai.always_confirm_broadcast',
            label: 'Confirm broadcast',
            type: 'checkbox',
            desc: 'Show a plan and ask y/n before running a command in all sessions',
          },
          {
            path: 'workspace_ai.always_confirm_multi_step',
            label: 'Confirm multi-step plans',
            type: 'checkbox',
            desc: 'Show a plan and ask y/n before executing multiple sequential commands',
          },
          {
            path: 'workspace_ai.agent_relay_auto_submit',
            label: 'Agent relay auto-submit',
            type: 'checkbox',
            desc: 'Automatically submit when relaying a message to an AI agent pane',
          },
        ],
      },
    ],
  },
];

// ── SettingsPanel class ───────────────────────────────────────────────────────

export class SettingsPanel {
  readonly el: HTMLElement;
  private cfg: any = null;
  private activeSection = 'general';
  private saveStatus!: HTMLElement;
  private contentEl!: HTMLElement;
  private navEl!: HTMLElement;
  private fontFamilies: string[] = FALLBACK_FONTS;
  private hasUnsavedPreview = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'settings-overlay';
    this.el.style.display = 'none';
    this.buildChrome();

    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.hide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) { e.stopPropagation(); this.hide(); }
    }, true);

    // Sync panel when config.yaml is edited externally (hot-reload → config:changed).
    // Skip if the user has unsaved preview changes — don't clobber their edits.
    configContext.onChange((newCfg) => {
      if (this.isOpen() && !this.hasUnsavedPreview) {
        this.cfg = deepClone(newCfg);
        this.renderSection(this.activeSection);
      }
    });
  }

  private buildChrome() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    const header = document.createElement('div');
    header.className = 'settings-header';
    header.innerHTML = `<span class="settings-title">Settings</span>`;
    this.saveStatus = document.createElement('span');
    this.saveStatus.className = 'settings-save-status';
    header.appendChild(this.saveStatus);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'settings-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => this.hide());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'settings-body';

    this.navEl = document.createElement('nav');
    this.navEl.className = 'settings-nav';
    body.appendChild(this.navEl);

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'settings-content';
    body.appendChild(this.contentEl);
    panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'settings-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'settings-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.hide());
    const saveBtn = document.createElement('button');
    saveBtn.className = 'settings-btn settings-btn-primary';
    saveBtn.textContent = 'Save & Apply';
    saveBtn.addEventListener('click', () => this.save());
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    panel.appendChild(footer);

    this.el.appendChild(panel);
  }

  // ── public ─────────────────────────────────────────────────────────────────

  show() {
    this.cfg = deepClone(configContext.get());
    this.hasUnsavedPreview = false;
    this.saveStatus.textContent = '';
    getFontFamilies().then(families => {
      this.fontFamilies = families;
      if (this.isOpen() && this.activeSection === 'appearance') this.renderSection('appearance');
    });
    this.buildNav();
    this.renderSection(this.activeSection);
    this.el.style.display = 'flex';
  }

  hide() {
    if (this.hasUnsavedPreview) {
      configContext.revertPreview();
      this.hasUnsavedPreview = false;
    }
    this.el.style.display = 'none';
  }

  isOpen() { return this.el.style.display !== 'none'; }
  toggle() { this.isOpen() ? this.hide() : this.show(); }

  // ── private ────────────────────────────────────────────────────────────────

  private buildNav() {
    this.navEl.innerHTML = '';
    for (const sec of SECTIONS) {
      const item = document.createElement('div');
      item.className = `settings-nav-item${sec.id === this.activeSection ? ' active' : ''}`;
      item.textContent = sec.label;
      item.addEventListener('click', () => {
        this.activeSection = sec.id;
        this.navEl.querySelectorAll('.settings-nav-item').forEach(el =>
          el.classList.toggle('active', el === item));
        this.renderSection(sec.id);
      });
      this.navEl.appendChild(item);
    }
  }

  private markDirty() {
    this.saveStatus.textContent = 'Unsaved changes';
    this.saveStatus.className = 'settings-save-status dirty';
    this.hasUnsavedPreview = true;
    configContext.applyPreview(this.cfg);
  }

  private renderSection(id: string) {
    const sec = SECTIONS.find(s => s.id === id)!;
    this.contentEl.innerHTML = '';

    const title = document.createElement('h2');
    title.className = 'settings-section-title';
    title.textContent = sec.label;
    this.contentEl.appendChild(title);

    // Fully custom renderer (Keybindings)
    if (sec.custom) {
      const wrapper = document.createElement('div');
      this.contentEl.appendChild(wrapper);
      sec.custom(this.cfg, wrapper, () => this.markDirty());
      return;
    }

    // Grouped sections (General / Appearance / Terminal / AI)
    if (sec.groups) {
      for (const group of sec.groups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'st-group';

        const heading = document.createElement('div');
        heading.className = 'st-group-heading';
        heading.textContent = group.label;
        groupEl.appendChild(heading);

        if (group.custom) {
          const wrapper = document.createElement('div');
          groupEl.appendChild(wrapper);
          group.custom(this.cfg, wrapper, () => this.markDirty());
        } else {
          for (const f of group.fields ?? []) {
            groupEl.appendChild(this.buildField(f));
          }
        }

        this.contentEl.appendChild(groupEl);
      }
      return;
    }

    // Flat field list (legacy fallback)
    for (const f of sec.fields ?? []) {
      this.contentEl.appendChild(this.buildField(f));
    }
  }

  private buildField(f: F): HTMLElement {
    const row = document.createElement('div');
    row.className = 'st-field';

    const labelEl = document.createElement('label');
    labelEl.className = 'st-label';
    labelEl.textContent = f.label;
    if (f.desc) {
      const d = document.createElement('span');
      d.className = 'st-desc';
      d.textContent = f.desc;
      labelEl.appendChild(d);
    }
    row.appendChild(labelEl);

    const rawVal = getPath(this.cfg, f.path);
    const displayVal = f.read ? f.read(rawVal) : rawVal;

    if (f.type === 'checkbox') {
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.className = 'st-checkbox';
      inp.checked = !!displayVal;
      inp.addEventListener('change', () => {
        setPath(this.cfg, f.path, inp.checked);
        this.markDirty();
      });
      row.appendChild(inp);

    } else if (f.type === 'select') {
      const sel = document.createElement('select');
      sel.className = 'st-input';
      for (const opt of f.opts ?? []) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt || '(auto)';
        if (opt === String(displayVal ?? '')) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        const v = f.write ? f.write(sel.value) : sel.value;
        setPath(this.cfg, f.path, v);
        this.markDirty();
      });
      row.appendChild(sel);

    } else if (f.type === 'combobox') {
      // <input> + <datalist>: free text + suggestions from opts list
      const listId = `st-dl-${f.path.replace(/\./g, '-')}`;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'st-input';
      inp.value = String(displayVal ?? '');
      inp.setAttribute('list', listId);
      const dl = document.createElement('datalist');
      dl.id = listId;
      for (const opt of f.opts ?? []) {
        const o = document.createElement('option');
        o.value = opt;
        dl.appendChild(o);
      }
      inp.addEventListener('input', () => {
        const v = f.write ? f.write(inp.value) : inp.value;
        setPath(this.cfg, f.path, v);
        this.markDirty();
      });
      row.appendChild(inp);
      row.appendChild(dl);

    } else if (f.type === 'color') {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.className = 'st-color-input';
      inp.value = String(displayVal || '#000000');
      bindValuePreview(inp, () => {
        setPath(this.cfg, f.path, inp.value);
        this.markDirty();
      });
      row.appendChild(inp);

    } else if (f.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.className = 'st-input st-textarea';
      ta.value = String(displayVal ?? '');
      ta.rows = 4;
      ta.addEventListener('input', () => {
        const v = f.write ? f.write(ta.value) : ta.value;
        setPath(this.cfg, f.path, v);
        this.markDirty();
      });
      row.appendChild(ta);

    } else if (f.type === 'fontfamily') {
      const sel = document.createElement('select');
      sel.className = 'st-input';
      const current = String(displayVal ?? '');
      const families = this.fontFamilies.includes(current)
        ? this.fontFamilies
        : [current, ...this.fontFamilies];
      for (const family of families) {
        const opt = document.createElement('option');
        opt.value = opt.textContent = family;
        if (family === current) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        setPath(this.cfg, f.path, sel.value);
        this.markDirty();
      });
      row.appendChild(sel);

    } else {
      // text or number
      const inp = document.createElement('input');
      inp.type = f.type;
      inp.className = 'st-input';
      inp.value = String(displayVal ?? '');
      if (f.min != null) inp.min = String(f.min);
      if (f.max != null) inp.max = String(f.max);
      if (f.step != null) inp.step = String(f.step);
      inp.addEventListener('input', () => {
        const v = f.type === 'number' ? parseFloat(inp.value) : inp.value;
        const finalV = f.write ? f.write(String(v)) : v;
        setPath(this.cfg, f.path, finalV);
        this.markDirty();
      });
      row.appendChild(inp);
    }

    return row;
  }

  private async save() {
    try {
      await invoke('config_save', { cfg: this.cfg });
      this.hasUnsavedPreview = false;
      this.hide();
    } catch (e: any) {
      this.saveStatus.textContent = `Error: ${e}`;
      this.saveStatus.className = 'settings-save-status error';
    }
  }
}
