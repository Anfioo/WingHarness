//! CC Switch：AI 编程 CLI 的供应商切换功能。
//!
//! Adapted from cc-switch (MIT), https://github.com/farion1231/cc-switch.
//! Copyright (c) 2025 Jason Young. See `THIRD_PARTY_NOTICES.md`.
//!
//! 模块划分：
//! - [`app_type`]：支持的应用枚举与静态元数据
//! - [`provider`]：供应商数据结构
//! - [`settings`]：应用级设置（可见性、目录覆盖、onboarding 开关）
//! - [`paths`]：各应用配置路径与本模块数据位置
//! - [`db`]：SQLite 连接、建表与旧 JSON 迁移
//! - [`store`]：供应商数据持久化（SQLite DAO，挂在 [`db::Database`] 上）
//! - [`version`]：本地 CLI 版本检测
//! - [`patch`]：JSON / TOML / YAML / ENV 配置文件保序改写
//! - [`project`]：各应用的供应商投影器
//! - [`switch`]：切换引擎
//! - [`seed`]：启动播种与「导入本机配置」
//! - [`onboarding`]：onboarding / 插件集成等特殊操作

pub mod app_type;
pub mod codex_switches;
pub mod db;
pub mod editor;
pub mod import;
pub mod models;
pub mod onboarding;
pub mod patch;
pub mod paths;
pub mod project;
pub mod provider;
pub mod seed;
pub mod settings;
pub mod store;
pub mod switch;
pub mod version;
