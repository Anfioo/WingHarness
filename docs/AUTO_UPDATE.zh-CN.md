# 自动更新配置

本文说明本项目使用的发布与自动更新流程。

## 概览

本项目使用 GitHub Releases 作为更新后端。在发布工作流中，GitHub Actions 会替换 `src-tauri/tauri.conf.json` 里的更新占位符，使应用指向：

```text
https://github.com/<owner>/<repo>/releases/latest/download/latest.json
https://gitee.com/anfioo/WingHarness/releases/download/latest/latest.json
```

两个端点按顺序尝试。第二个是 Gitee 镜像，供无法访问 GitHub 的用户使用；`gitee-sync` 工作流会在每次发布后重新生成它的 `latest.json`。

## 前置条件

1. 生成用于安全更新的签名密钥对
2. 在 GitHub Actions 中配置签名相关 Secrets
3. 从默认分支发版（`origin/HEAD` 指向的分支，通常是 `main`）
4. 使用 `vX.Y.Z` 格式的标签发布版本

## 步骤 1：生成签名密钥

运行以下命令生成密钥对：

```bash
pnpm tauri signer generate -w ~/.tauri/myapp.key
```

该命令会输出：
- **私钥**：保存到 `~/.tauri/myapp.key`
- **公钥**：一个以 `dW50cnVzdGVkIGNvbW1lbnQ6...` 开头的字符串

请妥善保管私钥。

## 步骤 2：配置 GitHub Secrets

在 GitHub 仓库的 Settings → Secrets and variables → Actions 中添加以下 Secrets：

1. `TAURI_SIGNING_PRIVATE_KEY` - `~/.tauri/myapp.key` 的内容
2. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - 你设置的密码（如果有）
3. `TAURI_SIGNING_PUBLIC_KEY` - 第 1 步生成的公钥

## 步骤 3：保持版本文件一致

发布脚本要求以下文件中的版本号保持一致：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

不要只手动修改其中一个文件，统一使用发布脚本作为版本发布入口。

## 步骤 4：创建发布

运行：

```bash
pnpm release:version
```

脚本在真正修改文件前会执行发布前检查：
- 确保工作区干净
- 校验版本文件一致（`package.json`、`tauri.conf.json`、`Cargo.toml`，存在 `Cargo.lock` 时也一并校验）
- 在发布分支上，检查目标 tag 是否已在本地或远端 `origin` 存在

之后它会：
- 同步更新所有版本文件
- 在发布分支上：创建发布提交、创建 `vX.Y.Z` tag，可选地推送分支和 tag
- 在其他分支上：更新完版本文件就结束，不暂存、不提交、不打 tag、不推送，方便功能分支改版本号而不会触发发布

GitHub Actions 会在收到 `v*` 标签后触发。它会先创建一个**草稿** Release，描述由
上一个 tag 以来的约定式提交生成，随后把构建产物上传到同一个草稿中。

## 步骤 5：检查并发布草稿

Release 会一直保持草稿状态，直到你手动发布。GitHub Actions 完成后：

1. 在 GitHub Releases 中打开草稿，检查自动生成的更新说明。
2. 确认其中包含更新所需资源：
   - `latest.json`
   - Windows updater bundle 产物
   - 签名文件
3. 发布该草稿。

草稿发布前不会出现在 updater endpoint 上，客户端无法发现更新；已发布 Release 中
缺少 `latest.json` 时同样无法发现更新。

## 工作原理

1. 应用会在启动时或手动检查时访问 updater endpoint
2. 如果发现更高版本，会打开独立的更新窗口，显示新版本号、发布时间与更新说明（`latest.json` 的 `notes` 字段）
3. 窗口提供两个选择：立即安装，或跳过这个版本
4. 跳过后的版本启动时不再提示，出现更新的版本会再次提示；在关于窗口手动检查时永远强制弹窗，即使该版本已被跳过
5. 如果没有更新，手动检查会明确显示当前已是最新版本；如果检查失败，界面会显示错误并把底层原因（网络、404、签名等）附在提示里，避免「更新失败」无法排查
6. 下载过程中，进度基于累计下载字节数计算；下载中关闭窗口只是隐藏，下载与安装继续进行
7. 安装完成后，应用会自动重启

## 开发版打包（保留开发者菜单）

默认打包版在右键菜单里不提供「刷新」和「开发者工具」（避免误点丢掉编辑状态，且正式版不带调试器）。需要保留时加上 `-DevBuild`：

```powershell
.\scripts\build.ps1 -DevBuild
```

该开关会设置 `BUILD_DEV=1`（构建时注入前端），并给 `tauri build` 追加 `--features devtools`。如果直接调用 `pnpm tauri build`，需要自行设置 `BUILD_DEV=1` 并加上 `--features devtools`。

## 故障排查

**更新检查失败：**
- 检查最新 Release 资源中是否包含 `latest.json`
- 确认签名密钥配置正确

**检测不到更新：**
- 确认已安装应用的版本低于最新 Release 的版本
- 确认发布标签使用 `vX.Y.Z` 格式

**签名验证失败：**
- 确认 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PUBLIC_KEY` 匹配
- 修正 Secrets 后重新构建并重新发布

## 相关文件

- `.github/workflows/release.yml`
- `scripts/release-version.mjs`
- `src-tauri/tauri.conf.json`
