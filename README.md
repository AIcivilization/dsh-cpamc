# dsh-cpamc

**为 DeepSeek Harness（DSH）提供模型：装一个插件，就能在 DSH 里使用和管理多个模型来源。**

> **状态：0.1.0 alpha，还没有发布到 npm。** npm 上现有的 `dsh-cpamc` 是早期占位包，没有功能。下面标「已实现」的部分已在 macOS（Apple 芯片）上用真实组件测试过；其他平台和 VPS 还在验证中。

dsh-cpamc 在 [dsh-model](https://github.com/AIcivilization/dsh-model) 的基础上开发。

## 它做什么

- **为 DSH 提供模型**：登录过、检查通过的来源，它的模型会自动出现在 DSH 的模型选择器里。
- **装好就能用**：模型服务、四个 IDE 来源的组件、完整管理界面、配置和 API Key 都由插件准备好，版本锁定并校验 sha256。
- **默认六个来源**：WorkBuddy、Trae、Qoder、ZCode，加上 Claude 订阅和 Codex 订阅。账号由你自己登录。
- **模型列表不会太长**：每个来源都可以在 DSH 里显示或隐藏。默认只显示免费来源里、已经在你的账号上实测调通的模型，最多 2 个；其余的需要时再勾选。
- **完整功能一键打开**：登录账号、修改完整配置、调整路由、查看详细日志，都在原版完整管理界面里做。它管理的就是为 DSH 提供模型的同一个服务，你在那里改的设置不会被 dsh-cpamc 覆盖。

## 在 DSH 里管理：设置 → dsh-cpamc

| 位置 | 内容 | 状态 |
|---|---|---|
| 页面顶部 | `dsh-cpamc` 与当前版本；有新版本时才出现「更新」；「卸载」 | 已实现 |
| 模型管理 | 最近使用的模型；六个来源的状态、账号、显示 / 隐藏开关；最近 24 小时的真实请求数、成功率、延迟和速度（没有数据时写「暂无请求数据」）；选择在 DSH 里显示哪些模型 | 已实现 |
| API Key | 本机地址与外部地址；每台设备一把 key，新增、复制、轮换、吊销 | 已实现 |
| 服务 | 模型服务、渠道组件、完整管理界面的版本与运行状态；重新检查、重启、修复 | 已实现 |
| 全部功能 | 确认服务在运行后，打开原版完整管理界面；复制登录密钥（不显示，30 秒后从剪贴板清除） | 本机已实现；VPS 计划中 |

界面语言跟随 DSH。

## 快速开始（开发版）

```bash
git clone https://github.com/AIcivilization/dsh-cpamc.git
cd dsh-cpamc && npm ci && npm run build
node bin/dsh-cpamc.js setup
```

`setup` 可以重复执行。之后在 DSH 的「设置 → dsh-cpamc」里点「全部功能」登录来源。

## 常用命令

| 命令 | 作用 |
|---|---|
| `setup` | 安装 / 修复全部（可重复执行） |
| `sources` | 六个来源：登录状态、在 DSH 里显示还是隐藏、账号、模型数 |
| `source show\|hide <来源>` | 在 DSH 里显示 / 隐藏这个来源的模型 |
| `panel [--show-key]` | 打印完整管理界面的地址 |
| `key list\|add\|revoke\|rotate <名称>` | 访问 key，每台设备一把 |
| `stats` | 按 key、来源、模型的成功率、延迟和速度 |
| `status` / `doctor` | 总览 / 逐项自检 |
| `migrate` | 从 dsh-model 迁过来：Claude / Codex 登录与访问 key（只复制，不删除） |
| `update` / `uninstall` | 更新 / 干净卸载 |

## 平台

| 平台 | 状态 |
|---|---|
| macOS Apple 芯片 | 已用真实组件测试 |
| macOS Intel、Linux x64 / arm64、Windows x64 | 组件已齐，待逐个实测 |
| Windows arm64 | 渠道组件暂无该平台版本，验证中 |
| VPS（配合 [dsh-vps](https://github.com/AIcivilization/dsh-vps)） | 计划中：完整管理界面放在 dsh-vps 的登录保护之后，和 DSH 使用同一个网址 |

## 安全与卸载

- 服务只监听本机；调用模型始终需要 API Key；DSH 设置页拿不到守护进程和服务的密钥。
- 卸载会依次撤下对外访问、还原 DSH 配置、停止并移除服务、确认端口已经释放，最后才从 DSH 移除插件。任何一步没完成都会停下来并且可以重试，不会显示「已卸载」。

## 注意

- 来源账号的凭据在官方客户端之外使用，可能不符合服务商的条款，账号存在风险，请自行判断。
- dsh-cpamc 只负责转接，不提供任何额度。
- 和 dsh-model 可以同时装着，但 DSH 里会出现两组模型。建议执行 `dsh-cpamc migrate` 后卸载 dsh-model。

## 方案

见 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/M0-findings.md](docs/M0-findings.md)。

## 许可

MIT，见 [LICENSE](./LICENSE)。

---

## English

**A model provider for DeepSeek Harness (DSH): install one plugin to use and manage several model sources inside DSH.**

> **Status: 0.1.0 alpha, not yet published to npm.** The current `dsh-cpamc` package on npm is an early placeholder. Parts marked as done have been tested with real components on macOS (Apple silicon); other platforms and VPS are still being verified.

Built on [dsh-model](https://github.com/AIcivilization/dsh-model):

- **Models for DSH**: signed-in, verified sources show up in the DSH model picker automatically.
- **No manual setup**: the plugin prepares the model service, the components for the four IDE sources, the full management interface, configuration and API keys, all version-pinned and sha256-verified.
- **Six default sources**: WorkBuddy, Trae, Qoder, ZCode, plus Claude and Codex subscriptions. You sign in to your own accounts.
- **A short model list**: every source can be shown or hidden in DSH. By default only models from free sources that were actually tested on your account are shown, two at most.
- **All features one click away**: sign-ins, full configuration, routing and detailed logs live in the original full management interface, which manages the very service that serves DSH. Settings you change there are not overwritten by dsh-cpamc.

**Settings → dsh-cpamc**: a header (name, version, Update only when a newer version exists, Uninstall), Models (last used model, the six sources with status, show / hide switch and real 24-hour request stats), API keys, Service, and an **All features** card. The panel follows DSH's language. VPS support together with [dsh-vps](https://github.com/AIcivilization/dsh-vps) is planned.

Uninstall removes remote access, restores DSH config, stops and removes the services, confirms the ports are free and only then removes the plugin from DSH; if any step fails it stops and can be retried.

Source credentials used outside their official clients may conflict with the providers' terms; use at your own risk. dsh-cpamc does not provide any quota.

See [docs/DESIGN.md](docs/DESIGN.md). MIT licensed.
