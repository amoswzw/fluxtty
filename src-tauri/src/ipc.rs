use crate::config::{load_config, SharedConfig};
use crate::pty::SharedPtyManager;
use crate::session::{AgentType, SessionStatus, SharedSessionManager};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize)]
pub struct SpawnPtyArgs {
    pub pane_id: u32,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub new_row: bool,
    /// Which row to target in DOM order. When new_row is true, this is the
    /// insertion point for the new row. Otherwise this is the row to add to.
    pub target_row: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct WritePtyArgs {
    pub pane_id: u32,
    pub data: String,
}

#[derive(Debug, Deserialize)]
pub struct ResizePtyArgs {
    pub pane_id: u32,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
pub struct SpawnPtyResult {
    pub pane_id: u32,
    pub pid: u32,
}

#[derive(Debug, Serialize)]
pub struct SessionListResult {
    pub panes: Vec<crate::session::PaneInfo>,
    pub active_pane_id: Option<u32>,
}

#[tauri::command]
pub async fn pty_spawn(
    args: SpawnPtyArgs,
    app: AppHandle,
    pty_mgr: State<'_, SharedPtyManager>,
    session_mgr: State<'_, SharedSessionManager>,
    config: State<'_, SharedConfig>,
) -> Result<SpawnPtyResult, String> {
    let (shell, shell_args, group, cwd) = {
        let cfg = config.lock().unwrap();
        // session_defaults.shell overrides cfg.shell.program if set
        let shell = cfg.session_defaults.shell
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| cfg.shell.program.clone());
        let shell_args = cfg.shell.args.clone();
        let group = cfg.session_defaults.group.clone();
        let cwd = args.cwd.unwrap_or_else(|| {
            dirs::home_dir()
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });
        (shell, shell_args, group, cwd)
    };

    let row_index = {
        let mut session = session_mgr.lock().unwrap();
        if args.new_row {
            // Use the exact insertion point the frontend computed. Falls back
            // to append if not provided.
            let target = args.target_row.unwrap_or_else(|| session.layout().rows.len());
            session.prepare_new_row_at(target)
        } else if let Some(target) = args.target_row {
            // Caller explicitly specified which row to add to
            target.min(session.layout().rows.len().saturating_sub(1))
        } else {
            // Add to last row if exists
            let layout = session.layout();
            if layout.rows.is_empty() {
                0
            } else {
                layout.rows.len() - 1
            }
        }
    };

    let pid = {
        let mut pty = pty_mgr.lock().unwrap();
        pty.spawn(args.pane_id, &shell, &shell_args, &cwd, args.cols, args.rows, app.clone(), session_mgr.inner().clone())?
    };

    {
        let mut session = session_mgr.lock().unwrap();
        let _pane = session.create_pane(args.pane_id, cwd, group, pid, row_index);
        // Notify frontend of session change
        let _ = app.emit("session:changed", session.all_panes());
        drop(session);
    }

    Ok(SpawnPtyResult {
        pane_id: args.pane_id,
        pid,
    })
}

#[tauri::command]
pub async fn pty_write(
    args: WritePtyArgs,
    pty_mgr: State<'_, SharedPtyManager>,
) -> Result<(), String> {
    let mut pty = pty_mgr.lock().unwrap();
    pty.write(args.pane_id, args.data.as_bytes())
}

#[tauri::command]
pub async fn pty_resize(
    args: ResizePtyArgs,
    pty_mgr: State<'_, SharedPtyManager>,
) -> Result<(), String> {
    let mut pty = pty_mgr.lock().unwrap();
    pty.resize(args.pane_id, args.cols, args.rows)
}

#[tauri::command]
pub async fn pty_kill(
    pane_id: u32,
    app: AppHandle,
    pty_mgr: State<'_, SharedPtyManager>,
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<(), String> {
    {
        let mut pty = pty_mgr.lock().unwrap();
        pty.kill(pane_id);
    }
    {
        let mut session = session_mgr.lock().unwrap();
        session.remove_pane(pane_id);
        let _ = app.emit("session:changed", session.all_panes());
    }
    Ok(())
}

#[tauri::command]
pub async fn session_list(
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<SessionListResult, String> {
    let session = session_mgr.lock().unwrap();
    Ok(SessionListResult {
        panes: session.all_panes(),
        active_pane_id: session.active_pane_id(),
    })
}

#[tauri::command]
pub async fn session_set_active(
    pane_id: u32,
    app: AppHandle,
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<(), String> {
    let mut session = session_mgr.lock().unwrap();
    session.set_active_pane(pane_id);
    let _ = app.emit("session:active_changed", pane_id);
    Ok(())
}

#[tauri::command]
pub async fn session_rename(
    pane_id: u32,
    name: String,
    app: AppHandle,
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<(), String> {
    let mut session = session_mgr.lock().unwrap();
    session.rename_pane(pane_id, name);
    let _ = app.emit("session:changed", session.all_panes());
    Ok(())
}

#[tauri::command]
pub async fn session_set_group(
    pane_id: u32,
    group: String,
    app: AppHandle,
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<(), String> {
    let mut session = session_mgr.lock().unwrap();
    session.set_pane_group(pane_id, group);
    let _ = app.emit("session:changed", session.all_panes());
    Ok(())
}

#[tauri::command]
pub async fn session_set_agent(
    pane_id: u32,
    agent_type: String,
    app: AppHandle,
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<(), String> {
    let agent = match agent_type.as_str() {
        "claude" => AgentType::Claude,
        "codex" => AgentType::Codex,
        "aider" => AgentType::Aider,
        "unknown" => AgentType::Unknown,
        _ => AgentType::None,
    };
    let mut session = session_mgr.lock().unwrap();
    session.set_pane_agent(pane_id, agent);
    let _ = app.emit("session:changed", session.all_panes());
    Ok(())
}

#[tauri::command]
pub async fn session_set_status(
    pane_id: u32,
    status: String,
    app: AppHandle,
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<(), String> {
    let s = match status.as_str() {
        "running" => SessionStatus::Running,
        "error" => SessionStatus::Error,
        _ => SessionStatus::Idle,
    };
    let mut session = session_mgr.lock().unwrap();
    session.set_pane_status(pane_id, s);
    let _ = app.emit("session:changed", session.all_panes());
    Ok(())
}

#[tauri::command]
pub async fn session_set_note(
    pane_id: u32,
    note: String,
    app: AppHandle,
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<(), String> {
    let mut session = session_mgr.lock().unwrap();
    session.set_pane_note(pane_id, note);
    let _ = app.emit("session:changed", session.all_panes());
    Ok(())
}

#[tauri::command]
pub async fn config_get(config: State<'_, SharedConfig>) -> Result<crate::config::Config, String> {
    let cfg = config.lock().unwrap();
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn config_save(
    cfg: crate::config::Config,
    config: State<'_, SharedConfig>,
    app: AppHandle,
) -> Result<(), String> {
    let path = crate::config::config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let yaml = serde_yaml::to_string(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, yaml).map_err(|e| e.to_string())?;
    {
        let mut c = config.lock().unwrap();
        *c = cfg.clone();
    }
    let _ = app.emit("config:changed", cfg);
    log::info!("Config saved to {:?}", path);
    Ok(())
}

#[tauri::command]
pub async fn config_reload(
    app: AppHandle,
    config: State<'_, SharedConfig>,
) -> Result<(), String> {
    let new_cfg = load_config();
    {
        let mut cfg = config.lock().unwrap();
        *cfg = new_cfg.clone();
    }
    let _ = app.emit("config:changed", new_cfg);
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ShellCompleteArgs {
    pub input: String,
    pub cwd: String,
}

#[tauri::command]
pub async fn shell_complete(args: ShellCompleteArgs) -> Result<Vec<String>, String> {
    let input = &args.input;

    // Decide what to complete and which word is being completed
    let (bash_script, word): (&str, String) = if !input.contains(' ') {
        // First word — complete commands, aliases, functions
        (
            "compgen -A function -A alias -c -- \"$COMP_WORD\" 2>/dev/null | sort -u | head -100",
            input.clone(),
        )
    } else {
        // Argument position — complete file/dir paths
        let w = input.rsplit(' ').next().unwrap_or("").to_string();
        (
            "compgen -f -- \"$COMP_WORD\" 2>/dev/null | sort -u | head -100",
            w,
        )
    };

    // Resolve cwd (handle ~ prefix)
    let cwd_path = {
        let p = &args.cwd;
        if p == "~" {
            dirs::home_dir().unwrap_or_default()
        } else if let Some(rest) = p.strip_prefix("~/") {
            dirs::home_dir().unwrap_or_default().join(rest)
        } else {
            let pb = std::path::PathBuf::from(p);
            if pb.exists() { pb } else { dirs::home_dir().unwrap_or_default() }
        }
    };

    let output = std::process::Command::new("bash")
        .args(["-c", bash_script])
        .env("COMP_WORD", &word)
        .current_dir(&cwd_path)
        .output()
        .map_err(|e| e.to_string())?;

    let completions: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(completions)
}

/// Read an environment variable from the Rust process (API keys are not visible to WebView JS).
#[tauri::command]
pub async fn get_env_var(name: String) -> Result<String, String> {
    std::env::var(&name).map_err(|_| format!("Environment variable '{}' is not set", name))
}

/// Run `claude -p <prompt>` as a subprocess and return the response text.
/// Requires the `claude` CLI to be installed and authenticated.
#[tauri::command]
pub async fn claude_cli_query(prompt: String) -> Result<String, String> {
    use std::process::Command;

    let output = Command::new("claude")
        .args(["-p", &prompt])
        .output()
        .map_err(|e| format!("Failed to spawn `claude` CLI: {}. Is it installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("claude CLI error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn pty_get_scrollback(
    pane_id: u32,
    pty_mgr: State<'_, SharedPtyManager>,
) -> Result<Vec<String>, String> {
    let pty = pty_mgr.lock().unwrap();
    Ok(pty.get_scrollback(pane_id))
}
