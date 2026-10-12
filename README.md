# dsh-cpamc

**在 DeepSeek Harness（dsh）里打开完整的 CPAMC 管理界面。**

> **状态：`0.0.1` 是占位版本，还没有任何实现。**
>
> 这个版本只为在 npm 上占住 `dsh-cpamc` 这个名字。它**不是**一个可用的 dsh 插件
> ——`package.json` 里刻意没有 `dsh` 字段，所以 dsh 不会加载它，装上去也不会有任何效果。
> 请等 `0.1.0`。

---

## 它要做什么

CPAMC 是 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的网页管理界面
（独立仓库：[Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)，
MIT）。它有仪表盘、配置面板、AI 提供商、认证文件与 OAuth、配额、日志、插件、系统信息——
一整套东西。

问题是：想用上它，你得先自己把 CLIProxyAPI 装起来、写 `config.yaml`、挑端口、配密钥、
启动服务，然后再去开浏览器。

**dsh-cpamc 想把这些都省掉。** 装上插件，在 dsh 里点一下，就有一个能用的完整 CPAMC。

## 计划中的做法

- **自带引擎**：首次运行时按平台自动下载 CLIProxyAPI 并校验 sha256，生成配置、挑端口、拉起进程。
- **完整界面**：直接把官方 CPAMC 的前端搬进来，功能一个不少。上游更新能直接获得，
  也不会出现「某个功能没做，还得去开网页」的情况。
- **复用已有实例**：机器上已经有 CLIProxyAPI 在跑时，优先复用，不覆盖它的配置。
- **端口会躲让**：默认端口被占用时自动换一个，并且**持久化**——因为这个实例的 `/v1` 端点
  是要给外部客户端用的，端口每次重启都变会让用户的配置全废。
- **界面形态**：在 dsh 里以全屏浮层打开。

## 前置条件

- DeepSeek Harness
- Node ≥ 20
- 平台：macOS / Linux / Windows（**目标**是全平台，具体支持范围随实现确定）
- 能访问 GitHub Release（引擎从这里下载）

## 许可

MIT。见 [LICENSE](./LICENSE)。

非官方项目，与 CLIProxyAPI、CPAMC 的维护者无关。CPAMC 界面版权归
[router-for-me](https://github.com/router-for-me) 所有，本项目只做集成。

---

## English

**Open the full CPAMC console inside DeepSeek Harness (dsh).**

`0.0.1` is a name-reservation placeholder — no implementation yet, and not a usable
dsh plugin (there is deliberately no `dsh` field in `package.json`). Wait for `0.1.0`.

The goal: skip installing and wiring up CLIProxyAPI by hand. The plugin brings the engine
along, downloads it per-platform with sha256 verification on first run, picks a free
(and persisted) port, and opens the official CPAMC front end — the whole thing, not a
subset — inside dsh. MIT licensed.
