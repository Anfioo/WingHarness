use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub version: String,
    pub libgit2: String,
    /// Whether libgit2 was built with its own TLS / SSH support. Until the
    /// `vendored-openssl` feature is turned on, `ssh` is false on Windows, so
    /// the UI must not offer SSH remotes before that phase lands.
    pub https: bool,
    pub ssh: bool,
}

#[tauri::command]
pub fn git_engine_info() -> EngineInfo {
    let version = git2::Version::get();
    let (major, minor, rev) = version.libgit2_version();

    EngineInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        libgit2: format!("{major}.{minor}.{rev}"),
        https: version.https(),
        ssh: version.ssh(),
    }
}