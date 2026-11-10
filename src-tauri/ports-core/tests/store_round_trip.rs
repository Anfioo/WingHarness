use std::path::PathBuf;

use ports_core::models::{PortGrouping, PortsSettings};
use ports_core::{paths, store};

fn scratch_directory() -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("ports-core-public-store-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    directory.join("ports")
}

#[test]
fn public_save_then_load_round_trips_through_the_data_directory() {
    // This file is its own test binary, so setting the process-wide directory
    // once cannot race another test.
    let directory = scratch_directory();
    paths::CONFIG_DIR
        .set(directory.clone())
        .expect("the ports directory is set once per test binary");

    assert_eq!(store::load().expect("load"), store::defaults());
    assert!(
        !directory.exists(),
        "a missing directory must not be created on read"
    );

    let by_app = PortsSettings {
        pinned_ports: vec![8080, 3000],
        pinned_only: true,
        group_by: PortGrouping::App,
    };
    let saved = store::save(by_app).expect("save");
    assert_eq!(saved.pinned_ports, vec![3000, 8080]);
    assert_eq!(saved.group_by, PortGrouping::App);

    // `load` must read the file `save` wrote, not a second path below it.
    let settings_file = paths::settings_path().expect("settings path");
    assert_eq!(settings_file, directory.join("settings.json"));
    assert!(settings_file.exists());

    assert_eq!(store::load().expect("load"), saved);

    let _ = std::fs::remove_dir_all(&directory);
}
