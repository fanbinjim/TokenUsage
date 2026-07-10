use tokenusage_core::{AppSettings, DataPaths, load_multi_runtime};

fn main() {
    let settings = AppSettings::default();
    let mut snapshot = load_multi_runtime(&DataPaths::live(&settings), &settings);
    let include_private = std::env::args().any(|argument| argument == "--include-private");
    if !include_private {
        for runtime in &mut snapshot.runtimes {
            if let Some(local) = &mut runtime.snapshot.local {
                for thread in &mut local.recent_threads {
                    thread.title = "[redacted]".into();
                    thread.cwd = "[redacted]".into();
                }
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&snapshot).expect("snapshot serialization failed"));
}
