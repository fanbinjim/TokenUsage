# TokenUsage

TokenUsage 是一个本地优先的 Windows 桌面应用，用于查看 Codex 的账号额度与本机 Token 使用情况。它是参考 `ref/codexU` 重写的跨平台项目：Windows 为首发平台，Linux 将复用 Rust 数据层和 React UI。

## 当前进度

- 已实现：Tauri/React/Rust 工程、Windows 构建、Codex app-server 额度读取、本地 SQLite 总量、session JSONL Token 增量解析、诊断、原生托盘菜单和基础仪表盘。
- 待实现：动态双环托盘图标、快捷浮窗、趋势/项目/任务面板、Claude Code provider、缓存、更新检查、安装器与 Linux 打包。

## Windows 任务栏常驻用量条

Windows 10/11 没有向第三方应用开放稳定的任务栏扩展 API。应用参考 TrafficMonitor 的实现，在 WebView2 初始化完成后通过 `SetParent` 将透明 HUD 挂载为 `Shell_TrayWnd` 的子窗口；嵌入失败时才降级为独立贴靠窗口。子窗口不参与桌面顶层窗口的 Z-order 竞争，因此点击任务栏不会闪动或消失。

- 默认显示 5h / 7d 额度和进度，手动刷新及每 5 分钟后台刷新都会同步更新。
- 默认距任务栏右侧 1050 个逻辑像素，对应当前截图中的红框位置；可在“设置 > 任务栏距右侧偏移”中调节。
- 任务栏启用开关也位于设置中。自动隐藏或停靠在左右侧的任务栏不显示该横向用量条。

## 开发环境

- Node.js 20.19+（当前开发机使用 Node 24 LTS）
- Rust 1.85+，使用 `x86_64-pc-windows-msvc`
- Visual Studio 2022 Build Tools，包含 C++ 桌面工作负载

安装依赖：

```powershell
npm install
```

开发运行：

```powershell
$env:Path = "$HOME\.cargo\bin;$env:Path"
npm run tauri:dev
```

验证：

```powershell
npm test
cargo test -p tokenusage-core
npm run build
cargo check --workspace
```

生成不含安装器的 Release 可执行文件：

```powershell
$env:Path = "$HOME\.cargo\bin;$env:Path"
npm exec tauri build -- --features custom-protocol --no-bundle
```

## 数据与隐私

- 账号额度仅通过可运行的 `codex app-server` 获取。应用优先查找手动配置路径、`TOKENUSAGE_CODEX_BIN` 与 PATH 中的 Codex CLI。
- 如果 app-server 不可用，应用降级为只读取 `%USERPROFILE%\.codex\state_5.sqlite` 和 session JSONL 的本地统计。
- 不读取 `auth.json`，不上传 usage、线程、路径、日志、prompt、回复或工具参数。
- `tokenusage-probe` 默认对线程标题和路径脱敏；只有显式传入 `--include-private` 时才输出本地展示字段。

## 文档

- [01_PLAN.md](01_PLAN.md)：Windows 移植与 Linux 预留的完整实施计划。
- [02_UI_REFERENCE_COMPARISON.md](02_UI_REFERENCE_COMPARISON.md)：当前 Windows 版与 `ref/codexU` 截图和设计规范的视觉对比、重构顺序与验收标准。
