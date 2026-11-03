# Codex 代理启动

通过 Windows `IApplicationActivationManager` 启动已安装的 `OpenAI.Codex` 打包应用，为外层 Chromium 传入代理参数。保留局域网和回环地址直连，并禁用 QUIC。

## 配置

确保本地代理已启动。默认使用其 HTTP/混合端口 `7893`，与系统是否开启全局代理无关。

外层应用的代理参数不会自动替代内部 Codex 进程的网络配置。将 [.env.example](.env.example) 中的四项合并到 `%USERPROFILE%\.codex\.env`；已存在时只更新对应项，保留其他内容。代理端口应与启动参数一致。此示例不包含账号、API Key 或任何登录信息。

如果使用自定义 Codex 配置目录，应在实际使用的配置目录中设置这些变量。本工具不修改系统代理、注册表或其他应用的代理。

## 启动

完整退出 Codex 后执行：

```powershell
.\Launch-Codex.cmd
.\Launch-Codex.cmd -Proxy http://127.0.0.1:7890
```

可以给 `Launch-Codex.cmd` 创建自己的 Windows 快捷方式。脚本基于自身目录定位文件，仓库可放在任意位置。

需要手机镜像时执行：

```powershell
.\Launch-Codex.cmd -WithBridge
```

此时额外启用 `127.0.0.1:9223` 的 Chromium 调试接口，并启动相邻的 `browser-bridge/start.ps1`。只运行代理启动时不启用调试接口。不要将调试端口映射到公网。

如需更换调试端口，可用 `-DebugPort 9233 -WithBridge`，同时修改 `browser-bridge/private/config.json` 中的 `cdp`。桥接默认只开放本机 HTTP 入口；手机连接需另外配置 HTTPS。

## 排查

- 提示已经运行：从应用菜单完整退出后再启动，已有进程不会重新应用启动参数。
- 找不到 `OpenAI.Codex`：此脚本面向 Windows 打包应用安装方式，不支持任意便携版程序。
- 桌面正常但内部请求失败：确认 `.codex/.env` 中的代理地址及端口，并重启 Codex。
- 代理启动成功但桥接失败：检查 Node.js 是否在 PATH，以及桥接端口是否被占用。详细步骤见[桥接说明](../browser-bridge/README.md)。
