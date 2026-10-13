// plugin/remote-deploy.js — 从这台电脑上的 DSH，经 SSH 把 dsh-cpamc 装到（或卸出）一台已经有 DSH 的服务器（设计 §9.1）
//
// 改写自 dsh-vps 的 plugin/remote-install.mjs（同一作者，MIT）：校验、SSH 参数、密码传递、失败说明沿用它的做法，
// 服务器上执行的换成 npm install -g dsh-cpamc@<本机插件的版本> && dsh-cpamc setup。
//   - 密码只进这一次 ssh 子进程的环境变量，经 SSH_ASKPASS 小脚本交给 ssh：不写盘、不进日志、不保存。
//     不填密码就用本机已有的 SSH 密钥
//   - 服务器上以 nohup + setsid 后台运行，日志写 /var/log/dsh-cpamc-deploy.log；这边只是 tail 它，SSH 中途断开照样跑完
//   - 同一时间只跑一个任务；结果留在内存里供界面轮询
// 路由挂在 DSH 的 /api 通道（ctx.connection.fetch），由 DSH 自己做同源与登录校验。

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const LOGS = { install: '/var/log/dsh-cpamc-deploy.log', uninstall: '/var/log/dsh-cpamc-undeploy.log' }
const JOB_TIMEOUT_MS = 30 * 60_000
const MAX_LINES = 400

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[?[0-9A-Fa-f:.]+\]?)$/
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const T = (lang, zh, en) => (lang === 'en' ? en : zh)

/** 校验并规整表单；返回 { value } 或 { error }（界面直接展示 error） */
export function validateRequest(body, lang = 'zh') {
  const b = body && typeof body === 'object' ? body : {}
  const host = String(b.host ?? '').trim().replace(/^\[|\]$/g, '')
  const port = Number(b.port ?? 22)
  const user = String(b.user ?? 'root').trim() || 'root'
  const password = typeof b.password === 'string' ? b.password : ''
  const action = b.action === 'uninstall' ? 'uninstall' : 'install'
  const mirror = action === 'install' && b.mirror === true
  const keepAuth = action === 'uninstall' && b.keepAuth === true
  if (!host || host.length > 253 || !HOST_RE.test(host)) return { error: T(lang, '服务器地址格式不对（填公网 IP 或能解析到它的域名）', 'Server address looks wrong (use its public IP or a domain that resolves to it)') }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: T(lang, 'SSH 端口应为 1–65535', 'SSH port must be 1–65535') }
  if (!USER_RE.test(user)) return { error: T(lang, '用户名格式不对', 'Invalid user name') }
  if (password.length > 1024) return { error: T(lang, '密码太长', 'Password too long') }
  return { value: { action, host, port, user, password, mirror, keepAuth } }
}

/** 服务器上执行的脚本（经 stdin 交给 sh -s，参数不进命令行） */
export function remoteScript({ action = 'install', version, mirror = false, keepAuth = false }) {
  if (!VERSION_RE.test(String(version))) throw new Error(`bad version: ${version}`)
  const log = LOGS[action === 'uninstall' ? 'uninstall' : 'install']
  const registry = mirror ? ' --registry=https://registry.npmmirror.com' : ''
  const work =
    action === 'uninstall'
      ? `command -v dsh-cpamc >/dev/null 2>&1 || { echo "dsh-cpamc is not installed on this server"; exit 0; }; dsh-cpamc uninstall --yes --remove-plugin${keepAuth ? ' --keep-auth' : ''}`
      : `npm install -g dsh-cpamc@${version}${registry} && dsh-cpamc setup`
  return [
    'set -u',
    'if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo -n"; $SUDO true 2>/dev/null || { echo "DSHCPAMC_ERR=need_root"; exit 3; }; fi',
    // 前提：服务器上已经有能用的 DSH（dsh-vps 装的，或自己装的），以及 Node 20+ 与 npm
    'command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || { echo "DSHCPAMC_ERR=no_node"; exit 5; }',
    'M=$(node -p "process.versions.node.split(\'.\')[0]" 2>/dev/null || echo 0); [ "$M" -ge 20 ] 2>/dev/null || { echo "DSHCPAMC_ERR=old_node"; exit 5; }',
    action === 'install' ? '[ -d /opt/dsh-vps ] || command -v dsh >/dev/null 2>&1 || [ -d /home/dsh/.dsh ] || [ -d "$HOME/.dsh" ] || { echo "DSHCPAMC_ERR=no_dsh"; exit 6; }' : 'true',
    `L=${log}`,
    '$SUDO rm -f "$L"',
    // 后台独立运行：SSH 断开不影响；结束时在日志末尾写退出码
    `$SUDO nohup setsid sh -c 'L="$1"; shift; { ${work.replace(/'/g, `'\\''`)}; echo "DSHCPAMC_EXIT=$?"; } >>"$L" 2>&1' dshcpamc "$L" </dev/null >/dev/null 2>&1 &`,
    'P=$!',
    'for i in 1 2 3 4 5 6 7 8 9 10; do [ -f "$L" ] && break; sleep 1; done',
    'echo "DSHCPAMC_STARTED"',
    '$SUDO tail -n +1 -f --pid="$P" "$L" 2>/dev/null',
    '$SUDO tail -n 3 "$L" 2>/dev/null | grep "^DSHCPAMC_EXIT=" || true',
  ].join('\n') + '\n'
}

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '')

export function noSshClientHint(platform = process.platform, lang = 'zh') {
  return platform === 'win32'
    ? T(lang, '本机找不到 ssh 命令：打开 Windows「设置 → 系统 → 可选功能」，添加「OpenSSH 客户端」，装好后重启 DSH', 'No ssh command on this computer: in Windows Settings → System → Optional features, add "OpenSSH Client", then restart DSH')
    : T(lang, '本机找不到 ssh 命令：先装 OpenSSH 客户端，装好后重启 DSH', 'No ssh command on this computer: install the OpenSSH client, then restart DSH')
}

/** ssh 失败说人话 */
export function classifyFailure(stderr, exitCode, usedPassword, platform = process.platform, lang = 'zh') {
  const t = String(stderr)
  if (/\bENOENT\b/.test(t)) return noSshClientHint(platform, lang)
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(t)) return T(lang, '服务器的 SSH 指纹和本机记录的不一致（重装过系统？）。确认无误后在本机执行 ssh-keygen -R <服务器地址> 再试', 'The server\'s SSH fingerprint differs from the one on record (reinstalled?). If expected, run ssh-keygen -R <server> and retry')
  if (/Permission denied \(publickey\)/i.test(t) && usedPassword) return T(lang, '这台服务器关掉了密码登录，只认密钥：把密码留空，用本机已配置好的 SSH 密钥登录', 'This server disabled password login and only accepts keys: leave the password empty to use your SSH key')
  if (/Permission denied/i.test(t)) return usedPassword ? T(lang, '密码不对，或这个用户不允许用密码登录（有的系统默认禁止 root 密码登录）', 'Wrong password, or this user may not log in with a password (some systems forbid root password login)') : T(lang, '本机的 SSH 密钥登录不了这台服务器：填上密码再试', 'Your SSH key cannot log in to this server: enter the password and retry')
  if (/Could not resolve hostname/i.test(t)) return T(lang, '服务器地址解析不了，检查一下是否填错', 'The server address does not resolve; check it')
  if (/Connection closed by|Connection reset by|kex_exchange_identification/i.test(t)) return T(lang, '服务器断开了 SSH 连接：确认端口确实是 SSH 端口，以及服务器防火墙、fail2ban 是否拦截了本机的地址', 'The server closed the SSH connection: check the port is SSH and that a firewall or fail2ban is not blocking you')
  if (/Connection refused/i.test(t)) return T(lang, 'SSH 端口拒绝连接：检查端口号，以及服务器防火墙 / 安全组是否放行', 'SSH port refused: check the port and the firewall / security group')
  if (/timed out|No route to host|Network is unreachable/i.test(t)) return T(lang, '连不上服务器：检查地址和端口，以及云厂商安全组是否放行 SSH', 'Cannot reach the server: check address, port and the cloud security group')
  if (exitCode === 3) return T(lang, '这个用户不是 root，也没有免密 sudo。请改用 root，或先给该用户配置免密 sudo', 'This user is not root and has no passwordless sudo; use root or configure passwordless sudo')
  if (exitCode === 5) return T(lang, '服务器上没有 Node 20 以上和 npm。DSH 本身就需要它们：先在服务器上装好 DSH 再部署', 'The server has no Node 20+ and npm, which DSH itself needs: install DSH on the server first')
  if (exitCode === 6) return T(lang, '服务器上没找到 DSH。dsh-cpamc 是 DSH 的插件，先在服务器上装好 DSH 再部署', 'No DSH found on the server. dsh-cpamc is a DSH plugin: install DSH on the server first')
  const last = t.replace(/\r/g, '').trim().split('\n').filter((l) => l && !/^Warning: Permanently added/i.test(l)).pop()
  return last ? T(lang, `SSH 连接失败：${last}`, `SSH failed: ${last}`) : T(lang, `SSH 连接失败（退出码 ${exitCode}）`, `SSH failed (exit code ${exitCode})`)
}

/** 部署任务：同一时间只有一个 */
export function createDeployer({ version, spawnImpl = spawn, platform = process.platform, env = process.env, now = Date.now } = {}) {
  let job = null

  function snapshot() {
    if (!job) return { job: null }
    const { child, timer, ...rest } = job
    return { job: { ...rest, lines: job.lines.slice(-MAX_LINES) } }
  }

  async function start(value, lang = 'zh') {
    if (job && job.state === 'running') return { error: T(lang, '已经有一个任务在进行中，等它结束再试', 'A job is already running; wait for it to finish'), status: 409 }
    const { host, port, user, password, mirror, keepAuth } = value
    const action = value.action === 'uninstall' ? 'uninstall' : 'install'
    const remoteLog = LOGS[action]
    job = { action, state: 'running', host, port, user, mirror, keepAuth, version, startedAt: now(), endedAt: null, lines: [], error: null, phase: 'connecting' }
    const current = job
    const target = `${user}@${host.includes(':') ? `[${host}]` : host}`
    const args = ['-T', '-p', String(port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8', '-o', 'ControlMaster=no', '-o', 'ControlPath=none']
    let askDir = null
    const childEnv = { ...env }
    if (password) {
      askDir = await mkdtemp(join(tmpdir(), 'dsh-cpamc-askpass-'))
      const helper = join(askDir, platform === 'win32' ? 'askpass.cmd' : 'askpass.sh')
      if (platform === 'win32') await writeFile(helper, `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" -e "process.stdout.write(process.env.DSH_CPAMC_PW+'\\n')"\r\n`)
      else await writeFile(helper, '#!/bin/sh\nprintf \'%s\\n\' "$DSH_CPAMC_PW"\n', { mode: 0o700 })
      args.push('-o', 'PreferredAuthentications=keyboard-interactive,password', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1')
      Object.assign(childEnv, { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: env.DISPLAY || ':0', DSH_CPAMC_PW: password })
    } else {
      args.push('-o', 'BatchMode=yes')
    }
    args.push('--', target, 'sh -s')

    let child
    try {
      child = spawnImpl('ssh', args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      if (askDir) rm(askDir, { recursive: true, force: true }).catch(() => {})
      current.state = 'failed'
      current.error = /ENOENT/.test(String(error.message)) ? noSshClientHint(platform, lang) : T(lang, `无法启动 ssh：${error.message}`, `Could not start ssh: ${error.message}`)
      current.endedAt = now()
      return { job: snapshot().job }
    }
    current.child = child
    let stderr = ''
    let buf = ''
    const outDec = new StringDecoder('utf8')
    const errDec = new StringDecoder('utf8')
    const push = (line) => {
      const clean = strip(line)
      if (clean === 'DSHCPAMC_STARTED') {
        current.phase = 'running'
        return
      }
      current.lines.push(clean)
      if (current.lines.length > MAX_LINES * 2) current.lines.splice(0, current.lines.length - MAX_LINES)
    }
    child.stdout.on('data', (d) => {
      buf += outDec.write(d)
      const parts = buf.split('\n')
      buf = parts.pop()
      for (const p of parts) push(p)
    })
    child.stderr.on('data', (d) => {
      stderr = (stderr + errDec.write(d)).slice(-4000)
    })
    const finish = (code) => {
      if (current.endedAt) return
      clearTimeout(current.timer)
      if (buf) push(buf)
      if (askDir) rm(askDir, { recursive: true, force: true }).catch(() => {})
      current.endedAt = now()
      const exitLine = current.lines.find((l) => /^DSHCPAMC_EXIT=\d+/.test(l))
      current.lines = current.lines.filter((l) => !/^DSHCPAMC_(EXIT|ERR)=/.test(l))
      const remoteExit = exitLine ? Number(exitLine.split('=')[1]) : null
      if (remoteExit === 0) current.state = 'success'
      else if (remoteExit !== null) {
        current.state = 'failed'
        current.error = T(lang, `服务器上执行失败（退出码 ${remoteExit}），详见下方日志；完整日志在服务器的 ${remoteLog}`, `Failed on the server (exit code ${remoteExit}); see the log below; full log on the server: ${remoteLog}`)
      } else if (current.phase === 'running') {
        current.state = 'failed'
        current.error = T(lang, `与服务器的连接中断了，但任务仍在服务器上继续。稍后 SSH 登录执行 sudo tail -n 50 ${remoteLog} 查看结果`, `The connection dropped, but the job keeps running on the server. Later, SSH in and run sudo tail -n 50 ${remoteLog}`)
      } else {
        current.state = 'failed'
        current.error = classifyFailure(stderr, code, Boolean(password), platform, lang)
      }
    }
    child.on('error', (error) => {
      stderr += `\n${error.message}`
      finish(255)
    })
    child.on('close', (code) => finish(code))
    current.timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // 已退出
      }
    }, JOB_TIMEOUT_MS)
    child.stdin.end(remoteScript({ action, version, mirror, keepAuth }))
    return { job: snapshot().job }
  }

  function dispose() {
    if (job?.child && !job.endedAt) {
      try {
        job.child.kill('SIGTERM')
      } catch {
        // 已退出
      }
    }
  }

  return { start, snapshot, dispose }
}
