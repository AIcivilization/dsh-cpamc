# M0 实测记录

对应 [DESIGN.md](DESIGN.md) §12 的验证项。没有列出的项尚未测试。

## 2026-10-13 · macOS arm64

环境：CPA 官方发布版 8.0.13（与 dsh-model 锁定的版本相同），渠道插件包 v0.8.68 darwin-arm64。在临时目录和临时端口 18417 上启动隔离实例，不涉及本机已有的服务。

### V1 官方 CPA 能否加载渠道插件 —— 通过

- 配置 `plugins.enabled: true`、`plugins.dir: <绝对路径>`，并给 `plugins.configs.<id>.enabled` 逐个设为 `true`。启动日志显示四个插件全部加载并注册：workbuddy 0.9.58、trae 0.12.75、qoder 0.8.63、zcode 0.2.0。
- 插件包里的 mimo 没有启用，状态为 `registered: false`，不影响其他插件。
- 结论：**不需要自己编译 CPA**，直接用官方发布版。其余平台仍需逐个实测。

### V2 四个渠道在原版管理界面中可见、可登录 —— 通过（登录本身未完成）

- `GET /v0/management/plugins`：四个渠道都是 `effective_enabled: true`、`supports_oauth: true`，并带有图标和配置项（例如 Qoder 的 `login_region: cn|intl`）。
- `GET /v0/management/plugins/<id>/accounts`：四个渠道都返回 200。
- `GET /v8/management/oauth/auth-url?provider=<id>`：四个渠道都返回授权链接和 `state`。
- 管理界面左侧栏的「插件」分组里列出了 Qoder、Trae、WorkBuddy、ZCode，每个渠道都有自己的账号面板（导入凭据、刷新、签到、任务等）。
- 渠道面板提供「粘贴回调地址」的输入框（`/v0/resource/plugins/<id>/panel`、`oauth_submit`）。浏览器访问不到本机回调地址时（例如 VPS），也能完成登录。
- 未测：真实账号登录、模型目录、实际调用。需要用户提供账号，留到下一轮。

### V3 管理页的提供方式和版本锁定 —— 已查明

- 第一次访问时，CPA 下载 `management.html`（单文件，约 3.2 MB），存放在 `<工作目录>/static/management.html`。
- 配置项 `management.disable-auto-update-panel: true`：只在文件缺失时下载，之后不再自动更新。
- `management.panel-github-repository`：指定管理页的下载来源。
- 做法：dsh-cpamc 预先把锁定版本放到 `static/management.html`（在 manifest 里写明 sha256），并开启 `disable-auto-update-panel`。
- 本次下载到的版本是 v8.0.13 对应的管理页，sha256 为 `808cfd05ce5766a0f3854f8e095e5c5ea6e4313399f2df0d52b7a40352be29df`。

### V6 管理界面在子路径 `/cpamc/` 下能否使用 —— 可用，首次需要手动填一次地址

用一个去掉 `/cpamc` 前缀再转发的本机代理模拟 gate：

- 页面在 `/cpamc/management.html` 下可以正常加载，因为它是单文件。
- 登录页默认的连接地址只取了域名部分（`http://host`），**没有带上子路径**。勾选「自定义连接地址」，填入 `http://host/cpamc` 后即可登录。之后所有请求（`/cpamc/v8/management/*`、`/cpamc/v0/resource/plugins/*`、`/cpamc/v1/models`）都正确带上前缀。
- 浏览器会记住这个地址，只需填一次。「全部功能」卡片要给出这一步的提示，并提供可以复制的完整地址。
- 渠道面板要求再输入一次管理密钥：不经代理直接访问时也一样，属于原版行为，与子路径无关。

### 其他

- CPA 启动后会定期从网上更新模型目录（每 3 小时）。这是 CPA 的默认行为，与管理页的版本锁定无关。
- 测试结束后已停止实例和代理，确认 18417、18418 和插件的回调端口都已释放。
