//! Integrated terminal: up to `MAX_TERMINALS` shells, each in a pseudo-terminal, streamed to the webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Shells open at the same time; the frontend picks a slot id below this.
const MAX_TERMINALS: u32 = 3;

#[derive(serde::Serialize, Clone)]
struct TermData {
    id: u32,
    data: String,
}

#[derive(serde::Serialize, Clone)]
/// `generation` tells a shell apart from the one it replaced in the same slot.
struct TermExit {
    id: u32,
    generation: u64,
}

#[derive(Default)]
pub struct Terminal {
    sessions: Mutex<HashMap<u32, Session>>,
    counter: Mutex<u64>,
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".to_string())
    }
}

fn stop_session(session: Option<Session>) {
    if let Some(mut session) = session {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

impl Terminal {
    /// Ends every shell (called when the app closes).
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.sessions.lock() {
            for (_, session) in guard.drain() {
                stop_session(Some(session));
            }
        }
    }
}

/// Starts the shell of slot `id` in `cwd` (the home folder if missing or invalid), replacing a running one,
/// and returns its generation. Output goes to the `term-data` event (base64); `term-exit` is emitted
/// when the shell ends.
#[tauri::command]
pub fn term_start(app: AppHandle, state: State<Terminal>, id: u32, cwd: Option<String>, rows: u16, cols: u16) -> Result<u64, String> {
    if id >= MAX_TERMINALS {
        return Err(format!("terminal {id}: at most {MAX_TERMINALS} terminals"));
    }
    let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
    stop_session(guard.remove(&id));

    let pair = native_pty_system().openpty(size(rows, cols)).map_err(|e| e.to_string())?;
    let mut command = CommandBuilder::new(default_shell());
    command.env("TERM", "xterm-256color");
    if let Some(dir) = cwd.map(PathBuf::from).filter(|dir| dir.is_dir()) {
        command.cwd(dir);
    }
    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let generation = {
        let mut counter = state.counter.lock().map_err(|e| e.to_string())?;
        *counter += 1;
        *counter
    };
    guard.insert(id, Session { master: pair.master, writer, child });

    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buffer[..n]);
                    let _ = app.emit("term-data", TermData { id, data });
                }
            }
        }
        let _ = app.emit("term-exit", TermExit { id, generation });
    });
    Ok(generation)
}

#[tauri::command]
pub fn term_write(state: State<Terminal>, id: u32, data: String) -> Result<(), String> {
    let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = guard.get_mut(&id).ok_or("terminal not started")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: State<Terminal>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    let guard = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = guard.get(&id) {
        session.master.resize(size(rows, cols)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Ends the shell of slot `id`, if any.
#[tauri::command]
pub fn term_stop(state: State<Terminal>, id: u32) {
    if let Ok(mut guard) = state.sessions.lock() {
        stop_session(guard.remove(&id));
    }
}

/// Text of the system clipboard: the WebView denies `navigator.clipboard.readText` without a user gesture.
#[tauri::command]
pub fn clipboard_get() -> String {
    arboard::Clipboard::new().and_then(|mut clipboard| clipboard.get_text()).unwrap_or_default()
}

/// Text of the PRIMARY selection (what other terminals copy on select); empty where unsupported.
#[tauri::command]
pub fn primary_get() -> String {
    #[cfg(target_os = "linux")]
    {
        use arboard::{GetExtLinux, LinuxClipboardKind};
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            return clipboard.get().clipboard(LinuxClipboardKind::Primary).text().unwrap_or_default();
        }
    }
    String::new()
}

/// Sets the PRIMARY selection, so a middle click in another terminal pastes it.
#[tauri::command]
pub fn primary_set(text: String) {
    #[cfg(target_os = "linux")]
    {
        use arboard::{LinuxClipboardKind, SetExtLinux};
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            let _ = clipboard.set().clipboard(LinuxClipboardKind::Primary).text(text);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = text;
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn shell_runs_in_a_pty_in_the_given_folder() {
        let pair = native_pty_system().openpty(size(24, 80)).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "pwd; echo s-nib-ok"]);
        command.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut output = String::new();
        let mut buffer = [0u8; 256];
        while let Ok(n) = reader.read(&mut buffer) {
            if n == 0 {
                break;
            }
            output.push_str(&String::from_utf8_lossy(&buffer[..n]));
        }
        child.wait().unwrap();
        assert!(output.contains("s-nib-ok"), "{output}");
        assert!(output.contains("tmp"), "{output}");
    }
}
