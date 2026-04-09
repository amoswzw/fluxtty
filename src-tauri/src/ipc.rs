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
    use tokio::process::Command;

    // macOS GUI apps don't inherit the shell PATH, so `claude` may not be
    // found with Command::new("claude"). Run via an interactive login shell
    // (-i -l) so that both ~/.zprofile and ~/.zshrc are sourced, picking up
    // paths added by nvm, homebrew, etc.
    // stdin is /dev/null to prevent interactive prompts from hanging.
    // The prompt is passed via an env var to avoid shell-injection issues.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(&shell)
        .args(["-i", "-l", "-c", "claude -p \"$FLUXTTY_PROMPT\""])
        .env("FLUXTTY_PROMPT", &prompt)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("Failed to spawn shell: {}. Is `claude` CLI installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        if msg.contains("command not found") {
            return Err(format!(
                "claude CLI not found in PATH.\n\
                Run `which claude` in your terminal to find the path, \
                then make sure it is accessible from your shell profile \
                (~/.zprofile or ~/.zshrc)."
            ));
        }
        return Err(format!("claude CLI error: {}", msg));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ── LLM API proxy ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct LlmCompleteArgs {
    pub messages: Vec<LlmMessage>,
    pub model: String,
    pub provider: Option<String>,
    pub api_key_env: Option<String>,
    pub base_url: Option<String>,
}

/// Infer provider from model name (mirrors the JS inferProvider logic).
fn infer_provider(model: &str) -> &'static str {
    if model == "claude-cli" { return "claude-cli"; }
    if model.starts_with("claude-") { return "anthropic"; }
    if model.starts_with("gpt-") || model.starts_with("o1-") || model.starts_with("o3-")
        || model.starts_with("o4-") || model.starts_with("chatgpt-") { return "openai"; }
    if model.starts_with("gemini-") { return "google"; }
    if model.starts_with("ollama/") || model.starts_with("ollama:") { return "ollama"; }
    if let Some(prefix) = model.split_once('/').map(|(p, _)| p) {
        // explicit provider prefix — return as static str via leak (rare path)
        let s: &'static str = Box::leak(prefix.to_string().into_boxed_str());
        return s;
    }
    "openai"
}

/// Strip "provider/" prefix from model name before sending to the API.
fn strip_provider_prefix(model: &str) -> &str {
    let prefixes = ["anthropic/", "openai/", "google/", "ollama/", "ollama:"];
    for p in prefixes {
        if let Some(rest) = model.strip_prefix(p) { return rest; }
    }
    model
}

#[tauri::command]
pub async fn llm_complete(args: LlmCompleteArgs) -> Result<String, String> {
    let provider = args.provider
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| infer_provider(&args.model))
        .to_string();

    // Resolve API key from environment variable
    let api_key = args.api_key_env
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|env| std::env::var(env).ok())
        .unwrap_or_default();

    let model = strip_provider_prefix(&args.model).to_string();
    let client = reqwest::Client::new();

    match provider.as_str() {
        "anthropic" => {
            let base = args.base_url.as_deref().unwrap_or("https://api.anthropic.com");
            let url = format!("{}/v1/messages", base.trim_end_matches('/'));

            let system: Vec<_> = args.messages.iter()
                .filter(|m| m.role == "system")
                .map(|m| m.content.as_str())
                .collect();
            let chat: Vec<_> = args.messages.iter()
                .filter(|m| m.role != "system")
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();

            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": 1024,
                "messages": chat,
            });
            if !system.is_empty() {
                body["system"] = serde_json::json!(system.join("\n\n"));
            }

            let res = client.post(&url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Anthropic request failed: {}", e))?;

            if !res.status().is_success() {
                let status = res.status().as_u16();
                let text = res.text().await.unwrap_or_default();
                return Err(format!("Anthropic {}: {}", status, text.trim()));
            }
            let data: serde_json::Value = res.json().await
                .map_err(|e| format!("Anthropic parse error: {}", e))?;
            Ok(data["content"][0]["text"].as_str().unwrap_or("").to_string())
        }

        "openai" => {
            let base = args.base_url.as_deref().unwrap_or("https://api.openai.com");
            let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));

            let msgs: Vec<_> = args.messages.iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();
            let body = serde_json::json!({ "model": model, "messages": msgs });

            let res = client.post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("OpenAI request failed: {}", e))?;

            if !res.status().is_success() {
                let status = res.status().as_u16();
                let text = res.text().await.unwrap_or_default();
                return Err(format!("OpenAI {}: {}", status, text.trim()));
            }
            let data: serde_json::Value = res.json().await
                .map_err(|e| format!("OpenAI parse error: {}", e))?;
            Ok(data["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
        }

        "google" => {
            let base = args.base_url.as_deref().unwrap_or("https://generativelanguage.googleapis.com");
            let url = format!(
                "{}/v1beta/models/{}:generateContent",
                base.trim_end_matches('/'), model
            );

            let system: Vec<_> = args.messages.iter()
                .filter(|m| m.role == "system")
                .map(|m| m.content.as_str())
                .collect();
            let contents: Vec<_> = args.messages.iter()
                .filter(|m| m.role != "system")
                .map(|m| serde_json::json!({
                    "role": if m.role == "assistant" { "model" } else { "user" },
                    "parts": [{ "text": m.content }],
                }))
                .collect();

            let mut body = serde_json::json!({ "contents": contents });
            if !system.is_empty() {
                body["system_instruction"] = serde_json::json!({
                    "parts": [{ "text": system.join("\n\n") }]
                });
            }

            let res = client.post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Google request failed: {}", e))?;

            if !res.status().is_success() {
                let status = res.status().as_u16();
                let text = res.text().await.unwrap_or_default();
                return Err(format!("Google {}: {}", status, text.trim()));
            }
            let data: serde_json::Value = res.json().await
                .map_err(|e| format!("Google parse error: {}", e))?;
            Ok(data["candidates"][0]["content"]["parts"][0]["text"]
                .as_str().unwrap_or("").to_string())
        }

        "ollama" => {
            let base = args.base_url.as_deref().unwrap_or("http://localhost:11434");
            let url = format!("{}/api/chat", base.trim_end_matches('/'));

            // Strip leading "ollama/" or "ollama:" if present
            let ollama_model = model.trim_start_matches("ollama/").trim_start_matches("ollama:");
            let msgs: Vec<_> = args.messages.iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();
            let body = serde_json::json!({
                "model": ollama_model,
                "messages": msgs,
                "stream": false,
            });

            let res = client.post(&url)
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Ollama request failed: {}. Is Ollama running?", e))?;

            if !res.status().is_success() {
                let status = res.status().as_u16();
                let text = res.text().await.unwrap_or_default();
                return Err(format!("Ollama {}: {}", status, text.trim()));
            }
            let data: serde_json::Value = res.json().await
                .map_err(|e| format!("Ollama parse error: {}", e))?;
            Ok(data["message"]["content"].as_str().unwrap_or("").to_string())
        }

        other => Err(format!(
            "Unknown provider \"{}\". Supported: anthropic, openai, google, ollama, claude-cli",
            other
        )),
    }
}

#[tauri::command]
pub async fn pty_get_scrollback(
    pane_id: u32,
    pty_mgr: State<'_, SharedPtyManager>,
) -> Result<Vec<String>, String> {
    let pty = pty_mgr.lock().unwrap();
    Ok(pty.get_scrollback(pane_id))
}

// ── Workspace snapshot (disk persistence — Phase 6.2) ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneSnapshot {
    pub name: String,
    pub group: String,
    pub note: String,
    pub cwd: String,
    pub row_index: usize,
    pub pane_index: usize,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub version: u32,
    pub panes: Vec<PaneSnapshot>,
}

fn resolve_snapshot_path(cfg: &crate::config::PersistenceConfig) -> std::path::PathBuf {
    let p = &cfg.disk_state_path;
    if let Some(rest) = p.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else if p == "~" {
        dirs::home_dir().unwrap_or_default()
    } else {
        std::path::PathBuf::from(p)
    }
}

/// Save the current workspace layout to disk so it can be restored on next launch.
#[tauri::command]
pub async fn workspace_snapshot_save(
    snapshot: WorkspaceSnapshot,
    config: State<'_, SharedConfig>,
) -> Result<(), String> {
    let path = {
        let cfg = config.lock().unwrap();
        resolve_snapshot_path(&cfg.persistence)
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    // Atomic write via temp file + rename to avoid a corrupt snapshot on crash.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    log::info!("Workspace snapshot saved ({} panes) to {:?}", snapshot.panes.len(), path);
    Ok(())
}

/// Load the workspace snapshot from disk. Returns None if no snapshot exists or it is corrupt.
#[tauri::command]
pub async fn workspace_snapshot_load(
    config: State<'_, SharedConfig>,
) -> Result<Option<WorkspaceSnapshot>, String> {
    let path = {
        let cfg = config.lock().unwrap();
        resolve_snapshot_path(&cfg.persistence)
    };
    if !path.exists() {
        return Ok(None);
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Could not read snapshot {:?}: {}", path, e);
            return Ok(None);
        }
    };
    match serde_json::from_str::<WorkspaceSnapshot>(&content) {
        Ok(snap) => {
            log::info!("Workspace snapshot loaded ({} panes) from {:?}", snap.panes.len(), path);
            Ok(Some(snap))
        }
        Err(e) => {
            log::warn!("Workspace snapshot corrupt, starting fresh: {}", e);
            Ok(None)
        }
    }
}
