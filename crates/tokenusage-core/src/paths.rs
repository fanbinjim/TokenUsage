use crate::AppSettings;
use std::{env, ffi::OsString, path::{Path, PathBuf}};

#[derive(Clone, Debug)]
pub struct DataPaths {
    pub home_directory: PathBuf,
    pub codex_directory: PathBuf,
    pub claude_directory: PathBuf,
    pub app_config_directory: PathBuf,
    pub app_cache_directory: PathBuf,
}

impl DataPaths {
    pub fn live(settings: &AppSettings) -> Self {
        let home_directory = env_path("USERPROFILE").or_else(|| env_path("HOME")).unwrap_or_else(|| PathBuf::from("."));
        let codex_directory = settings.codex_data_directory.as_ref().map(PathBuf::from)
            .or_else(|| env_path("TOKENUSAGE_CODEX_DATA_DIR"))
            .unwrap_or_else(|| home_directory.join(".codex"));
        let claude_directory = settings.claude_data_directory.as_ref().map(PathBuf::from)
            .or_else(|| env_path("TOKENUSAGE_CLAUDE_DATA_DIR"))
            .unwrap_or_else(|| home_directory.join(".claude"));
        let app_config_directory = app_config_directory(&home_directory);
        let app_cache_directory = app_cache_directory(&home_directory);
        Self { home_directory, codex_directory, claude_directory, app_config_directory, app_cache_directory }
    }

    pub fn codex_database_path(&self) -> Option<PathBuf> {
        [self.codex_directory.join("state_5.sqlite"), self.codex_directory.join("sqlite").join("state_5.sqlite")]
            .into_iter().find(|candidate| candidate.is_file())
    }

    pub fn display_path(&self, path: &Path) -> String {
        path.strip_prefix(&self.home_directory)
            .map(|relative| format!("~{}{}", std::path::MAIN_SEPARATOR, relative.display()))
            .unwrap_or_else(|_| path.display().to_string())
    }

    pub fn codex_executable_candidates(&self, settings: &AppSettings) -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        if let Some(path) = settings.codex_executable_path.as_deref() { candidates.push(PathBuf::from(path)); }
        if let Some(path) = env_path("TOKENUSAGE_CODEX_BIN") { candidates.push(path); }
        let names = if cfg!(windows) { ["codex.exe", "codex.cmd", "codex.bat"] } else { ["codex", "codex", "codex"] };
        if let Some(path) = env::var_os("PATH") {
            for directory in env::split_paths(&path) {
                for name in names { candidates.push(directory.join(name)); }
            }
        }
        if cfg!(windows) {
            if let Some(app_data) = env_path("APPDATA") {
                candidates.push(app_data.join("npm").join("codex.cmd"));
                candidates.push(app_data.join("npm").join("codex.exe"));
            }
            if let Some(local_app_data) = env_path("LOCALAPPDATA") {
                candidates.push(local_app_data.join("Programs").join("Codex").join("codex.exe"));
            }
        } else {
            candidates.push(PathBuf::from("/usr/local/bin/codex"));
            candidates.push(PathBuf::from("/usr/bin/codex"));
        }
        candidates.into_iter().filter(|path| path.is_file()).collect()
    }
}

fn env_path(name: &str) -> Option<PathBuf> { env::var_os(name).map(PathBuf::from) }

fn app_config_directory(home: &Path) -> PathBuf {
    if let Some(override_directory) = env_path("TOKENUSAGE_CONFIG_DIR") { return override_directory; }
    if cfg!(windows) {
        return env_path("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming")).join("TokenUsage");
    }
    env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")).join("tokenusage")
}

fn app_cache_directory(home: &Path) -> PathBuf {
    if let Some(override_directory) = env_path("TOKENUSAGE_CACHE_DIR") { return override_directory; }
    if cfg!(windows) {
        return env_path("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local")).join("TokenUsage").join("cache");
    }
    env_path("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache")).join("tokenusage")
}

pub fn command_line_for(path: &Path) -> (OsString, Vec<OsString>) {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if cfg!(windows) && matches!(extension.as_str(), "cmd" | "bat") {
        let shell = env::var_os("ComSpec").unwrap_or_else(|| OsString::from("cmd.exe"));
        let script = path.display().to_string();
        let command = format!("\"\"{}\" app-server\"", script.replace('"', ""));
        return (shell, vec![OsString::from("/D"), OsString::from("/S"), OsString::from("/C"), OsString::from(command)]);
    }
    (path.as_os_str().to_os_string(), vec![OsString::from("app-server")])
}
