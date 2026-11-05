use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub family: String,
    pub monospaced: bool,
}

pub fn list() -> Vec<FontFamily> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut families: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    for face in db.faces() {
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        if name.starts_with('.') || name.trim().is_empty() {
            continue;
        }
        let monospaced = families.entry(name.clone()).or_insert(false);
        *monospaced |= face.monospaced;
    }
    let mut out: Vec<FontFamily> = families
        .into_iter()
        .map(|(family, monospaced)| FontFamily { family, monospaced })
        .collect();
    out.sort_by_key(|f| f.family.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_installed_families_sorted_with_a_monospace_flag() {
        let fonts = list();
        assert!(!fonts.is_empty());
        assert!(fonts.iter().any(|f| f.monospaced));
        assert!(fonts.iter().all(|f| !f.family.starts_with('.')));
        let names: Vec<String> = fonts.iter().map(|f| f.family.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }
}
