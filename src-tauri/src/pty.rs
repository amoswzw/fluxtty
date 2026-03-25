use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

// ── Shell integration ────────────────────────────────────────────────────────
// Creates a ZDOTDIR shim (for zsh) that installs a precmd hook emitting
// OSC 7 (file:// CWD notification) on every prompt, then sources the user's
// real rc files so normal shell config is unaffected.

fn setup_shell_integration(shell: &str) -> Vec<(String, String)> {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    // Only handle zsh for now (default macOS shell)
    if !shell_name.contains("zsh") {
        return vec![];
    }

    let zdotdir = match dirs::config_dir() {
        Some(d) => d.join("fluxtty").join("zdotdir"),
        None => return vec![],
    };
    if std::fs::create_dir_all(&zdotdir).is_err() {
        return vec![];
    }

    // Capture the user's real ZDOTDIR (or $HOME) before we override it
    let orig = std::env::var("ZDOTDIR").unwrap_or_else(|_| {
        dirs::home_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    // .zshrc: install precmd hook + source user's real .zshrc
    let zshrc = format!(
        r#"# fluxtty — auto-generated, do not edit
_wt_cwd() {{ printf '\033]7;file://%s%s\033\\' "$HOST" "$PWD"; }}
autoload -Uz add-zsh-hook 2>/dev/null
add-zsh-hook precmd _wt_cwd
_wt_cwd
if [[ -f "{orig}/.zshrc" ]]; then ZDOTDIR="{orig}" source "{orig}/.zshrc"; fi
"#
    );

    // .zshenv: source user's real .zshenv
    let zshenv = format!(
        r#"# fluxtty — auto-generated, do not edit
if [[ -f "{orig}/.zshenv" ]]; then source "{orig}/.zshenv"; fi
"#
    );

    let _ = std::fs::write(zdotdir.join(".zshrc"), &zshrc);
    let _ = std::fs::write(zdotdir.join(".zshenv"), &zshenv);

    vec![("ZDOTDIR".to_string(), zdotdir.to_string_lossy().to_string())]
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

        let mut cmd = CommandBuilder::new(shell);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.cwd(cwd);

        // Pass through environment + shell integration vars (ZDOTDIR for zsh)
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in setup_shell_integration(shell) {
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
