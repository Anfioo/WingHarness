# 全局快捷键开发指南

本指南介绍如何在 Tauri v2 应用中使用 `tauri-plugin-global-shortcut` 插件实现全局快捷键功能。

## 概述

全局快捷键允许应用在未获得焦点时也能响应键盘组合键。本模板提供了完整的实现方案：

- 键盘事件捕获与转换
- 快捷键注册/注销
- 快捷键输入 UI 组件
- 权限配置

## 配置步骤

### 1. 安装插件

在 `src-tauri/Cargo.toml` 中添加：

```toml
[dependencies]
tauri-plugin-global-shortcut = "2"
```

### 2. 初始化插件

在 `src-tauri/src/lib.rs` 中：

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::init())
        // ... 其他插件
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 3. 配置权限

在 `src-tauri/capabilities/default.json` 中添加：

```json
{
  "permissions": [
    "global-shortcut:default",
    "global-shortcut:allow-is-registered",
    "global-shortcut:allow-register",
    "global-shortcut:allow-register-all",
    "global-shortcut:allow-unregister",
    "global-shortcut:allow-unregister-all"
  ]
}
```

### 4. 安装前端依赖

```bash
pnpm add @tauri-apps/plugin-global-shortcut
```

## 实现方式

### 工具函数 (`src/lib/shortcut.ts`)

#### 快捷键字符串 (`src/lib/shortcut-spec.ts`)

设置里存的是一个字符串，只有两种形式：

- 组合键 —— `Ctrl+Shift+A`、`Super+A`（Win 键）—— 插件能注册的格式；
- 预设 —— `preset:space`、`preset:doubleCtrl`、`preset:winSpace` —— 系统注册 API
  表达不了的触发方式。预设也可以只是一个
  普通组合键：`ctrlW` 存成 `Ctrl+W`，它只是选择器里的一键入口，没有自己的
  存储形式。

```typescript
import {
  DoublePressTracker,
  formatCombo,
  keyFromEvent,
  parseCombo,
  shortcutMatchesEvent,
} from "@/lib/shortcut-spec";

parseCombo("Ctrl+Shift+A"); // { modifiers: ["Ctrl", "Shift"], key: "A" }
formatCombo(["Super"], "A"); // "Super+A"
keyFromEvent(keyboardEvent); // "A"、"Space"、"F5"……
```

- `keyFromEvent` 读的是 `event.code` 而不是 `event.key`：按住 Shift 时 `key`
  是被 Shift 改写的字符，永远对不上选择器写下的值。
- `shortcutMatchesEvent(spec, event, tracker)` 回答“这次按键是否触发该快捷键”。
  `DoublePressTracker` 必须由调用方在多次 keydown 之间保留 —— 双击 Ctrl 只能从
  两个事件里认出来。
- `isEditableTarget(event.target)` 是应用内监听器需要的守卫：输入框里的按键是
  打字，不是快捷键。

**支持的修饰键：** `Ctrl`、`Shift`、`Alt`、`Super`（Win 键）。

**支持的按键：** 字母、数字、`F1`–`F12`、`Space`、`Enter`、`Tab`、`Esc`、
退格/删除/插入、方向键、Home/End/PageUp/PageDown，以及常见符号键 —— 都是插件
解析器认识的写法。

#### 注册快捷键

```typescript
import { registerShortcut } from "@/lib/shortcut";

await registerShortcut("Ctrl+Shift+A", () => {
  console.log("快捷键触发！");
});

// 替换已有快捷键
await registerShortcut("Ctrl+Shift+B", callback, "Ctrl+Shift+A");
```

#### 注销快捷键

```typescript
import { unregisterShortcut, unregisterAllShortcut } from "@/lib/shortcut";

// 注销指定快捷键
await unregisterShortcut("Ctrl+Shift+A");

// 注销所有快捷键
await unregisterAllShortcut();
```

### UI 组件 (`src/components/shortcut-field.tsx`)

所有快捷键设置共用一个控件：

```typescript
import { ShortcutField } from "@/components/shortcut-field";

function Settings() {
  const [shortcut, setShortcut] = useState("Ctrl+Shift+A");

  return (
    <ShortcutField
      value={shortcut}
      onChange={setShortcut}
      presets={["space", "doubleCtrl", "winSpace"]}
    />
  );
}
```

**功能特性：**

- 当前触发方式显示成按键帽，点击打开选择器
- 传入 `presets` 时，预设显示在自定义区域上方
- Shift/Ctrl/Alt/Win 可点选，最多同时两个
- 按键既可以从列表选择，也可以直接按下（“按下按键”）
- `onChange("")` 清除设置
- 占位文字、预设、命名按键和选择器文案都走 i18n

组件不负责持久化：它只交回字符串，存到哪里由调用方决定。系统注册的设置也可以
传 `presets`，只要每个预设存的都是组合键 —— 例如 `ctrlW` 存成 `Ctrl+W`。如果
预设是应用内触发（单个空格、双击 Ctrl），就不要传，它们无法通过插件注册。

## 应用内触发

不是组合键的预设只能在应用内部处理，否则它监听的按键（空格、单独的 Ctrl）会被
系统级地吞掉：

```typescript
import { DoublePressTracker, isEditableTarget, shortcutMatchesEvent } from "@/lib/shortcut-spec";

const doubleCtrl = new DoublePressTracker();

function onKeyDown(event: KeyboardEvent) {
  if (isEditableTarget(event.target)) return;
  if (shortcutMatchesEvent(shortcut, event, doubleCtrl)) {
    event.preventDefault();
    openQuickPreview();
  }
}

useEffect(() => {
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [shortcut]);
```

监听器住在 webview 里，所以这类触发只在应用窗口获得焦点时生效 —— 这也正是它
可以安全地使用空格的原因。设置项的“?”提示应当写明这一点。

## 完整示例

```typescript
import { useEffect, useState } from "react";
import { ShortcutField } from "@/components/shortcut-field";
import { registerShortcut, unregisterShortcut } from "@/lib/shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";

function Settings() {
  const [shortcut, setShortcut] = useState("Ctrl+Shift+A");

  useEffect(() => {
    // 注册快捷键以显示窗口
    const setupShortcut = async () => {
      await registerShortcut(shortcut, async () => {
        const window = getCurrentWindow();
        await window.show();
        await window.setFocus();
      });
    };

    setupShortcut();

    // 组件卸载时清理
    return () => {
      unregisterShortcut(shortcut);
    };
  }, [shortcut]);

  return (
    <div>
      <label>全局快捷键：</label>
      <ShortcutField value={shortcut} onChange={setShortcut} />
    </div>
  );
}
```

## 最佳实践

1. **始终注销**：组件卸载或快捷键变更时清理注册
2. **验证输入**：交给全局注册的组合键至少包含一个修饰键（预设是应用内的事，
   不走注册）
3. **避免冲突**：注册前检查快捷键是否已被占用
4. **用户反馈**：设置/更改快捷键时显示提示消息
5. **持久化**：按项目约定存进配置文件；只有历史遗留的显示主窗口快捷键仍在
   `localStorage`

## 故障排查

### 快捷键无效

- 检查快捷键是否已被系统或其他应用占用
- 验证 `capabilities/default.json` 中的权限配置
- 确保插件已在 `src-tauri/src/lib.rs` 中初始化

### 快捷键冲突

```typescript
import { isRegistered } from "@tauri-apps/plugin-global-shortcut";

const registered = await isRegistered("Ctrl+Shift+A");
if (registered) {
  console.warn("快捷键已被注册");
}
```

## API 参考

### `parseCombo(spec: string): ComboSpec | null`

把组合键拆成修饰键和按键；不是组合键时返回 null。`formatCombo` 是逆操作，
按固定顺序拼回字符串。

### `shortcutMatchesEvent(spec, event, tracker): boolean`

这次按键是否触发该快捷键 —— 预设和组合键都走这里。`DoublePressTracker` 由
调用方持有，在多次 keydown 之间保留，用来识别双击 Ctrl。

### `registerShortcut(shortcut: string, callback: () => void, oldShortcut?: string): Promise<void>`

注册全局快捷键及回调函数。

**参数：**

- `shortcut`：要注册的快捷键字符串
- `callback`：快捷键按下时执行的函数
- `oldShortcut`：可选的旧快捷键，用于注销

### `unregisterShortcut(shortcut?: string): Promise<void>`

注销指定快捷键。

### `unregisterAllShortcut(): Promise<void>`

注销应用注册的所有快捷键。

## 相关文档

- [Tauri 全局快捷键插件](https://v2.tauri.app/plugin/global-shortcut/)
- [键盘事件参考](https://developer.mozilla.org/zh-CN/docs/Web/API/KeyboardEvent)
