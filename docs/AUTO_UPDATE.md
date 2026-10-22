# Auto Update Configuration

This guide explains the release and auto-update flow used by this project.

## Overview

This project uses GitHub Releases as the updater backend. During the release workflow, GitHub Actions replaces the updater placeholders in `src-tauri/tauri.conf.json` so the application points to:

```text
https://github.com/<owner>/<repo>/releases/latest/download/latest.json
```

## Prerequisites

1. Generate a signing key pair for secure updates
2. Add the signing secrets to GitHub Actions
3. Release from the `main` branch
4. Publish releases with tags in the `vX.Y.Z` format

## Step 1: Generate Signing Keys

Run the following command to generate a key pair:

```bash
pnpm tauri signer generate -w ~/.tauri/myapp.key
```

This will output:
- **Private key**: Saved to `~/.tauri/myapp.key`
- **Public key**: A string starting with `dW50cnVzdGVkIGNvbW1lbnQ6...`

Keep the private key secret.

## Step 2: Configure GitHub Secrets

Add the following secrets to your GitHub repository under Settings → Secrets and variables → Actions:

1. `TAURI_SIGNING_PRIVATE_KEY` - Content of `~/.tauri/myapp.key`
2. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - Password you set, if any
3. `TAURI_SIGNING_PUBLIC_KEY` - Public key generated in Step 1

## Step 3: Keep Version Files in Sync

The release script expects these files to share the same version:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

Use the release script as the single release entrypoint instead of editing only one file manually.

## Step 4: Create a Release

Run:

```bash
pnpm release:version
```

The script performs release preflight checks before it makes changes:
- Ensures the working tree is clean
- Requires the current branch to be `main`
- Verifies the three version files are consistent
- Checks that the target tag does not already exist locally or on `origin`

Then it:
- Updates all version files together
- Creates a release commit
- Creates a `vX.Y.Z` tag
- Optionally pushes the branch and tag

The GitHub Actions workflow is triggered by `v*` tags.

## Step 5: Verify the Published Assets

After GitHub Actions finishes, verify that the latest published release contains updater assets such as:
- `latest.json`
- Windows updater bundle artifacts
- Signature files

If `latest.json` is missing from the latest published release, updater clients cannot discover updates.

## How It Works

1. The app checks the updater endpoint on startup or during a manual check
2. If a newer version is available, a dedicated update window opens, showing the new version, publish date and release notes (the `notes` field of `latest.json`)
3. The window offers two choices: install now, or skip this version
4. A skipped version no longer prompts on startup; a newer release prompts again. A manual check from the About window always forces the prompt, even for a skipped version
5. If no update is available, the manual flow reports that the app is up to date. If the check fails, the UI reports an error with the underlying cause attached to the toast (network, 404, signing, ...), which keeps "update failed" diagnosable
6. During download, progress is calculated from cumulative downloaded bytes; closing the window while downloading only hides it, the download and install continue
7. After installation, the app relaunches automatically

## Dev Builds (keeping the developer menu)

Packaged builds leave "Reload" and "Developer Tools" out of the right-click menu by default (end users should not lose editing state to a stray click, and release builds ship without the inspector). Pass `-DevBuild` to keep them:

```powershell
.\scripts\build.ps1 -DevBuild
```

The switch sets `BUILD_DEV=1` (injected into the frontend at build time) and appends `--features devtools` to `tauri build`. When invoking `pnpm tauri build` directly, set `BUILD_DEV=1` and add `--features devtools` yourself.

## Troubleshooting

**Update check fails:**
- Check that `latest.json` exists in the latest release assets
- Confirm the signing keys are configured correctly

**No update detected:**
- Confirm the installed app version is lower than the latest release version
- Confirm the release tag uses the `vX.Y.Z` format

**Signature verification fails:**
- Make sure `TAURI_SIGNING_PRIVATE_KEY` matches `TAURI_SIGNING_PUBLIC_KEY`
- Rebuild and republish the release after correcting secrets

## Related Files

- `.github/workflows/release.yml`
- `scripts/release-version.mjs`
- `src-tauri/tauri.conf.json`
