use crate::config::{load_config, SharedConfig};
use crate::pty::SharedPtyManager;
use crate::session::{AgentType, PaneNameSource, SessionStatus, SharedSessionManager};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize)]
pub struct SpawnPtyArgs {
    pub pane_id: u32,
    pub cwd: Option<String>,
    pub tmux_session: Option<String>,
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
    pub tmux_session: Option<String>,
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
    let (shell, shell_args, tmux, group, cwd) = {
        let cfg = config.lock().unwrap();
        // session_defaults.shell overrides cfg.shell.program if set
        let shell = cfg
            .session_defaults
            .shell
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| cfg.shell.program.clone());
        let shell_args = cfg.shell.args.clone();
        let tmux = cfg.tmux.clone();
        let group = cfg.session_defaults.group.clone();
        let cwd = args.cwd.unwrap_or_else(|| {
            dirs::home_dir()
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });
        (shell, shell_args, tmux, group, cwd)
    };

    let row_index = {
        let mut session = session_mgr.lock().unwrap();
        if args.new_row {
            // Use the exact insertion point the frontend computed. Falls back
            // to append if not provided.
            let target = args
                .target_row
                .unwrap_or_else(|| session.layout().rows.len());
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

    let spawn = {
        let mut pty = pty_mgr.lock().unwrap();
        pty.spawn(
            args.pane_id,
            &shell,
            &shell_args,
            &tmux,
            args.tmux_session.as_deref(),
            &cwd,
            args.cols,
            args.rows,
            app.clone(),
            session_mgr.inner().clone(),
        )?
    };

    {
        let mut session = session_mgr.lock().unwrap();
        let _pane = session.create_pane(
            args.pane_id,
            cwd,
            group,
            row_index,
            spawn.tmux_session.clone(),
        );
        // Notify frontend of session change
        let _ = app.emit("session:changed", session.all_panes());
        drop(session);
    }

    Ok(SpawnPtyResult {
        pane_id: args.pane_id,
        pid: spawn.pid,
        tmux_session: spawn.tmux_session,
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
    name_source: Option<String>,
    app: AppHandle,
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<(), String> {
    let source = match name_source.as_deref() {
        Some("auto") => PaneNameSource::Auto,
        _ => PaneNameSource::Manual,
    };
    let mut session = session_mgr.lock().unwrap();
    session.rename_pane(pane_id, name, source);
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
        "gemini" => AgentType::Gemini,
        "opencode" => AgentType::Opencode,
        "goose" => AgentType::Goose,
        "cursor" => AgentType::Cursor,
        "qwen" => AgentType::Qwen,
        "amp" => AgentType::Amp,
        "crush" => AgentType::Crush,
        "openhands" => AgentType::Openhands,
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
pub async fn config_reload(app: AppHandle, config: State<'_, SharedConfig>) -> Result<(), String> {
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

fn split_shell_word_for_completion(input: &str) -> (&str, bool) {
    let mut token_start = 0;
    let mut completed_tokens = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let mut in_token = false;

    for (idx, ch) in input.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        match ch {
            '\\' if !in_single => {
                escaped = true;
                in_token = true;
            }
            '\'' if !in_double => {
                in_single = !in_single;
                in_token = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                in_token = true;
            }
            c if !in_single && !in_double && c.is_whitespace() => {
                if in_token {
                    completed_tokens += 1;
                    in_token = false;
                }
                token_start = idx + c.len_utf8();
            }
            _ => in_token = true,
        }
    }

    (&input[token_start..], completed_tokens == 0)
}

fn unescape_shell_word(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    for ch in word.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }

        match ch {
            '\\' if !in_single => escaped = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            _ => out.push(ch),
        }
    }

    if escaped {
        out.push('\\');
    }

    out
}

fn shell_escape_word(word: &str) -> String {
    let mut escaped = String::with_capacity(word.len());
    for ch in word.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-') {
            escaped.push(ch);
        } else {
            escaped.push('\\');
            escaped.push(ch);
        }
    }
    escaped
}

#[tauri::command]
pub async fn shell_complete(args: ShellCompleteArgs) -> Result<Vec<String>, String> {
    let input = &args.input;
    let (current_word, first_word) = split_shell_word_for_completion(input);
    let word = unescape_shell_word(current_word);

    // Decide what to complete and which word is being completed
    let bash_script = if first_word {
        // First word — complete commands, aliases, functions
        "compgen -A function -A alias -c -- \"$COMP_WORD\" 2>/dev/null | sort -u | head -100"
    } else {
        // Argument position — complete file/dir paths
        "compgen -f -- \"$COMP_WORD\" 2>/dev/null | sort -u | head -100"
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
            if pb.exists() {
                pb
            } else {
                dirs::home_dir().unwrap_or_default()
            }
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
        .map(shell_escape_word)
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
    ai_cli_query("claude-cli".to_string(), prompt).await
}

/// Run a local AI CLI as a subprocess and return the response text.
/// Requires the selected CLI to be installed and authenticated.
#[tauri::command]
pub async fn ai_cli_query(cli: String, prompt: String) -> Result<String, String> {
    use tokio::process::Command;

    let (binary, shell_command) = match cli.as_str() {
        "claude-cli" => ("claude", "claude -p \"$FLUXTTY_PROMPT\""),
        "codex-cli" => ("codex", "codex exec \"$FLUXTTY_PROMPT\""),
        "opencode-cli" => ("opencode", "opencode run \"$FLUXTTY_PROMPT\""),
        "gemini-cli" => ("gemini", "gemini --prompt \"$FLUXTTY_PROMPT\""),
        "qwen-cli" => ("qwen", "qwen --prompt \"$FLUXTTY_PROMPT\""),
        other => return Err(format!("Unsupported AI CLI model: {}", other)),
    };

    // macOS GUI apps don't inherit the shell PATH, so `claude` may not be
    // found with Command::new("claude"). Run via an interactive login shell
    // (-i -l) so that both ~/.zprofile and ~/.zshrc are sourced, picking up
    // paths added by nvm, homebrew, etc.
    // stdin is /dev/null to prevent interactive prompts from hanging.
    // The prompt is passed via an env var to avoid shell-injection issues.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(&shell)
        .args(["-i", "-l", "-c", shell_command])
        .env("FLUXTTY_PROMPT", &prompt)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| {
            format!(
                "Failed to spawn shell: {}. Is `{}` CLI installed?",
                e, binary
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = stderr.trim();
        if msg.contains("command not found") {
            return Err(format!(
                "{} CLI not found in PATH.\n\
                Run `which {}` in your terminal to find the path, \
                then make sure it is accessible from your shell profile \
                (~/.zprofile or ~/.zshrc).",
                binary, binary
            ));
        }
        let detail = if !msg.is_empty() {
            msg.to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exited with {} without output", output.status)
        };
        return Err(format!("{} CLI error: {}", binary, detail));
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
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    #[serde(default)]
    pub options: std::collections::BTreeMap<String, serde_json::Value>,
}

/// Infer provider from model name (mirrors the JS inferProvider logic).
fn infer_provider(model: &str) -> &'static str {
    match model {
        "claude-cli" => return "claude-cli",
        "codex-cli" => return "codex-cli",
        "opencode-cli" => return "opencode-cli",
        "gemini-cli" => return "gemini-cli",
        "qwen-cli" => return "qwen-cli",
        _ => {}
    }
    if model.starts_with("claude-") {
        return "anthropic";
    }
    if model.starts_with("gpt-")
        || model.starts_with("o1-")
        || model.starts_with("o3-")
        || model.starts_with("o4-")
        || model.starts_with("chatgpt-")
    {
        return "openai";
    }
    if model.starts_with("gemini-") {
        return "google";
    }
    if model.starts_with("ollama/") || model.starts_with("ollama:") {
        return "ollama";
    }
    if model.starts_with("deepseek-") {
        return "deepseek";
    }
    if model.starts_with("grok-") {
        return "xai";
    }
    if model.starts_with("mistral-") || model.starts_with("codestral-") {
        return "mistral";
    }
    if model.starts_with("kimi-") {
        return "moonshot";
    }
    if model.starts_with("glm-") {
        return "zai";
    }
    if let Some(prefix) = model.split_once('/').map(|(p, _)| p) {
        // explicit provider prefix — return as static str via leak (rare path)
        let s: &'static str = Box::leak(prefix.to_string().into_boxed_str());
        return s;
    }
    "openai"
}

/// Strip "provider/" prefix from model name before sending to the API.
fn strip_provider_prefix<'a>(model: &'a str, provider: &str) -> &'a str {
    let explicit_prefix = format!("{}/", provider);
    if let Some(rest) = model.strip_prefix(&explicit_prefix) {
        return rest;
    }
    model
}

fn versioned_api_url(base: &str, version: &str, endpoint: &str) -> String {
    let base = base.trim_end_matches('/');
    let version = version.trim_matches('/');
    let endpoint = endpoint.trim_start_matches('/');
    if base.ends_with(&format!("/{}", version)) {
        format!("{}/{}", base, endpoint)
    } else {
        format!("{}/{}/{}", base, version, endpoint)
    }
}

fn append_api_path(base: &str, endpoint: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        endpoint.trim_start_matches('/'),
    )
}

fn resolve_config_string(value: &str) -> Result<String, String> {
    if let Some(name) = value
        .strip_prefix("{env:")
        .and_then(|v| v.strip_suffix('}'))
    {
        return std::env::var(name)
            .map_err(|_| format!("Environment variable '{}' is not set", name));
    }

    if let Some(path) = value
        .strip_prefix("{file:")
        .and_then(|v| v.strip_suffix('}'))
    {
        let path = if let Some(rest) = path.strip_prefix("~/") {
            dirs::home_dir().unwrap_or_default().join(rest)
        } else {
            std::path::PathBuf::from(path)
        };
        return std::fs::read_to_string(&path)
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("Could not read {:?}: {}", path, e));
    }

    Ok(value.to_string())
}

fn option_string(
    options: &std::collections::BTreeMap<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| options.get(*key)?.as_str().map(ToString::to_string))
}

fn openai_chat_completions_url(
    provider: &str,
    base: &str,
    options: &std::collections::BTreeMap<String, serde_json::Value>,
) -> String {
    option_string(options, &["chatCompletionsPath", "chat_completions_path"])
        .or_else(|| default_chat_completions_path(provider).map(ToString::to_string))
        .map(|path| append_api_path(base, &path))
        .unwrap_or_else(|| versioned_api_url(base, "v1", "chat/completions"))
}

fn option_u64(
    options: &std::collections::BTreeMap<String, serde_json::Value>,
    keys: &[&str],
) -> Option<u64> {
    keys.iter().find_map(|key| options.get(*key)?.as_u64())
}

fn apply_common_llm_options(
    body: &mut serde_json::Value,
    options: &std::collections::BTreeMap<String, serde_json::Value>,
) {
    if let Some(v) = option_u64(options, &["maxTokens", "max_tokens"]) {
        body["max_tokens"] = serde_json::json!(v);
    }
    if let Some(v) = options.get("temperature").and_then(|v| v.as_f64()) {
        body["temperature"] = serde_json::json!(v);
    }
    if let Some(v) = options
        .get("topP")
        .or_else(|| options.get("top_p"))
        .and_then(|v| v.as_f64())
    {
        body["top_p"] = serde_json::json!(v);
    }
    if let Some(v) = option_string(options, &["reasoningEffort", "reasoning_effort"]) {
        body["reasoning_effort"] = serde_json::json!(v);
    }
}

#[tauri::command]
pub async fn llm_complete(args: LlmCompleteArgs) -> Result<String, String> {
    let provider = args
        .provider
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| infer_provider(&args.model))
        .to_string();

    let base_url = args
        .base_url
        .clone()
        .or_else(|| option_string(&args.options, &["baseURL", "base_url"]))
        .map(|value| resolve_config_string(&value))
        .transpose()?
        .or_else(|| default_base_url(&provider).map(ToString::to_string));

    // Resolve API key from OpenCode-style {env:...}/{file:...}, or legacy env var.
    let api_key = args
        .api_key
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(resolve_config_string)
        .transpose()?
        .or_else(|| {
            args.api_key_env
                .as_deref()
                .filter(|s| !s.is_empty())
                .and_then(|env| std::env::var(env).ok())
        })
        .or_else(|| {
            option_string(&args.options, &["apiKey", "api_key"])
                .and_then(|value| resolve_config_string(&value).ok())
        })
        .or_else(|| default_api_key_env(&provider).and_then(|env| std::env::var(env).ok()))
        .unwrap_or_default();

    let model = strip_provider_prefix(&args.model, &provider).to_string();
    let client = reqwest::Client::new();
    let provider_kind = match provider.as_str() {
        "anthropic" | "openai" | "google" | "ollama" => provider.as_str(),
        "openai-compatible" | "lmstudio" | "openrouter" | "deepseek" | "xai" | "mistral"
        | "groq" | "together" | "moonshot" | "zai" | "perplexity" | "fireworks" | "cerebras" => {
            "openai"
        }
        _ if base_url.is_some() => "openai",
        _ => provider.as_str(),
    };

    match provider_kind {
        "anthropic" => {
            let base = base_url.as_deref().unwrap_or("https://api.anthropic.com");
            let url = versioned_api_url(base, "v1", "messages");

            let system: Vec<_> = args.messages.iter()
                .filter(|m| m.role == "system")
                .map(|m| m.content.as_str())
                .collect();
            let chat: Vec<_> = args.messages.iter()
                .filter(|m| m.role != "system")
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();

            let max_tokens = option_u64(&args.options, &["maxTokens", "max_tokens"]).unwrap_or(1024);
            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": max_tokens,
                "messages": chat,
            });
            if !system.is_empty() {
                body["system"] = serde_json::json!(system.join("\n\n"));
            }
            if let Some(thinking) = args.options.get("thinking") {
                body["thinking"] = thinking.clone();
            }
            if let Some(v) = args.options.get("temperature").and_then(|v| v.as_f64()) {
                body["temperature"] = serde_json::json!(v);
            }
            if let Some(v) = args.options.get("topP").or_else(|| args.options.get("top_p")).and_then(|v| v.as_f64()) {
                body["top_p"] = serde_json::json!(v);
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
            let base = base_url.as_deref().unwrap_or("https://api.openai.com");
            let url = openai_chat_completions_url(&provider, base, &args.options);

            let msgs: Vec<_> = args.messages.iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();
            let mut body = serde_json::json!({ "model": model, "messages": msgs });
            apply_common_llm_options(&mut body, &args.options);

            let mut req = client.post(&url).header("content-type", "application/json").json(&body);
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", api_key));
            }
            let res = req
                .send()
                .await
                .map_err(|e| format!("OpenAI-compatible request failed: {}", e))?;

            if !res.status().is_success() {
                let status = res.status().as_u16();
                let text = res.text().await.unwrap_or_default();
                return Err(format!("OpenAI-compatible {}: {}", status, text.trim()));
            }
            let data: serde_json::Value = res.json().await
                .map_err(|e| format!("OpenAI-compatible parse error: {}", e))?;
            Ok(data["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
        }

        "google" => {
            let base = base_url.as_deref().unwrap_or("https://generativelanguage.googleapis.com");
            let url = versioned_api_url(base, "v1beta", &format!("models/{}:generateContent", model));

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
            if let Some(max_tokens) = option_u64(&args.options, &["maxTokens", "max_tokens"]) {
                body["generationConfig"]["maxOutputTokens"] = serde_json::json!(max_tokens);
            }
            if let Some(temperature) = args.options.get("temperature").and_then(|v| v.as_f64()) {
                body["generationConfig"]["temperature"] = serde_json::json!(temperature);
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
            let base = base_url.as_deref().unwrap_or("http://localhost:11434");
            let url = append_api_path(base, "api/chat");

            let ollama_model = model.trim_start_matches("ollama/").trim_start_matches("ollama:");
            let msgs: Vec<_> = args.messages.iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();
            let mut body = serde_json::json!({
                "model": ollama_model,
                "messages": msgs,
                "stream": false,
            });
            if let Some(options) = args.options.get("options") {
                body["options"] = options.clone();
            }

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
            "Unknown provider \"{}\". Use anthropic/openai/google/ollama or configure a baseURL for an OpenAI-compatible provider.",
            other
        )),
    }
}

fn default_api_key_env(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        "google" => Some("GOOGLE_API_KEY"),
        "openrouter" => Some("OPENROUTER_API_KEY"),
        "deepseek" => Some("DEEPSEEK_API_KEY"),
        "xai" => Some("XAI_API_KEY"),
        "mistral" => Some("MISTRAL_API_KEY"),
        "groq" => Some("GROQ_API_KEY"),
        "together" => Some("TOGETHER_API_KEY"),
        "moonshot" => Some("MOONSHOT_API_KEY"),
        "zai" => Some("ZAI_API_KEY"),
        "perplexity" => Some("PERPLEXITY_API_KEY"),
        "fireworks" => Some("FIREWORKS_API_KEY"),
        "cerebras" => Some("CEREBRAS_API_KEY"),
        _ => None,
    }
}

fn default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "ollama" => Some("http://localhost:11434"),
        "lmstudio" => Some("http://localhost:1234/v1"),
        "openrouter" => Some("https://openrouter.ai/api/v1"),
        "deepseek" => Some("https://api.deepseek.com/v1"),
        "xai" => Some("https://api.x.ai/v1"),
        "mistral" => Some("https://api.mistral.ai/v1"),
        "groq" => Some("https://api.groq.com/openai/v1"),
        "together" => Some("https://api.together.xyz/v1"),
        "moonshot" => Some("https://api.moonshot.ai/v1"),
        "zai" => Some("https://api.z.ai/api/coding/paas/v4"),
        "perplexity" => Some("https://api.perplexity.ai"),
        "fireworks" => Some("https://api.fireworks.ai/inference/v1"),
        "cerebras" => Some("https://api.cerebras.ai/v1"),
        _ => None,
    }
}

fn default_chat_completions_path(provider: &str) -> Option<&'static str> {
    match provider {
        "zai" | "perplexity" => Some("chat/completions"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn strips_only_the_selected_fluxtty_provider_prefix() {
        assert_eq!(strip_provider_prefix("openai/gpt-5.4", "openai"), "gpt-5.4");
        assert_eq!(
            strip_provider_prefix("anthropic/claude-sonnet-4.5", "openrouter"),
            "anthropic/claude-sonnet-4.5",
        );
    }

    #[test]
    fn builds_versioned_urls_without_duplicate_version_segments() {
        assert_eq!(
            versioned_api_url("https://api.openai.com", "v1", "chat/completions"),
            "https://api.openai.com/v1/chat/completions",
        );
        assert_eq!(
            versioned_api_url("https://openrouter.ai/api/v1", "v1", "chat/completions"),
            "https://openrouter.ai/api/v1/chat/completions",
        );
    }

    #[test]
    fn provider_specific_chat_path_supports_zai_and_perplexity() {
        let options = BTreeMap::new();
        assert_eq!(
            openai_chat_completions_url("zai", "https://api.z.ai/api/coding/paas/v4", &options),
            "https://api.z.ai/api/coding/paas/v4/chat/completions",
        );
        assert_eq!(
            openai_chat_completions_url("perplexity", "https://api.perplexity.ai", &options),
            "https://api.perplexity.ai/chat/completions",
        );
    }
}

/// AI-friendly pane context: structured metadata + recent stripped scrollback.
/// Returns `None` if the pane does not exist.
#[derive(Debug, Serialize)]
pub struct PaneContext {
    pub info: crate::session::PaneInfo,
    /// Last N lines of PTY output with ANSI escape codes stripped.
    pub recent_output: Vec<String>,
}

/// Maximum lines of scrollback included in pane context.
const PANE_CONTEXT_OUTPUT_LINES: usize = 50;

#[tauri::command]
pub async fn get_pane_context(
    pane_id: u32,
    pty_mgr: State<'_, SharedPtyManager>,
    session_mgr: State<'_, SharedSessionManager>,
) -> Result<Option<PaneContext>, String> {
    let info = {
        let session = session_mgr.lock().unwrap();
        session.all_panes().into_iter().find(|p| p.id == pane_id)
    };
    let Some(info) = info else { return Ok(None) };

    let raw_lines = {
        let pty = pty_mgr.lock().unwrap();
        pty.get_scrollback(pane_id)
    };

    // Strip ANSI escape sequences so the AI receives clean text.
    let recent_output = raw_lines
        .iter()
        .rev()
        .take(PANE_CONTEXT_OUTPUT_LINES)
        .rev()
        .map(|line| strip_ansi(line))
        .filter(|line| !line.trim().is_empty())
        .collect();

    Ok(Some(PaneContext {
        info,
        recent_output,
    }))
}

/// Very small ANSI stripper: removes ESC-based sequences common in terminal output.
/// This intentionally avoids pulling in a full-featured crate for a single use-case.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            match chars.peek() {
                // CSI sequence: ESC [ ... final-byte (0x40–0x7E)
                Some('[') => {
                    chars.next(); // consume '['
                    for c in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC sequence: ESC ] ... ST (BEL or ESC \)
                Some(']') => {
                    chars.next(); // consume ']'
                    loop {
                        match chars.next() {
                            None | Some('\x07') => break,
                            Some('\x1b') => {
                                chars.next();
                                break;
                            } // ESC \
                            _ => {}
                        }
                    }
                }
                // Other two-char sequences: skip next char
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
        } else {
            out.push(ch);
        }
    }
    out
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
    #[serde(default)]
    pub tmux_session: Option<String>,
    #[serde(default)]
    pub name_source: Option<PaneNameSource>,
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
    log::info!(
        "Workspace snapshot saved ({} panes) to {:?}",
        snapshot.panes.len(),
        path
    );
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
            log::info!(
                "Workspace snapshot loaded ({} panes) from {:?}",
                snap.panes.len(),
                path
            );
            Ok(Some(snap))
        }
        Err(e) => {
            log::warn!("Workspace snapshot corrupt, starting fresh: {}", e);
            Ok(None)
        }
    }
}

// ── Window chrome ──────────────────────────────────────────────────────────────────────────────

/// Show or hide the macOS traffic-light buttons without touching window
/// decorations (which would remove rounded corners and shadow).
/// On non-macOS platforms this is a no-op.
#[tauri::command]
pub async fn window_set_traffic_lights_hidden(
    window: tauri::WebviewWindow,
    hidden: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};

        // Cast to usize so the value is Send and can be moved into the closure.
        let ns_win_ptr = window.ns_window().map_err(|e| e.to_string())? as usize;

        window
            .run_on_main_thread(move || unsafe {
                let ns_win = ns_win_ptr as *mut Object;
                // NSWindowCloseButton = 0, NSWindowMiniaturizeButton = 1, NSWindowZoomButton = 2
                for kind in [0i64, 1i64, 2i64] {
                    let btn: *mut Object = msg_send![ns_win, standardWindowButton: kind];
                    if !btn.is_null() {
                        let _: () = msg_send![btn, setHidden: hidden as u8];
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, hidden);
    Ok(())
}

/// Forcefully exits the Tauri application with code 0.
#[tauri::command]
pub async fn app_exit(app: tauri::AppHandle) -> Result<(), String> {
    crate::IS_EXITING.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
    Ok(())
}
