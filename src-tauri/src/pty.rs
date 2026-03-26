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
    // precmd_functions/chpwd_functions are plain arrays; appending to them is
    // zero call-stack overhead.  add-zsh-hook is intentionally avoided because
    // it is an autoloaded function whose first invocation loads a file from
    // $fpath, adding depth that can overflow FUNCNEST in heavily-plugined setups.
    // _wt_cwd is emitted once immediately (before sourcing the user's .zshrc)
    // so the initial CWD notification fires at the shallowest possible depth.
    let zshrc = format!(r#"# fluxtty — auto-generated, do not edit
if [[ -z "$_FLUXTTY_INIT" ]]; then
  export _FLUXTTY_INIT=1
  _wt_cwd() {{ printf '\033]7;file://%s%s\033\\' "$HOST" "$PWD"; }}
  typeset -ga precmd_functions chpwd_functions
  precmd_functions+=(_wt_cwd)
  chpwd_functions+=(_wt_cwd)
  _wt_cwd
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
    let init_script = r#"# fluxtty — auto-generated, do not edit
if [[ -z "$_FLUXTTY_INIT" ]]; then
  export _FLUXTTY_INIT=1
  _wt_cwd() { printf '\033]7;file://%s%s\007' "${HOSTNAME:-$(hostname)}" "$PWD"; }
  _wt_cwd
fi
if shopt -q login_shell 2>/dev/null; then
  for _f in ~/.bash_profile ~/.bash_login ~/.profile; do
    [[ -f "$_f" ]] && { source "$_f"; break; }
  done
  unset _f
else
  [[ -f ~/.bashrc ]] && source ~/.bashrc
fi
# Re-attach hook in case rc files overwrote PROMPT_COMMAND
if [[ "$PROMPT_COMMAND" != *_wt_cwd* ]]; then
  PROMPT_COMMAND="_wt_cwd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
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
    let script = r#"# fluxtty — auto-generated, do not edit
if not set -q _FLUXTTY_INIT
  set -gx _FLUXTTY_INIT 1
  function _wt_cwd_prompt --on-event fish_prompt
    printf '\033]7;file://%s%s\033\\' (hostname) $PWD
  end
  _wt_cwd_prompt
end
"#;
    let _ = std::fs::write(conf_d.join("fluxtty.fish"), script);
    ShellIntegration::default()
}

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

                        // Parse OSC 7 → update session CWD
                        if let Some(new_cwd) = parse_osc7(&data_str) {
                            if let Ok(mut session) = session_mgr.lock() {
                                session.set_pane_cwd(pane_id, new_cwd);
                                let all = session.all_panes();
                                let _ = app.emit("session:changed", all);
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
