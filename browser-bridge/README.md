# Codex Browser Bridge

复用正在运行的 Codex Chromium 页面，将 DOM 和样式镜像到手机，手机的输入、点击、滚动和附件操作回传原窗口。不修改 Codex 安装包，也不创建第二个 agent。

## 本机启动

Windows 10/11，Node.js 22 或更新版本。Node.js 必须在 PATH 中；桥接服务没有 npm 运行依赖。

在本目录执行：

```powershell
.\setup.ps1
.\start.ps1

# 在终端查看运行信息
.\start.ps1 -Foreground
```

如果当前 PowerShell 禁止执行脚本，可用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1` 和 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1` 运行；这仅影响该进程，不更改系统执行策略。

首次配置生成 `private/config.json` 和 `private/login-password.txt`。Windows 初始化脚本将 `private/` 权限限定到当前用户和 SYSTEM，不覆盖已有配置。密码不会写入服务日志。

Codex 必须以 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223` 启动。可使用仓库的 `proxy-launcher/Launch-Codex.cmd -WithBridge` 一并启动；已经运行的 Codex 必须先完整退出。

电脑打开 `http://127.0.0.1:4788`，使用生成的随机密码登录。此 HTTP 入口只监听回环地址，手机不能直接访问电脑的 `4788` 端口。手机接入使用下面的 HTTPS 入口。

## 配置手机 HTTPS 入口

需要自己控制的域名、有效证书，以及从手机到电脑的 HTTPS 网络路径。默认 HTTPS 端口为 `18443`，域名和 DNS 服务均不预置为作者的配置。

已有证书时，修改 `private/config.json` 的以下字段，保留其他字段和生成的密码哈希：

```json
{
  "publicOrigin": "https://codex.example.com:18443",
  "tlsPort": 18443,
  "certificate": "C:/certs/fullchain.pem",
  "privateKey": "C:/certs/tls-key.pem"
}
```

然后重启桥接服务。手机打开 `publicOrigin` 中配置的完整地址。证书名称、实际访问域名、端口和 `publicOrigin` 必须相符。

### 可选：阿里云 DNS 自动签发

仓库提供 Let's Encrypt DNS-01 脚本，从**你自己的** DDNS-Go 配置读取唯一的 `alidns` 账号，不复制或打印 DNS 密钥。Python 3.10 或更新版本：

```powershell
python -m pip install -r requirements.txt
python tls.py --domain codex.example.com --zone example.com --dns-config 'C:\path\to\ddns-go.yaml'

# ACME 和 DNS 可见性查询需要代理时
python tls.py --domain codex.example.com --zone example.com --dns-config 'C:\path\to\ddns-go.yaml' --proxy http://127.0.0.1:7893
```

将示例域名和路径替换成自己的值。`--zone` 是阿里云托管的 DNS 区域；可与 `--domain` 相同，也可为其父域名。脚本仅添加本次验证所需的 TXT 记录，结束时删除该条记录，不修改 A/AAAA 记录。域名仍需事先解析到可连接的地址。

签发成功后，脚本写入证书路径、域名、代理和 DNS 配置文件路径。启动服务后每 12 小时检查证书，剩余不足 30 天时续签并热加载。此机制需要电脑和服务在线；续签失败会记录错误，等待后续周期。手动配置的证书由使用者管理续期。

### 可选：UPnP 和 Windows 防火墙

普通启动不修改路由器或防火墙。需要本机直连公网、路由器支持 UPnP，并具有防火墙操作权限时，在管理员 PowerShell 中明确执行：

```powershell
.\network.ps1

# 或启动时刷新映射
.\start.ps1 -OpenNetwork

# 撤销本服务的映射和防火墙规则
.\network.ps1 -Remove
```

默认将外部 TCP `18443` 映射到配置中的 `tlsPort`。可通过 `-ExternalPort` 更换外部端口，同时更正 `publicOrigin`。脚本遇到其他服务占用的映射会停止；不直接覆盖。公网路径受路由器、运营商 NAT 和网络策略影响，创建映射不代表手机一定可达。

Chromium 调试接口始终只连回环地址。对外只提供经过登录验证的 HTTPS 桥接入口，不能暴露 `9223` 调试端口。

## 支持范围

- 与桌面共用一个真实窗口，支持切换会话、中文输入、点击、选择框和滚动。
- 手机独立调整窄屏布局，不改变桌面原有 DOM 高度和样式。
- 支持菜单、嵌套侧栏、浏览器返回及 Shadow DOM 中的代码变更面板。
- 手机选择多个文件后逐个上传，单文件最多 64 MB，进入原输入框后等待手动发送。
- 支持桌面变化通知、DOM 子树与样式增量传输；断线后重新同步。
- 旧消息阅读位置通过段落锚点保留；停在底部时跟随新内容。
- 页面内的提问卡片可选择选项、补充文字并提交。

上传原件位于 `private/uploads/`，草稿可能引用它们，服务不会自动清除。此目录可能包含个人文件，不应提交 Git。

系统原生对话框、文件夹整体上传、嵌入式网页/iframe、canvas、音视频流、依赖鼠标坐标的控件和手机后台系统通知不在支持范围。页面结构适配也可能受 Codex 版本和界面语言影响。

## 登录和请求验证

密码使用 scrypt 哈希。登录后生成随机服务端会话，12 小时过期；Cookie 设置 HttpOnly、SameSite，HTTPS 下增加 Secure。写请求检查 Origin 和 CSRF；登录失败限流。资源只能通过页面发现的资源编号获取，手机不提供任意 URL 代理、JavaScript 执行或任意 CDP 命令接口。

手机操作会直接作用于电脑上的真实会话。退出手机登录可使对应会话失效。

## 测试和停止

```powershell
npm test

# 仓库根目录的独立浏览器测试器
python ..\tools\run-browser-tests.py
```

`npm test` 默认跳过需要 Chromium 的用例。设置 `CBB_TEST_CDP` 可运行浏览器用例；应使用独立测试浏览器。测试器会自动创建、关闭独立无头浏览器并清理其临时目录，不向模型发送消息。

前台运行按 Ctrl+C 停止。后台运行时先核对 `private/server.pid` 对应的进程命令行确实指向本目录 `server.mjs`，再停止该进程。更改证书、端口或配置后重启服务。
