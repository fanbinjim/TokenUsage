# TokenUsage：Windows 移植与 Linux 预留方案

## 1. 总体方案

- 在 `TokenUsage/` 中新建独立项目，不修改 `ref/codexU`；产品名统一为 `TokenUsage`，应用标识使用 `com.tokenusage.desktop`。
- 采用 Tauri 2 + React + TypeScript + Vite；Rust 承担本地数据、SQLite、JSONL、缓存、Codex app-server、托盘和更新检查。
- 首发支持 Windows 10/11 x64，提供 NSIS 每用户安装包和便携 ZIP；后续首个 Linux 目标为 Ubuntu x64。
- 采用“分阶段全量移植”：先发布 Codex 核心可用版，再补齐高级分析、Claude Code 和公开发行能力。
- 这是重写式移植，不尝试跨平台编译 Swift：原项目的领域模型、聚合算法和数据口径可复用；SwiftUI/AppKit、`NSStatusItem`、Carbon 热键、DMG 构建及硬编码 macOS 路径全部替换。
- 继续坚持本地优先：不上传会话、路径、Token、任务或账号数据；唯一默认联网行为是请求 GitHub Release 元数据。

## 2. 架构与接口

### Rust 核心

- 建立与 Tauri 解耦的 `tokenusage-core` crate，包含：
  - `domain`：Runtime、额度窗口、Token 拆分、趋势、项目、工具、Skill、任务、诊断等模型。
  - `providers`：`CodexProvider`、`ClaudeCodeProvider`，通过统一 `RuntimeProvider` trait 输出快照。
  - `services`：聚合、缓存、定价估算、更新检查、路径解析和调度。
  - `platform`：Windows/Linux 的可执行文件发现、应用目录和桌面行为适配。
- 增加开发专用 `tokenusage-probe` CLI，以脱敏 JSON 输出核心读取结果，便于无需启动 UI 的回归测试。
- Rust 与前端的序列化统一使用 camelCase、RFC 3339 UTC 时间、`schemaVersion`；缺失数据必须返回 `null`，不能伪造成 0。

### Codex 数据链

- 按[官方协议](https://developers.openai.com/codex/app-server)启动 `codex app-server`，使用 stdio JSONL，依次发送 `initialize`、`initialized`、`account/read`、`account/rateLimits/read` 和 `account/usage/read`；总超时 12 秒，按请求 ID 聚合部分成功结果并终止子进程。
- 可执行文件优先级固定为：
  1. 设置页手动指定；
  2. `TOKENUSAGE_CODEX_BIN`；
  3. PATH/App Execution Alias；
  4. 常见用户级 CLI 目录。
- `.exe` 直接启动，`.cmd/.bat` 只允许通过固定参数的 `cmd.exe` 适配器启动；不执行任意用户命令，不复制或提权运行 `WindowsApps` 内部资源。
- 每个候选先执行轻量可执行性探测。Microsoft Store 内部路径若返回拒绝访问，展示明确诊断并引导安装独立 Codex CLI 或手动选择路径。
- app-server 不可用时进入 SQLite-only 模式；绝不读取 `auth.json`，也不把账号邮箱内容传给前端。
- 使用 `rusqlite` 的 bundled SQLite 只读连接读取：
  - `%USERPROFILE%\.codex\state_5.sqlite`
  - `%USERPROFILE%\.codex\sqlite\state_5.sqlite`
- 不再依赖系统 `sqlite3` 或 `grep`。根据 `PRAGMA table_info` 检测 schema，缺少可选字段时只降级对应功能；数据库繁忙时短暂退避重试。
- 流式读取 rollout JSONL，只解析 `token_count`、工具名称和 Skill 归属：
  - 对累计 Token 快照计算相邻增量；
  - 出现负增量时视作新累计周期；
  - cached input 是 input 子集，不能重复计价；
  - 超大或损坏行跳过并生成脱敏诊断，不能加载整个日志文件。
- 保留原有精确/近似数据标记：详细日志按事件时间聚合；缺失时使用 `threads.updated_at` 近似，UI 明确显示来源质量。

### Claude Code 与缓存

- 第二阶段移植 `~/.claude/projects/**/*.jsonl`、`stats-cache.json`、`.claude.json`、`tasks/**/*.json` 的读取和聚合。
- Claude 额度继续采用可选 statusLine 快照：
  - Windows：`%LOCALAPPDATA%\TokenUsage\cache\claude-code\statusline-snapshot.json`
  - Linux：`$XDG_CACHE_HOME/tokenusage/claude-code/statusline-snapshot.json`
  - 沿用 `schemaVersion`、`capturedAt`、5h/7d usedPercentage 和 resetsAt；超过 15 分钟显示 stale。
- 缓存按文件路径、大小、修改时间及数据库/WAL 指纹失效，使用临时文件加原子替换写入；缓存只保存统计结果，不保存 prompt、回复、工具参数或输出。
- 定价表改为带版本与来源日期的内置资源；首版迁移参考项目已有条目，未知模型仍统计 Token，但不计入金额估算。

### Tauri IPC 与桌面外壳

- 对前端只开放以下类型化命令：
  - `bootstrap()`：设置、现有快照、诊断和版本。
  - `refreshUsage(force)`：刷新所有 Runtime。
  - `refreshTaskBoard(runtime)`：刷新选中 Runtime 的任务。
  - `saveSettings(patch)`：验证并保存设置。
  - `checkUpdate(manual)`：检查 GitHub Release。
- Rust 后台通过 `tokenusage://snapshot`、`tokenusage://task-board` 和 `tokenusage://diagnostics` 事件推送更新；前端不得直接获得文件系统、Shell、SQLite 或任意 HTTP 权限。
- 设置存入 `%APPDATA%\TokenUsage\settings.json`，包含语言、主题、Runtime 可见性、默认 Runtime、额度方向、快捷面板密度、置顶、关闭后驻留、更新频道、Codex 路径和数据目录覆盖；至少保留一个可见 Runtime。
- 完整数据每 5 分钟刷新；任务看板在主窗或快捷浮窗可见时每 10 秒刷新，隐藏时停止高频轮询，打开窗口立即刷新。

## 3. Windows UI 与功能迁移

- React 使用严格 TypeScript、Zustand、i18next；图表采用按需加载的 ECharts Canvas 模块，覆盖额度环、Token 拆分、六个月热力图、7 日趋势和项目排行。
- 不引入通用 UI 组件库；把参考项目的颜色、间距、圆角和层级整理为 CSS 语义变量。Windows 11 可使用 Mica/Acrylic，Windows 10 和 Linux 使用可读的实色回退。
- 主窗口保留 Runtime 切换、额度、今日/7日/总量、估算价值、任务、趋势、项目、工具/Skill 和诊断；中英文、系统/亮/暗主题完整迁移。
- Windows 托盘采用平台适配：
  - 动态双环图标表达 5h/7d 额度；
  - tooltip 展示 Runtime、剩余比例、重置时间和今日 Token；
  - 左键打开无边框快捷浮窗，按托盘位置和当前显示器 DPI 定位，失焦或 Esc 关闭；
  - 右键原生菜单提供打开主窗、刷新、Runtime、设置和退出。
- macOS 的 Minimal/Classic/Rich 长状态栏模式不做像素级复刻：托盘图标固定为双环，相关信息密度设置迁移为快捷浮窗的 Compact/Detailed 模式。
- 使用 Tauri 官方 [tray](https://v2.tauri.app/learn/system-tray/)、positioner、single-instance、window-state 和 [global-shortcut](https://v2.tauri.app/plugin/global-shortcut/) 能力；`Command+U` 在 Windows 映射为 `Ctrl+U`，热键冲突时应用仍可运行并显示诊断。

## 4. 分阶段实施

1. **基础与协议验证**
   - 安装 Rust/MSVC 构建环境，建立 Tauri/React/Rust workspace、锁文件、CI 和脱敏 fixtures。
   - 完成领域模型、路径抽象、probe CLI 和模拟 app-server。
   - 在当前 Windows 环境验证“独立 CLI / 手动路径 / Store 路径拒绝访问 / SQLite-only”四种状态。

2. **Windows Alpha：Codex 核心版**
   - 完成 app-server 配额、本地 SQLite 总量、JSONL Token 拆分、主窗口核心卡片、托盘快捷浮窗、诊断和设置。
   - 支持后台运行、单实例、`Ctrl+U`、手动刷新和脱敏 JSON probe。

3. **Windows Beta：Codex 全功能与 Claude**
   - 补齐任务/自动化、趋势、热力图、项目、工具、Skill、缓存和价值估算。
   - 接入 Claude transcript、任务、Skill、stats fallback、statusLine 快照和多 Runtime 聚合。

4. **Windows 公共发布**
   - 生成 `TokenUsage-<version>-windows-x64-setup.exe` 与 portable ZIP，NSIS 使用 per-user 模式和 WebView2 bootstrapper，具体遵循 [Tauri Windows 安装器文档](https://v2.tauri.app/distribute/windows-installer/)。
   - 自动检查更新默认每天一次、Stable 频道默认开启，Beta 需用户选择；只提示并打开下载页，不静默安装。
   - 更新仓库由 CI 的 `TOKENUSAGE_UPDATE_REPOSITORY` 注入，禁止继续读取参考项目的 Release。
   - 生成 SHA-256；正式 Stable 发布以 Authenticode 签名为门槛，未配置证书时只发布 prerelease。
   - 保留 MIT 许可和上游归属说明，并明确 TokenUsage 为非 OpenAI/Anthropic 官方产品。

5. **后续 Linux**
   - 从第一阶段开始在 Ubuntu CI 运行 core/parser 测试，避免业务层引入 Win32 API。
   - Linux 阶段只新增 XDG 路径、PATH 探测、托盘/热键适配及 `.deb`、AppImage 打包；React UI、Rust 数据层和 IPC 不重写。
   - 首个验收环境为 Ubuntu x64；安装 WebKitGTK、AppIndicator 等 [Tauri 官方依赖](https://v2.tauri.app/start/prerequisites/)。Wayland 下全局热键若桌面环境限制，则降级为托盘/应用内快捷键。

## 5. 测试与验收

- Rust 单元测试覆盖：版本/路径、Token delta、时间桶、费用、聚合、TOML、SQLite schema 兼容、缓存失效和诊断脱敏。
- 集成测试使用合成 SQLite、Codex/Claude JSONL 和假 app-server，覆盖成功、部分响应、超时、拒绝访问、数据库锁、损坏/超大行、快照缺失/过期和未知模型。
- 前端使用 Vitest + React Testing Library，验证 `null` 显示为 `--`、Runtime 至少保留一个、语言/主题、任务分类、图表空状态和设置持久化。
- Windows 验收覆盖：
  - 非 ASCII、空格和长路径；
  - 100%/150%/200% DPI 与多显示器浮窗定位；
  - 托盘、Explorer 重启、关闭后驻留、单实例和热键冲突；
  - 独立 CLI 可用时显示官方额度，不可用时本地统计继续工作；
  - NSIS 安装/升级/卸载及 portable 启动；
  - WebView2 已安装和缺失两类干净虚拟机。
- 性能验收要求流式解析、不整文件载入；未变化日志不得重复解析；窗口隐藏后无高频任务查询。
- 隐私验收扫描日志、缓存、诊断和更新请求，确保不包含 prompt、回复、工具参数、工具输出、认证 Token、邮箱或未脱敏的用户主目录。

## 默认假设

- 首版只支持原生 Windows Codex 数据，不自动读取 WSL 内部数据库；可通过设置页覆盖数据目录。
- Codex 官方配额以可执行的独立 CLI 为前置条件；Store 包内部资源不是受支持的依赖入口。
- Windows 首发仅 x64，ARM64 后置；Linux 首发仅 Ubuntu x64。
- macOS 参考项目继续独立维护，本次不把新 Tauri 项目反向替换为 macOS 发行版。
- 缺失数据保持未知状态；估算金额始终标注“估算”，Stable 更新频道默认不接收 prerelease。
