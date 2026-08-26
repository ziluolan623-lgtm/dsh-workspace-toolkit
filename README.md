# dsh-workspace-toolkit

DeepSeek Harness (DSH) 侧边栏 / 工作区实用工具插件。

## 这个插件做什么

**1. 侧边栏底部按钮竖排修复**

多个插件都会往侧边栏底部（Settings 按钮旁边）加自己的动作按钮，装的插件一多，这些按钮会挤在同一行里被压扁、看不清图标。这个功能把该区域的排列方式从横排改成竖排，每个按钮独立一行，不再挤压变形。纯视觉修复，不改变任何按钮的功能。

**2. 归档会话面板**

侧边栏底部新增一个「归档会话」按钮，点开是一个滑出面板，列出你归档过的所有会话（标题 + 所在目录 + 归档/创建时间）。DSH 原生 UI 里归档会话不会在任何地方展示出来，这个面板补上了「看到它们、管理它们」的入口。

面板内每条会话可以做三件事：

- **取消归档** —— 一键把会话从归档状态里摘出来，它会自动回到原来所属的工作区（如果原来没有工作区，就回到未分组列表）。
- **在文件夹中显示** —— 直接拉起系统文件管理器并定位到该会话的存档文件（Windows 会高亮选中该文件，macOS 同理，Linux 因为没有统一的「选中文件」命令，会打开所在的父目录）。
- **移动到工作区…** —— 取消归档的同时直接归入某个工作区，省去「先取消归档、再手动拖进去」两步。

**一个使用上要知道的限制**：「移动到工作区」这个下拉菜单只会列出该会话所在目录（cwd）确实对应的工作区——DSH 的工作区分组是按目录自动判定的，不支持把会话硬塞进任意一个不相关的工作区，所以下拉里经常只有 0 个或 1 个选项，这是 DSH 底层机制决定的，不是这个插件功能不全（详见下方设计取舍）。

## 功能与实现对照

| # | 功能 | Host | Client |
|---|------|------|--------|
| 1 | 侧边栏底部动作按钮竖排修复 | 占位 effect（结构对称，无实际逻辑） | 注入 CSS：`[class*="footerActions"] { flex-direction: column }` |
| 2 | 归档会话面板 | `GET /workspace-toolkit/archive/list` | `sidebar.footer.action` 触发按钮 + 面板 UI |
| 3 | 取消归档 | `POST /workspace-toolkit/archive/unarchive` | 面板内「取消归档」按钮 |
| 4 | 在文件夹中显示 | `POST /workspace-toolkit/archive/reveal`（拉起 `explorer.exe /select,` / `open -R`） | 面板内「在文件夹中显示」按钮 |
| 5 | 移动到工作区 | `POST /workspace-toolkit/archive/eligible-moves` + `.../move-to` | 面板内「移动到工作区…」下拉 |

功能 3–5 只作用于**归档面板内的会话**，不影响侧边栏其它任何位置——见下方设计取舍。

## 设计取舍（读代码/升级前请先看这里）

### 为什么不是完整替换 `sidebar.workspaces`

`sidebar.workspaces` 是 `kind:"single"` 槎，被 `@deepseek-ai/dsh-client-ui-workspace`（约 2500 行）完全占用，且该组件没有任何内部扩展点（拖拽状态机、分组派生、目录流、重命名/删除对话框全部硬编码）。完整替换意味着重新实现整个组件。本插件改为在 `shell.overlay` 加一个独立的归档面板，功能上是原生 UI 的补充，不是替代。

### 为什么"移动到工作区"只列出 cwd 匹配的工作区

DSH 的工作区分组是**按会话的 cwd 自动判定**的，不是自由拖拽的树状结构：

```js
// @deepseek-ai/dsh-workspace Workspace.attachSession()
if (cwd !== this.record.path) throw new Error(...)  // cwd 不匹配直接拒绝

// Workspace.sessionIds getter
get sessionIds() {
  return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path)
}
```

一个会话永远只能归入它自身 cwd 对应的工作区。所以"移动到工作区…"下拉只会列出与该会话 cwd 一致的工作区（通常 0 或 1 个），不会出现"随意拖进任意文件夹"的效果——这是 DSH 底层模型的限制，不是本插件偷懒。

### 为什么"取消归档"调用未公开内部方法

`ctx.workspaceRegistry` 只公开了 `archiveSession()`，没有公开对应的取消归档方法。`archivedSessionIds` 是只读 getter。本插件里 `lib/archive-store.js` 的 `unarchiveSession()` 直接调用该服务实例上未在公共 API 里登记的 `requireState()` / `setState()` / `enqueueOperation()`，复刻 `archiveSession()` 自己的读-改-写模式。

**风险**：`@deepseek-ai/dsh-workspace` 包升级时，这三个方法名/签名可能变化而不通知，届时取消归档会直接抛错（`archive-store.js` 顶部有存在性检查，报错会指向这份说明，不会静默写坏数据）。取消归档语义上只是把 sessionId 从 `archivedSessionIds` 数组里摘掉——源码注释确认"archiving 从不触碰工作区记账，取消归档会恢复原位"，所以这里没有更多状态要处理。

### 为什么"在文件夹中显示"只在归档面板生效

出于同样的"收缩范围"考虑：`sessionPersistence.locate()` 只解析磁盘位置，`ctx.subprocess.spawn()` 拉起系统命令（Windows `explorer.exe /select,`，macOS `open -R`，Linux 退化为打开父目录）都是通用能力，但为了保持功能边界清晰、避免在原生会话列表里叠加菜单项，这个动作只出现在本插件自己的归档面板里。

## 安装

```
dsh plugin --profile <你的 profile 名> add dsh-workspace-toolkit@github:ziluolan623-lgtm/dsh-workspace-toolkit
```

或手动编辑 profile 的 `package.json`：

```jsonc
{
  "dependencies": {
    "dsh-workspace-toolkit": "github:ziluolan623-lgtm/dsh-workspace-toolkit"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-workspace-toolkit"]
    }
  }
}
```

重启 DSH 使 bundle 生效。

## 已知限制

- 取消归档依赖未公开内部 API（见上）。
- "在文件夹中显示"在 Linux 上不会高亮具体文件，只打开父目录（无统一 CLI 高亮语义）。
- 依赖 `sessionQuery` 服务读取会话标题；缺失时标题列可能为空，不影响核心功能。
