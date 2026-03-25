mod config;
mod ipc;
mod pty;
mod session;

use config::new_shared_config;
use ipc::*;
use pty::new_shared_pty_manager;
use session::new_shared_session_manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_config = new_shared_config();
    let max_scrollback = shared_config.lock().unwrap().persistence.scrollback_lines as usize;

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build())
        .manage(shared_config.clone())
        .manage(new_shared_pty_manager(max_scrollback))
        .manage(new_shared_session_manager())
        .setup(move |app| {
            let handle = app.handle().clone();
            let cfg_shared = shared_config.clone();

            let watch_path = config::config_path();

            // Create parent directory so the watcher doesn't fail when
            // the config file doesn't exist yet.
            if let Some(parent) = watch_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            std::thread::spawn(move || {
                use notify::{Watcher, RecursiveMode, recommended_watcher};
                use tauri::Emitter;

                let (tx, rx) = std::sync::mpsc::channel();
                let mut watcher = match recommended_watcher(move |res| {
                    let _ = tx.send(res);
                }) {
                    Ok(w) => w,
                    Err(e) => {
                        log::warn!("Config watcher failed to create: {}", e);
                        return;
                    }
                };

                // Watch the directory; the file may not exist yet.
                let watch_dir = watch_path.parent().unwrap_or(&watch_path);
                if let Err(e) = watcher.watch(watch_dir, RecursiveMode::NonRecursive) {
                    log::warn!("Config watcher failed to watch {:?}: {}", watch_dir, e);
                    return;
                }

                for res in rx {
                    match res {
                        Ok(event) => {
                            let is_config = event.paths.iter().any(|p| p == &watch_path);
                            if !is_config { continue; }
                            // Debounce: only react to Create/Modify
                            use notify::EventKind;
                            match event.kind {
                                EventKind::Create(_) | EventKind::Modify(_) => {}
                                _ => continue,
                            }
                            let new_cfg = config::load_config();
                            {
                                let mut c = cfg_shared.lock().unwrap();
                                *c = new_cfg.clone();
                            }
                            let _ = handle.emit("config:changed", new_cfg);
                            log::info!("Config hot-reloaded from file");
                        }
                        Err(e) => log::warn!("Config watcher error: {}", e),
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_get_scrollback,
            session_list,
            session_set_active,
            session_rename,
            session_set_group,
            session_set_agent,
            session_set_status,
            session_set_note,
            config_get,
            config_reload,
            config_save,
            shell_complete,
            get_env_var,
            claude_cli_query,
            llm_complete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running fluxtty");
}
