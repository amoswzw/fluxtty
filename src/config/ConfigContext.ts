import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface AppConfig {
  window: { opacity: number; padding: { x: number; y: number }; decorations: string; startup_mode: string };
  font: { family: string; size: number; builtin_box_drawing: boolean };
  colors: {
    primary: { background: string; foreground: string };
    cursor: { text: string; cursor: string };
    normal: Record<string, string>;
    bright: Record<string, string>;
    theme: string | null;
  };
  cursor: { style: string; blinking: boolean; blink_interval: number };
  scrolling: { history: number; multiplier: number };
  shell: { program: string; args: string[] };
  keybindings: Array<{ key: string; mods: string | null; action: string }>;
  input: { live_typing: boolean };
  workspace_ai: {
    /** anthropic | openai | google | ollama | claude-cli | none  (inferred from model if omitted) */
    provider: string | null;
    /** Model name: claude-sonnet-4-6 | gpt-4o | gemini-2.0-flash | ollama/llama3 | none | claude-cli */
    model: string;
    /** Env var name holding the API key */
    api_key_env: string;
    /** Base URL override — required for Ollama, useful for OpenAI-compatible endpoints */
    base_url: string | null;
    always_confirm_broadcast: boolean;
    always_confirm_multi_step: boolean;
  };
  waterfall: { row_height_mode: string; fixed_row_height: number; scroll_snap: boolean; new_pane_focus: boolean };
  persistence: { keep_alive: boolean; scrollback_lines: number; save_scrollback_on_exit: boolean };
}

type ConfigListener = (config: AppConfig) => void;

class ConfigContext {
  private config: AppConfig | null = null;
  private listeners: ConfigListener[] = [];

  async init() {
    this.config = await invoke<AppConfig>('config_get');
    this.applyToDOM(this.config);

    await listen<AppConfig>('config:changed', (event) => {
      this.config = event.payload;
      this.applyToDOM(this.config);
      this.listeners.forEach(l => l(this.config!));
    });
  }

  get(): AppConfig {
    if (!this.config) throw new Error('Config not loaded');
    return this.config;
  }

  onChange(listener: ConfigListener) {
    this.listeners.push(listener);
  }

  getXtermTheme(cfg?: AppConfig) {
    const c = (cfg ?? this.get()).colors;
    const opacity = (cfg ?? this.get()).window.opacity;
    const hex = c.primary.background.replace('#', '');
    const xtermBg = hex.length === 6
      ? (() => {
          const r = parseInt(hex.slice(0, 2), 16);
          const g = parseInt(hex.slice(2, 4), 16);
          const b = parseInt(hex.slice(4, 6), 16);
          const a = Math.max(0, Math.min(1, opacity));
          return `rgba(${r},${g},${b},${a})`;
        })()
      : c.primary.background;
    return {
      background: xtermBg,
      foreground: c.primary.foreground,
      cursor: c.cursor.cursor,
      cursorAccent: c.cursor.text,
      black: c.normal.black,
      red: c.normal.red,
      green: c.normal.green,
      yellow: c.normal.yellow,
      blue: c.normal.blue,
      magenta: c.normal.magenta,
      cyan: c.normal.cyan,
      white: c.normal.white,
      brightBlack: c.bright.black,
      brightRed: c.bright.red,
      brightGreen: c.bright.green,
      brightYellow: c.bright.yellow,
      brightBlue: c.bright.blue,
      brightMagenta: c.bright.magenta,
      brightCyan: c.bright.cyan,
      brightWhite: c.bright.white,
    };
  }

  /** Apply a config immediately (live preview) without persisting to disk.
   *  Only updates terminals (xterm), NOT CSS vars — so the settings panel UI
   *  stays visually stable while the user is editing colors. */
  applyPreview(cfg: AppConfig) {
    this.listeners.forEach(l => l(cfg));
  }

  /** Revert terminals to the last saved config (e.g. on settings cancel). */
  revertPreview() {
    if (this.config) this.applyPreview(this.config);
  }

  private applyToDOM(cfg?: AppConfig) {
    const c = cfg ?? this.config;
    if (!c) return;
    const root = document.documentElement;

    // Primary colors — keep --fg and --text in sync
    root.style.setProperty('--bg',   c.colors.primary.background);
    root.style.setProperty('--fg',   c.colors.primary.foreground);
    root.style.setProperty('--text', c.colors.primary.foreground);

    // ANSI palette — update both --color-X (xterm refs) and --X (UI refs)
    const n = c.colors.normal;
    const b = c.colors.bright;
    root.style.setProperty('--color-black',   n.black);
    root.style.setProperty('--color-red',     n.red);
    root.style.setProperty('--color-green',   n.green);
    root.style.setProperty('--color-yellow',  n.yellow);
    root.style.setProperty('--color-blue',    n.blue);
    root.style.setProperty('--color-magenta', n.magenta);
    root.style.setProperty('--color-cyan',    n.cyan);
    root.style.setProperty('--color-white',   n.white);

    // UI color variables (used throughout style.css)
    root.style.setProperty('--red',     n.red);
    root.style.setProperty('--green',   n.green);
    root.style.setProperty('--yellow',  b.yellow);   // bright yellow is more readable as UI accent
    root.style.setProperty('--blue',    n.blue);
    root.style.setProperty('--magenta', n.magenta);
    root.style.setProperty('--cyan',    n.cyan);
    // --accent, --focus, --surface, --surface2, --border, --muted are
    // derived via color-mix() in CSS from --bg/--fg/--blue — no JS needed

    root.style.setProperty('--font-family', `'${c.font.family}', 'Symbols Nerd Font Mono', 'JetBrains Mono', 'Fira Code', Consolas, monospace`);
    root.style.setProperty('--font-size', `${c.font.size}px`);
    root.style.setProperty('--window-padding-x', `${c.window.padding.x}px`);
    root.style.setProperty('--window-padding-y', `${c.window.padding.y}px`);
    root.style.setProperty('--window-opacity', String(c.window.opacity));

    // Compute rgba background so CSS can apply opacity without dimming text.
    // Hex must be 6-char (#rrggbb); fall back to opaque if malformed.
    const hex = c.colors.primary.background.replace('#', '');
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = Math.max(0, Math.min(1, c.window.opacity));
      root.style.setProperty('--bg-alpha', `rgba(${r},${g},${b},${a})`);
    } else {
      root.style.setProperty('--bg-alpha', c.colors.primary.background);
    }
  }
}

export const configContext = new ConfigContext();
