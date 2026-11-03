# Codex Tools

Windows 上的两个 Codex 桌面端实用工具：通过本地代理启动，以及在手机浏览器中操作电脑上正在运行的 Codex 窗口。

| 模块 | 用途 | 使用说明 |
| --- | --- | --- |
| [proxy-launcher](proxy-launcher/) | 为 Windows 打包应用传入代理参数，可选启动手机桥接服务 | [代理启动](proxy-launcher/README.md) |
| [browser-bridge](browser-bridge/) | 镜像桌面页面，将手机的输入、点击、滚动和附件传回原窗口 | [手机访问](browser-bridge/README.md) |

个人项目，非 OpenAI 官方产品。手机和电脑共用同一个真实窗口及其会话权限；桌面界面更新后，DOM 适配可能需要调整。

## 快速开始

需要 Windows 10/11、已安装的 Codex Windows 打包应用，以及可用的本地 HTTP 代理。手机桥接另外需要 Node.js 22 或更新版本。

```powershell
git clone https://github.com/kang-png/codex-tools.git
cd codex-tools

# 完整退出已运行的 Codex 后，仅通过代理启动
.\proxy-launcher\Launch-Codex.cmd

# 或同时启用手机桥接
.\proxy-launcher\Launch-Codex.cmd -WithBridge
```

默认代理为 `http://127.0.0.1:7893`。其他端口可通过 `-Proxy` 指定。内部 Codex 进程的代理需按[代理启动说明](proxy-launcher/README.md)配置 `.codex/.env`。

桥接首次启动生成本地配置和随机密码。先在电脑打开 `http://127.0.0.1:4788` 验证，再按[手机访问说明](browser-bridge/README.md)配置自己的域名和 HTTPS。

## 验证

桥接运行本身不需要安装 npm 依赖。下面命令均在仓库根目录执行：

```powershell
# 无浏览器测试；浏览器用例会明确标为跳过
npm --prefix browser-bridge test

# 用独立的无头 Chrome/Edge 运行完整浏览器测试，不操作现有 Codex
python tools/run-browser-tests.py

# TLS 域名参数和续签配置测试，不访问 DNS/ACME 服务
python -m pip install -r browser-bridge/requirements.txt
python -m unittest discover -s browser-bridge/test -p 'test_*.py'

# 在 Windows 上解析 PowerShell 脚本并编译启动器中的 C# 类型，不启动应用
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/check-powershell.ps1
```

测试覆盖登录、CSRF、上传路径、资源访问、增量同步、输入回传、手机布局、菜单、Shadow DOM、阅读位置和页面提问。隔离浏览器测试不能代替真实手机、公网网络和长期运行验证。

运行密码、证书、上传附件和本地配置保存在 `browser-bridge/private/`，由 Git 忽略。仓库只包含源码、示例配置、文档和测试。
