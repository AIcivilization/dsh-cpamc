# dsh-cpamc 设计方案

> 状态：方案（2026-10-13）。基于 [dsh-model](https://github.com/AIcivilization/dsh-model) 的**增量方案**：凡是本文没有提到的部分，一律沿用 dsh-model 的现有实现和设计（见其 `docs/DESIGN.md` 与 `docs/M0-findings.md`）。
>
> 写作约定：对外的说明、README 和界面里，只出现 dsh-cpamc、dsh-model、dsh-vps、DSH、CPA / CPAMC 和各来源的官方名称，不出现借鉴过的其他产品名称。

## 实现状态（2026-10-13，0.1.0-alpha.0）

| 部分 | 状态 |
|---|---|
| 改名、六个来源、删除 bridge / OpenCode / 本机模型 | 已完成 |
| 渠道插件包与管理界面锁版本安装，配置按键维护（§6），同名模型别名 | 已完成，macOS arm64 契约测试通过 |
| 设置页：页眉、模型管理、API Key、服务、「全部功能」（本机） | 已完成，渲染测试与浏览器预览通过；尚未在真实 DSH 里装过 |
| 默认显示实测调通的免费模型（§4.2） | 已完成；需要真实账号验证 |
| 卸载确认端口释放、插件最后移除；从 dsh-model 迁移 | 已完成 |
| VPS：gate 的 `/cpamc/` 入口（§7.4） | 未开始，需要 dsh-vps 改动；目前给出 SSH 隧道办法 |
| 其余平台实测、Windows arm64 | 未开始 |
| 从 DSH 插件管理器直接移除时的自检兜底（§10.3） | 未开始 |

## 0. 一句话

dsh-cpamc = dsh-model 的引擎与 DSH 接线 + CPA 渠道插件提供的四个 IDE 来源 + 一个精简的 DSH 设置面板 + 一张打开原版 CPAMC 的「全部功能」卡片。

dsh-cpamc 为 DSH 提供模型。CPA（服务端）承载模型请求和全部来源，原版 CPAMC（CPA 自带的网页管理界面）负责登录和完整设置。dsh-cpamc 负责省掉用户自己安装、配置、接线这些步骤，并在 DSH 里给出日常需要的那一小部分。

## 1. 用户要求（定稿，实现不得删减）

| # | 要求 |
|---|---|
| R1 | dsh-cpamc **为 DSH 提供模型**：已登录、已完成设置的来源，其模型自动出现在 DSH 的模型选择器里 |
| R2 | DSH「设置」菜单里有 dsh-cpamc 面板，分三部分：① 当前可用的来源和模型、正在用哪个、连接速率、运行状态；② 生成 API Key；③ 其他必要内容 |
| R3 | 面板只显示来自 CPA 的、**已登录、已完成设置**的内容，只显示有用的部分 |
| R4 | 面板底部有一张卡片，带说明文字和「全部功能」按钮。点击后打开**原版 CPAMC**，让原版 CPA 为我们服务。我们不改 CPAMC |
| R5 | 首次安装默认装好六个来源：WorkBuddy、Trae、Qoder、ZCode，加 Claude 订阅和 Codex 订阅。这六个来源都由原版 CPA / CPAMC 提供 |
| R6 | 每个来源都有「显示 / 隐藏」按钮。默认只向 DSH 显示一两个好用的免费模型，够处理简单任务即可 |
| R7 | 页面顶部：产品名 dsh-cpamc（不可点）、当前版本号（不可点）、「更新」（检测到新版本才出现）、「卸载」（从 DSH 卸载本插件）。**没有**语言选择，语言跟随 DSH |
| R8 | 一开始就要求全平台可用（macOS、Windows、Linux）。界面支持多种语言，跟随 DSH |
| R9 | VPS 上安装时，要处理好域名、本机 IP、公网 IP 之间的冲突 |
| R10 | VPS 账号管理整合 [dsh-vps](https://github.com/AIcivilization/dsh-vps) |
| R11 | 卸载必须停掉相应的服务。卸载后不能有服务还在后台运行，也不能有端口被占着 |
| R12 | 本仓库现有内容可以全部推倒重做，按需更新 GitHub 上的 [dsh-cpamc](https://github.com/AIcivilization/dsh-cpamc) |

## 2. 架构

```text
DSH 设置 → dsh-cpamc 面板 ──/api-dsh-cpamc/*（在 DSH 自己的鉴权之后）──┐
                                                                  ▼
                                         dsh-cpamc 守护进程（沿用 dsh-model daemon）
                                          ├─ 管理 API（带管理密钥）→ CPA
                                          ├─ 用量轮询与统计（stats）
                                          └─ 同步 DSH provider 和凭据引用
「全部功能」──→ 原版 CPAMC（CPA 自带 /management.html）──管理 API──┐
                                                                  ▼
DSH 模型选择器 ──Bearer dsh key──→ CPA 127.0.0.1:<端口>/v1（唯一入口）
                                   ├─ 渠道插件：workbuddy / trae / qoder / zcode
                                   └─ 原生 OAuth：claude / codex
```

- 只有一份 CPA 配置、一个 CPA 进程。面板和 CPAMC 管的是**同一个实例**。
- CPA、守护进程、CPAMC 都只监听 `127.0.0.1`。浏览器拿不到管理密钥（面板经宿主端转发；CPAMC 的密钥处理见 §7.3）。

## 3. 相对 dsh-model 的增量

### 3.1 原样沿用

| 能力 | dsh-model 中的位置 |
|---|---|
| 引擎锁版本、sha256 校验、原子安装、升级回滚 | `engine-manifest.json`、`src/engine/install.ts` |
| 系统服务托管：launchd、systemd user / system、Windows | `src/service/*` |
| DSH 接线：`profiles/<p>/cordis.patch.yml` 合并、`.credentials.yaml` 引用、逐字节还原 | `src/dsh/*` |
| 用量统计：按 key、来源、模型统计成功率、延迟、tokens/s | `src/daemon/stats.ts`、`usage.ts` |
| 页面一键安装、更新、卸载，VPS 上的 root 提权单元 | `src/commands/self.ts`、`src/service/admin.ts` |
| VPS 对外地址：Caddy :9443，域名或 `<ip>.sslip.io` | `src/remote/public.ts` |
| 中英文案、`--json` 命令行 | `src/i18n.ts`、`src/cli.ts` |

### 3.2 修改

| 项 | dsh-model 现状 | dsh-cpamc |
|---|---|---|
| 来源集合 | 12 个（Kimi、Grok、OpenCode、Ollama 等） | 固定六个（§4）。其他来源不在面板管理，见 §14 Q2 |
| WorkBuddy | 自研 bridge，读取并解密 App 凭据 | 改用 CPA 渠道插件，在 CPAMC 里走 OAuth 登录。**bridge 删除** |
| 登录 | 面板内登录（device code、粘贴回调地址） | 默认在 CPAMC 里完成。面板只显示状态，并给出「去全部功能登录」 |
| 引擎配置 | `engine.yaml` 每次 setup 整份重新生成 | CPAMC 也会写这份配置，所以改为**局部维护**（§6） |
| 控制台 | `disable-control-panel: true` | 打开，并锁定管理页版本（§7） |
| 默认模型 | 每个来源推荐 5 个 | 全局只推荐 1–2 个免费模型（§4.2） |
| 页眉 | 「关于」区块里放版本、更新、卸载 | 移到页面顶部（§5.0） |
| 语言 | 客户端读 `document.lang`，只分中文和英文 | 跟随 DSH locale。文案走资源文件，可扩展更多语言 |

### 3.3 新增

- 渠道插件包：按平台下载、校验、放进 `plugins/`，在配置里逐个 `enabled: true`。
- 同名模型别名表：同一个模型由多个渠道提供时，拆成 `渠道/模型`，避免 CPA 在渠道之间轮询、消耗别家账号的额度。
- 「全部功能」卡片和 CPAMC 访问路径（本机和 VPS 各一条）。
- 渠道的余额和积分（来自渠道插件的管理接口），作为来源行的辅助信息显示。

### 3.4 删除

WorkBuddy bridge 及其系统服务、OpenCode Zen 集成、本机模型（Ollama、LM Studio）、面板内的登录流程。是否保留其余 CPA 原生来源，见 §14 Q2。

## 4. 六个来源

### 4.1 来源矩阵

| 来源 | CPA 中的提供方式 | 在 CPAMC 里登录 | 平台 |
|---|---|---|---|
| WorkBuddy | 渠道插件 `workbuddy` | 插件 OAuth（`/v8/management/oauth/auth-url?provider=workbuddy`） | 跟随渠道插件包 |
| Trae | 渠道插件 `trae` | 插件 OAuth | 同上 |
| Qoder | 渠道插件 `qoder` | 插件 OAuth | 同上 |
| ZCode | 渠道插件 `zcode` | 插件 OAuth | 同上 |
| Claude 订阅 | CPA 原生 | OAuth 回调式，端口 54545，可粘贴回调地址 | 跟随 CPA |
| Codex 订阅 | CPA 原生 | OAuth 回调式，端口 1455，或 device code | 跟随 CPA |

- 渠道插件包里还带着其他渠道（例如 mimo）。只启用上面四个，其余不写入启用清单。
- 四个渠道的接口各不相同：ZCode 的余额单位是 token，其他是积分；ZCode 的模型列表路径是 `/plugins/zcode/models`，其他是 `/models/groups`。差异集中登记在一张渠道表里，面板、别名表、启用清单都从这张表派生。
- 合规：渠道和订阅的凭据在官方客户端之外使用，可能不符合服务商条款。沿用 dsh-model 的做法：首次开启前提示风险，并记录确认时间。Claude 有封禁第三方使用的先例，开启前需要单独确认。

### 4.2 显示规则（R6）

两层开关，都只影响 **DSH 模型选择器**，不改 CPA 和 CPAMC 里的任何东西。

1. **来源开关**（每行一个）：隐藏后，该来源的所有模型都不进 DSH。
2. **模型勾选**（展开来源后）：决定已显示的来源里，哪些模型进入 DSH。

默认状态：

- 首次安装时，六个来源的开关都是「显示」，但模型勾选只包含**推荐清单**里、并且实际可用的 1–2 个模型。
- 推荐清单 `recommend.json` 随插件版本发布：列出模型 id、来源，以及核实免费的日期。只推荐费用档为「免费」并且实测调通的模型。一个都没调通时，显示空状态和原因，不拿别的模型凑数。
- 来源目录里**新出现的模型默认不勾选**。勾选过的模型下线后自动去掉。
- 用户的选择存在 `config.json` 的 `visibility` 里，插件升级后保留。

## 5. 设置面板

入口：**DSH 设置 → dsh-cpamc**。注册方式沿用 dsh-model 的 `plugin/cordis.patch.yml` + `settings.section`。

### 5.0 页眉（R7）

| 元素 | 行为 |
|---|---|
| `dsh-cpamc` | 产品名，纯文本 |
| `v0.x.y` | 当前插件版本，纯文本。引擎和渠道插件的版本放在 §5.3 |
| 更新 | 守护进程定期查询 npm 最新版本，只有比当前新**且兼容当前平台**时才显示。点击后执行沿用的 `update` 流程。引擎或渠道插件单独有新版时，**不**触发这个按钮 |
| 卸载 | 弹出确认，选择是否保留登录数据，然后执行 §10.3 的卸载顺序 |

### 5.1 来源与模型（R2 ①、R3）

六行固定来源，每行显示：

- 来源名、状态（未登录 / 检查中 / 可用 / 需要重新登录 / 额度用完 / 异常），以及显示 / 隐藏开关；
- 已勾选进 DSH 的模型。展开后可以改勾选。**只有已登录且探测通过的来源可以展开**；
- 余额或积分（渠道插件提供时才显示）；
- 该来源最近 1 小时和 24 小时的成功率、平均延迟、tokens/s，数据来自沿用的 stats，标出样本数。没有请求时显示「暂无数据」；
- 未登录的来源只显示一个按钮「在全部功能中登录」，不展开，也不进 DSH。

页面上方显示一行「正在用」：DSH 没有接口提供当前会话选中的模型，所以显示**最近一次成功请求用到的模型**，并且明确标注为「最近使用」。

### 5.2 API Key（R2 ②）

沿用 dsh-model 的 `keys.json`，以及新增、复制、轮换、吊销操作和逐 key 统计。新增规则：

- 新 key 的完整内容只显示一次，之后列表只显示名称、创建时间、最近使用时间和后 4 位。
- `dsh` 这把 key 自动接入 DSH，不能吊销，只能轮换。
- 用户可能在 CPAMC 里直接改 `api-keys`，对账规则见 §6。
- 地址分两种显示：**本机地址** `http://127.0.0.1:<端口>/v1`，标注「仅本机」；**外部地址**，只在 VPS 上已经配好对外路由时显示。

### 5.3 服务与其他（R2 ③）

- CPA 状态：运行中 / 启动中 / 已停止 / 启动失败（附原因）。端口、CPA 版本、渠道插件版本。
- 操作：「重新检查」「重启服务」「修复」（沿用 `repair`）。
- VPS 上额外显示：部署位置、外部地址、证书状态，并链接到 dsh-vps 的账号管理页（R10）。
- 不显示 YAML、管理密钥、完整日志。

### 5.4 「全部功能」卡片（R4）

文案：「需要登录账号、修改完整配置、调整路由或查看详细日志？打开原版管理界面。」按钮：**全部功能**。

点击后：确认 CPA 在运行（不在就先启动）→ 打开 CPAMC（本机和 VPS 的地址见 §7）→ 用系统默认浏览器打开。DSH 内嵌窗口留到验证后再考虑，OAuth 跳转在系统浏览器里最可靠。

## 6. 配置归属：面板和 CPAMC 共写一份配置

这是在 dsh-model 基础上改动最大的地方。CPAMC 通过管理 API 直接改 CPA 的配置。如果 dsh-cpamc 继续整份重新生成配置，用户在 CPAMC 里的修改会被覆盖。

规则：

1. **首次安装**时生成完整配置。之后**以 CPA 实际配置为准**，不再整份重写。
2. dsh-cpamc 只拥有以下几项，修改时**按键局部修改**（优先走管理 API，CPA 停机时才直接改文件，并保留原缩进）：
   - `server.host`（必须是 `127.0.0.1`）；
   - `access.api-keys` 中由 `keys.json` 管理的那些 key；
   - `management.secret-key`；
   - `plugins.configs.<四个渠道>.enabled`；
   - 别名表中 dsh-cpamc 生成的条目。
3. 其余字段（路由策略、代理、额外的 provider、日志等）归用户和 CPAMC 所有，dsh-cpamc 只读。
4. **key 对账**：`keys.json` 里有但 CPA 里没有的 key，视为在 CPAMC 里被删除，标记为已吊销。CPA 里有但 `keys.json` 里没有的 key，列为「在全部功能中添加」（无名称，只显示后 4 位，不能在面板里吊销）。
5. `修复` 只补齐 dsh-cpamc 拥有的字段，不还原用户的修改。

## 7. 原版 CPAMC 的接入

### 7.1 启用与版本锁定

- 配置里设置 `disable-control-panel: false`，由 CPA 在 `/management.html` 上提供 CPAMC。
- CPA 第一次访问时会下载管理页到 `<工作目录>/static/management.html`，默认还会定期自动更新。dsh-cpamc 预先放好锁定版本（`engine-manifest.json` 里写明 sha256），并设置 `disable-auto-update-panel: true`，这样就不再下载或更新（V3 已实测）。
- 管理页、CPA 版本、渠道插件版本三者一起写在 manifest 的兼容组合里，一起升级。

### 7.2 本机

本机直接打开 `http://127.0.0.1:<端口>/management.html`。`allow-remote: false` 保持不变。

### 7.3 管理密钥

原版 CPAMC 登录时要用户输入管理密钥，这一点不能改 CPAMC 去绕开。方案：

- 「全部功能」卡片里提供「复制登录密钥」：只复制到剪贴板，界面不显示明文，30 秒后清空剪贴板（在平台支持时）。
- 不把密钥放进 URL、查询参数、日志或 DSH 配置。
- 卡片上有「重置登录密钥」：生成新的管理密钥并让 CPA 重载。守护进程同步更新自己持有的那份。

这意味着管理密钥会到达用户手里，这是使用原版 CPAMC 的前提。面板本身仍然不接触管理密钥。

### 7.4 VPS

经反向代理过来的请求，在 CPA 看来来自本机，`allow-remote: false` 起不到保护作用，所以 CPAMC 必须放在登录门后面。dsh-vps 已有现成的登录门，直接复用：

- **现状**（dsh-vps `gate/server.js`）：Caddy 把 DSH 站点的全部请求转给 dsh-gate（127.0.0.1:3100）。gate 负责登录（scrypt 口令、HMAC 会话 Cookie、登录限流、`X-Forwarded-For` 由 Caddy 覆盖防伪造），对未登录的请求一律拒绝或跳转登录，然后透明代理到 DSH（3080）。gate 已经按路径分流过自己的页面（`/login`、`/gate/*`、`/setup`），也对插件市场路径做了同源校验。
- **做法**：在 gate 里给 CPAMC 加一个路径前缀（例如 `/cpamc/`），**先过 gate 登录**，再去掉前缀转发到 `127.0.0.1:<CPA 端口>`。CPAMC 打开地址就是 `https://<dsh 的域名或 IP>/cpamc/management.html`，和 DSH 同源，复用同一个登录态。Caddy 和证书都不用改，也不用新开端口。
- 写请求沿用 gate 对插件市场的同源校验，防跨站请求。
- 前缀和上游端口由 dsh-cpamc 通过一个**小接口**登记给 gate（例如 gate 读取 `state/routes.d/dsh-cpamc.json`，dsh-cpamc 卸载时删除该文件）。gate 只接受指向 `127.0.0.1` 的上游，不接受任意地址。这是 dsh-vps 侧的一处小改动（§12 V6）。
- 不走 DSH 插件宿主路由：DSH 插件路由只支持 GET、HEAD、POST，而 CPAMC 的管理接口要用 PUT、PATCH、DELETE。
- 对外的 `:9443` 站点（dsh-model 现有）只转发 `/v1/*`，只认模型 API key，不暴露任何管理路径。

## 8. 平台矩阵（R8）

| 平台 | CPA | 渠道插件包 | 服务托管 | 状态 |
|---|---|---|---|---|
| macOS arm64 | ✓ | ✓ `.dylib` | launchd（沿用） | 目标 |
| macOS x64 | ✓ | ✓ | launchd | 目标 |
| Linux x64 | ✓ | ✓ `.so` | systemd user / system | 目标 |
| Linux arm64 | ✓ | ✓ | systemd | 目标 |
| Windows x64 | ✓ | ✓ `.dll` | Windows（dsh-model 0.18 beta） | 目标，需完成 beta 收尾 |
| Windows arm64 | ✓ | **✗ 没有发布** | Windows | **缺口**：用 x64 版本的 CPA 加渠道插件，在系统的 x64 仿真下运行，或者等渠道插件补发 arm64 版本 |

- 所有下载项（CPA、渠道插件包、管理页）都写进同一份 `engine-manifest.json`，带 URL 和 sha256，不在运行时查询「latest」。
- 渠道插件和 CPA 的兼容性要成对验证（§12 V1）。渠道插件**不自动升级**，跟随插件版本一起升级。

## 9. VPS 与地址（R9、R10）

沿用 dsh-model 的 VPS 模式（`/opt/dsh-vps` 检测、`User=dsh` 的 systemd 单元、root 提权单元），并明确三种地址：

| 地址 | 使用方 | 值 |
|---|---|---|
| 管理地址 | 守护进程、宿主端 | `http://127.0.0.1:<端口>`，永远只走本机 |
| provider 地址 | 服务器上的 DSH | `http://127.0.0.1:<端口>/v1`。服务器**不通过**自己的公网域名回连自己，避免 NAT 回环、DNS、证书问题 |
| 外部地址 | 用户其他设备上的客户端 | `https://<dsh 的域名>:9443/v1`；只有 IP 时用 `https://<ip>.sslip.io:9443/v1` |

- 写给 DSH 的 `baseURL` 永远是服务器本机地址，不会把 `127.0.0.1` 发给远程浏览器使用，也不会把公网域名写进服务器端配置。
- 域名或 IP 由 dsh-vps 提供。现在 dsh-model 直接读 `/etc/caddy/dsh-site.conf`，0.1 先沿用。之后改为调用 dsh-vps 的接口（§12 V6），dsh-cpamc 不保存 SSH 或 VPS 登录凭据。
- 域名或 IP 变化后，重新生成 `:9443` 站点和外部地址。服务器上 DSH 的 provider 地址不受影响。

## 10. 安装、更新、卸载

### 10.1 首次安装

用户从 DSH 插件市场安装 dsh-cpamc → 面板显示「一键安装」（沿用 dsh-model 的页面安装流程；VPS 上需要 root，只给出命令）→ 依次执行：

平台检查 → 下载 CPA、渠道插件包、管理页并校验 → 原子安装 → 生成配置（§6 第 1 条）→ 生成 `dsh` key 和管理密钥 → 注册服务并启动 → 健康检查 → 写入 DSH provider（模型为空时**不写**）。

每一步都可以重复执行，结果一样。所有步骤完成后，六个来源都显示为「未登录」，等用户去「全部功能」里登录。

### 10.2 更新

沿用 dsh-model 的 `update`。插件新版本可能带来新的 manifest（CPA、渠道插件、管理页）：先在临时端口上验证新组合，通过后再切换，失败就回滚到上一个版本。

### 10.3 卸载（R11）

顺序：

1. 撤掉 VPS 上的 `:9443` 站点（reload Caddy）和 gate 里的 `/cpamc/` 登记；
2. 先停守护进程（否则它可能在还原之后又把模型清单写回 DSH），再从 DSH 撤下 provider 和凭据引用（逐字节还原）；
3. 停止并注销 CPA 的服务，以及 VPS 上的提权单元；
4. 按 PID、启动时间、可执行文件路径确认**本插件的**进程都已退出。退不掉的按 TERM → 等待 → KILL 处理；
5. 确认端口已经释放（最多等 40 秒：CPA 优雅退出时会等后台网络请求，网络慢时要将近 30 秒，实测）；
6. 删除 dsh-cpamc 的数据（是否保留登录数据由用户在第 0 步选择）；
7. 最后通过 DSH 插件管理移除插件本身。

任何一步失败，都显示失败原因和「重试」，不显示「已卸载」。

**从 DSH 插件管理器直接移除**时，不会经过上面的流程。需要验证 DSH 有没有卸载钩子（§12 V4）。没有的话，守护进程定期检查插件是否还在任一 profile 中；连续多次检查都不在，就执行第 1 到第 6 步，然后自行退出。

## 11. 与 dsh-model 共存

两者都会占用 CPA 的端口，都会往 DSH 写 provider，所以**同一台机器只能装一个**。

- 安装 dsh-cpamc 时如果检测到 dsh-model，提示迁移：Codex 和 Claude 的登录文件格式相同，可以直接复制过来；key 可以连名称一起迁移；然后调用 dsh-model 的卸载。
- 用户不同意迁移时，停止安装并说明原因，不和 dsh-model 抢端口。

## 12. 实现前逐项验证

实测结果见 [M0-findings.md](M0-findings.md)。✅ 已通过（macOS arm64），◐ 部分通过。每一项都标出参考依据：dsh-model 的现有实现，或参考插件的做法（地址见内部交接说明，不随仓库发布）。

| # | 验证项 | 参考依据 | 不通过时 |
|---|---|---|---|
| V1 ✅ | 官方 CPA 发布版能否加载渠道插件包（各平台），以及渠道插件和 CPA 的版本兼容性 | 参考插件用的是从上游 tag 重新编译的 CPA（只有 Windows x64），需要确认官方发布版是否可以直接用 | 在 `AIcivilization/CLIProxyAPI` 用上游 tag 编译各平台版本，manifest 指向自己的 release（dsh-model 设计 §8 已预留这条路） |
| V2 ✅ | 四个渠道在 CPAMC 里可见：账号列表、OAuth 登录、模型目录 | 参考插件经 `/v0/management/plugins/<id>/*` 和 `/v8/management/oauth/*` 管理 | 若 CPAMC 不显示渠道插件，R5「由原版 CPAMC 提供」无法满足，需要和你确认 |
| V3 ✅ | CPAMC 管理页的提供方式、自动更新、能否锁版本 | CPA 配置 `disable-control-panel` 等字段 | 记录偏差（§7.1） |
| V4 | DSH 有没有卸载钩子；插件更新后是否需要重启 DSH | dsh-model：更新后需要重启 DSH | 用 §10.3 的守护进程自检兜底 |
| V5 | VPS 上 Claude 和 Codex 在 CPAMC 里能否完成 OAuth（粘贴回调地址） | dsh-model §14.2：管理接口 `oauth/callback` | 面板保留 dsh-model 的登录流程，作为 VPS 上的备用 |
| V6 ◐ | gate 加 `/cpamc/` 前缀转发（登记文件 + 先登录后转发 + 同源校验）；CPAMC 在带前缀的路径下能否正常工作（页面资源路径、管理接口基地址） | dsh-vps `gate/server.js` 已有登录门和按路径分流；dsh-model 已读 `dsh-site.conf` 取域名 | CPAMC 不认前缀时，改用 gate 的独立子路径，或在登录页里手动填写带前缀的地址 |
| V7 | Windows arm64：x64 仿真下 CPA 加渠道插件能否运行 | — | 0.1 在该平台标记为不支持，并在下载前提示 |
| V8 | 同名模型跨渠道轮询的别名表写法 | 参考插件 `model-alias` | — |
| V9 | 推荐清单里的模型实测：免费、能调通 | dsh-model `pricing` 字段（2026-10 核实） | 推荐清单为空，面板显示空状态 |

## 13. 里程碑

| 版本 | 内容 |
|---|---|
| 0.1 | 从 dsh-model 分出代码，去掉 bridge 和多余来源；接入渠道插件包；完成 §6 的配置归属；面板三部分加页眉；「全部功能」（本机）。平台：macOS、Linux |
| 0.2 | Windows x64；dsh-model 迁移；卸载自检兜底 |
| 0.3 | VPS：CPAMC 挂在 dsh-vps 的 gate 登录门后面（含 dsh-vps 侧小改动），外部地址；Windows arm64 结论 |

全平台是产品目标。上表是交付顺序，不是降低范围：每个平台都要有实测记录才算支持。

## 14. 待决问题

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 面板内要不要保留「登录」按钮，作为 CPAMC 之外的快捷入口？ | 0.1 按建议实现：面板只有「在全部功能中登录」；命令行保留 `dsh-cpamc login` 备用。V5 不通过时，VPS 上再加回来 |
| Q2 | 用户在 CPAMC 里加了六个以外的来源（例如 Gemini），它的模型进不进 DSH？ | 0.1 暂不放进 DSH；建议的「其他来源」折叠分组待实现 |
| Q3 | 余额、签到这类渠道功能要不要在面板里做？ | 0.1 只显示 Claude / Codex 的用量；渠道余额待接入，签到等留在 CPAMC |
