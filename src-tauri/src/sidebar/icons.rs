//! Custom SVG icons the sidebar picker offers.
//!
//! The files live in a folder beside the layout, so adding an icon is dropping
//! an `.svg` file into it — no build step and no manifest to keep in sync. The
//! picker lists the folder on demand; the manager stores a chosen file as
//! `custom:<stem>` in the layout.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const DIR_NAME: &str = "icons";
/// Largest file read. An icon is a few kilobytes; anything past this is not one
/// and would only bloat the data URL handed to the webview.
const MAX_BYTES: u64 = 256 * 1024;
/// Most icons offered at once, so a folder full of images cannot stall a window.
const MAX_ICONS: usize = 256;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomIcon {
    /// The file stem, which is what the layout stores after `custom:`.
    pub name: String,
    /// The document text, which the frontend turns into a data URL.
    pub svg: String,
}

/// Folder holding the SVG files.
pub fn dir() -> PathBuf {
    crate::config::dir().join(DIR_NAME)
}

/// The folder, created when missing so a user has somewhere to drop files.
pub fn ensure_dir() -> Result<PathBuf, String> {
    let dir = dir();
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;
    Ok(dir)
}

/// Every SVG the folder holds, sorted by name.
///
/// Unreadable, oversized, and non-SVG files are skipped: one bad file must not
/// take the picker down with it.
pub fn list() -> Vec<CustomIcon> {
    match ensure_dir() {
        Ok(dir) => read_icons(&dir),
        Err(error) => {
            eprintln!("{error}");
            Vec::new()
        }
    }
}

fn read_icons(dir: &Path) -> Vec<CustomIcon> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut icons: Vec<CustomIcon> = Vec::new();
    for entry in entries.flatten() {
        if icons.len() >= MAX_ICONS {
            break;
        }

        let path = entry.path();
        if !path.is_file() || !is_svg(&path) {
            continue;
        }

        let Some(name) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };

        // Name collisions would make one file silently shadow another, so the
        // first one read wins and the rest are left for the user to rename.
        if icons
            .iter()
            .any(|icon| icon.name.eq_ignore_ascii_case(name))
        {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > MAX_BYTES {
            eprintln!(
                "Skipping {}: larger than {} KiB.",
                path.display(),
                MAX_BYTES / 1024
            );
            continue;
        }

        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        // Notepad writes a BOM by default, which would otherwise show up as
        // stray characters in the data URL.
        let svg = String::from_utf8_lossy(crate::config::strip_bom(&bytes)).into_owned();
        if svg.trim().is_empty() {
            continue;
        }

        icons.push(CustomIcon {
            name: name.to_string(),
            svg,
        });
    }

    icons.sort_by_key(|icon| icon.name.to_lowercase());
    icons
}

fn is_svg(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch folder that removes itself, so the tests never touch the real
    /// data directory.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mabang-icons-{tag}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>"#;

    #[test]
    fn lists_only_svg_files_sorted_by_name() {
        let scratch = Scratch::new("filter");
        fs::write(scratch.0.join("beta.svg"), SVG).unwrap();
        fs::write(scratch.0.join("Alpha.SVG"), SVG).unwrap();
        fs::write(scratch.0.join("notes.txt"), SVG).unwrap();
        fs::write(scratch.0.join("no-extension"), SVG).unwrap();

        let names: Vec<String> = read_icons(&scratch.0)
            .into_iter()
            .map(|icon| icon.name)
            .collect();
        assert_eq!(names, vec!["Alpha", "beta"]);
    }

    #[test]
    fn skips_blank_and_oversized_files() {
        let scratch = Scratch::new("limits");
        fs::write(scratch.0.join("blank.svg"), "   \n").unwrap();
        fs::write(scratch.0.join("huge.svg"), vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        fs::write(scratch.0.join("ok.svg"), SVG).unwrap();

        let icons = read_icons(&scratch.0);
        assert_eq!(icons.len(), 1);
        assert_eq!(icons[0].name, "ok");
        assert!(icons[0].svg.contains("<svg"));
    }

    /// A BOM would otherwise leak into the data URL as a stray character.
    #[test]
    fn drops_a_utf8_bom() {
        let scratch = Scratch::new("bom");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(SVG.as_bytes());
        fs::write(scratch.0.join("bom.svg"), bytes).unwrap();

        let icons = read_icons(&scratch.0);
        assert_eq!(icons.len(), 1);
        assert!(icons[0].svg.starts_with("<svg"));
    }

    #[test]
    fn keeps_the_first_of_two_files_with_the_same_stem() {
        let scratch = Scratch::new("duplicates");
        fs::write(scratch.0.join("logo.svg"), SVG).unwrap();
        fs::write(scratch.0.join("LOGO.SVG"), "<svg/>").unwrap();

        assert_eq!(read_icons(&scratch.0).len(), 1);
    }
}
