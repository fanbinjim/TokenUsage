use crate::RuntimeScope;
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const APP_SETTINGS_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct AppSettings {
    pub schema_version: u32,
    pub language: String,
    pub theme: String,
    pub selected_runtime: RuntimeScope,
    pub visible_runtimes: Vec<RuntimeScope>,
    pub show_used_quota: bool,
    pub quick_panel_density: String,
    pub keep_running_when_main_window_closed: bool,
    pub keep_main_window_on_top: bool,
    pub taskbar_widget_enabled: bool,
    pub taskbar_widget_right_offset: u32,
    pub automatic_update_checks_enabled: bool,
    pub receive_prereleases: bool,
    pub codex_executable_path: Option<String>,
    pub codex_data_directory: Option<String>,
    pub claude_data_directory: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: APP_SETTINGS_SCHEMA_VERSION,
            language: "auto".into(),
            theme: "system".into(),
            selected_runtime: RuntimeScope::Codex,
            visible_runtimes: vec![RuntimeScope::Codex, RuntimeScope::ClaudeCode],
            show_used_quota: false,
            quick_panel_density: "compact".into(),
            keep_running_when_main_window_closed: true,
            keep_main_window_on_top: false,
            taskbar_widget_enabled: true,
            taskbar_widget_right_offset: 0,
            automatic_update_checks_enabled: true,
            receive_prereleases: false,
            codex_executable_path: None,
            codex_data_directory: None,
            claude_data_directory: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub language: Option<String>,
    pub theme: Option<String>,
    pub selected_runtime: Option<RuntimeScope>,
    pub visible_runtimes: Option<Vec<RuntimeScope>>,
    pub show_used_quota: Option<bool>,
    pub quick_panel_density: Option<String>,
    pub keep_running_when_main_window_closed: Option<bool>,
    pub keep_main_window_on_top: Option<bool>,
    pub taskbar_widget_enabled: Option<bool>,
    pub taskbar_widget_right_offset: Option<u32>,
    pub automatic_update_checks_enabled: Option<bool>,
    pub receive_prereleases: Option<bool>,
    pub codex_executable_path: Option<Option<String>>,
    pub codex_data_directory: Option<Option<String>>,
    pub claude_data_directory: Option<Option<String>>,
}

impl AppSettings {
    pub fn apply_patch(&mut self, patch: SettingsPatch) {
        if let Some(value) = patch.language {
            self.language = value;
        }
        if let Some(value) = patch.theme {
            self.theme = value;
        }
        if let Some(value) = patch.visible_runtimes {
            self.visible_runtimes = value;
        }
        if self.visible_runtimes.is_empty() {
            self.visible_runtimes.push(RuntimeScope::Codex);
        }
        if let Some(value) = patch.selected_runtime {
            self.selected_runtime = value;
        }
        if !self.visible_runtimes.contains(&self.selected_runtime) {
            self.selected_runtime = self.visible_runtimes[0];
        }
        if let Some(value) = patch.show_used_quota {
            self.show_used_quota = value;
        }
        if let Some(value) = patch.quick_panel_density {
            self.quick_panel_density = value;
        }
        if let Some(value) = patch.keep_running_when_main_window_closed {
            self.keep_running_when_main_window_closed = value;
        }
        if let Some(value) = patch.keep_main_window_on_top {
            self.keep_main_window_on_top = value;
        }
        if let Some(value) = patch.taskbar_widget_enabled {
            self.taskbar_widget_enabled = value;
        }
        if let Some(value) = patch.taskbar_widget_right_offset {
            self.taskbar_widget_right_offset = value.clamp(0, 3000);
        }
        if let Some(value) = patch.automatic_update_checks_enabled {
            self.automatic_update_checks_enabled = value;
        }
        if let Some(value) = patch.receive_prereleases {
            self.receive_prereleases = value;
        }
        if let Some(value) = patch.codex_executable_path {
            self.codex_executable_path = value;
        }
        if let Some(value) = patch.codex_data_directory {
            self.codex_data_directory = value;
        }
        if let Some(value) = patch.claude_data_directory {
            self.claude_data_directory = value;
        }
    }
}

#[derive(Clone, Debug)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(config_directory: PathBuf) -> Self {
        Self {
            path: config_directory.join("settings.json"),
        }
    }
    pub fn load(&self) -> AppSettings {
        fs::read(&self.path)
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default()
    }
    pub fn save(&self, settings: &AppSettings) -> anyhow::Result<()> {
        let parent = self.path.parent().context("settings path has no parent")?;
        fs::create_dir_all(parent)?;
        let data = serde_json::to_vec_pretty(settings)?;
        let temporary = tempfile::NamedTempFile::new_in(parent)?;
        fs::write(temporary.path(), data)?;
        temporary.persist(&self.path).map_err(|error| error.error)?;
        Ok(())
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_always_keep_one_visible_runtime() {
        let mut settings = AppSettings::default();
        settings.apply_patch(SettingsPatch {
            visible_runtimes: Some(vec![]),
            ..Default::default()
        });
        assert_eq!(settings.visible_runtimes, vec![RuntimeScope::Codex]);
        assert_eq!(settings.selected_runtime, RuntimeScope::Codex);
    }

    #[test]
    fn selected_runtime_falls_back_to_visible_runtime() {
        let mut settings = AppSettings::default();
        settings.apply_patch(SettingsPatch {
            visible_runtimes: Some(vec![RuntimeScope::ClaudeCode]),
            selected_runtime: Some(RuntimeScope::Codex),
            ..Default::default()
        });
        assert_eq!(settings.selected_runtime, RuntimeScope::ClaudeCode);
    }

    #[test]
    fn settings_store_replaces_existing_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store = SettingsStore::new(directory.path().to_path_buf());
        let mut settings = AppSettings::default();
        store.save(&settings).expect("initial settings save");
        settings.theme = "dark".into();
        store.save(&settings).expect("replacement settings save");
        assert_eq!(store.load().theme, "dark");
    }

    #[test]
    fn old_settings_files_receive_taskbar_widget_defaults() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"theme":"light"}"#).expect("legacy settings parse");
        assert!(settings.taskbar_widget_enabled);
        assert_eq!(settings.schema_version, APP_SETTINGS_SCHEMA_VERSION);
        assert_eq!(settings.taskbar_widget_right_offset, 0);
    }

    #[test]
    fn taskbar_widget_offset_is_bounded() {
        let mut settings = AppSettings::default();
        settings.apply_patch(SettingsPatch {
            taskbar_widget_right_offset: Some(9_000),
            ..Default::default()
        });
        assert_eq!(settings.taskbar_widget_right_offset, 3000);
    }
}
