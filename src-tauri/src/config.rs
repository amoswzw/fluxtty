use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub window: WindowConfig,
    pub font: FontConfig,
    pub colors: ColorsConfig,
    pub cursor: CursorConfig,
    pub scrolling: ScrollingConfig,
    pub shell: ShellConfig,
    pub keybindings: Vec<KeyBinding>,
    pub input: InputConfig,
    pub workspace_ai: WorkspaceAiConfig,
    pub waterfall: WaterfallConfig,
    pub persistence: PersistenceConfig,
    pub session_defaults: SessionDefaults,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowConfig {
    pub opacity: f64,
    pub transparency_enabled: bool,
    pub shell_background_opaque: bool,
    pub padding: PaddingConfig,
    pub decorations: String,
    pub startup_mode: String,
    pub compact_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PaddingConfig {
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FontConfig {
    pub family: String,
    pub size: f64,
    pub builtin_box_drawing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ColorsConfig {
    pub primary: PrimaryColors,
    pub cursor: CursorColors,
    pub normal: AnsiColors,
    pub bright: AnsiColors,
    pub theme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PrimaryColors {
    pub background: String,
    pub foreground: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CursorColors {
    pub text: String,
    pub cursor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AnsiColors {
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CursorConfig {
    pub style: String,
    pub blinking: bool,
    pub blink_interval: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ScrollingConfig {
    pub history: u32,
    pub multiplier: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ShellConfig {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyBinding {
    pub key: String,
    pub mods: Option<String>,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct InputConfig {
    /// When true, every keystroke in Insert mode is forwarded to the PTY immediately
    /// instead of waiting for Enter. The shell handles echo and line editing.
    pub live_typing: bool,
    /// Which modifier key reroutes wheel scrolling from the terminal to the
    /// workspace container.
    /// One of: meta | control | alt | shift | disabled.
    #[serde(alias = "terminal_scroll_modifier")]
    pub workspace_scroll_modifier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceAiConfig {
    pub always_confirm_broadcast: bool,
    pub always_confirm_multi_step: bool,
    pub agent_relay_auto_submit: bool,
    /// Provider: anthropic | openai | google | ollama | claude-cli | none
    /// If omitted, inferred from the model name.
    pub provider: Option<String>,
    /// Model name, e.g. claude-sonnet-4-6, gpt-4o, gemini-2.0-flash, ollama/llama3
    pub model: String,
    /// Name of the environment variable that holds the API key
    pub api_key_env: String,
    /// Override the API base URL (required for Ollama, useful for custom OpenAI-compatible endpoints)
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WaterfallConfig {
    pub row_height_mode: String,
    pub fixed_row_height: u32,
    pub scroll_snap: bool,
    pub new_pane_focus: bool,
    pub note_width: u32,
    pub pane_min_width: u32,
    pub show_note_button: bool,
    pub inactive_pane_scrim_strength: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PersistenceConfig {
    pub keep_alive: bool,
    pub disk_state_path: String,
    pub scrollback_lines: u32,
    pub save_scrollback_on_exit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionDefaults {
    pub group: String,
    pub shell: Option<String>,
}

// Default implementations

impl Default for Config {
    fn default() -> Self {
        Config {
            window: WindowConfig::default(),
            font: FontConfig::default(),
            colors: ColorsConfig::default(),
            cursor: CursorConfig::default(),
            scrolling: ScrollingConfig::default(),
            shell: ShellConfig::default(),
            keybindings: default_keybindings(),
            input: InputConfig::default(),
            workspace_ai: WorkspaceAiConfig::default(),
            waterfall: WaterfallConfig::default(),
            persistence: PersistenceConfig::default(),
            session_defaults: SessionDefaults::default(),
        }
    }
}

impl Default for WindowConfig {
    fn default() -> Self {
        WindowConfig {
            opacity: 0.72,
            transparency_enabled: true,
            shell_background_opaque: true,
            padding: PaddingConfig { x: 8, y: 6 },
            decorations: "full".to_string(),
            startup_mode: "windowed".to_string(),
            compact_mode: false,
        }
    }
}

impl Default for PaddingConfig {
    fn default() -> Self {
        PaddingConfig { x: 8, y: 6 }
    }
}

impl Default for FontConfig {
    fn default() -> Self {
        FontConfig {
            family: "JetBrains Mono".to_string(),
            size: 13.0,
            builtin_box_drawing: true,
        }
    }
}

impl Default for ColorsConfig {
    fn default() -> Self {
        ColorsConfig {
            primary: PrimaryColors {
                background: "#2e3440".to_string(),
                foreground: "#d8dee9".to_string(),
            },
            cursor: CursorColors {
                text: "#2e3440".to_string(),
                cursor: "#eceff4".to_string(),
            },
            normal: AnsiColors {
                black: "#3b4252".to_string(),
                red: "#bf616a".to_string(),
                green: "#a3be8c".to_string(),
                yellow: "#ebcb8b".to_string(),
                blue: "#81a1c1".to_string(),
                magenta: "#b48ead".to_string(),
                cyan: "#88c0d0".to_string(),
                white: "#e5e9f0".to_string(),
            },
            bright: AnsiColors {
                black: "#4c566a".to_string(),
                red: "#bf616a".to_string(),
                green: "#a3be8c".to_string(),
                yellow: "#ebcb8b".to_string(),
                blue: "#81a1c1".to_string(),
                magenta: "#b48ead".to_string(),
                cyan: "#8fbcbb".to_string(),
                white: "#eceff4".to_string(),
            },
            theme: Some("nord".to_string()),
        }
    }
}

impl Default for PrimaryColors {
    fn default() -> Self {
        PrimaryColors {
            background: "#2e3440".to_string(),
            foreground: "#d8dee9".to_string(),
        }
    }
}

impl Default for CursorColors {
    fn default() -> Self {
        CursorColors {
            text: "#2e3440".to_string(),
            cursor: "#eceff4".to_string(),
        }
    }
}

impl Default for AnsiColors {
    fn default() -> Self {
        AnsiColors {
            black: "#3b4252".to_string(),
            red: "#bf616a".to_string(),
            green: "#a3be8c".to_string(),
            yellow: "#ebcb8b".to_string(),
            blue: "#81a1c1".to_string(),
            magenta: "#b48ead".to_string(),
            cyan: "#88c0d0".to_string(),
            white: "#e5e9f0".to_string(),
        }
    }
}

impl Default for CursorConfig {
    fn default() -> Self {
        CursorConfig {
            style: "Block".to_string(),
            blinking: true,
            blink_interval: 750,
        }
    }
}

impl Default for ScrollingConfig {
    fn default() -> Self {
        ScrollingConfig {
            history: 10000,
            multiplier: 3,
        }
    }
}

impl Default for ShellConfig {
    fn default() -> Self {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        ShellConfig {
            program: shell,
            args: vec![],
        }
    }
}

fn default_keybindings() -> Vec<KeyBinding> {
    let settings_mod = if cfg!(target_os = "macos") { "Meta" } else { "Control" };
    vec![
        KeyBinding { key: "N".to_string(), mods: Some("Control".to_string()), action: "NewTerminal".to_string() },
        KeyBinding { key: "H".to_string(), mods: Some("Control".to_string()), action: "SplitHorizontal".to_string() },
        KeyBinding { key: "W".to_string(), mods: Some("Control".to_string()), action: "ClosePane".to_string() },
        KeyBinding { key: "B".to_string(), mods: Some("Control".to_string()), action: "ToggleSidebar".to_string() },
        KeyBinding { key: "\\".to_string(), mods: Some("Control".to_string()), action: "ToggleInputMode".to_string() },
        KeyBinding { key: ",".to_string(), mods: Some(settings_mod.to_string()), action: "OpenSettings".to_string() },
        KeyBinding { key: "Q".to_string(), mods: Some("Control".to_string()), action: "Quit".to_string() },
    ]
}

impl Default for InputConfig {
    fn default() -> Self {
        InputConfig {
            live_typing: true,
            workspace_scroll_modifier: "meta".to_string(),
        }
    }
}

impl Default for WorkspaceAiConfig {
    fn default() -> Self {
        WorkspaceAiConfig {
            always_confirm_broadcast: true,
            always_confirm_multi_step: true,
            agent_relay_auto_submit: false,
            provider: None,
            model: "none".to_string(),
            api_key_env: "ANTHROPIC_API_KEY".to_string(),
            base_url: None,
        }
    }
}

impl Default for WaterfallConfig {
    fn default() -> Self {
        WaterfallConfig {
            row_height_mode: "viewport".to_string(),
            fixed_row_height: 40,
            scroll_snap: false,
            new_pane_focus: true,
            note_width: 280,
            pane_min_width: 150,
            show_note_button: true,
            inactive_pane_scrim_strength: 22,
        }
    }
}

impl Default for PersistenceConfig {
    fn default() -> Self {
        PersistenceConfig {
            keep_alive: true,
            disk_state_path: "~/.local/share/fluxtty/workspace.json".to_string(),
            scrollback_lines: 5000,
            save_scrollback_on_exit: true,
        }
    }
}

impl Default for SessionDefaults {
    fn default() -> Self {
        SessionDefaults {
            group: "default".to_string(),
            shell: None,
        }
    }
}

// Config loading

pub fn config_path() -> PathBuf {
    // Prefer XDG_CONFIG_HOME if set, otherwise use ~/.config on all platforms.
    // This matches the documented path (~/.config/fluxtty/config.yaml) and avoids
    // macOS's ~/Library/Application Support which dirs::config_dir() returns.
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("~"))
                .join(".config")
        });
    base.join("fluxtty").join("config.yaml")
}

pub fn load_config() -> Config {
    let path = config_path();
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_yaml::from_str(&content) {
                Ok(cfg) => {
                    log::info!("Config loaded from {:?}", path);
                    return cfg;
                }
                Err(e) => {
                    log::warn!("Config parse error: {}, using defaults", e);
                }
            },
            Err(e) => {
                log::warn!("Config read error: {}, using defaults", e);
            }
        }
    }
    Config::default()
}

pub type SharedConfig = Arc<Mutex<Config>>;

pub fn new_shared_config() -> SharedConfig {
    Arc::new(Mutex::new(load_config()))
}
