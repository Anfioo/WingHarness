// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! The built-in provider presets: nineteen mail services plus the custom IMAP
//! fallback, as a static table.
//!
//! The table lives in Rust rather than in a `provider_presets` table: it only
//! changes with a release, it needs no migration, and the account form must be
//! able to render it before the database is even open.
//!
//! This release authenticates with a password or an app password only (OAuth is
//! out of scope), so Gmail and Outlook are listed with [`AuthKind::AppPassword`]
//! and a note saying so: their hosts are reachable over IMAP, but only with an
//! app-specific password.

use std::sync::LazyLock;

use crate::models::{AuthKind, ProviderPreset, Security};

/// The preset a caller falls back to when nothing else matches.
pub const CUSTOM_KEY: &str = "custom";

/// Every built-in provider preset, in display order.
pub fn presets() -> &'static [ProviderPreset] {
    PRESETS.as_slice()
}

/// Look a preset up by its stable key.
///
/// An exact hit wins; otherwise the key goes through the same containment rules
/// the source form used (`netease163` → `163`, `exmail` → `tencentEnterprise`),
/// so a caller that passes a human name still lands on the right hosts. An
/// unknown key returns `None`, which is how the form switches to the custom
/// branch.
pub fn find(key: &str) -> Option<&'static ProviderPreset> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(preset) = presets().iter().find(|preset| preset.key == trimmed) {
        return Some(preset);
    }
    let normalized = normalize_key(trimmed);
    presets().iter().find(|preset| preset.key == normalized)
}

/// Map a loose provider key onto the canonical one, keeping the source order:
/// the more specific rules run before the substring that would also match them
/// (`aliyunEnterprise` before `aliyun`, `tencentEnterprise` before `qq`).
fn normalize_key(raw: &str) -> String {
    let key = raw.trim().to_lowercase();
    let matches = |needle: &str| key.contains(needle);

    if matches("gmail") || matches("google") {
        return "gmail".to_string();
    }
    if matches("yahoo") {
        return "yahoo".to_string();
    }
    if matches("outlook")
        || matches("hotmail")
        || matches("live.com")
        || matches("office365")
        || matches("microsoft")
    {
        return "outlook".to_string();
    }
    // `126` is NetEase's second domain and keeps its own hosts, so it is checked
    // before the group that maps everything else NetEase onto `163`.
    if matches("126") {
        return "126".to_string();
    }
    if matches("163") || matches("yeah") || matches("netease") {
        return "163".to_string();
    }
    if matches("tencent_enterprise") || matches("tencententerprise") || matches("exmail") {
        return "tencentEnterprise".to_string();
    }
    if matches("qq") || matches("foxmail") {
        return "qq".to_string();
    }
    if matches("aliyun_enterprise")
        || matches("alibaba")
        || matches("qiye.aliyun")
        || matches("aliyunenterprise")
    {
        return "aliyunEnterprise".to_string();
    }
    if matches("aliyun") {
        return "aliyun".to_string();
    }
    if matches("189") {
        return "189".to_string();
    }
    if matches("sohu") {
        return "sohu".to_string();
    }
    if matches("sina") {
        return "sina".to_string();
    }
    if matches("139") {
        return "139".to_string();
    }
    if matches("21cn") {
        return "21cn".to_string();
    }
    if matches("perfect") || matches("88.com") || matches("111.com") || matches("email.cn") {
        return "perfect".to_string();
    }
    if matches("icloud") || matches("me.com") || matches("mac.com") {
        return "icloud".to_string();
    }
    if matches("aol") {
        return "aol".to_string();
    }
    if matches("yandex") {
        return "yandex".to_string();
    }
    if matches("mailru") || matches("mail.ru") {
        return "mailru".to_string();
    }
    if matches("custom") {
        return CUSTOM_KEY.to_string();
    }

    key
}

/// Build a preset from the parts every service shares. The rest of the fields
/// default to the common case — 993/IMAP with implicit TLS, 465/SMTP with
/// implicit TLS, the same auth kind on both sides — and the few services that
/// differ override them with struct update syntax.
fn preset(
    key: &str,
    display_name: &str,
    domains: &[&str],
    auth_type: AuthKind,
    imap_host: &str,
    smtp_host: &str,
) -> ProviderPreset {
    ProviderPreset {
        key: key.to_string(),
        display_name: display_name.to_string(),
        domains: domains.iter().map(|domain| domain.to_string()).collect(),
        auth_type,
        imap_host: imap_host.to_string(),
        imap_port: 993,
        imap_security: Security::SslTls,
        smtp_host: Some(smtp_host.to_string()),
        smtp_port: Some(465),
        smtp_security: Some(Security::SslTls),
        smtp_auth_type: Some(auth_type),
        smtp_requires_auth: true,
        requires_enable_imap: true,
        requires_app_password: auth_type == AuthKind::AppPassword,
        setup_help_url: None,
        notes: None,
    }
}

static PRESETS: LazyLock<Vec<ProviderPreset>> = LazyLock::new(|| {
    vec![
        ProviderPreset {
            setup_help_url: Some(
                "https://support.google.com/accounts/answer/185833".to_string(),
            ),
            notes: Some(
                "Requires an app-specific password: turn on 2-step verification, then create one."
                    .to_string(),
            ),
            ..preset(
                "gmail",
                "Gmail",
                &["gmail.com", "googlemail.com"],
                AuthKind::AppPassword,
                "imap.gmail.com",
                "smtp.gmail.com",
            )
        },
        ProviderPreset {
            setup_help_url: Some(
                "https://help.yahoo.com/kb/generate-third-party-manual-passwords-sln15241.html"
                    .to_string(),
            ),
            ..preset(
                "yahoo",
                "Yahoo Mail",
                &["yahoo.com", "ymail.com"],
                AuthKind::AppPassword,
                "imap.mail.yahoo.com",
                "smtp.mail.yahoo.com",
            )
        },
        ProviderPreset {
            smtp_port: Some(587),
            smtp_security: Some(Security::Starttls),
            setup_help_url: Some(
                "https://support.microsoft.com/account-billing/manage-app-passwords-for-two-step-verification"
                    .to_string(),
            ),
            notes: Some(
                "Outlook needs an app password in this release; OAuth sign-in is not supported."
                    .to_string(),
            ),
            ..preset(
                "outlook",
                "Outlook",
                &["outlook.com", "hotmail.com", "live.com", "office365.com", "microsoft.com"],
                AuthKind::AppPassword,
                "outlook.office365.com",
                "smtp.office365.com",
            )
        },
        ProviderPreset {
            notes: Some("Use the client authorization code, not the account password.".to_string()),
            ..preset(
                "163",
                "网易 163",
                &["163.com", "yeah.net", "netease.com"],
                AuthKind::AppPassword,
                "imap.163.com",
                "smtp.163.com",
            )
        },
        ProviderPreset {
            notes: Some("Use the client authorization code, not the account password.".to_string()),
            ..preset(
                "126",
                "网易 126",
                &["126.com"],
                AuthKind::AppPassword,
                "imap.126.com",
                "smtp.126.com",
            )
        },
        ProviderPreset {
            notes: Some("Use the client authorization code, not the account password.".to_string()),
            ..preset(
                "qq",
                "QQ 邮箱",
                &["qq.com", "foxmail.com"],
                AuthKind::AppPassword,
                "imap.qq.com",
                "smtp.qq.com",
            )
        },
        preset(
            "tencentEnterprise",
            "腾讯企业邮",
            &["exmail.qq.com"],
            AuthKind::Password,
            "imap.exmail.qq.com",
            "smtp.exmail.qq.com",
        ),
        ProviderPreset {
            notes: Some("Use the client-specific password, not the login password.".to_string()),
            ..preset(
                "aliyun",
                "阿里云邮箱",
                &["aliyun.com"],
                AuthKind::AppPassword,
                "imap.aliyun.com",
                "smtp.aliyun.com",
            )
        },
        preset(
            "aliyunEnterprise",
            "阿里云企业邮",
            &["qiye.aliyun.com"],
            AuthKind::Password,
            "imap.qiye.aliyun.com",
            "smtp.qiye.aliyun.com",
        ),
        preset(
            "189",
            "天翼 189",
            &["189.cn"],
            AuthKind::Password,
            "imap.189.cn",
            "smtp.189.cn",
        ),
        ProviderPreset {
            notes: Some("Use the independent password, not the login password.".to_string()),
            ..preset(
                "sohu",
                "搜狐邮箱",
                &["sohu.com"],
                AuthKind::AppPassword,
                "imap.sohu.com",
                "smtp.sohu.com",
            )
        },
        preset(
            "sina",
            "新浪邮箱",
            &["sina.com", "sina.cn"],
            AuthKind::AppPassword,
            "imap.sina.com",
            "smtp.sina.com",
        ),
        ProviderPreset {
            notes: Some("Use the client-specific password, not the login password.".to_string()),
            ..preset(
                "139",
                "移动 139",
                &["139.com"],
                AuthKind::AppPassword,
                "imap.139.com",
                "smtp.139.com",
            )
        },
        preset(
            "21cn",
            "21CN 邮箱",
            &["21cn.com"],
            AuthKind::Password,
            "imap.21cn.com",
            "smtp.21cn.com",
        ),
        ProviderPreset {
            notes: Some("Use the dedicated password, not the login password.".to_string()),
            ..preset(
                "perfect",
                "完美邮箱",
                &["88.com", "111.com", "email.cn"],
                AuthKind::AppPassword,
                "imap.88.com",
                "smtp.88.com",
            )
        },
        ProviderPreset {
            smtp_port: Some(587),
            smtp_security: Some(Security::Starttls),
            setup_help_url: Some("https://support.apple.com/en-us/102654".to_string()),
            notes: Some(
                "Requires an app-specific password generated with your Apple ID.".to_string(),
            ),
            ..preset(
                "icloud",
                "iCloud Mail",
                &["icloud.com", "me.com", "mac.com"],
                AuthKind::AppPassword,
                "imap.mail.me.com",
                "smtp.mail.me.com",
            )
        },
        preset(
            "aol",
            "AOL Mail",
            &["aol.com"],
            AuthKind::AppPassword,
            "imap.aol.com",
            "smtp.aol.com",
        ),
        preset(
            "yandex",
            "Yandex Mail",
            &["yandex.com", "yandex.ru", "ya.ru"],
            AuthKind::AppPassword,
            "imap.yandex.com",
            "smtp.yandex.com",
        ),
        preset(
            "mailru",
            "Mail.ru",
            &["mail.ru", "inbox.ru", "list.ru", "bk.ru"],
            AuthKind::AppPassword,
            "imap.mail.ru",
            "smtp.mail.ru",
        ),
        // The fallback: the user types the hosts, so nothing is prefilled and the
        // auth kind stays manual.
        ProviderPreset {
            key: CUSTOM_KEY.to_string(),
            display_name: "Custom IMAP".to_string(),
            domains: Vec::new(),
            auth_type: AuthKind::Manual,
            imap_host: String::new(),
            imap_port: 993,
            imap_security: Security::SslTls,
            smtp_host: Some(String::new()),
            smtp_port: Some(465),
            smtp_security: Some(Security::SslTls),
            smtp_auth_type: Some(AuthKind::Manual),
            smtp_requires_auth: true,
            requires_enable_imap: false,
            requires_app_password: false,
            setup_help_url: None,
            notes: None,
        },
    ]
});

#[cfg(test)]
mod tests {
    use super::{find, normalize_key, presets, CUSTOM_KEY};
    use crate::models::AuthKind;

    #[test]
    fn ships_twenty_presets_with_unique_keys() {
        let presets = presets();
        assert_eq!(presets.len(), 20);

        let mut keys: Vec<&str> = presets.iter().map(|preset| preset.key.as_str()).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), 20, "two presets share a key");

        assert!(presets.iter().any(|preset| preset.key == CUSTOM_KEY));
    }

    #[test]
    fn every_preset_carries_usable_connection_settings() {
        for preset in presets() {
            assert!(!preset.display_name.trim().is_empty(), "{}", preset.key);
            assert!(
                (1..=65535).contains(&preset.imap_port),
                "{} has an invalid IMAP port",
                preset.key
            );
            if let Some(port) = preset.smtp_port {
                assert!(
                    (1..=65535).contains(&port),
                    "{} has an invalid SMTP port",
                    preset.key
                );
            }
            if preset.key == CUSTOM_KEY {
                assert!(preset.imap_host.is_empty());
                assert_eq!(preset.auth_type, AuthKind::Manual);
                continue;
            }
            assert!(!preset.imap_host.trim().is_empty(), "{}", preset.key);
            assert!(!preset.domains.is_empty(), "{} has no domain", preset.key);
            assert!(
                preset.smtp_host.is_some(),
                "{} has no SMTP host",
                preset.key
            );
        }
    }

    #[test]
    fn gmail_and_outlook_ask_for_an_app_password() {
        for key in ["gmail", "outlook"] {
            let preset = find(key).unwrap();
            assert_eq!(preset.auth_type, AuthKind::AppPassword);
            assert!(preset.requires_app_password);
            assert!(preset.notes.is_some());
        }
    }

    #[test]
    fn finds_a_preset_by_exact_key() {
        assert_eq!(find("163").unwrap().imap_host, "imap.163.com");
        assert_eq!(find("custom").unwrap().key, CUSTOM_KEY);
        assert_eq!(find("  qq ").unwrap().key, "qq");
    }

    #[test]
    fn falls_back_to_the_canonical_key_for_loose_names() {
        assert_eq!(find("netease163").unwrap().key, "163");
        assert_eq!(find("Netease").unwrap().key, "163");
        assert_eq!(find("126.com").unwrap().key, "126");
        assert_eq!(find("exmail").unwrap().key, "tencentEnterprise");
        assert_eq!(find("tencent_enterprise").unwrap().key, "tencentEnterprise");
        assert_eq!(find("aliyun_enterprise").unwrap().key, "aliyunEnterprise");
        assert_eq!(find("gmail.com").unwrap().key, "gmail");
        assert_eq!(find("custom_imap").unwrap().key, CUSTOM_KEY);
    }

    #[test]
    fn keeps_mail_ru_apart_from_ru_domains() {
        assert_eq!(normalize_key("mail.ru"), "mailru");
        assert_eq!(find("yandex.ru").unwrap().key, "yandex");
    }

    #[test]
    fn returns_none_for_an_unknown_key() {
        assert!(find("some-other-service").is_none());
        assert!(find("").is_none());
        assert!(find("   ").is_none());
    }
}
