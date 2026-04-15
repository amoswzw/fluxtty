use crate::config::TmuxConfig;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ── Shell integration ────────────────────────────────────────────────────────
// Injects an OSC 7 CWD-notification hook into the spawned shell so fluxtty
// can track the working directory of each pane.
//
// Per-shell strategy:
//
//   zsh   — ZDOTDIR shim (.zshenv + .zshrc written to a config subdir).
//            Uses precmd_functions/chpwd_functions arrays directly to avoid
//            add-zsh-hook, which autoloads a helper function and adds
//            call-stack depth that can hit FUNCNEST inside complex configs.
//            .zshenv temporarily restores the user's original ZDOTDIR so
//            their code never sees the shim path; restores ours afterwards
//            so zsh still reads our .zshrc.
//
//   bash  — Interactive non-login: prepend --init-file (sources normal rcfiles
//            internally and re-attaches PROMPT_COMMAND after).
//            Login shell (-l/--login): can't use --init-file; export _wt_cwd
//            via BASH_FUNC_* env mechanism + seed PROMPT_COMMAND (best-effort).
//
//   fish  — Write to ~/.config/fish/conf.d/fluxtty.fish (auto-sourced by fish,
//            idempotent on each spawn).

struct ShellIntegration {
    env: Vec<(String, String)>,
    extra_args: Vec<String>,
}

impl Default for ShellIntegration {
    fn default() -> Self {
        ShellIntegration {
            env: vec![],
            extra_args: vec![],
        }
    }
}

fn shell_integration_env(tmux_passthrough: bool) -> Vec<(String, String)> {
    vec![(
        "_FLUXTTY_TMUX_PASSTHROUGH".to_string(),
        if tmux_passthrough { "1" } else { "0" }.to_string(),
    )]
}

fn setup_shell_integration(
    shell: &str,
    user_args: &[String],
    tmux_passthrough: bool,
) -> ShellIntegration {
    let name = Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if name.contains("zsh") {
        return setup_zsh(tmux_passthrough);
    }
    if name.contains("bash") {
        return setup_bash(user_args, tmux_passthrough);
    }
    if name == "fish" {
        return setup_fish(tmux_passthrough);
    }
    ShellIntegration::default()
}

fn setup_zsh(tmux_passthrough: bool) -> ShellIntegration {
    let zdotdir = match dirs::config_dir() {
        Some(d) => d.join("fluxtty").join("zdotdir"),
        None => return ShellIntegration::default(),
    };
    if std::fs::create_dir_all(&zdotdir).is_err() {
        return ShellIntegration::default();
    }

    let orig = std::env::var("ZDOTDIR").unwrap_or_else(|_| {
        dirs::home_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    // No .zshenv is created intentionally.
    //
    // Any attempt to source the user's ~/.zshenv from a shim .zshenv (or to
    // modify ZDOTDIR inside .zshenv) has proven fragile: some zsh builds
    // trigger internal re-read logic when ZDOTDIR changes during the startup
    // phase, causing "job table full or recursion limit exceeded".
    //
    // Skipping .zshenv is safe for interactive panes because:
    //   1. fluxtty inherits the parent process environment, so PATH and other
    //      vars set in ~/.zshenv are already present.
    //   2. The user's .zshrc is the primary interactive-shell config and is
    //      sourced below.
    //
    // Delete any .zshenv left by an older fluxtty version so zsh does not
    // accidentally pick it up.
    let _ = std::fs::remove_file(zdotdir.join(".zshenv"));

    // .zshrc — runs for interactive shells.
    // precmd_functions/chpwd_functions/preexec_functions are plain arrays.
    // add-zsh-hook is intentionally avoided (can overflow FUNCNEST in heavily
    // plugined setups).
    //
    // OSC 133 shell integration:
    //   _wt_precmd — runs before each prompt:
    //     • saves $? so later functions can't clobber it
    //     • emits OSC 133;D;exitcode (previous command done)
    //     • emits OSC 7 CWD
    //     • emits OSC 133;A (prompt start)
    //   _wt_preexec — runs just before each command executes:
    //     • emits OSC 133;B;cmd=<command> (command start, first 512 chars)
    //   chpwd still fires _wt_cwd on plain `cd` between prompts.
    let zshrc = format!(
        r#"# fluxtty — auto-generated, do not edit
if [[ -z "$_FLUXTTY_INIT" ]]; then
  export _FLUXTTY_INIT=1
  _wt_osc() {{
    if [[ -n "$TMUX" && "${{_FLUXTTY_TMUX_PASSTHROUGH:-1}}" != "0" ]]; then
      printf '\033Ptmux;\033\033]%s\007\033\\' "$1"
    else
      printf '\033]%s\007' "$1"
    fi
  }}
  _wt_cwd() {{ _wt_osc "7;file://$HOST$PWD"; }}
  _wt_precmd() {{
    local _ec=$?
    _wt_osc "133;D;$_ec"
    _wt_cwd
    _wt_osc "133;A"
  }}
  _wt_preexec() {{
    local _cmd="${{1:0:512}}"
    _wt_osc "133;B;cmd=$_cmd"
  }}
  typeset -ga precmd_functions chpwd_functions preexec_functions
  precmd_functions+=(_wt_precmd)
  chpwd_functions+=(_wt_cwd)
  preexec_functions+=(_wt_preexec)
  _wt_precmd
fi
export ZDOTDIR="{orig}"
[[ -f "{orig}/.zshrc" ]] && source "{orig}/.zshrc"
"#
    );

    let _ = std::fs::write(zdotdir.join(".zshrc"), &zshrc);

    let mut env = shell_integration_env(tmux_passthrough);
    env.push(("ZDOTDIR".to_string(), zdotdir.to_string_lossy().to_string()));

    ShellIntegration {
        env,
        extra_args: vec![],
    }
}

fn setup_bash(user_args: &[String], tmux_passthrough: bool) -> ShellIntegration {
    let init_dir = match dirs::config_dir() {
        Some(d) => d.join("fluxtty"),
        None => return ShellIntegration::default(),
    };
    if std::fs::create_dir_all(&init_dir).is_err() {
        return ShellIntegration::default();
    }

    let init_path = init_dir.join("bash-init.sh");
    // OSC 133 shell integration for bash:
    //   _wt_precmd_bash — runs via PROMPT_COMMAND before each prompt:
    //     captures $?, emits OSC 133;D, OSC 7 CWD, OSC 133;A.
    //   DEBUG trap — runs before each command to emit OSC 133;B.
    //     Uses $_wt_cmd_pending flag to emit only the first expansion per
    //     interactive command (the DEBUG trap fires for every pipeline stage,
    //     so we guard with a flag cleared in PROMPT_COMMAND).
    let init_script = r#"# fluxtty — auto-generated, do not edit
if [[ -z "$_FLUXTTY_INIT" ]]; then
  export _FLUXTTY_INIT=1
  _wt_osc() {
    if [[ -n "$TMUX" && "${_FLUXTTY_TMUX_PASSTHROUGH:-1}" != "0" ]]; then
      printf '\033Ptmux;\033\033]%s\007\033\\' "$1"
    else
      printf '\033]%s\007' "$1"
    fi
  }
  _wt_cwd() { _wt_osc "7;file://${HOSTNAME:-$(hostname)}$PWD"; }
  _wt_precmd_bash() {
    local _ec=$?
    _wt_osc "133;D;$_ec"
    _wt_cwd
    _wt_osc "133;A"
    _wt_cmd_pending=1
  }
  _wt_preexec_bash() {
    if [[ "$_wt_cmd_pending" == "1" && "$BASH_COMMAND" != "_wt_precmd_bash" ]]; then
      _wt_cmd_pending=0
      local _cmd="${BASH_COMMAND:0:512}"
      _wt_osc "133;B;cmd=$_cmd"
    fi
  }
  _wt_cmd_pending=1
  trap '_wt_preexec_bash' DEBUG
  _wt_precmd_bash
fi
if shopt -q login_shell 2>/dev/null; then
  for _f in ~/.bash_profile ~/.bash_login ~/.profile; do
    [[ -f "$_f" ]] && { source "$_f"; break; }
  done
  unset _f
else
  [[ -f ~/.bashrc ]] && source ~/.bashrc
fi
# Re-attach hooks in case rc files overwrote PROMPT_COMMAND / DEBUG trap
if [[ "$PROMPT_COMMAND" != *_wt_precmd_bash* ]]; then
  PROMPT_COMMAND="_wt_precmd_bash${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
trap '_wt_preexec_bash' DEBUG
"#;
    let _ = std::fs::write(&init_path, init_script);

    let is_login = user_args.iter().any(|a| a == "-l" || a == "--login");
    if is_login {
        // Login shells don't read --init-file; export the function via
        // bash's BASH_FUNC_* mechanism and seed PROMPT_COMMAND as env vars.
        // Best-effort: user's .bash_profile may still overwrite PROMPT_COMMAND.
        let mut env = shell_integration_env(tmux_passthrough);
        env.extend(vec![
                ("PROMPT_COMMAND".to_string(), "_wt_cwd".to_string()),
                (
                    "BASH_FUNC__wt_cwd%%".to_string(),
                    r#"() { local _payload="7;file://${HOSTNAME:-$(hostname)}$PWD"; if [[ -n "$TMUX" && "${_FLUXTTY_TMUX_PASSTHROUGH:-1}" != "0" ]]; then printf '\033Ptmux;\033\033]%s\007\033\\' "$_payload"; else printf '\033]%s\007' "$_payload"; fi; }"#.to_string(),
                ),
        ]);
        ShellIntegration {
            env,
            extra_args: vec![],
        }
    } else {
        ShellIntegration {
            env: shell_integration_env(tmux_passthrough),
            extra_args: vec![
                "--init-file".to_string(),
                init_path.to_string_lossy().to_string(),
            ],
        }
    }
}

fn setup_fish(tmux_passthrough: bool) -> ShellIntegration {
    // fish auto-sources every *.fish file in conf.d at startup.
    // Writing here on each spawn is idempotent (content never changes).
    let conf_d = match dirs::home_dir() {
        Some(h) => h.join(".config").join("fish").join("conf.d"),
        None => return ShellIntegration::default(),
    };
    if std::fs::create_dir_all(&conf_d).is_err() {
        return ShellIntegration::default();
    }
    // fish auto-sources every *.fish file in conf.d at startup — idempotent.
    // OSC 133 integration:
    //   fish_prompt event → OSC 133;D (exit code of last cmd), OSC 7, OSC 133;A
    //   fish_preexec event → OSC 133;B;cmd=<command>
    let script = r#"# fluxtty — auto-generated, do not edit
if not set -q _FLUXTTY_INIT
  set -gx _FLUXTTY_INIT 1
  function _wt_osc
    set -l payload $argv[1]
    if set -q TMUX; and test "$_FLUXTTY_TMUX_PASSTHROUGH" != "0"
      printf '\033Ptmux;\033\033]%s\007\033\\' "$payload"
    else
      printf '\033]%s\007' "$payload"
    end
  end
  function _wt_precmd_fish --on-event fish_prompt
    _wt_osc "133;D;$status"
    _wt_osc "7;file://"(hostname)$PWD
    _wt_osc "133;A"
  end
  function _wt_preexec_fish --on-event fish_preexec
    set -l _cmd (printf '%.512s' $argv[1])
    _wt_osc "133;B;cmd=$_cmd"
  end
  _wt_precmd_fish
end
"#;
    let _ = std::fs::write(conf_d.join("fluxtty.fish"), script);
    ShellIntegration {
        env: shell_integration_env(tmux_passthrough),
        extra_args: vec![],
    }
}

// ── OSC 133 shell integration parser ────────────────────────────────────────

/// Events decoded from OSC 133 sequences emitted by the shell integration hooks.
#[derive(Debug, PartialEq)]
pub enum Osc133Event {
    /// 133;A — prompt is about to be drawn.
    PromptStart,
    /// 133;B[;cmd=<text>] — a command is about to execute.
    CommandStart { cmd: Option<String> },
    /// 133;C — command output is about to begin (rarely used; kept for completeness).
    CommandOutput,
    /// 133;D;exitcode — command finished with the given exit code.
    CommandDone { exit_code: i32 },
}

/// Parse all OSC 133 sequences present in `data`.
/// Handles both BEL (0x07) and ST (ESC \) terminators.
pub fn parse_osc133(data: &str) -> Vec<Osc133Event> {
    let prefix = "\x1b]133;";
    let mut events = Vec::new();
    let mut search = data;

    while let Some(rel) = search.find(prefix) {
        search = &search[rel + prefix.len()..];

        // Find terminator — take whichever comes first.
        let end_bel = search.find('\x07');
        let end_st  = search.find("\x1b\\");
        let end = match (end_bel, end_st) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None)    => a,
            (None,    Some(b)) => b,
            (None,    None)    => search.len(),
        };

        let seq = &search[..end];
        if let Some(ev) = parse_one_osc133(seq) {
            events.push(ev);
        }

        // Advance past the terminator.
        if end < search.len() {
            let term_len = if search[end..].starts_with("\x1b\\") { 2 } else { 1 };
            search = &search[end + term_len..];
        } else {
            break;
        }
    }

    events
}

fn parse_one_osc133(seq: &str) -> Option<Osc133Event> {
    let first = seq.chars().next()?;
    match first {
        'A' => Some(Osc133Event::PromptStart),
        'B' => {
            // Optional suffix: ;cmd=<text>
            let cmd = seq.strip_prefix("B;cmd=").map(|s| s.to_string());
            Some(Osc133Event::CommandStart { cmd })
        }
        'C' => Some(Osc133Event::CommandOutput),
        'D' => {
            let code_str = seq.strip_prefix("D;").unwrap_or("0");
            let exit_code = code_str.parse::<i32>().unwrap_or(0);
            Some(Osc133Event::CommandDone { exit_code })
        }
        _ => None,
    }
}

// ── Alternate-screen detection ───────────────────────────────────────────────

/// Returns `Some(true)` if the data chunk enters alternate screen,
/// `Some(false)` if it exits, `None` if neither sequence is present.
pub fn parse_alternate_screen(data: &str) -> Option<bool> {
    // Scan once for both markers; take the last occurrence to handle the rare
    // case where a single chunk contains both enter and exit.
    let enter = data.rfind("\x1b[?1049h");
    let exit  = data.rfind("\x1b[?1049l");
    match (enter, exit) {
        (Some(a), Some(b)) => Some(a > b), // whichever is later wins
        (Some(_), None)    => Some(true),
        (None,    Some(_)) => Some(false),
        (None,    None)    => None,
    }
}

// ── OSC 7 ────────────────────────────────────────────────────────────────────

/// Parse an OSC 7 sequence from a PTY data chunk.
/// Format: ESC ] 7 ; file://hostname/path ST  (ST = BEL or ESC \)
fn parse_osc7(data: &str) -> Option<String> {
    let prefix = "\x1b]7;file://";
    let start = data.find(prefix)?;
    let rest = &data[start + prefix.len()..];
    // skip hostname → find first '/'
    let path_start = rest.find('/')?;
    let path_and_term = &rest[path_start..];
    // terminator: BEL (0x07) or ST (ESC \) — use whichever comes first
    let end_bel = path_and_term.find('\x07');
    let end_st  = path_and_term.find("\x1b\\");
    let end = match (end_bel, end_st) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None)    => a,
        (None,    Some(b)) => b,
        (None,    None)    => path_and_term.len(),
    };
    let path = path_and_term[..end].to_string();
    if path.starts_with('/') { Some(path) } else { None }
}

// ── tmux launcher ────────────────────────────────────────────────────────────

fn shell_quote(arg: &str) -> String {
    if arg.is_empty() {
        return "''".to_string();
    }

    if arg.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '@' | '%' | '_' | '+' | '=' | ':' | ',' | '.' | '/' | '-'
            )
    }) {
        return arg.to_string();
    }

    format!("'{}'", arg.replace('\'', "'\\''"))
}

fn cwd_name(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("workspace")
        .to_string()
}

fn sanitize_tmux_session_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, ':' | ';') {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        "fluxtty".to_string()
    } else {
        trimmed.to_string()
    }
}

fn short_tmux_id() -> String {
    Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect()
}

fn expand_tmux_session_name(template: &str, pane_id: u32, cwd: &str, short_id: &str) -> String {
    let raw = template
        .replace("{pane_id}", &pane_id.to_string())
        .replace("{cwd_name}", &cwd_name(cwd))
        .replace("{short_id}", short_id);
    sanitize_tmux_session_name(&raw)
}

fn resolve_tmux_session_name(
    tmux: &TmuxConfig,
    requested: Option<&str>,
    pane_id: u32,
    cwd: &str,
) -> String {
    requested
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(sanitize_tmux_session_name)
        .unwrap_or_else(|| expand_tmux_session_name(&tmux.session, pane_id, cwd, &short_tmux_id()))
}

fn build_shell_command(shell: &str, integration_args: &[String], user_args: &[String]) -> String {
    let words = std::iter::once(shell)
        .chain(integration_args.iter().map(String::as_str))
        .chain(user_args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>();
    words.join(" ")
}

fn build_tmux_args(
    tmux: &TmuxConfig,
    session_name: &str,
    cwd: &str,
    shell: &str,
    shell_args: &[String],
    integration: &ShellIntegration,
) -> Vec<String> {
    let mut args = tmux.extra_args.clone();

    if tmux.passthrough {
        // tmux 3.3+ gates passthrough. Older tmux versions ignore this quietly.
        args.extend([
            "set-option".to_string(),
            "-gq".to_string(),
            "allow-passthrough".to_string(),
            "on".to_string(),
            ";".to_string(),
        ]);
    }

    args.push("new-session".to_string());
    if tmux.auto_attach {
        args.push("-A".to_string());
    }
    args.push("-s".to_string());
    args.push(session_name.to_string());
    args.push("-c".to_string());
    args.push(cwd.to_string());
    args.push(build_shell_command(
        shell,
        &integration.extra_args,
        shell_args,
    ));
    args
}

pub struct PtySpawnOutcome {
    pub pid: u32,
    pub tmux_session: Option<String>,
}

pub struct PtyProcess {
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
}

pub struct PtyManager {
    ptys: HashMap<u32, PtyProcess>,
    scrollback: HashMap<u32, Arc<Mutex<Vec<String>>>>,
    max_scrollback: usize,
}

impl PtyManager {
    pub fn new(max_scrollback: usize) -> Self {
        PtyManager {
            ptys: HashMap::new(),
            scrollback: HashMap::new(),
            max_scrollback,
        }
    }

    pub fn spawn(
        &mut self,
        pane_id: u32,
        shell: &str,
        args: &[String],
        tmux: &TmuxConfig,
        requested_tmux_session: Option<&str>,
        cwd: &str,
        cols: u16,
        rows: u16,
        app: AppHandle,
        session_mgr: crate::session::SharedSessionManager,
    ) -> Result<PtySpawnOutcome, String> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let integration = setup_shell_integration(shell, args, tmux.passthrough);

        let (program, command_args, tmux_session) = if tmux.enabled {
            let session_name =
                resolve_tmux_session_name(tmux, requested_tmux_session, pane_id, cwd);
            let tmux_program = if tmux.program.trim().is_empty() {
                "tmux".to_string()
            } else {
                tmux.program.clone()
            };
            (
                tmux_program,
                build_tmux_args(tmux, &session_name, cwd, shell, args, &integration),
                Some(session_name),
            )
        } else {
            let mut command_args = Vec::new();
            // Integration args (e.g. --init-file for bash) must come before user args.
            command_args.extend(integration.extra_args.clone());
            command_args.extend(args.iter().cloned());
            (shell.to_string(), command_args, None)
        };

        let mut cmd = CommandBuilder::new(&program);
        for arg in &command_args {
            cmd.arg(arg);
        }
        cmd.cwd(cwd);

        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Clear inherited tmux environment variables to allow fluxtty to nest seamlessly
        // if fluxtty itself was launched from inside an existing tmux session (e.g. CLI)
        cmd.env_remove("TMUX");
        cmd.env_remove("TMUX_PANE");
        for (k, v) in &integration.env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            if tmux.enabled {
                format!("Failed to spawn tmux: {}", e)
            } else {
                format!("Failed to spawn shell: {}", e)
            }
        })?;

        let pid = child.process_id().unwrap_or(0);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get PTY reader: {}", e))?;

        let scrollback_arc: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        self.scrollback.insert(pane_id, scrollback_arc.clone());
        self.ptys.insert(
            pane_id,
            PtyProcess {
                master: pair.master,
                writer,
            },
        );

        // Spawn reader thread
        let scrollback_clone = scrollback_arc.clone();
        let max_sb = self.max_scrollback;

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            // Carry-over buffer for incomplete UTF-8 sequences split across chunks.
            // from_utf8_lossy would replace the partial bytes with U+FFFD; instead
            // we hold them and prepend to the next read so the sequence completes.
            let mut incomplete: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = app.emit(&format!("pty-closed-{}", pane_id), ());
                        break;
                    }
                    Ok(n) => {
                        // Prepend any leftover bytes from the previous chunk.
                        let mut data = incomplete.clone();
                        data.extend_from_slice(&buf[..n]);
                        incomplete.clear();

                        // Decode as UTF-8, keeping trailing incomplete sequences
                        // for the next iteration rather than replacing with U+FFFD.
                        let data_str = match std::str::from_utf8(&data) {
                            Ok(s) => s.to_string(),
                            Err(e) => {
                                let valid_up_to = e.valid_up_to();
                                // Save the incomplete tail for next chunk
                                incomplete.extend_from_slice(&data[valid_up_to..]);
                                // Decode only the valid prefix
                                String::from_utf8_lossy(&data[..valid_up_to]).to_string()
                            }
                        };

                        // Accumulate scrollback (simple line split)
                        if let Ok(mut sb) = scrollback_clone.lock() {
                            for line in data_str.split('\n') {
                                if !line.is_empty() {
                                    sb.push(line.to_string());
                                    if sb.len() > max_sb {
                                        sb.remove(0);
                                    }
                                }
                            }
                        }

                        // Parse all escape-sequence metadata before acquiring
                        // the session lock so we hold the lock as briefly as possible.
                        let new_cwd       = parse_osc7(&data_str);
                        let osc133_events = parse_osc133(&data_str);
                        let alt_screen    = parse_alternate_screen(&data_str);

                        let state_changed = new_cwd.is_some()
                            || !osc133_events.is_empty()
                            || alt_screen.is_some();

                        if state_changed {
                            let all_panes = if let Ok(mut session) = session_mgr.lock() {
                                if let Some(cwd) = new_cwd {
                                    session.set_pane_cwd(pane_id, cwd);
                                }
                                for event in osc133_events {
                                    match event {
                                        Osc133Event::CommandStart { cmd } => {
                                            if let Some(cmd_text) = cmd {
                                                let trimmed = cmd_text.trim().to_string();
                                                if !trimmed.is_empty() {
                                                    session.set_pane_last_command(pane_id, trimmed);
                                                }
                                            }
                                        }
                                        Osc133Event::CommandDone { exit_code } => {
                                            session.set_pane_command_done(pane_id, exit_code);
                                            let _ = app.emit("pane:command_complete",
                                                serde_json::json!({ "pane_id": pane_id, "exit_code": exit_code }));
                                        }
                                        _ => {}
                                    }
                                }
                                if let Some(active) = alt_screen {
                                    session.set_pane_alternate_screen(pane_id, active);
                                }
                                session.all_panes()
                            } else {
                                vec![]
                            };
                            if !all_panes.is_empty() {
                                let _ = app.emit("session:changed", all_panes);
                            }
                        }

                        // Emit PTY data to frontend
                        let _ = app.emit(
                            &format!("pty-data-{}", pane_id),
                            PtyDataPayload { pane_id, data: data_str },
                        );
                    }
                    Err(_) => {
                        let _ = app.emit(&format!("pty-closed-{}", pane_id), ());
                        break;
                    }
                }
            }
        });

        if let Some(session) = &tmux_session {
            log::info!(
                "Spawned PTY for pane {} (pid {}, tmux session {})",
                pane_id,
                pid,
                session
            );
        } else {
            log::info!("Spawned PTY for pane {} (pid {})", pane_id, pid);
        }
        Ok(PtySpawnOutcome { pid, tmux_session })
    }

    pub fn write(&mut self, pane_id: u32, data: &[u8]) -> Result<(), String> {
        if let Some(pty) = self.ptys.get_mut(&pane_id) {
            pty.writer.write_all(data).map_err(|e| format!("PTY write error: {}", e))?;
            Ok(())
        } else {
            Err(format!("Pane {} not found", pane_id))
        }
    }

    pub fn resize(&mut self, pane_id: u32, cols: u16, rows: u16) -> Result<(), String> {
        if let Some(pty) = self.ptys.get_mut(&pane_id) {
            pty.master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| format!("PTY resize error: {}", e))?;
            Ok(())
        } else {
            Err(format!("Pane {} not found", pane_id))
        }
    }

    pub fn kill(&mut self, pane_id: u32) {
        self.ptys.remove(&pane_id);
        self.scrollback.remove(&pane_id); // drops the Arc; thread's clone keeps it alive until thread exits
        log::info!("Killed PTY for pane {}", pane_id);
    }

    pub fn get_scrollback(&self, pane_id: u32) -> Vec<String> {
        self.scrollback
            .get(&pane_id)
            .and_then(|arc| arc.lock().ok())
            .map(|v| v.clone())
            .unwrap_or_default()
    }
}

#[derive(Clone, serde::Serialize)]
pub struct PtyDataPayload {
    pub pane_id: u32,
    pub data: String,
}

pub type SharedPtyManager = Arc<Mutex<PtyManager>>;

pub fn new_shared_pty_manager(max_scrollback: usize) -> SharedPtyManager {
    Arc::new(Mutex::new(PtyManager::new(max_scrollback)))
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_osc133 ─────────────────────────────────────────────────────────

    #[test]
    fn test_osc133_prompt_start_bel() {
        let data = "\x1b]133;A\x07";
        let events = parse_osc133(data);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], Osc133Event::PromptStart));
    }

    #[test]
    fn test_osc133_prompt_start_st() {
        let data = "\x1b]133;A\x1b\\";
        let events = parse_osc133(data);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], Osc133Event::PromptStart));
    }

    #[test]
    fn test_osc133_command_start_no_cmd() {
        let data = "\x1b]133;B\x07";
        let events = parse_osc133(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            Osc133Event::CommandStart { cmd } => assert!(cmd.is_none()),
            _ => panic!("expected CommandStart"),
        }
    }

    #[test]
    fn test_osc133_command_start_with_cmd() {
        let data = "\x1b]133;B;cmd=cargo build\x07";
        let events = parse_osc133(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            Osc133Event::CommandStart { cmd } => {
                assert_eq!(cmd.as_deref(), Some("cargo build"));
            }
            _ => panic!("expected CommandStart"),
        }
    }

    #[test]
    fn test_osc133_command_done_zero() {
        let data = "\x1b]133;D;0\x07";
        let events = parse_osc133(data);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], Osc133Event::CommandDone { exit_code: 0 }));
    }

    #[test]
    fn test_osc133_command_done_nonzero() {
        let data = "\x1b]133;D;127\x07";
        let events = parse_osc133(data);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], Osc133Event::CommandDone { exit_code: 127 }));
    }

    #[test]
    fn test_osc133_multiple_events_in_one_chunk() {
        // Simulate a chunk that contains D (done) then A (prompt start) then the prompt text.
        let data = "some output\x1b]133;D;0\x07\x1b]133;A\x07$ ";
        let events = parse_osc133(data);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], Osc133Event::CommandDone { exit_code: 0 }));
        assert!(matches!(events[1], Osc133Event::PromptStart));
    }

    #[test]
    fn test_osc133_embedded_in_normal_output() {
        let data = "normal text\x1b]133;B;cmd=git status\x1b\\more text";
        let events = parse_osc133(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            Osc133Event::CommandStart { cmd } => {
                assert_eq!(cmd.as_deref(), Some("git status"));
            }
            _ => panic!("expected CommandStart"),
        }
    }

    #[test]
    fn test_osc133_no_sequences() {
        let data = "hello world\r\n$ ";
        let events = parse_osc133(data);
        assert!(events.is_empty());
    }

    #[test]
    fn test_osc133_unknown_command_ignored() {
        let data = "\x1b]133;Z\x07";
        let events = parse_osc133(data);
        assert!(events.is_empty());
    }

    // ── tmux launcher helpers ────────────────────────────────────────────────

    #[test]
    fn test_tmux_session_template_expands_and_sanitizes() {
        let name = expand_tmux_session_name(
            "fluxtty-{pane_id}-{cwd_name}-{short_id}:bad",
            42,
            "/Users/alice/project",
            "abc123ef",
        );
        assert_eq!(name, "fluxtty-42-project-abc123ef_bad");
    }

    #[test]
    fn test_default_tmux_session_template_does_not_use_pane_id() {
        let tmux = TmuxConfig::default();
        let name = resolve_tmux_session_name(&tmux, None, 42, "/Users/alice/project");
        assert!(name.starts_with("fluxtty-project-"));
        assert!(!name.contains("42"));
    }

    #[test]
    fn test_tmux_requested_session_wins_for_restore() {
        let tmux = TmuxConfig::default();
        let name = resolve_tmux_session_name(&tmux, Some("restored:session"), 7, "/tmp/other");
        assert_eq!(name, "restored_session");
    }

    #[test]
    fn test_tmux_args_include_attach_session_and_shell_command() {
        let mut tmux = TmuxConfig::default();
        tmux.extra_args = vec!["-L".to_string(), "fluxtty-test".to_string()];
        let integration = ShellIntegration {
            env: vec![],
            extra_args: vec![
                "--init-file".to_string(),
                "/tmp/fluxtty init.sh".to_string(),
            ],
        };
        let args = build_tmux_args(
            &tmux,
            "work",
            "/tmp/project",
            "/bin/bash",
            &[],
            &integration,
        );
        assert_eq!(
            args,
            vec![
                "-L",
                "fluxtty-test",
                "set-option",
                "-gq",
                "allow-passthrough",
                "on",
                ";",
                "new-session",
                "-A",
                "-s",
                "work",
                "-c",
                "/tmp/project",
                "/bin/bash --init-file '/tmp/fluxtty init.sh'",
            ]
        );
    }

    // ── parse_alternate_screen ────────────────────────────────────────────────

    #[test]
    fn test_alt_screen_enter() {
        let data = "\x1b[?1049h";
        assert_eq!(parse_alternate_screen(data), Some(true));
    }

    #[test]
    fn test_alt_screen_exit() {
        let data = "\x1b[?1049l";
        assert_eq!(parse_alternate_screen(data), Some(false));
    }

    #[test]
    fn test_alt_screen_none() {
        let data = "no escape sequences here";
        assert_eq!(parse_alternate_screen(data), None);
    }

    #[test]
    fn test_alt_screen_exit_after_enter_in_same_chunk() {
        // Enter then exit in same chunk → exit (last one) wins.
        let data = "\x1b[?1049h some output \x1b[?1049l";
        assert_eq!(parse_alternate_screen(data), Some(false));
    }

    #[test]
    fn test_alt_screen_enter_after_exit_in_same_chunk() {
        let data = "\x1b[?1049l then \x1b[?1049h";
        assert_eq!(parse_alternate_screen(data), Some(true));
    }

    // ── parse_osc7 ────────────────────────────────────────────────────────────

    #[test]
    fn test_osc7_bel() {
        let data = "\x1b]7;file://myhostname/Users/alice/projects\x07";
        assert_eq!(parse_osc7(data), Some("/Users/alice/projects".to_string()));
    }

    #[test]
    fn test_osc7_st() {
        let data = "\x1b]7;file://myhostname/home/bob/src\x1b\\";
        assert_eq!(parse_osc7(data), Some("/home/bob/src".to_string()));
    }
}
