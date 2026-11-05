//! Package-source records and the shell-free parsing rules that turn
//! registered uninstall commands into typed evidence.
//!
//! Free-form command strings never leave this module. Callers receive a
//! validated executable path, its raw argument text, and a stable kind; the
//! caller stores only a digest of that evidence.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::applications::contracts::{
    ApplicationInstallScope, WindowsRegisteredUninstallKind,
};
use crate::applications::running_identity;
use crate::platform::contracts::ApplicationUninstallDiagnostic;

/// One static AppX inventory script.
///
/// The script is a compile-time constant. No user-controlled value is ever
/// interpolated into it, so PowerShell never evaluates application metadata as
/// code.
pub(crate) const APPX_INVENTORY_SCRIPT: &str = r#"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'
$startApps = @{}
Get-StartApps -ErrorAction SilentlyContinue | ForEach-Object {
  $family = ([string]$_.AppID).Split('!')[0]
  if ($family -and -not $startApps.ContainsKey($family)) { $startApps[$family] = [string]$_.Name }
}
$packages = @(Get-AppxPackage -ErrorAction Stop)
$items = @(
  $packages |
    Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage -and -not $_.NonRemovable -and -not $_.IsPartiallyStaged } |
    ForEach-Object {
      $package = $_
      $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction SilentlyContinue
      $displayName = [string]$startApps[$package.PackageFamilyName]
      if (-not $displayName -or $displayName -like 'ms-resource:*') {
        $displayName = [string]$manifest.Package.Properties.DisplayName
      }
      $applications = @($manifest.Package.Applications.Application)
      if ($applications.Count -eq 1 -and (-not $displayName -or $displayName -like 'ms-resource:*' -or $displayName -eq [string]$package.Name)) {
        $applicationName = [string]$applications[0].VisualElements.DisplayName
        if ($applicationName -and $applicationName -notlike 'ms-resource:*') { $displayName = $applicationName }
      }
      if (-not $displayName -or $displayName -like 'ms-resource:*') { $displayName = [string]$package.Name }
      $publisher = [string]$manifest.Package.Properties.PublisherDisplayName
      if (-not $publisher -or $publisher.StartsWith('ms-resource:')) { $publisher = [string]$package.Publisher }
      $application = $applications[0]
      $executable = if ($null -ne $application) { [string]$application.Executable } else { '' }
      $icon = ''
      if ($null -ne $application) {
        $visualElements = $application.VisualElements
        $declared = [string]$visualElements.Square44x44Logo
        if (-not $declared) { $declared = [string]$visualElements.Square150x150Logo }
        if ($declared) {
          # Manifests name the unqualified asset, but installed packages carry
          # scale- and targetsize-qualified copies, so resolve the real file.
          $installRoot = [string]$package.InstallLocation
          $resolved = Join-Path $installRoot $declared
          if (Test-Path -LiteralPath $resolved -PathType Leaf -ErrorAction SilentlyContinue) {
            $icon = $declared
          } else {
            $folder = Split-Path -Path $declared -Parent
            $stem = [IO.Path]::GetFileNameWithoutExtension($declared)
            $searchRoot = if ($folder) { Join-Path $installRoot $folder } else { $installRoot }
            $candidates = @(Get-ChildItem -LiteralPath $searchRoot -Filter ($stem + '*.png') -File -ErrorAction SilentlyContinue)
            if ($candidates.Count -eq 0) {
              $candidates = @(Get-ChildItem -LiteralPath $installRoot -Filter ($stem + '*.png') -File -Recurse -ErrorAction SilentlyContinue)
            }
            $best = $candidates |
              Sort-Object @{ Expression = {
                if ($_.Name -like '*targetsize-48*') { 0 }
                elseif ($_.Name -like '*targetsize-44*') { 1 }
                elseif ($_.Name -like '*scale-200*') { 2 }
                elseif ($_.Name -like '*scale-100*') { 3 }
                else { 4 }
              } }, Name |
              Select-Object -First 1
            if ($null -ne $best) {
              $icon = $best.FullName.Substring($installRoot.TrimEnd('\').Length + 1)
            }
          }
        }
      }
      [pscustomobject]@{
        systemSigned = ([string]$package.SignatureKind -eq 'System')
        packageFamilyName = [string]$package.PackageFamilyName
        packageFullName = [string]$package.PackageFullName
        name = $displayName
        version = [string]$package.Version
        publisher = $publisher
        installLocation = [string]$package.InstallLocation
        executable = $executable
        icon = $icon
      }
    }
)
$result = [pscustomobject]@{
  schemaVersion = 1
  items = $items
}
ConvertTo-Json -InputObject $result -Depth 4 -Compress
"#;

/// One AppX package as reported by [`APPX_INVENTORY_SCRIPT`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackagedApplicationRecord {
    pub(crate) system_signed: bool,
    pub(crate) package_family_name: String,
    pub(crate) package_full_name: String,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) publisher: String,
    pub(crate) install_location: String,
    pub(crate) executable: String,
    pub(crate) icon: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackagedApplicationInventory {
    pub(crate) schema_version: u32,
    pub(crate) items: Vec<PackagedApplicationRecord>,
}

/// One package reported by `winget list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WingetProduct {
    pub(crate) name: String,
    pub(crate) package_id: String,
    pub(crate) version: Option<String>,
}

/// Validated form of a registered uninstall command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedUninstallCommand {
    pub(crate) kind: WindowsRegisteredUninstallKind,
    pub(crate) executable: PathBuf,
    pub(crate) arguments: String,
}

/// Parses and validates a registered uninstall command without invoking a
/// shell or searching `PATH`.
pub(crate) fn parse_uninstall_command(
    command: &str,
    key_name: &str,
    scope: ApplicationInstallScope,
) -> Result<ParsedUninstallCommand, ApplicationUninstallDiagnostic> {
    let parsed = parse_command_evidence(command, key_name, scope)?;
    if matches!(
        parsed.kind,
        WindowsRegisteredUninstallKind::Executable | WindowsRegisteredUninstallKind::BatchScript
    ) {
        let metadata = std::fs::metadata(&parsed.executable).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => ApplicationUninstallDiagnostic::ExecutableMissing,
            std::io::ErrorKind::PermissionDenied => {
                ApplicationUninstallDiagnostic::ExecutableAccessDenied
            }
            _ => ApplicationUninstallDiagnostic::ExecutableProbeFailed,
        })?;
        if !metadata.is_file() {
            return Err(ApplicationUninstallDiagnostic::InvalidExecutable);
        }
    }
    Ok(parsed)
}

/// Splits and classifies a command without touching the filesystem. Callers
/// that need a runnable target use [`parse_uninstall_command`].
fn parse_command_evidence(
    command: &str,
    key_name: &str,
    scope: ApplicationInstallScope,
) -> Result<ParsedUninstallCommand, ApplicationUninstallDiagnostic> {
    let command = command.trim();
    if command.is_empty() {
        return Err(ApplicationUninstallDiagnostic::CommandMissing);
    }
    if let Some(product_code) = parse_winget_product_code(command) {
        if scope == ApplicationInstallScope::CurrentUser
            && product_code.eq_ignore_ascii_case(key_name)
        {
            return Ok(ParsedUninstallCommand {
                kind: WindowsRegisteredUninstallKind::WingetProduct,
                executable: PathBuf::from("winget"),
                arguments: product_code.to_ascii_lowercase(),
            });
        }
        return Err(ApplicationUninstallDiagnostic::UnsupportedCommandHost);
    }
    if scope == ApplicationInstallScope::CurrentUser {
        if let Some((script, arguments)) = parse_user_powershell_script(command) {
            return Ok(ParsedUninstallCommand {
                kind: WindowsRegisteredUninstallKind::UserPowerShellScript,
                executable: script,
                arguments: arguments.join("\0"),
            });
        }
    }
    let (executable, arguments) = split_registered_command(command)
        .ok_or(ApplicationUninstallDiagnostic::InvalidCommand)?;
    let expanded = expand_environment_path(&executable);
    if expanded.split('%').count() >= 3 {
        return Err(ApplicationUninstallDiagnostic::UnresolvedEnvironment);
    }
    let executable = PathBuf::from(expanded);
    if !executable.is_absolute() {
        return Err(ApplicationUninstallDiagnostic::RelativeExecutable);
    }
    if executable
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("rundll32.exe"))
    {
        return validate_rundll32(executable, &arguments);
    }
    if is_blocked_host(&executable) {
        return Err(ApplicationUninstallDiagnostic::UnsupportedCommandHost);
    }
    let kind = match extension_kind(&executable) {
        Some(WindowsRegisteredUninstallKind::Executable) => {
            WindowsRegisteredUninstallKind::Executable
        }
        Some(WindowsRegisteredUninstallKind::BatchScript) => {
            WindowsRegisteredUninstallKind::BatchScript
        }
        _ => return Err(ApplicationUninstallDiagnostic::InvalidExecutable),
    };
    Ok(ParsedUninstallCommand {
        kind,
        executable,
        arguments,
    })
}

/// Stable blake3 digest over the normalized command evidence.
pub(crate) fn command_digest(command: &ParsedUninstallCommand) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"systools-windows-registered-uninstaller-v1");
    hasher.update(kind_code(command.kind).as_bytes());
    hasher.update(running_identity::path_identity_key(&command.executable).as_bytes());
    hasher.update(command.arguments.as_bytes());
    hasher.finalize().to_hex().to_string()
}

pub(crate) const fn kind_code(kind: WindowsRegisteredUninstallKind) -> &'static str {
    match kind {
        WindowsRegisteredUninstallKind::Executable => "executable",
        WindowsRegisteredUninstallKind::BatchScript => "batch-script",
        WindowsRegisteredUninstallKind::Rundll32 => "rundll32",
        WindowsRegisteredUninstallKind::UserPowerShellScript => "user-powershell-script",
        WindowsRegisteredUninstallKind::WingetProduct => "winget-product",
    }
}

/// Splits a registered command without a shell. A quoted prefix must end at a
/// whitespace boundary; otherwise only an `.exe`, `.bat`, or `.cmd` suffix
/// followed by whitespace or the end of the string is a boundary.
fn split_registered_command(command: &str) -> Option<(String, String)> {
    if command.len() > 32_768 || command.contains(['\0', '\r', '\n']) {
        return None;
    }
    if let Some(quoted) = command.strip_prefix('"') {
        let closing_quote = quoted.find('"')?;
        let executable = &quoted[..closing_quote];
        let tail = &quoted[closing_quote + 1..];
        if executable.is_empty() || tail.starts_with(|c: char| !c.is_whitespace()) {
            return None;
        }
        return Some((executable.to_string(), tail.trim().to_string()));
    }
    let lowercase = command.to_ascii_lowercase();
    let end = [".exe", ".bat", ".cmd"]
        .into_iter()
        .flat_map(|suffix| lowercase.match_indices(suffix))
        .filter_map(|(index, _)| {
            let end = index + 4;
            (end == command.len() || command[end..].starts_with(char::is_whitespace))
                .then_some(end)
        })
        .min()?;
    let executable = &command[..end];
    if executable.contains('"') {
        return None;
    }
    Some((executable.to_string(), command[end..].trim().to_string()))
}

/// Expands only tokens present in the original registration, once. Recursive
/// replacement could loop forever when a value refers to itself.
pub(crate) fn expand_environment_variables(
    value: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> String {
    let mut output = String::with_capacity(value.len());
    let mut remaining = value;
    while let Some(start) = remaining.find('%') {
        output.push_str(&remaining[..start]);
        let token = &remaining[start + 1..];
        let Some(end) = token.find('%') else {
            output.push_str(&remaining[start..]);
            return output;
        };
        match lookup(&token[..end]) {
            Some(replacement) => output.push_str(&replacement),
            None => output.push_str(&remaining[start..start + end + 2]),
        }
        remaining = &token[end + 1..];
    }
    output.push_str(remaining);
    output
}

fn expand_environment_path(value: &str) -> String {
    expand_environment_variables(value, |name| std::env::var(name).ok())
}

fn extension_kind(path: &Path) -> Option<WindowsRegisteredUninstallKind> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("exe") => Some(WindowsRegisteredUninstallKind::Executable),
        Some("bat") | Some("cmd") => Some(WindowsRegisteredUninstallKind::BatchScript),
        _ => None,
    }
}

fn is_blocked_host(executable: &Path) -> bool {
    executable.file_name().is_some_and(|name| {
        [
            "cmd.exe",
            "cscript.exe",
            "mshta.exe",
            "powershell.exe",
            "pwsh.exe",
            "regsvr32.exe",
            "rundll32.exe",
            "wscript.exe",
        ]
        .iter()
        .any(|blocked| name.eq_ignore_ascii_case(blocked))
    })
}

fn validate_rundll32(
    _host: PathBuf,
    arguments: &str,
) -> Result<ParsedUninstallCommand, ApplicationUninstallDiagnostic> {
    if arguments.contains(['&', '|', '<', '>', '^', '\0', '\r', '\n']) {
        return Err(ApplicationUninstallDiagnostic::InvalidCommand);
    }
    let (library, remainder) = split_first_argument(arguments)
        .ok_or(ApplicationUninstallDiagnostic::InvalidCommand)?;
    let library = PathBuf::from(expand_environment_path(&library));
    if !library.is_absolute() || is_blocked_host(&library) {
        return Err(ApplicationUninstallDiagnostic::RelativeExecutable);
    }
    if !library
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"))
    {
        return Err(ApplicationUninstallDiagnostic::InvalidExecutable);
    }
    if !library.is_file() {
        return Err(ApplicationUninstallDiagnostic::ExecutableMissing);
    }
    let (entry_point, parameters) = split_first_argument(&remainder)
        .ok_or(ApplicationUninstallDiagnostic::InvalidCommand)?;
    if !valid_entry_point(&entry_point) {
        return Err(ApplicationUninstallDiagnostic::InvalidCommand);
    }
    let arguments = if parameters.trim().is_empty() {
        entry_point
    } else {
        format!("{entry_point} {parameters}")
    };
    Ok(ParsedUninstallCommand {
        kind: WindowsRegisteredUninstallKind::Rundll32,
        executable: library,
        arguments,
    })
}

fn valid_entry_point(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '.' | '_' | '#' | '-' | ',')
        })
}

/// Splits the first argument using double quotes, returning the unquoted value
/// and the unparsed remainder.
fn split_first_argument(value: &str) -> Option<(String, String)> {
    let value = value.trim_start();
    if value.is_empty() {
        return None;
    }
    if let Some(quoted) = value.strip_prefix('"') {
        let closing = quoted.find('"')?;
        let argument = &quoted[..closing];
        let remainder = quoted[closing + 1..].trim_start();
        return (!argument.is_empty()).then(|| (argument.to_string(), remainder.to_string()));
    }
    let end = value.find(char::is_whitespace).unwrap_or(value.len());
    Some((value[..end].to_string(), value[end..].trim_start().to_string()))
}

fn parse_winget_product_code(command: &str) -> Option<String> {
    let parts = command.split_whitespace().collect::<Vec<_>>();
    (parts.len() == 4
        && matches!(
            parts[0].to_ascii_lowercase().as_str(),
            "winget" | "winget.exe"
        )
        && parts[1].eq_ignore_ascii_case("uninstall")
        && parts[2].eq_ignore_ascii_case("--product-code")
        && !parts[3].is_empty())
    .then(|| parts[3].to_string())
}

fn parse_user_powershell_script(command: &str) -> Option<(PathBuf, Vec<String>)> {
    if command.contains(['\r', '\n', ';', '|', '>', '<', '`']) {
        return None;
    }
    let (host, remainder) = split_powershell_host(command)?;
    if !(host.eq_ignore_ascii_case("powershell")
        || host.eq_ignore_ascii_case("powershell.exe")
        || Path::new(&host)
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("powershell.exe")))
    {
        return None;
    }
    let tokens = tokenize_arguments(remainder)?;
    let (script, arguments) = parse_powershell_file_tokens(&tokens)
        .or_else(|| parse_powershell_command_tokens(&tokens))?;
    let script = trusted_current_user_script(&script)?;
    Some((script, arguments))
}

fn split_powershell_host(command: &str) -> Option<(String, &str)> {
    if let Some(quoted) = command.strip_prefix('"') {
        let closing_quote = quoted.find('"')?;
        let host = quoted[..closing_quote].trim();
        let remainder = quoted[closing_quote + 1..].trim();
        return (!host.is_empty()).then(|| (host.to_string(), remainder));
    }
    let end = command.find(char::is_whitespace).unwrap_or(command.len());
    let host = command[..end].trim();
    (!host.is_empty()).then(|| (host.to_string(), command[end..].trim()))
}

fn parse_powershell_file_tokens(tokens: &[String]) -> Option<(String, Vec<String>)> {
    let file_index = tokens
        .iter()
        .position(|token| token.eq_ignore_ascii_case("-file"))?;
    if !valid_powershell_host_options(tokens[..file_index].iter()) {
        return None;
    }
    let script = tokens.get(file_index + 1)?.clone();
    let arguments = tokens[file_index + 2..].to_vec();
    safe_script_arguments(&arguments).then_some((script, arguments))
}

fn parse_powershell_command_tokens(tokens: &[String]) -> Option<(String, Vec<String>)> {
    let command_index = tokens.iter().position(|token| {
        token.eq_ignore_ascii_case("-c") || token.eq_ignore_ascii_case("-command")
    })?;
    let body = tokens.get(command_index + 1)?.trim();
    if !valid_powershell_host_options(
        tokens[..command_index]
            .iter()
            .chain(tokens[command_index + 2..].iter()),
    ) {
        return None;
    }
    let body = body.strip_prefix('&')?.trim();
    let (script, remainder) = split_first_argument(body)?;
    let arguments = tokenize_arguments(&remainder)?;
    if !safe_script_arguments(&arguments) {
        return None;
    }
    Some((script, arguments))
}

fn valid_powershell_host_options<'a>(tokens: impl IntoIterator<Item = &'a String>) -> bool {
    let mut tokens = tokens.into_iter();
    while let Some(token) = tokens.next() {
        let normalized = token.to_ascii_lowercase();
        let accepted = match normalized.as_str() {
            "-noprofile" | "-noninteractive" | "-nologo" | "-noexit" => true,
            "-executionpolicy" => matches!(
                tokens.next().map(|value| value.to_ascii_lowercase()).as_deref(),
                Some("bypass" | "unrestricted" | "remotesigned" | "allsigned" | "default")
            ),
            "-windowstyle" => matches!(
                tokens.next().map(|value| value.to_ascii_lowercase()).as_deref(),
                Some("hidden" | "normal" | "minimized")
            ),
            "-inputformat" | "-outputformat" => matches!(
                tokens.next().map(|value| value.to_ascii_lowercase()).as_deref(),
                Some("none" | "text")
            ),
            _ => false,
        };
        if !accepted {
            return false;
        }
    }
    true
}

fn tokenize_arguments(value: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut pending = false;
    for character in value.chars() {
        match character {
            '"' => {
                quoted = !quoted;
                pending = true;
            }
            character if character.is_whitespace() && !quoted => {
                if pending {
                    tokens.push(std::mem::take(&mut current));
                    pending = false;
                }
            }
            character if character.is_control() => return None,
            character => {
                current.push(character);
                pending = true;
            }
        }
    }
    if quoted {
        return None;
    }
    if pending {
        tokens.push(current);
    }
    Some(tokens)
}

fn safe_script_arguments(arguments: &[String]) -> bool {
    arguments.iter().all(|argument| {
        argument.len() <= 4096 && !argument.contains(['\0', '\r', '\n', ';', '|', '>', '<'])
    })
}

fn trusted_current_user_script(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(expand_environment_path(value.trim().trim_matches('"')));
    (path.is_absolute()
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("ps1"))
        && path.is_file())
    .then_some(path)
}

/// Parses the fixed-column table printed by `winget list`.
///
/// The header identifies the columns, so localized column widths do not change
/// how records are read. Unparseable lines are skipped: this source is
/// enrichment only and never fails a scan.
pub(crate) fn parse_winget_list(output: &str) -> Vec<WingetProduct> {
    let mut products = Vec::new();
    let mut columns = None;
    for line in output.lines() {
        if columns.is_none() {
            columns = winget_columns(line);
            continue;
        }
        let Some((id_column, version_column)) = columns else {
            continue;
        };
        if line.trim().is_empty() || line.starts_with('-') || !line.contains(char::is_alphanumeric) {
            continue;
        }
        let Some(name) = slice_column(line, 0, Some(id_column)) else {
            continue;
        };
        let Some(package_id) = slice_column(line, id_column, Some(version_column.unwrap_or(usize::MAX)))
        else {
            continue;
        };
        if name.is_empty() || package_id.is_empty() {
            continue;
        }
        let version = version_column
            .and_then(|start| slice_column(line, start, None))
            .and_then(|value| {
                value
                    .split_whitespace()
                    .next()
                    .map(std::string::ToString::to_string)
            })
            .filter(|value| !value.is_empty());
        products.push(WingetProduct {
            name,
            package_id,
            version,
        });
    }
    products.sort_by(|left, right| {
        left.package_id
            .to_ascii_lowercase()
            .cmp(&right.package_id.to_ascii_lowercase())
    });
    products.dedup_by(|left, right| left.package_id.eq_ignore_ascii_case(&right.package_id));
    products
}

fn winget_columns(header: &str) -> Option<(usize, Option<usize>)> {
    let id_column = header.find("Id")?;
    let version_column = header.find("Version");
    (id_column > 0).then_some((id_column, version_column))
}

fn slice_column(line: &str, start: usize, end: Option<usize>) -> Option<String> {
    let end = end.map_or(line.len(), |end| end.min(line.len()));
    if start > end {
        return None;
    }
    let value = line.get(start..end)?;
    Some(value.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(command: &str) -> Option<ParsedUninstallCommand> {
        parse_command_evidence(command, "Example", ApplicationInstallScope::Machine).ok()
    }

    #[test]
    fn quoted_and_unquoted_executables_preserve_arguments() {
        let executable = r"C:\Vendor Suite\uninstall.exe";
        for command in [
            format!("\"{executable}\" /remove \"value with spaces & punctuation\""),
            format!("{executable} /remove \"value with spaces & punctuation\""),
        ] {
            let parsed = parse(&command).expect("command should parse");
            assert_eq!(parsed.executable, PathBuf::from(executable));
            assert_eq!(parsed.arguments, r#"/remove "value with spaces & punctuation""#);
            assert_eq!(parsed.kind, WindowsRegisteredUninstallKind::Executable);
        }
    }

    #[test]
    fn suffixes_inside_directories_do_not_truncate_the_executable() {
        let parsed = parse(r"C:\tools.exe.backup\Vendor App\Uninstall.EXE /remove")
            .expect("the directory suffix must not become the executable boundary");
        assert_eq!(
            parsed.executable,
            PathBuf::from(r"C:\tools.exe.backup\Vendor App\Uninstall.EXE")
        );
        assert_eq!(parsed.arguments, "/remove");
    }

    #[test]
    fn malformed_commands_are_rejected_without_a_shell() {
        for (command, reason) in [
            ("", ApplicationUninstallDiagnostic::CommandMissing),
            (
                "uninstall.exe\n/remove",
                ApplicationUninstallDiagnostic::InvalidCommand,
            ),
            (
                r#"C:\app.exe.bak"#,
                ApplicationUninstallDiagnostic::InvalidCommand,
            ),
            (
                r#""C:\app.exe"/remove"#,
                ApplicationUninstallDiagnostic::InvalidCommand,
            ),
        ] {
            assert_eq!(
                parse_uninstall_command(command, "Example", ApplicationInstallScope::Machine),
                Err(reason),
                "{command}"
            );
        }
    }

    #[test]
    fn relative_and_blocked_hosts_are_not_actionable() {
        assert_eq!(
            parse_uninstall_command(
                r"uninstall.exe /remove",
                "Example",
                ApplicationInstallScope::Machine
            ),
            Err(ApplicationUninstallDiagnostic::RelativeExecutable)
        );
        assert_eq!(
            parse_uninstall_command(
                r"C:\Windows\System32\cmd.exe /c uninstall.bat",
                "Example",
                ApplicationInstallScope::Machine
            ),
            Err(ApplicationUninstallDiagnostic::UnsupportedCommandHost)
        );
    }

    #[test]
    fn environment_expansion_is_bounded_and_preserves_unresolved_tokens() {
        assert_eq!(
            expand_environment_variables(r"%SELF%\app.exe", |_| Some("%SELF%".into())),
            r"%SELF%\app.exe"
        );
        assert_eq!(
            expand_environment_variables(r"%MISSING%\app.exe", |_| None),
            r"%MISSING%\app.exe"
        );
        assert_eq!(
            expand_environment_variables(r"%ROOT%\app.exe", |_| Some(r"C:\Apps".into())),
            r"C:\Apps\app.exe"
        );
    }

    #[test]
    fn winget_product_registration_requires_the_matching_current_user_key() {
        let command = "winget uninstall --product-code Example";
        assert_eq!(
            parse_uninstall_command(command, "Example", ApplicationInstallScope::Machine),
            Err(ApplicationUninstallDiagnostic::UnsupportedCommandHost)
        );
        let parsed =
            parse_uninstall_command(command, "example", ApplicationInstallScope::CurrentUser)
                .expect("a matching current-user winget registration is actionable");
        assert_eq!(parsed.kind, WindowsRegisteredUninstallKind::WingetProduct);
    }

    #[test]
    fn executable_presence_is_probed_after_parsing() {
        let current =
            std::env::current_exe().expect("the test executable path should be readable");
        let command = format!("\"{}\" /remove", current.display());
        let parsed = parse_uninstall_command(&command, "Example", ApplicationInstallScope::Machine)
            .expect("an existing executable is actionable");
        assert_eq!(parsed.executable, current);
        let missing = format!(
            "\"C:\\Missing\\uninstall-{}.exe\"",
            std::process::id()
        );
        assert_eq!(
            parse_uninstall_command(&missing, "Example", ApplicationInstallScope::Machine),
            Err(ApplicationUninstallDiagnostic::ExecutableMissing)
        );
    }

    #[test]
    fn digests_depend_on_kind_executable_and_arguments() {
        let first = ParsedUninstallCommand {
            kind: WindowsRegisteredUninstallKind::Executable,
            executable: PathBuf::from(r"C:\Vendor\uninstall.exe"),
            arguments: "/remove".to_string(),
        };
        let normalized = ParsedUninstallCommand {
            kind: WindowsRegisteredUninstallKind::Executable,
            executable: PathBuf::from(r"c:/vendor/UNINSTALL.EXE"),
            arguments: "/remove".to_string(),
        };
        let changed = ParsedUninstallCommand {
            arguments: "/repair".to_string(),
            ..normalized.clone()
        };
        assert_eq!(command_digest(&first), command_digest(&normalized));
        assert_ne!(command_digest(&first), command_digest(&changed));
    }

    #[test]
    fn winget_table_parsing_reads_fixed_columns() {
        let output = "Name                          Id                        Version   Available Source\n\
                      -------------------------------------------------------------------------------\n\
                      7-Zip 22.01 (x64)             7zip.7zip                 22.01     24.09   winget\n\
                      Example App                   Vendor.Example            1.2.3             winget\n";
        let products = parse_winget_list(output);
        assert_eq!(products.len(), 2);
        assert_eq!(products[0].package_id, "7zip.7zip");
        assert_eq!(products[0].name, "7-Zip 22.01 (x64)");
        assert_eq!(products[0].version.as_deref(), Some("22.01"));
        assert_eq!(products[1].package_id, "Vendor.Example");
    }

    #[test]
    fn winget_parser_ignores_unstructured_output() {
        assert!(parse_winget_list("no package sources configured").is_empty());
        assert!(parse_winget_list("").is_empty());
    }
}
