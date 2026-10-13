# dsh-cpamc

**为 DeepSeek Harness（DSH）提供模型：装一个插件，就能在 DSH 里使用和管理多个模型来源。**

> **状态：设计阶段。** 目前 npm 上的 `dsh-cpamc` 只是占位包，没有任何功能，也不是可用的 DSH 插件。下面描述的是计划中的功能。

## 它将是什么

dsh-cpamc 是一个 DSH 插件，在 [dsh-model](https://github.com/AIcivilization/dsh-model) 的基础上开发：

- **为 DSH 提供模型**：已登录并通过检查的来源，其模型自动出现在 DSH 的模型选择器里。
- **装好就能用**：模型服务、来源组件、配置和 API Key 都由插件自动准备，不用单独安装或手写配置。
- **默认六个来源**：WorkBuddy、Trae、Qoder、ZCode，加上 Claude 订阅和 Codex 订阅。账号由你自己登录授权。
- **模型列表不会太长**：每个来源都可以在 DSH 里显示或隐藏。默认只显示一两个好用的免费模型，处理简单任务就够了，其他的需要时再打开。

## 在 DSH 里管理：设置 → dsh-cpamc（计划）

| 位置 | 内容 |
|---|---|
| 页面顶部 | 产品名和当前版本；有新版本时才出现「更新」；「卸载」 |
| 来源与模型 | 六个来源的状态、显示 / 隐藏开关、在 DSH 里显示哪些模型、最近使用的模型、成功率、延迟和速度。只显示已登录、已设置好的内容 |
| API Key | 每台设备或每个工具一把 key：新增、复制、轮换、吊销；本机地址和外部地址 |
| 服务 | 运行状态、版本、重新检查、重启、修复 |
| 「全部功能」 | 打开原版完整管理界面，用于登录账号、修改完整配置、调整路由、查看详细日志。它管理的是同一个服务 |

界面语言跟随 DSH。

## 计划支持

- **平台**：macOS、Windows、Linux。每个平台都实测通过后才算支持。
- **VPS**：和 [dsh-vps](https://github.com/AIcivilization/dsh-vps) 配合。完整管理界面放在 dsh-vps 的登录保护之后，和 DSH 使用同一个网址，不用新开端口。其他设备通过 dsh-vps 的域名或公网 IP 调用模型，必须带 API Key。
- **安全**：服务只监听本机；调用模型始终需要 API Key；DSH 设置页拿不到管理密钥。
- **干净卸载**：先停掉服务、确认端口已经释放，再从 DSH 移除插件。卸载后不会有服务留在后台。

## 注意

- 来源账号的凭据在官方客户端之外使用，可能不符合服务商的条款，账号存在风险，请自行判断。
- dsh-cpamc 只负责转接，不提供任何额度。
- 和 dsh-model 不能同时安装。安装 dsh-cpamc 时会提示从 dsh-model 迁移。

## 方案

见 [docs/DESIGN.md](docs/DESIGN.md)。

## 许可

MIT，见 [LICENSE](./LICENSE)。

---

## English

**A model provider for DeepSeek Harness (DSH): install one plugin to use and manage several model sources inside DSH.**

> **Status: design stage.** The `dsh-cpamc` package on npm is a placeholder with no functionality. It is not a usable DSH plugin yet. Everything below is planned.

dsh-cpamc is a DSH plugin built on [dsh-model](https://github.com/AIcivilization/dsh-model):

- **Models for DSH**: models from sources that are signed in and verified appear in the DSH model picker automatically.
- **No manual setup**: the plugin prepares the model service, source components, configuration and API keys for you.
- **Six default sources**: WorkBuddy, Trae, Qoder, ZCode, plus Claude and Codex subscriptions. You sign in to your own accounts.
- **A short model list**: every source can be shown or hidden in DSH. By default only one or two good free models are shown.

**Settings → dsh-cpamc** (planned): a header with the product name, version, Update (shown only when a new version exists) and Uninstall; sources and models with real status and speed; API keys; service status; and an **All features** card that opens the original full management interface for the same service. The panel follows DSH's language.

**Planned support**: macOS, Windows and Linux; VPS deployments together with [dsh-vps](https://github.com/AIcivilization/dsh-vps), where the full management interface sits behind dsh-vps sign-in; clean uninstall that stops all services and frees ports before the plugin is removed.

Source credentials used outside their official clients may conflict with the providers' terms; use at your own risk. dsh-cpamc does not provide any quota. It cannot be installed alongside dsh-model.

See [docs/DESIGN.md](docs/DESIGN.md). MIT licensed.
