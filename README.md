# Windows Telnet MCP

一个只在 Windows 上运行的本地 MCP Server，用来启动和实时操作真正可见的 Windows `telnet.exe` 窗口。

它不是把 Telnet 放进匿名管道或 ConPTY 的无头封装：每个会话都由系统 `conhost.exe` 承载，用户能在桌面上看到窗口、手工输入，并与 MCP 交替接管同一个会话。MCP 通过 Windows Console API 读取屏幕缓冲区、写入键盘事件。

## 环境要求

- Windows 10/11 或带桌面会话的 Windows Server
- Node.js 22 或更高版本
- PowerShell 7 (`pwsh.exe`)
- Windows Telnet Client 可选功能

本机尚未安装 Telnet 时，在“管理员”终端中执行：

```powershell
dism /online /Enable-Feature /FeatureName:TelnetClient
```

然后安装依赖：

```powershell
cd D:\work\windows-telnet-mcp
npm install
```

## 配置 MCP 客户端

通用 stdio 配置：

```json
{
  "mcpServers": {
    "windows-telnet": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\work\\windows-telnet-mcp\\src\\index.js"]
    }
  }
}
```

如果 PowerShell 7 不在默认位置，可加环境变量：

```json
{
  "env": {
    "TELNET_MCP_PWSH": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
  }
}
```

VS Code 可把同一项放到 `.vscode/mcp.json` 的 `servers` 下，并补上 `"type": "stdio"`。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `telnet_check` | 检查 Windows、Telnet、conhost 和 PowerShell 依赖 |
| `telnet_start` | 打开可见 Telnet 窗口；可直接连接主机，也可停在 `Microsoft Telnet>` |
| `telnet_list` | 列出当前 MCP 进程创建的会话 |
| `telnet_status` | 查询进程和窗口状态 |
| `telnet_read` | 读取用户当前可见区域或最近的屏幕缓冲区 |
| `telnet_send` | 以控制台键盘事件输入文本，可选择追加 Enter |
| `telnet_key` | 输入 Enter、方向键、`CTRL+]`、`CTRL+C` 等按键 |
| `telnet_wait_for_text` | 等待提示符或其他文本出现 |
| `telnet_focus` | 恢复并前置真实 Telnet 窗口 |
| `telnet_close` | 优雅退出；必要时可强制关闭 |

建议调用顺序：

1. `telnet_check`
2. `telnet_start`
3. `telnet_wait_for_text` 或 `telnet_read`
4. `telnet_send` / `telnet_key`
5. 重复读写
6. `telnet_close`

`telnet_start` 不传 `host` 时不会建立网络连接，适合先确认窗口和 Telnet 命令提示符。传入 `host` 后会发起真实的出站连接。

## 实现边界

- MCP Server 的 stdout 只用于 JSON-RPC；Telnet 不继承该管道。
- 每个会话有独立 worker，因此可以并行打开多个 Telnet 窗口。
- worker 退出不会主动关掉 Telnet，用户仍可手工继续操作；使用 `telnet_close` 才会关闭会话。
- 读取的是字符屏幕缓冲区，不是 OCR，速度快且不会受窗口遮挡影响。
- 目前不抓取像素截图，也不支持鼠标事件；Windows Telnet 本身是字符终端，这两项不是必要能力。
- Telnet 协议通常是明文的。不要通过不可信网络发送密码或敏感数据；有条件时应使用 SSH。

## 验证

```powershell
npm run check
```

集成测试会短暂打开一个真正可见的 `cmd.exe` 控制台，验证启动、屏幕读取、键盘输入和关闭的完整链路，但不会连接网络。即使机器未安装 Telnet，该测试也能执行。

## 文件结构

- `src/index.js`：MCP 工具、会话管理和 MCP stdio transport
- `src/windows-console-worker.ps1`：Win32 Console API、可见进程启动及实时读写
- `test/mcp.test.js`：MCP 握手、工具枚举和只读检查
- `test/worker.test.js`：真实可见控制台闭环测试
- `docs/design.md`：方案研究与取舍
