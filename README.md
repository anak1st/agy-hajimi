# agy-hajimi (Antigravity Hajimi)

> 仅面向 **Antigravity App（macOS 桌面端 `v2.33.0+` ~ `v2.35.2`）** 的顶栏上下文胶囊与悬浮监控卡片插件（UI 界面全英文，文档与代码注释采用中文）。

## 功能特点

- **零上下文 Token 开销**：通过 0 工具 MCP Stdio 宿主保活（`tools/list` 返回 `[]`），不向模型上下文注入任何工具定义。
- **右上角顶栏胶囊**：停靠在主窗口顶栏右上角原生按钮组旁，展示**圆形 SVG 进度条 + 上下文占用百分比**（正常 / 警告 `≥70%` / 危险 `≥88%` 自动变色）。
  - **加载状态**：首次加载或切换会话等待数据时隐藏圆环与百分比，仅显示 `Loading`。
  - **非对话界面自动隐藏**：切换到 Home、Inbox、Customizations、Settings 等非对话页面时自动隐藏胶囊并收起浮层、暂停轮询。
- **精简悬浮卡片（`Antigravity Hajimi`，`390px`）**：点击胶囊在页面顶层展开悬浮卡片（无深色内嵌背景块、纯英文界面）：
  - **顶部栏**：左侧展示应用名称 `Antigravity Hajimi`，右侧展示最新刷新时间 `HH:MM:SS` 与静态刷新按钮（支持 Remote SSH 会话标记）。
  - **Context Window**：展示当前会话**已用大小 / 总大小 + 百分比 + 单条彩色进度条**、剩余 Token 数与压缩次数（切换会话 ID 立即清空旧数据，严格隔离展示）。
  - **Live Performance（2×2）**：`Avg Speed`（主）+ `Latest`（次）、`Avg First Token (TTFT)` + `Latest`、`Avg Cache Hit Rate` + `Latest`、`Session Tokens`（含 steps 与 calls 统计）。
  - **Token Usage**：扁平 3 列展示 `Uncached Input` / `Cache Read` / `Output`。
  - **Model Quotas**：仅展示 **Gemini 系列模型**的 `5-Hour Limit` 与 `Weekly Limit` 剩余比例进度条及重置倒计时。
- **自适应懒刷新**：
  - **空闲状态**：每 **10 分钟**拉取一次；
  - **切换会话 ID**：路由变更立即清空旧展示并拉取一次；
  - **对话生成中**：自动切为每 **10 秒**拉取一次，生成完成后自动回落至 10 分钟；
  - **模型配额独立节流**：`Model Quotas` 固定每 **10 分钟**查询一次（不随切换会话、生成中或手动强制刷新频繁请求），且单次查询失败或返回空数据时保留上一次有效配额展示；
  - **手动刷新**：支持点击卡片右上角刷新按钮或右键顶栏胶囊随时立即刷新会话遥测。
- **主题自适应**：通过双 Shadow DOM 继承宿主 `--background`、`--card`、`--foreground`、`--border`、`--primary` 变量与 `color-mix()`，零延迟跟随浅色/深色主题。
- **零端口 CDP 通信**：采用 `Runtime.addBinding` 双向通道，无需额外开放本地 HTTP 服务端口。

---

## 环境要求

- **Antigravity App**（`v2.33.0+`，实测兼容 `v2.35.2`）
- **Node.js `>= 22`**（使用内置 `node:test` 与全局 `WebSocket` 客户端）
- **macOS**：一键生成 Debug 启动器需系统自带 `swift` 与 `iconutil`（Xcode Command Line Tools）

---

## 一键安装与 Debug App 生成

Antigravity App `v2.33.0+` 默认关闭了 `--remote-debugging-port=0`。项目内置一键安装脚本 [install.sh](install.sh)，会自动完成以下操作：

1. 将插件安装到 `~/.gemini/config/plugins/agy-hajimi/`；
2. 基于 `/Applications/Antigravity.app` 原图标全幅重绘，在 `~/Applications/Antigravity (Debug).app` 生成带有**右下角橙金 `DBG` 角标**的专属 Debug 启动器（与原版尺寸一致、不修改原应用签名），点击即可携带 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1` 启动宿主。

```bash
chmod +x install.sh
./install.sh
```

可选参数：
- `--no-debug-app`：仅同步/更新插件文件，不重新生成 `Antigravity (Debug).app`
- `--relaunch`：安装完成后自动退出当前无参运行的 Antigravity 并以 Debug 模式重新拉起

启用步骤：
1. 退出原有 Antigravity App（`Cmd + Q`），通过 `~/Applications/Antigravity (Debug).app` 启动（可将其拖入程序坞方便日常使用）；
2. 在 Antigravity App 左侧边栏 **Customizations → Installed** 打开 **agy-hajimi** 开关即可生效。

---

## 目录结构

```text
agy-hajimi/
├── plugin.json             # Antigravity 插件清单
├── mcp_config.json         # 0 工具 MCP Stdio 保活配置
├── install.sh              # 一键安装脚本 + macOS Debug App 启动器生成器
├── README.md               # 项目说明与致谢文档
├── assets/
│   └── logo.svg            # 插件图标
├── docs/
│   └── architecture.md     # 早期调研与架构设计记录
├── src/
│   ├── server/
│   │   ├── mcp-entry.mjs   # 0 工具 MCP Stdio 宿主与子进程看门狗
│   │   ├── daemon.mjs      # 后台守护进程主入口与会话轨迹缓存
│   │   ├── ls-client.mjs   # Language Server 自动发现、Connect-RPC 与固定 10m 配额节流
│   │   ├── time-math.mjs   # BigInt 纳秒级耗时与数值安全解析
│   │   ├── quota.mjs       # 模型名称映射与 Gemini 系列配额归一化
│   │   ├── metrics.mjs     # 单会话遥测汇总聚合引擎
│   │   ├── cdp-session.mjs # 单窗口 WebSocket CDP 命令传输封装
│   │   ├── cdp-targets.mjs # CDP 端口发现、主窗口白名单筛选与本地/SSH 识别
│   │   ├── cdp-bridge.mjs  # CDP 注入调度与 Runtime.addBinding 双向通道
│   │   └── ui-loader.mjs   # 前端分模块 ES 脚本零依赖组装器
│   └── ui/
│       ├── rpc-client.js   # CDP Binding 异步 RPC 客户端
│       ├── formatters.js   # DOM 构建、数值格式化与对话路由识别
│       ├── theme.js        # Shadow DOM 样式加载与亮暗主题极性同步
│       ├── dock.js         # 顶栏流式停靠、自适应间距高度与浮层定位
│       ├── components.js   # 胶囊与悬浮卡片各数据区块渲染组件
│       ├── scheduler.js    # 自适应懒刷新调度（10m / 10s / 路由隔离）
│       ├── overlay.js      # 前端双 Shadow Host 组装入口
│       └── overlay.css     # 宿主变量自适应样式表
└── tests/
    └── plugin.test.mjs     # Node 内置单元测试套件
```

开发与测试：

```bash
node --test tests/plugin.test.mjs
bash -n install.sh
```

更多早期底层调研与官方接口对比请参阅 [docs/architecture.md](docs/architecture.md)。

---

## 引用、借鉴与开源致谢

本插件为面向 **Antigravity App 单端极简体验** 的独立重构实现（从零编写，不分发任何第三方二进制或应用资源），在协议探索、UI 交互与启动器工程方案上参考并借鉴了以下优秀开源项目与官方文档：

1. **[`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor)**（GPL-3.0）
   - 借鉴了 **0 工具 MCP Stdio 宿主保活模式**（利用插件生命周期自动启停后台进程且不消耗模型上下文 Token）；
   - 借鉴了 **Dual Shadow Host 挂载架构**（顶栏 `@container/titlebar` 胶囊 + `document.body` 顶层悬浮卡片 Portal）；
   - 借鉴了 **14×14 圆形 SVG 进度条胶囊样式**与通过宿主 CSS 变量 + `color-mix()` 实现的亮暗主题实时跟随方案；
   - 参考了桌面端 **Language Server 自动发现**（`~/.gemini/antigravity/daemon/hub_*.json` + Connect-RPC `GetUserStatus` / `RetrieveUserQuotaSummary` / `GetAllCascadeTrajectories` / `GetCascadeTrajectory`）以及基于 **`BigInt` 纳秒时间戳**的高精度生成速率（TPS）计算思路。

2. **[`wycocoyu/agy-context-dashboard`](https://github.com/wycocoyu/agy-context-dashboard)**（MIT，Fork 自 [`ATtacK030130/antigrative-dashboard`](https://github.com/ATtacK030130/antigrative-dashboard)）
   - 借鉴了利用 CDP **`Runtime.addBinding` 建立零端口双向 RPC 通道**的机制（替代传统本地 HTTP 桥接服务器，减少本地端口暴露）；
   - 借鉴了 macOS 下通过独立包装 `.app` 启动器自动检测并附带 **`--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`** 拉起宿主应用的工程思路（不破坏原应用 `/Applications/Antigravity.app` 的代码签名），在此基础上改进了图标全幅铺底缩放与 `DBG` 角标生成脚本以适配 macOS Tahoe 图标规范。

3. **Google Antigravity 官方文档**（`Build plugins` / `MCP Apps` / `Sidecars` / `Changelog`）
   - 遵循官方 `plugin.json`、`mcp_config.json` 清单规范与 `GetAllPlugins` 发现机制；
   - 依据 `v2.33.0+` ~ `v2.35.2` 官方能力边界确认主窗口顶栏暂无原生 UI 扩展点及默认调试端口关闭行为。

---

## 免责声明

- 本项目为非官方社区插件，与 Google / Antigravity 官方无任何关联。
- 插件不会修改或破坏 `/Applications/Antigravity.app` 原始安装包内容。
