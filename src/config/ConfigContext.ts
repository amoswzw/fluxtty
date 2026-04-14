import { transport } from '../transport';

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHexColor(value: string): RgbColor | null {
  const hex = value.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function mixRgb(base: RgbColor, accent: RgbColor, accentWeight: number): RgbColor {
  const w = clamp(accentWeight, 0, 1);
  const baseWeight = 1 - w;
  return {
    r: Math.round(base.r * baseWeight + accent.r * w),
    g: Math.round(base.g * baseWeight + accent.g * w),
    b: Math.round(base.b * baseWeight + accent.b * w),
  };
}

function toRgbaString(color: RgbColor, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp(alpha, 0, 1)})`;
}

export interface AppConfig {
  window: { opacity: number; transparency_enabled: boolean; shell_background_opaque: boolean; padding: { x: number; y: number }; decorations: string; startup_mode: string; compact_mode: boolean };
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
  input: { live_typing: boolean; workspace_scroll_modifier: string };
  workspace_ai: {
    /** OpenCode-style provider/model id or CLI id: openai/gpt-5.4, zai/glm-5.1, ollama/qwen3-coder:latest, codex-cli */
    model: string;
    small_model?: string | null;
    /** OpenCode-style provider map keyed by provider id. */
    provider: Record<string, AiProviderConfig> | string | null;
    /** Legacy fields retained for old configs. Prefer provider.<id>.options.apiKey/baseURL. */
    api_key_env?: string;
    base_url?: string | null;
    always_confirm_broadcast: boolean;
    always_confirm_multi_step: boolean;
    agent_relay_auto_submit?: boolean;
  };
  waterfall: { row_height_mode: string; fixed_row_height: number; scroll_snap: boolean; new_pane_focus: boolean; note_width: number; pane_min_width: number; show_note_button: boolean; inactive_pane_scrim_strength: number };
  persistence: { restore_workspace_on_launch: boolean; scrollback_lines: number; save_scrollback_on_exit: boolean };
}

export interface AiProviderConfig {
  name?: string | null;
  npm?: string | null;
  options?: Record<string, unknown>;
  models?: Record<string, AiModelConfig>;
}

export interface AiModelConfig {
  id?: string | null;
  name?: string | null;
  options?: Record<string, unknown>;
  variants?: Record<string, AiModelVariantConfig>;
}

export interface AiModelVariantConfig {
  id?: string | null;
  name?: string | null;
  disabled?: boolean;
  options?: Record<string, unknown>;
}

type ConfigListener = (config: AppConfig) => void;

class ConfigContext {
  private config: AppConfig | null = null;
  private listeners: ConfigListener[] = [];

  async init() {
    this.config = await transport.send<AppConfig>('config_get');
    this.applyToDOM(this.config);

    await transport.listen<AppConfig>('config:changed', (config) => {
      this.config = config;
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
    const windowCfg = (cfg ?? this.get()).window;
    const shellOpaque = !!windowCfg.transparency_enabled && !!windowCfg.shell_background_opaque;
    const opacity = shellOpaque ? 1 : windowCfg.transparency_enabled ? windowCfg.opacity : 1;
    const backgroundHex = shellOpaque ? '#000000' : c.primary.background;
    const hex = backgroundHex.replace('#', '');
    const xtermBg = hex.length === 6
      ? (() => {
          const r = parseInt(hex.slice(0, 2), 16);
          const g = parseInt(hex.slice(2, 4), 16);
          const b = parseInt(hex.slice(4, 6), 16);
          const a = Math.max(0, Math.min(1, opacity));
          return `rgba(${r},${g},${b},${a})`;
        })()
      : backgroundHex;
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
   *  Only updates terminals plus a few compact-mode preview vars needed for
   *  layout/readability tuning. Theme CSS vars are left alone so the settings
   *  panel UI stays visually stable while the user edits colors. */
  applyPreview(cfg: AppConfig) {
    this.applyWindowPreviewVars(cfg);
    this.applyCompactPreviewVars(cfg);
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
    this.applyWindowPreviewVars(c);
    this.applyCompactPreviewVars(c);

    document.body.dataset.showNoteBtn = c.waterfall.show_note_button !== false ? 'true' : 'false';
    document.body.dataset.compact = c.window.compact_mode ? 'true' : 'false';

    // Recalc terminal layout after any config change (compact mode toggling
    // changes the visible height; font/padding changes affect row thresholds).
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));

  }

  private applyCompactPreviewVars(cfg: AppConfig) {
    const root = document.documentElement;
    const scrimStrength = Math.max(0, Math.min(40, Math.round(cfg.waterfall.inactive_pane_scrim_strength ?? 22)));
    const hoverStrength = Math.max(0, Math.round(scrimStrength * 0.45));
    root.style.setProperty(
      '--compact-inactive-pane-scrim-color',
      `color-mix(in srgb, var(--surface2) ${scrimStrength}%, transparent ${100 - scrimStrength}%)`,
    );
    root.style.setProperty(
      '--compact-inactive-pane-scrim-hover-color',
      `color-mix(in srgb, var(--surface2) ${hoverStrength}%, transparent ${100 - hoverStrength}%)`,
    );
  }

  private applyWindowPreviewVars(cfg: AppConfig) {
    const root = document.documentElement;
    const body = document.body;
    const bg = parseHexColor(cfg.colors.primary.background);
    const fg = parseHexColor(cfg.colors.primary.foreground);
    if (!bg || !fg) {
      root.style.setProperty('--window-opacity', '1');
      root.style.setProperty('--bg-alpha', cfg.colors.primary.background);
      body.dataset.transparent = 'false';
      body.dataset.shellOpaque = 'false';
      return;
    }

    const blue = parseHexColor(cfg.colors.normal.blue) ?? fg;
    const green = parseHexColor(cfg.colors.normal.green) ?? fg;
    const cyan = parseHexColor(cfg.colors.normal.cyan) ?? fg;
    const magenta = parseHexColor(cfg.colors.normal.magenta) ?? fg;
    const yellow = parseHexColor(cfg.colors.bright.yellow) ?? parseHexColor(cfg.colors.normal.yellow) ?? fg;

    const transparencyEnabled = !!cfg.window.transparency_enabled;
    const shellOpaque = transparencyEnabled && !!cfg.window.shell_background_opaque;
    const effectiveOpacity = transparencyEnabled ? clamp(cfg.window.opacity ?? 1, 0.15, 1) : 1;
    const transparencyLift = 1 - effectiveOpacity;
    const shellAlpha = effectiveOpacity;
    const sidebarAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.18, 0, 0.92) : 1;
    const chromeAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.22, 0, 0.94) : 1;
    const rowAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.12, 0, 0.9) : 1;
    const rowMutedAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.08, 0, 0.86) : 1;
    const rowActiveAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.2, 0, 0.93) : 1;
    const panelAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.28, 0, 0.95) : 1;
    const popoverAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.34, 0, 0.97) : 1;
    const paneHeaderAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.24, 0, 0.93) : 1;
    const inputAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.3, 0, 0.95) : 1;
    const noteAlpha = transparencyEnabled ? clamp(effectiveOpacity + transparencyLift * 0.22, 0, 0.94) : 1;

    const surface = mixRgb(bg, fg, 0.15);
    const surface2 = mixRgb(bg, fg, 0.25);
    const chromeBg = mixRgb(bg, surface, 0.2);
    const sidebarBg = mixRgb(bg, surface, 0.25);
    const rowBg = bg;
    const rowBgAlt = mixRgb(bg, surface, 0.06);
    const rowBgInactive = mixRgb(bg, surface, 0.05);
    const rowBgActive = mixRgb(bg, surface2, 0.12);
    const paneHeaderBg = mixRgb(surface2, bg, 0.2);
    const noteBg = mixRgb(bg, yellow, 0.04);
    const noteHeaderBg = mixRgb(surface2, yellow, 0.08);
    const inputBase = mixRgb(bg, surface, 0.35);
    const inputNormal = mixRgb(inputBase, blue, 0.15);
    const inputInsert = mixRgb(inputBase, green, 0.13);
    const inputTerminal = mixRgb(inputBase, cyan, 0.15);
    const inputAi = mixRgb(inputBase, magenta, 0.15);
    const aiLogBg = mixRgb(bg, magenta, 0.1);
    const inputPanelBg = mixRgb(surface2, bg, 0.15);
    const inputHintBg = mixRgb(surface2, bg, 0.22);
    const autocompleteBg = mixRgb(surface2, bg, 0.08);
    const popoverBg = mixRgb(surface2, bg, 0.1);
    const shellBg: RgbColor = { r: 0, g: 0, b: 0 };

    root.style.setProperty('--window-opacity', String(effectiveOpacity));
    root.style.setProperty('--bg-alpha', toRgbaString(bg, shellAlpha));
    root.style.setProperty('--app-shell-bg', toRgbaString(bg, shellAlpha));
    root.style.setProperty('--chrome-bg', toRgbaString(chromeBg, chromeAlpha));
    root.style.setProperty('--sidebar-bg', toRgbaString(sidebarBg, sidebarAlpha));
    root.style.setProperty('--sidebar-header-bg', toRgbaString(surface2, panelAlpha));
    root.style.setProperty('--sidebar-chip-bg', toRgbaString(surface, panelAlpha));
    root.style.setProperty('--row-bg', toRgbaString(rowBg, rowAlpha));
    root.style.setProperty('--row-bg-alt', toRgbaString(rowBgAlt, rowAlpha));
    root.style.setProperty('--row-bg-inactive', toRgbaString(rowBgInactive, rowMutedAlpha));
    root.style.setProperty('--row-bg-active', toRgbaString(rowBgActive, rowActiveAlpha));
    root.style.setProperty('--pane-bg', shellOpaque ? toRgbaString(shellBg, 1) : transparencyEnabled ? 'transparent' : toRgbaString(bg, 1));
    root.style.setProperty('--pane-header-bg', toRgbaString(paneHeaderBg, paneHeaderAlpha));
    root.style.setProperty('--note-pane-bg', toRgbaString(noteBg, noteAlpha));
    root.style.setProperty('--note-pane-header-bg', toRgbaString(noteHeaderBg, noteAlpha));
    root.style.setProperty('--input-bar-bg', toRgbaString(inputBase, inputAlpha));
    root.style.setProperty('--input-bar-bg-normal', toRgbaString(inputNormal, inputAlpha));
    root.style.setProperty('--input-bar-bg-insert', toRgbaString(inputInsert, inputAlpha));
    root.style.setProperty('--input-bar-bg-terminal', toRgbaString(inputTerminal, inputAlpha));
    root.style.setProperty('--input-bar-bg-ai', toRgbaString(inputAi, inputAlpha));
    root.style.setProperty('--ai-log-bg', toRgbaString(aiLogBg, panelAlpha));
    root.style.setProperty('--input-panel-bg', toRgbaString(inputPanelBg, panelAlpha));
    root.style.setProperty('--input-hint-bg', toRgbaString(inputHintBg, panelAlpha));
    root.style.setProperty('--autocomplete-bg', toRgbaString(autocompleteBg, popoverAlpha));
    root.style.setProperty('--overlay-backdrop-bg', `rgba(0, 0, 0, ${transparencyEnabled ? 0.42 : 0.6})`);
    root.style.setProperty('--settings-panel-bg', toRgbaString(chromeBg, panelAlpha));
    root.style.setProperty('--settings-hover-bg', toRgbaString(surface2, panelAlpha));
    root.style.setProperty('--popover-bg', toRgbaString(popoverBg, popoverAlpha));

    body.dataset.transparent = transparencyEnabled ? 'true' : 'false';
    body.dataset.shellOpaque = shellOpaque ? 'true' : 'false';
  }
}

export const configContext = new ConfigContext();
