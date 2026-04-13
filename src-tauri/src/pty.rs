use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

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
    env:       Vec<(String, String)>,
    extra_args: Vec<String>,
}

impl Default for ShellIntegration {
    fn default() -> Self { ShellIntegration { env: vec![], extra_args: vec![] } }
}

fn setup_shell_integration(shell: &str, user_args: &[String]) -> ShellIntegration {
    let name = std::path::Path::new(shell)
        .file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.contains("zsh")  { return setup_zsh(); }
    if name.contains("bash") { return setup_bash(user_args); }
    if name == "fish"        { return setup_fish(); }
    ShellIntegration::default()
}

fn setup_zsh() -> ShellIntegration {
    let zdotdir = match dirs::config_dir() {
        Some(d) => d.join("fluxtty").join("zdotdir"),
        None => return ShellIntegration::default(),
    };
    if std::fs::create_dir_all(&zdotdir).is_err() {
        return ShellIntegration::default();
    }

    let orig = std::env::var("ZDOTDIR").unwrap_or_else(|_| {
        dirs::home_dir().unwrap_or_default().to_string_lossy().to_string()
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
    let zshrc = format!(r#"# fluxtty — auto-generated, do not edit
if [[ -z "$_FLUXTTY_INIT" ]]; then
  export _FLUXTTY_INIT=1
  _wt_cwd() {{ printf '\033]7;file://%s%s\033\\' "$HOST" "$PWD"; }}
  _wt_precmd() {{
    local _ec=$?
    printf '\033]133;D;%d\033\\' "$_ec"
    _wt_cwd
    printf '\033]133;A\033\\'
  }}
  _wt_preexec() {{ printf '\033]133;B;cmd=%.512s\033\\' "$1"; }}
  typeset -ga precmd_functions chpwd_functions preexec_functions
  precmd_functions+=(_wt_precmd)
  chpwd_functions+=(_wt_cwd)
  preexec_functions+=(_wt_preexec)
  _wt_precmd
fi
export ZDOTDIR="{orig}"
[[ -f "{orig}/.zshrc" ]] && source "{orig}/.zshrc"
"#);

    let _ = std::fs::write(zdotdir.join(".zshrc"), &zshrc);

    ShellIntegration {
        env: vec![("ZDOTDIR".to_string(), zdotdir.to_string_lossy().to_string())],
        extra_args: vec![],
    }
}

fn setup_bash(user_args: &[String]) -> ShellIntegration {
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
  _wt_cwd() { printf '\033]7;file://%s%s\007' "${HOSTNAME:-$(hostname)}" "$PWD"; }
  _wt_precmd_bash() {
    local _ec=$?
    printf '\033]133;D;%d\007' "$_ec"
    _wt_cwd
    printf '\033]133;A\007'
    _wt_cmd_pending=1
  }
  _wt_preexec_bash() {
    if [[ "$_wt_cmd_pending" == "1" && "$BASH_COMMAND" != "_wt_precmd_bash" ]]; then
      _wt_cmd_pending=0
      printf '\033]133;B;cmd=%.512s\007' "$BASH_COMMAND"
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
        ShellIntegration {
            env: vec![
                ("PROMPT_COMMAND".to_string(), "_wt_cwd".to_string()),
                (
                    "BASH_FUNC__wt_cwd%%".to_string(),
                    r#"() { printf '\033]7;file://%s%s\007' "${HOSTNAME:-$(hostname)}" "$PWD"; }"#.to_string(),
                ),
            ],
            extra_args: vec![],
        }
    } else {
        ShellIntegration {
            env: vec![],
            extra_args: vec![
                "--init-file".to_string(),
                init_path.to_string_lossy().to_string(),
            ],
        }
    }
}

fn setup_fish() -> ShellIntegration {
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
  function _wt_precmd_fish --on-event fish_prompt
    printf '\033]133;D;%d\033\\' $status
    printf '\033]7;file://%s%s\033\\' (hostname) $PWD
    printf '\033]133;A\033\\'
  end
  function _wt_preexec_fish --on-event fish_preexec
    printf '\033]133;B;cmd=%.512s\033\\' $argv[1]
  end
  _wt_precmd_fish
end
"#;
    let _ = std::fs::write(conf_d.join("fluxtty.fish"), script);
    ShellIntegration::default()
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
        cwd: &str,
        cols: u16,
        rows: u16,
        app: AppHandle,
        session_mgr: crate::session::SharedSessionManager,
    ) -> Result<u32, String> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let integration = setup_shell_integration(shell, args);

        let mut cmd = CommandBuilder::new(shell);
        // Integration args (e.g. --init-file for bash) must come before user args
        for arg in &integration.extra_args {
            cmd.arg(arg);
        }
        for arg in args {
            cmd.arg(arg);
        }
        cmd.cwd(cwd);

        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in &integration.env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        let pid = child.process_id().unwrap_or(0);

        let writer = pair.master.take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

        let mut reader = pair.master.try_clone_reader()
            .map_err(|e| format!("Failed to get PTY reader: {}", e))?;

        let scrollback_arc: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        self.scrollback.insert(pane_id, scrollback_arc.clone());
        self.ptys.insert(pane_id, PtyProcess {
            master: pair.master,
            writer,
        });

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

        log::info!("Spawned PTY for pane {} (pid {})", pane_id, pid);
        Ok(pid)
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
