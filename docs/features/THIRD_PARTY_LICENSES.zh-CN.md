# 第三方许可

**关于**窗口里有一个**第三方许可**按钮。点击后会打开一个对话框，列出移植进
WingHarness 的上游项目，并展示完整的第三方声明，无需离开应用或联网即可阅读许可
信息。

## 对话框展示什么

- **来源项目** —— 每个上游一行：名称、许可证徽标、承载移植代码的模块，以及一个
  在系统浏览器中打开上游仓库的按钮。
- **完整声明** —— 当前语言对应的完整 `THIRD_PARTY_NOTICES` 文件，放在可滚动区域中。
- 顶部同时标明本项目自身的许可证：GPL-3.0-only。

## 内容来源

| 部分 | 来源 |
|------|------|
| 上游列表 | [`src/windows/about/index.tsx`](../../src/windows/about/index.tsx) 中的 `UPSTREAMS` |
| 声明文本 | [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 与 [`THIRD_PARTY_NOTICES.zh-CN.md`](../../THIRD_PARTY_NOTICES.zh-CN.md)，通过 Vite 的 `?raw` 导入 |
| 许可证文本 | [`licenses/`](../../licenses/) |

声明在构建时被打进前端，因此对话框离线可用，不需要 Tauri 命令，也不需要额外的
bundle 资源。两种语言都会打包，对话框按当前界面语言选择。

## 保持同步

移植新上游或上游许可证发生变化时：

1. 更新 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 及其
   `.zh-CN.md` 译本，并把许可证文本加入 `licenses/`。
2. 更新移植记录
   [`docs/UPSTREAM_PROJECTS.md`](../../docs/UPSTREAM_PROJECTS.md)。
3. 在 `UPSTREAMS` 中新增或修改对应行，对话框才会列出它。

## 文案

所有文案位于 [`src/i18n/locales/en.json`](../../src/i18n/locales/en.json) 与
[`src/i18n/locales/zh.json`](../../src/i18n/locales/zh.json) 的 `about.thirdParty`
和 `about.licenses*` 下。上游名称、许可证标识与模块路径不翻译。

## 限制

- 完整声明以纯文本展示，不做 Markdown 排版；供阅读的是上面的结构化来源列表。
- 对话框只做展示，不读取磁盘文件，因此显示的是构建时的声明内容。
