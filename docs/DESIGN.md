# dsh-cpamc 设计方案

> 状态：设计稿，尚未实现。
> 版本：0.1.0 的目标设计。

---

## 1. 目标

让一个**只有 DSH** 的人，不用碰命令行、不用装任何别的东西，就能拿到一套完整可用的
CLIProxyAPI（下称 CPA）+ CPAMC 管理界面。

具体说，装上插件之后用户应该能：

1. 在 DSH 里点一下，打开**完整的 CPAMC 界面**（官方那一套，不是子集）
2. 引擎、配置、密钥、端口都由插件备好，用户不需要知道这些东西存在
3. 如果机器上已经有 CPA 在跑，可以选择**附着**上去，而不是再起一个

## 2. 非目标

- **不做**把 CPA 功能重写成 DSH 原生界面的那套。界面就是 CPAMC 官方前端，一个不少。
- **不做**模型的接入侧（key 管理、来源开关、模型别名）。那是别的插件的事。
- **不追求**比手动装 CPA 更"高级"。目标只是**更省事**。

## 3. 已定的决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | 界面来源 = **嵌入 CPAMC 官方前端** | 功能完整度是这条路的核心价值 |
| D2 | 附着模式 = **可写** | 附着后能改配置，不只是只读观察 |
| D3 | 引擎 = **首次运行自动下载** | 用户不需要自己装 CPA |
| D4 | 端口 = **占用自动切换 + 持久化** | 见 §4.7 |
| D5 | 界面形态 = **DSH 全屏浮层**（`shell.overlay`） | |
| D6 | 与 dsh-model 无关 | 独立产品，各跑各的实例 |

---

## 4. 架构

### 4.1 总体

插件是标准的 DSH 双半边结构（照 dsh-model / dsh-cpa-monitor 的写法）：

| 半边 | 文件 | 运行环境 | 职责 |
|---|---|---|---|
| 宿主端 | `lib/index.js` | Cordis（`dsh web` / 桌面版主进程） | 下载引擎、管进程、挑端口、伺服面板、反代管理 API、注册配置面 |
| 客户端 | `lib/client.js` | 浏览器（DSH 外壳） | 注册 `shell.overlay` 全屏浮层 + 设置项 |

数据流：

```
DSH 外壳
  └ shell.overlay 全屏浮层
       └ iframe → 面板服务（loopback 独立端口）
            ├ /            → CPAMC 官方前端（注入 bootstrap）
            └ /v8/management/* → 反代到目标 CPA 实例（服务端注入密钥）
```

### 4.2 CPAMC 前端从哪来

**从 CPAMC 官方 release 下载，不由引擎提供。**

- 源：`router-for-me/Cli-Proxy-API-Management-Center` 的 release，asset 是单个
  `management.html`（约 3.1 MB）
- 锁版本 + 硬编码 sha256；缓存在 `~/.dsh-cpamc/panel/<version>/management.html`
- 多源 fallback（官方 GitHub → 镜像），失败可手动放文件

**为什么不用引擎自带的那份？**

引擎二进制里确实内嵌了 CPAMC（实测：把 `management.disable-control-panel` 设成 `false`，
`/management.html` 立刻返回 3,290,277 B 的完整界面）。但：

1. **附着场景用不了。** 附着到别人的实例时，我们改不了它的配置，
   它的 `disable-control-panel` 大概率还是 `true`，`/management.html` 是 404。
2. **安全姿态更好。** 引擎端口上永远不暴露任何网页，界面只在插件自己的面板服务上。
3. **一条代码路径。** 自建和附着共用同一套前端，不用分支。

代价是多一个 3.1 MB 的下载。相对引擎本体（约 63 MB）可以忽略。

### 4.3 界面怎么伺服 —— 两个候选

这是本设计里**最需要拍板的一处**，因为两条路的隔离性差一个量级。

#### 候选 A：挂在 DSH 自己的 webServer 上（同源）

宿主端在 DSH 的 webServer 上注册 `/dsh-cpamc/*`，iframe 指向同源路径。

- ✅ 实现最简单，不用额外端口
- ✅ 天然过 DSH 的登录校验
- ❌ **隔离不了。** 同源意味着 DSH 页面里**任何能执行 JS 的东西**都能调用
  `/dsh-cpamc/v8/management/*`，浏览器会自动带上我们注入的密钥。
  DSH 的插件机制本身就允许插件往页面注入 JS——所以一个第三方插件可以静默拿到
  CPA 的完全控制权（改配置、读全部凭据、看所有 API key）。
- ❌ 加 httpOnly cookie 也没用：**能挡住读 cookie，挡不住发请求**（浏览器会自动带）。
- ❌ 加页面令牌也没用：同源脚本读得到 DOM 和 JS 变量。

#### 候选 B：插件自己起一个 loopback 面板服务（跨源）**（推荐）**

宿主端在 `127.0.0.1` 的一个独立端口上 `http.createServer()`，iframe 指向它。
不需要新进程，只是宿主端多 listen 一个端口。

- ✅ **真正的跨源隔离。** DSH 页面里的其他插件读不到那个 origin 的 storage，
  也读不到跨源 iframe 的 `location`。
- ✅ **没有 CORS 问题** —— 前端和反代在同一个 origin（面板服务自己）。
- ✅ **没有 X-Frame-Options 问题** —— 前端是我们自己伺服的文件，不加限制头。
- ✅ 密钥不进浏览器（服务端反代时注入）。
- ⚠️ 多一个端口要管；多一层要保证只绑 `127.0.0.1`。
- ⚠️ **依赖 DSH 外壳的 CSP 允许跨源 iframe** —— 见 §8，必须先实测。

**倾向 B。** 代价是一个 loopback 端口，换到的是"其他插件碰不到这个界面和密钥"。
候选 A 的风险无法在插件层面消除，只能靠"用户信任自己装的每个插件"这个前提兜着。

### 4.4 密钥怎么给

**不进浏览器。** 面板服务在反代 `/v8/management/*` 时，于服务端加上
`Authorization: Bearer <managementKey>`，覆盖前端传来的任何值。

前端仍然需要一个**非空**的占位 `managementKey`——因为 CPAMC 的 `checkAuth` 是
`if (!managementKey || !apiBase) return false`，空值会跳登录页。所以注入一个固定占位串
（如 `dsh-cpamc-managed`），真实密钥由服务端兜住。

### 4.5 自动登录

CPAMC 是 zustand persist 到 localStorage 的，键为 `apiBase` / `managementKey` /
`isLoggedIn`，值默认做了混淆，但它有 `migratePlaintextKeys()` 会自动迁移明文——
所以**注入明文即可**。

启动逻辑（反编译产物确认）：若 `isLoggedIn === 'true'` 且 `apiBase` 与 `managementKey`
非空，则直接走自动登录，不显示登录页。

注入方式：伺服 `management.html` 时在 `<head>` 最前面插一段 `<script>`，写入上述三个键。

**两个必须遵守的约束**（都从 CPAMC 源码里挖出来的）：

1. **`apiBase` 必须是绝对 URL，带 `http://` 或 `https://` 前缀。**
   它的规范化函数是：
   ```js
   tp = e => { ...; /^https?:\/\//i.test(t) || (t = `http://${t}`); return t }
   ```
   传相对路径 `/dsh-cpamc` 会被拼成畸形的 `http:///dsh-cpamc`。
2. **不能依赖它的自动推导。**
   ```js
   rp = () => { const {protocol, hostname, port} = location; return tp(`${protocol}//${hostname}${port?':'+port:''}`) }
   ```
   它只取 **origin**，把 pathname 整个丢掉。所以在候选 A（挂在 `/dsh-cpamc/` 前缀下）
   必须显式写死 `apiBase`；在候选 B 下 `rp()` 恰好推导出面板服务的 origin，天然正确，
   但仍建议显式注入以免依赖内部行为。

**路由前缀不是问题**：CPAMC 用的是 **HashRouter**（`BrowserRouter` / `createBrowserHistory`
在产物里出现次数为 0，被 tree-shake 掉了），SPA 路由跑在 `#/dashboard` 这类 hash 里，
永远不会请求到服务端路径。所以挂在任意前缀下都安全。

### 4.6 引擎的获取与安装

- 源：`router-for-me/CLIProxyAPI` 的 release
- **锁版本**，不要用 latest：CPAMC 的界面与 CPA 的 v8 管理 API 是配套的，
  而且 CPA 的配置格式在 v7→v8 变过一次。用 latest 会让插件在用户机器上突然崩。
- 每平台硬编码 asset 名与 sha256。上游 v8.0.13 的资产长这样：

  ```
  CLIProxyAPI_<ver>_darwin_aarch64.tar.gz
  CLIProxyAPI_<ver>_darwin_amd64.tar.gz
  CLIProxyAPI_<ver>_linux_aarch64.tar.gz
  CLIProxyAPI_<ver>_linux_amd64.tar.gz
  CLIProxyAPI_<ver>_windows_aarch64.zip      ← Windows 是 .zip
  CLIProxyAPI_<ver>_windows_amd64.zip
  CLIProxyAPI_<ver>_*_no-plugin.tar.gz
  checksums.txt
  ```

- 安装到 `~/.dsh-cpamc/engine/versions/<ver>/`，`current` 软链指过去
- 校验：sha256 **硬编码在插件里**，不从网络取
- 下载完 **`chmod 0o755`**

#### 平台映射（这块必须写对）

| `process.platform` | `process.arch` | 上游 asset 段 | 归档 |
|---|---|---|---|
| `darwin` | `arm64` | `darwin_aarch64` | `.tar.gz` |
| `darwin` | `x64` | `darwin_amd64` | `.tar.gz` |
| `linux` | `arm64` | `linux_aarch64` | `.tar.gz` |
| `linux` | `x64` | `linux_amd64` | `.tar.gz` |
| `win32` | `x64` | `windows_amd64` | **`.zip`** |
| `win32` | `arm64` | `windows_aarch64` | **`.zip`** |

两个坑：

1. Node 返回 **`win32`**，上游用 **`windows`** —— 必须映射，不能直接拼。
2. Windows 是 **`.zip`**，其他平台是 `.tar.gz` —— 解压路径要分开。

#### 平台守卫（必须做）

**在下载之前**就判断平台是否支持，不支持则明确报错退出。

这条是从一次真实事故来的：`dsh-cpa-switch@0.12.0` 把资源名硬编码成
`CLIProxyAPI_*_windows_amd64.zip`，在 macOS 上照下不误，然后 `spawn` 那个
Windows PE 文件 → `EACCES` → **fatal uncaught exception 把整个 DSH 拖崩**，
用户连界面都进不去。它没有平台守卫，代价是宿主进程挂掉。

引擎二进制名在 Windows 上还要带 `.exe` 后缀。

### 4.7 端口

**默认 8317**（CPA 的惯例端口）。

规则：

```
首次启动 → 从默认端口开始往上找
         → 每个候选端口做一次真正的 bind 测试（net.createServer().listen）
         → 占用则 +1，最多试 N 个
         → 选中的端口写进 ~/.dsh-cpamc/config.json 持久化
后续启动 → 先试记录里的端口
         → 还在 → 直接用，什么都不变
         → 被占 → 重新找，并在界面上明确提示"端点已变更"
```

两个要点：

1. **探测必须真 bind，不能只 connect。** 有些程序占着端口但不接受连接，
   只看 connect 会误判成空闲，然后在启动引擎时才发现起不来。
2. **端口必须持久化。** 这个实例的 `/v1` 端点是给用户**外部客户端**用的
   （Cursor、Claude Code、自己的脚本）。端口每次重启都变会让用户配好的东西全废，
   而且报错信息很难懂。

另外允许用户**手动指定**端口——有人要固定端口做转发或防火墙规则，自动挑反而是麻烦。

### 4.8 实例发现与附着

用户选 `attached` 模式时，插件去找一个已有的 CPA 实例。

**发现方式**（按可靠性排序）：

1. **引擎自带的发现能力。** 实测 `--help` 里有：
   ```
   -discover         Discover local AI gateways and CPA instances on the LAN
   -discover-json    Output discovered gateways in JSON format
   -discover-service-type string   DNS-SD service type (default _ai-gateway._tcp)
   ```
   官方就有发现机制，比猜端口靠谱。**是否默认广播、能否扫到本机实例需要实测**（见 §8）。
2. **用户手动填。** 端口 + 管理密钥。最可靠，任何时候都能用。
3. **读已知位置的文件。** 例如 `~/.dsh-model/mgmt.json` 里有明文的 `dshg_...`。
   能做，但这是**跨产品私有文件耦合**，对方改个格式就崩。
   如果做，必须**明确告诉用户"我要去读 XX 文件了"**，不能静默。

**附着的硬约束**：管理 API 需要密钥，而引擎配置里的 `secret-key` 可能是
**bcrypt 哈希**（dsh-model 就是这么写的：`mgmt.json` 存明文，`engine.yaml` 存它的哈希）。
**哈希不可逆，读不出原值。** 所以密钥只能来自：用户手动提供，或者某个恰好存了明文的地方。

**附着的前提**：目标实例必须是 **CPA ≥ 8.0.0**（CPAMC 的硬要求）。
探测到低版本要明确拒绝，而不是连上去显示一堆空白。

#### 附着是可写的 —— 必须警告

D2 定的是可写。这意味着：

> 如果那个实例正被别的程序管理（比如 dsh-model 用 launchd 托管、配置由它生成），
> 用户在 CPAMC 里改的东西**可能被那个程序覆盖回去**。

插件**必须在附着模式的界面上显著提示这一点**，并显示"当前在管哪个实例"
（端口号 + 配置目录路径）。这不是锦上添花——用户很容易在错误的实例上配半天。

附着模式下插件**不碰目标实例的进程**，只连它的管理 API。

### 4.9 生命周期

| 模式 | 引擎进程 |
|---|---|
| `managed`（自建） | 插件负责：启动 / 停止 / 开机自启（macOS `launchd`、Linux `systemd --user`、Windows 计划任务） |
| `attached`（附着） | **不碰**。目标实例由它自己的管理者负责 |

`managed` 模式下，插件生成的 `config.yaml` 里：
- `management.secret-key`：用**明文**（便于自己反代时使用；不要用 bcrypt）
- `management.disable-control-panel: true`（界面由我们自己伺服，引擎端口不暴露网页）
- `management.allow-remote: false`
- `server.host: 127.0.0.1`

---

## 5. 配置

按 DSH 的三层覆盖：**schema 默认 → 组合层（`cordis.patch.yml`）→ 用户层**。

用户层落点随 DSH 版本变化（≤0.1 是 `$DSH_HOME/settings.yaml`，≥0.2 是当前 profile 的配置文档）。
DSH 0.2 的配置表单只保留标了 `meta.volatile` 的字段，标记方式用
`.extra("volatile", true)` 而不是 `.volatile()`（后者只存在于宿主打过补丁的
schemastery 3.18.4 里，公开发布的 3.18.2 没有这个方法）。

字段草案：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `managed` \| `attached` | `managed` | |
| `port` | number | `8317` | 自建实例端口，`0` = 自动挑 |
| `attach.baseURL` | string | — | 附着目标，如 `http://127.0.0.1:8317` |
| `attach.managementKey` | secret | — | 附着目标的管理密钥 |
| `engineVersion` | string | 锁定值 | |
| `panelVersion` | string | 锁定值 | CPAMC 前端版本 |
| `proxy` | string | — | 下载与上游请求用的代理 |
| `autoStart` | boolean | `true` | 开机自启（仅 managed） |
| `openIn` | `overlay` \| `browser` | `overlay` | 在哪打开界面 |

---

## 6. 平台适配

目标是 macOS / Linux / Windows 全平台，但工作量差异很大：

| 平台 | 引擎 | 服务托管 | 工作量 |
|---|---|---|---|
| macOS | ✅ 上游有包 | `launchd` | 小 |
| Linux | ✅ 上游有包 | `systemd --user` | 小 |
| Windows | ✅ 上游有包（`.zip`） | **没有现成方案** | 大 |

Windows 是真正的工作量所在：没有 launchd/systemd 那套"写个配置文件 + 调一个命令"的
简单路径。选项是 `sc.exe`（要管理员权限）、计划任务（行为差异大）、
或者放弃守护、只做前台启动。

**建议**：先把 macOS / Linux 做扎实，Windows 单独一个里程碑。

---

## 7. 安全与风险

| 风险 | 说明 | 处理 |
|---|---|---|
| **同源下的插件互扰** | 若走候选 A，DSH 页面里任何能执行 JS 的东西都能调用管理 API | 走候选 B（跨源） |
| **密钥泄漏到前端** | CPAMC 前端会调管理 API | 服务端反代注入，前端只有占位值 |
| **本机暴露** | 面板服务与引擎都监听端口 | 一律只绑 `127.0.0.1` |
| **附着时覆盖别人的配置** | D2 选了可写 | 界面显著警告 + 显示当前实例 |
| **下载被投毒** | 引擎和前端都从网络下载 | sha256 硬编码在插件里校验 |
| **不支持的平台拖崩宿主** | 见 §4.6 的真实事故 | 下载前平台守卫 |
| **配置双写冲突** | 附着到被别的程序管理的实例时 | 明确警告；不静默接管 |

**一句诚实的话**：DSH 的插件模型本身就要求"用户信任自己装的插件"。
上面这些措施能缩小攻击面，但**不能**在插件层面彻底解决同源互扰——
这是选择候选 B 的原因，也是它值得那一个额外端口的原因。

---

## 8. 必须先实测的前置条件

这几条不验证就动手，很可能白写：

1. **DSH 外壳的 CSP 是否允许 iframe。**
   同源（候选 A）和跨源 loopback（候选 B）都要测。如果 CSP 卡死 `frame-src`，
   整个浮层方案就得改（退化成"唤起系统浏览器"）。
2. **OAuth 流程在 iframe 里能不能走通。**
   CPAMC 里的 OAuth（Codex / Claude / Kimi / Gemini…）会跳外部授权页再回调到
   `http://localhost:<port>`。在 iframe 里做这个大概率有问题，可能要 `window.open` 新窗口；
   而新窗口如果没有 bootstrap 注入，会要求重新登录。
3. **CPAMC 的 `rp()` 在独立端口下推导是否正确**（候选 B 的关键前提）。
4. **引擎的 `-discover` 能否发现本机实例**、是否需要实例开启广播。
5. **`shell.overlay` 的尺寸与滚动行为** —— CPAMC 是为整页设计的（有侧边栏、多级路由），
   塞进浮层里可能出现嵌套滚动条、弹窗被裁剪。

---

## 9. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| **M0** | 实测 §8 的 5 条 | 结论 + 方案定稿（含 A/B 最终选择） |
| **M1** | 自建实例 + 面板能打开 | 最小可用：装上就能看到 CPAMC |
| **M2** | 自动登录 + 配置面 + 端口持久化 | 用户不用输密钥、不用管端口 |
| **M3** | 附着模式（可写）+ 实例标识 | 能接管已有实例 |
| **M4** | Windows 支持 | 全平台 |

`0.0.x` 是名字占位，`0.1.0` 从 M1 开始。

---

## 附：本设计中已验证的技术事实

以下都是实测或读源码确认的，不是推测：

| 事实 | 来源 |
|---|---|
| 引擎二进制内嵌 CPAMC，`disable-control-panel: false` 时 `/management.html` 返回 3,290,277 B | 临时实例实测 |
| CPAMC 用 HashRouter，挂在任意前缀下安全 | 反编译产物 |
| `apiBase` 非绝对 URL 会被强行补 `http://` | 反编译产物 `tp()` |
| 自动推导只取 origin、丢弃 pathname | 反编译产物 `rp()` |
| 自动登录条件是 `isLoggedIn` + `apiBase` + `managementKey` 三者非空 | 反编译产物 |
| 明文注入会被 `migratePlaintextKeys()` 自动迁移 | 反编译产物 |
| CPAMC 要求 CPA ≥ 8.0.0，只用 v8 Management API | CPAMC README |
| 上游发布资产命名（含 Windows 是 `.zip`） | GitHub release API |
| 引擎自带 `-discover` / DNS-SD `_ai-gateway._tcp` | `cli-proxy-api --help` |
| DSH 插件为 Cordis 双半边，宿主端可挂路由到 dsh webServer | dsh-model / dsh-cpa-monitor 源码 |
| 已知槽位：`settings.section`、`shell.overlay`、`sidebar.footer.action` | 现有插件源码 |
| 无平台守卫会导致宿主进程崩溃 | dsh-cpa-switch 在 macOS 上的真实崩溃日志 |
