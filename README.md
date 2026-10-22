# dsh-workspace-toolkit

DeepSeek Harness (DSH) 侧边栏 / 工作区实用工具插件。

## 这个插件做什么

**1. 侧边栏底部按钮竖排修复**

多个插件都会往侧边栏底部（Settings 按钮旁边）加自己的动作按钮，装的插件一多，这些按钮会挤在同一行里被压扁、看不清图标。这个功能把该区域的排列方式从横排改成竖排，每个按钮独立一行，不再挤压变形。纯视觉修复，不改变任何按钮的功能。

**2. 归档会话面板**

侧边栏底部新增一个「归档会话」按钮，点开是一个滑出面板，列出你归档过的所有会话（标题 + 所在目录 + 归档/创建时间）。DSH 原生 UI 里归档会话不会在任何地方展示出来，这个面板补上了「看到它们、管理它们」的入口。

面板内每条会话可以做四件事：

- **取消归档** —— 一键把会话从归档状态里摘出来，它会自动回到原来所属的工作区（如果原来没有工作区，就回到未分组列表）。
- **在文件夹中显示** —— 直接拉起系统文件管理器并定位到该会话的存档文件，并在面板内回显该路径（Windows 会高亮选中该文件，macOS 同理，Linux 因为没有统一的「选中文件」命令，会打开所在的父目录）。
- **注册为工作区** —— 把该会话自己的工作目录注册成一个工作区（已存在则复用），随后取消归档；会话之后归入这个工作区，不再散落在「未分组」。这是 DSH 模型下让会话获得工作区归属的唯一正确做法（分组按会话 header 的 cwd 决定）。
- **永久删除** —— 只对已归档的会话开放。先弹出二次确认（无需输入确认串），服务端再次校验归档状态与磁盘路径后，才会删除该会话自己的存档目录、清理工作区登记，并通知前端把该会话从列表移除。此操作不可恢复。

## 功能与实现对照

| # | 功能 | Host | Client |
|---|------|------|--------|
| 1 | 侧边栏底部动作按钮竖排修复 | 占位 effect（结构对称，无实际逻辑） | 注入 CSS：`[class*="footerActions"] { flex-direction: column }` |
| 2 | 归档会话面板 | `GET /workspace-toolkit/archive/list` | `sidebar.footer.action` 触发按钮 + 面板 UI |
| 3 | 取消归档 | `POST /workspace-toolkit/archive/unarchive` | 面板内「取消归档」按钮 |
| 4 | 在文件夹中显示 | `POST /workspace-toolkit/archive/reveal`（磁盘扫描定位 + `explorer.exe /select,`） | 面板内「在文件夹中显示」按钮 + 路径回显 |
| 5 | 注册为工作区 | `POST /workspace-toolkit/archive/register-workspace` | 面板内「注册为工作区」按钮 |
| 6 | 安全永久删除 | `POST /workspace-toolkit/archive/delete` | 二次确认 + 「永久删除」按钮 |

功能 3–6 只作用于**归档面板内的会话**，不影响侧边栏其它任何位置——见下方设计取舍。

## 设计取舍（读代码/升级前请先看这里）

### 为什么不是完整替换 `sidebar.workspaces`

`sidebar.workspaces` 是 `kind:"single"` 槎，被 `@deepseek-ai/dsh-client-ui-workspace`（约 2500 行）完全占用，且该组件没有任何内部扩展点（拖拽状态机、分组派生、目录流、重命名/删除对话框全部硬编码）。完整替换意味着重新实现整个组件。本插件改为在 `shell.overlay` 加一个独立的归档面板，功能上是原生 UI 的补充，不是替代。

### 为什么用「注册为工作区」代替「移动到工作区」

DSH 的工作区分组是**按会话的 cwd 自动判定**的，不是自由拖拽的树状结构：

```js
// @deepseek-ai/dsh-workspace Workspace.attachSession()
if (cwd !== this.record.path) throw new Error(...)  // cwd 不匹配直接拒绝

// Workspace.sessionIds getter
get sessionIds() {
  return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path)
}
```

会话的 cwd 在其创建时写入不可变的 SessionHeader，之后无法修改；`attachSession` 又强制要求 cwd 与工作区路径一致。因此一个会话**永远只能归入它自身 cwd 对应的工作区**——DSH 里不存在"把一个会话归入与它 cwd 无关的工作区"这个能力（官方 UI 同样没有）。

所以本插件**不再提供「移动到工作区」**（它只会列出一个"原工作区"，等价于取消归档，属于废功能），改为：

- **取消归档** = 回到原来的工作区（若原来没有工作区，就回「未分组」）
- **注册为工作区** = 把该会话自己的目录注册成工作区（已存在则复用），会话从此获得工作区归属、不再落在「未分组」

### 为什么"取消归档"优先用官方 API

新版 DSH（2026-10+）的 `ctx.workspaceRegistry` 已公开 `unarchiveSession(sessionId)`，本插件优先调用它。

旧版 DSH 没有该方法，此时回退到内部实现：直接调用服务实例上未公开的 `requireState()` / `setState()` / `enqueueOperation()`，复刻 `archiveSession()` 自己的读-改-写模式（同一队列、同一 storage domain）。

**风险**：旧版回退路径依赖未公开方法名，`@deepseek-ai/dsh-workspace` 升级可能变更；届时会直接抛错（有存在性检查与明确报错文案），不会静默写坏数据。取消归档语义上只是把 sessionId 从归档集合里摘掉——官方注释确认"archiving 从不触碰工作区记账，取消归档会恢复原位"。

### 为什么"在文件夹中显示"走磁盘扫描

新版 DSH 移除了 `sessionPersistence.locate()`，因此改为直接扫描 `<DSH_HOME>/sessions/<cwd>/<sessionId>/` 定位存档文件（支持 `session.jsonl` / `session.jsonl.zstd` / `session.v*.jsonl.zstd` 等版本化命名），再调用平台命令打开。面板会回显定位到的完整路径。

### 永久删除的安全边界

DSH 目前没有公开的会话删除 API，所以本插件只支持默认的文件型持久化存储，并在 Host 侧执行全部关键校验：

- sessionId 必须仍在 `archivedSessionIds` 中；普通/未归档会话不能通过该路由删除。
- `ctx.agents.get(sessionId)` 必须为空，避免运行中的 Agent 在退出时重新写回存档。
- `sessionPersistence.locate()` 的结果必须严格匹配 `<DSH_HOME>/sessions/<encoded-cwd>/<sessionId>/session.jsonl[.zstd]`。
- 目录名必须等于 sessionId；目录和存档文件不能是符号链接或 junction；realpath 必须仍位于 `sessions` 根目录内。
- 删除后会从所有工作区登记和归档集合中移除，并尽力清理投影缓存；搜索索引会由 DSH 自身的持久化对账移除。

删除的是 DSH 的本地会话存档，不会自动删除 Mnemon 已经提取并保存的记忆；如需删除相关记忆，应在 Mnemon 中单独处理。

## 安装

```
dsh plugin --profile <你的 profile 名> add dsh-workspace-toolkit@github:ziluolan623-lgtm/dsh-workspace-toolkit#v0.1.0
```

（DSH Desktop 用户可省略 `--profile <名>`，自动使用 desktop profile。）

或手动编辑 profile 的 `package.json`：

```jsonc
{
  "dependencies": {
    "dsh-workspace-toolkit": "github:ziluolan623-lgtm/dsh-workspace-toolkit#v0.1.0"
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

- 取消归档与删除后的归档登记清理依赖未公开内部 API（见上）。
- "在文件夹中显示"在 Linux 上不会高亮具体文件，只打开父目录（无统一 CLI 高亮语义）。
- 依赖 `sessionQuery` 服务读取会话标题；缺失时标题列可能为空，不影响核心功能。
- 永久删除只支持 `sessionPersistence.locate()` 能定位到标准 `session.jsonl` / `session.jsonl.zstd` 的文件型存储后端；其它后端会安全拒绝。
