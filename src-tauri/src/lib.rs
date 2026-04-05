use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::State;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotConfig {
    pub tool: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub slots: std::collections::HashMap<String, std::collections::HashMap<String, SlotConfig>>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            slots: std::collections::HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Python sidecar manager
// ---------------------------------------------------------------------------

pub struct Bridge {
    child: Option<Child>,
    stdin: Option<std::process::ChildStdin>,
    stdout: Option<BufReader<std::process::ChildStdout>>,
}

pub struct AppState {
    pub bridge: Mutex<Bridge>,
    pub config: Mutex<Config>,
    pub state_data: Mutex<std::collections::HashMap<String, bool>>,
    next_id: AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        let config = load_config_from_disk().unwrap_or_default();
        let state_data = load_state_from_disk().unwrap_or_default();
        Self {
            bridge: Mutex::new(Bridge {
                child: None,
                stdin: None,
                stdout: None,
            }),
            config: Mutex::new(config),
            state_data: Mutex::new(state_data),
            next_id: AtomicU64::new(1),
        }
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------
// Config / state persistence (compatible with Python version's JSON files)
// ---------------------------------------------------------------------------

fn config_dir() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn config_path() -> std::path::PathBuf {
    config_dir().join(".resolve_node_toggle_config.json")
}

fn state_path() -> std::path::PathBuf {
    config_dir().join(".resolve_node_toggle_state.json")
}

fn profiles_dir() -> std::path::PathBuf {
    config_dir().join(".resolve_node_toggle_profiles")
}

fn last_profile_path() -> std::path::PathBuf {
    config_dir().join(".resolve_node_toggle_last_profile")
}

fn load_config_from_disk() -> Option<Config> {
    let data = std::fs::read_to_string(config_path()).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_config_to_disk(config: &Config) {
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(config_path(), json);
    }
}

fn load_state_from_disk() -> Option<std::collections::HashMap<String, bool>> {
    let data = std::fs::read_to_string(state_path()).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_state_to_disk(state: &std::collections::HashMap<String, bool>) {
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(state_path(), json);
    }
}

// ---------------------------------------------------------------------------
// Sidecar communication
// ---------------------------------------------------------------------------

fn find_python() -> Option<String> {
    // Try common Python executable names
    let candidates = if cfg!(target_os = "windows") {
        vec!["python", "python3", "py"]
    } else {
        vec!["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python"]
    };
    for name in candidates {
        let check = if cfg!(target_os = "windows") {
            Command::new("where").arg(name).output()
        } else {
            Command::new("which").arg(name).output()
        };
        if let Ok(output) = check {
            if output.status.success() {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn spawn_bridge(bridge: &mut Bridge) -> Result<(), String> {
    // Kill existing if any
    if let Some(ref mut child) = bridge.child {
        let _ = child.kill();
    }

    let python = find_python().ok_or("Python not found. Install Python 3 to use Node Toggle.")?;

    // Find the sidecar script — check next to the executable, then in resources
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let sidecar_candidates: Vec<std::path::PathBuf> = vec![
        // Dev mode: relative to project root
        std::path::PathBuf::from("../sidecar/resolve_bridge.py"),
        std::path::PathBuf::from("sidecar/resolve_bridge.py"),
        // Next to exe (Windows NSIS install)
        exe_dir
            .as_ref()
            .map(|d| d.join("resolve_bridge.py"))
            .unwrap_or_default(),
        // macOS .app bundle: Contents/Resources/
        exe_dir
            .as_ref()
            .map(|d| d.join("../Resources/resolve_bridge.py"))
            .unwrap_or_default(),
        // Linux deb/AppImage: resources/ subfolder
        exe_dir
            .as_ref()
            .map(|d| d.join("resources/resolve_bridge.py"))
            .unwrap_or_default(),
    ];

    let sidecar_path = sidecar_candidates
        .iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            format!(
                "resolve_bridge.py not found. Searched: {:?}",
                sidecar_candidates
            )
        })?
        .clone();

    eprintln!(
        "[TAURI] Spawning: {} {}",
        python,
        sidecar_path.display()
    );

    let mut child = Command::new(&python)
        .arg(&sidecar_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Python bridge: {e}"))?;

    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let mut reader = BufReader::new(stdout);

    // Wait for ready signal
    let mut ready_line = String::new();
    reader
        .read_line(&mut ready_line)
        .map_err(|e| format!("Bridge didn't start: {e}"))?;

    let ready: Value = serde_json::from_str(ready_line.trim())
        .map_err(|e| format!("Invalid ready signal: {e}: {ready_line}"))?;
    if ready.get("ready") != Some(&Value::Bool(true)) {
        return Err(format!("Unexpected ready signal: {ready_line}"));
    }

    bridge.child = Some(child);
    bridge.stdin = Some(stdin);
    bridge.stdout = Some(reader);

    eprintln!("[TAURI] Bridge ready");
    Ok(())
}

fn call_bridge(state: &AppState, method: &str, params: Value) -> Result<Value, String> {
    let mut bridge = state.bridge.lock().map_err(|e| e.to_string())?;

    // Auto-spawn if not running
    if bridge.child.is_none() {
        spawn_bridge(&mut bridge)?;
    }

    let id = state.next_id();
    let request = json!({
        "id": id,
        "method": method,
        "params": params,
    });

    let request_str = serde_json::to_string(&request).map_err(|e| e.to_string())?;

    // Write to stdin
    let stdin = bridge.stdin.as_mut().ok_or("Bridge stdin unavailable")?;
    writeln!(stdin, "{}", request_str).map_err(|e| format!("Write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("Flush failed: {e}"))?;

    // Read response
    let stdout = bridge.stdout.as_mut().ok_or("Bridge stdout unavailable")?;
    let mut response_line = String::new();
    stdout
        .read_line(&mut response_line)
        .map_err(|e| format!("Read failed: {e}"))?;

    let response: Value =
        serde_json::from_str(response_line.trim()).map_err(|e| format!("Parse failed: {e}"))?;

    if let Some(err) = response.get("error") {
        if !err.is_null() {
            return Err(err.as_str().unwrap_or("Unknown error").to_string());
        }
    }

    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn bridge_connect(state: State<'_, AppState>) -> Result<Value, String> {
    call_bridge(&state, "connect", json!({}))
}

#[tauri::command]
fn bridge_get_graphs(state: State<'_, AppState>) -> Result<Value, String> {
    call_bridge(&state, "get_graphs", json!({}))
}

#[tauri::command]
fn bridge_get_nodes(state: State<'_, AppState>, section: String) -> Result<Value, String> {
    call_bridge(&state, "get_nodes", json!({"section": section}))
}

#[tauri::command]
fn bridge_set_node_enabled(
    state: State<'_, AppState>,
    section: String,
    tool: String,
    label: String,
    enabled: bool,
) -> Result<Value, String> {
    let result = call_bridge(
        &state,
        "set_node_enabled",
        json!({"section": section, "tool": tool, "label": label, "enabled": enabled}),
    )?;

    // Update local state tracking
    if result.get("success") == Some(&Value::Bool(true)) {
        if let Some(context) = result.get("context").and_then(|v| v.as_str()) {
            let sk = if !label.is_empty() {
                format!("{}:{}:{}:{}", section, tool, label, context)
            } else {
                format!("{}:{}:{}", section, tool, context)
            };
            let mut state_data = state.state_data.lock().map_err(|e| e.to_string())?;
            state_data.insert(sk, enabled);
            save_state_to_disk(&state_data);
        }
    }

    Ok(result)
}

#[tauri::command]
fn bridge_scan(state: State<'_, AppState>) -> Result<Value, String> {
    call_bridge(&state, "scan", json!({}))
}

#[tauri::command]
fn bridge_ping(state: State<'_, AppState>) -> Result<Value, String> {
    call_bridge(&state, "ping", json!({}))
}

// ---------------------------------------------------------------------------
// Config commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Result<Config, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.clone())
}

#[tauri::command]
fn save_config(state: State<'_, AppState>, config: Config) -> Result<(), String> {
    let mut current = state.config.lock().map_err(|e| e.to_string())?;
    *current = config;
    save_config_to_disk(&current);
    Ok(())
}

#[tauri::command]
fn get_state_data(state: State<'_, AppState>) -> Result<std::collections::HashMap<String, bool>, String> {
    let data = state.state_data.lock().map_err(|e| e.to_string())?;
    Ok(data.clone())
}

#[tauri::command]
fn save_state_data(
    state: State<'_, AppState>,
    data: std::collections::HashMap<String, bool>,
) -> Result<(), String> {
    let mut current = state.state_data.lock().map_err(|e| e.to_string())?;
    *current = data;
    save_state_to_disk(&current);
    Ok(())
}

// ---------------------------------------------------------------------------
// Profile commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_profiles() -> Result<Vec<String>, String> {
    let dir = profiles_dir();
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut names = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    names.push(stem.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn save_profile(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let dir = profiles_dir();
    let _ = std::fs::create_dir_all(&dir);
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&*config).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{name}.json")), json).map_err(|e| e.to_string())?;
    let _ = std::fs::write(last_profile_path(), &name);
    Ok(())
}

#[tauri::command]
fn load_profile(state: State<'_, AppState>, name: String) -> Result<Config, String> {
    let path = profiles_dir().join(format!("{name}.json"));
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let config: Config = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let mut current = state.config.lock().map_err(|e| e.to_string())?;
    *current = config.clone();
    save_config_to_disk(&current);
    let _ = std::fs::write(last_profile_path(), &name);
    Ok(config)
}

#[tauri::command]
fn delete_profile(name: String) -> Result<(), String> {
    let path = profiles_dir().join(format!("{name}.json"));
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    // Clear last-used if it was this one
    if let Ok(last) = std::fs::read_to_string(last_profile_path()) {
        if last.trim() == name {
            let _ = std::fs::remove_file(last_profile_path());
        }
    }
    Ok(())
}

#[tauri::command]
fn get_last_profile_name() -> Result<Option<String>, String> {
    match std::fs::read_to_string(last_profile_path()) {
        Ok(name) => {
            let name = name.trim().to_string();
            if name.is_empty() {
                Ok(None)
            } else {
                Ok(Some(name))
            }
        }
        Err(_) => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

pub fn kill_bridge(state: &AppState) {
    if let Ok(mut bridge) = state.bridge.lock() {
        if let Some(ref mut child) = bridge.child {
            let _ = child.kill();
        }
        bridge.child = None;
        bridge.stdin = None;
        bridge.stdout = None;
    }
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            bridge_connect,
            bridge_get_graphs,
            bridge_get_nodes,
            bridge_set_node_enabled,
            bridge_scan,
            bridge_ping,
            get_config,
            save_config,
            get_state_data,
            save_state_data,
            list_profiles,
            save_profile,
            load_profile,
            delete_profile,
            get_last_profile_name,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Node Toggle");
}
