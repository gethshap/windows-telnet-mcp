# Windows Telnet MCP

一个只在 Windows 上运行的本地 MCP Server，用来启动和实时操作真正可见的 Windows `telnet.exe` 窗口。

它不是把 Telnet 放进匿名管道或 ConPTY 的无头封装：每个会话都由系统 `conhost.exe` 承载，用户能在桌面上看到窗口、手工输入，并与 MCP 交替接管同一个会话。MCP 通过 Windows Console API 读取屏幕缓冲区、写入键盘事件。

## 环境要求

- Windows 10/11 或带桌面会话的 Windows Server
- Node.js 22 或更高版本
- Windows PowerShell 5.1 (`powershell.exe`) 或 PowerShell 7 (`pwsh.exe`)
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

启动器优先使用 PowerShell 7；未安装时会自动回退到 Windows 自带的 PowerShell 5.1。也可用环境变量显式指定：

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
- worker 在启动控制台前加入独立的 Windows Job Object；其唯一句柄关闭时，系统回收该会话的进程树。因此 worker 被强杀也不依赖 PowerShell 清理代码来回收 `telnet.exe` 和 `conhost.exe`。
- MCP 退出时同时停止已启动和正在启动的 worker，并禁止新会话；worker 另外监听 MCP 父进程退出，覆盖父进程突然终止、工作线程忙碌等情况。
- Telnet 自行退出时，worker 自动释放控制台并结束，会话随后从 `telnet_list` 移除。
- 如果宿主的 Job Object 限制不允许建立上述生命周期保护，启动会失败，不会退回到可能遗留进程的启动方式。
- 读取的是字符屏幕缓冲区，不是 OCR，速度快且不会受窗口遮挡影响。
- 目前不抓取像素截图，也不支持鼠标事件；Windows Telnet 本身是字符终端，这两项不是必要能力。
- Telnet 协议通常是明文的。不要通过不可信网络发送密码或敏感数据；有条件时应使用 SSH。

## 验证

```powershell
npm run check
```

集成测试会使用检测到的 PowerShell 7 和 Windows PowerShell 5.1，短暂打开真正可见的 `cmd.exe` 控制台，覆盖读写、EOF 清理、客户端自行退出、worker 强杀、32,768 字符输入中断，以及读屏字符边界。会话管理单元测试覆盖启动/关闭竞态、关闭幂等性和失败清理。

安装 Telnet 后，还会通过 MCP 工具测试真实 `telnet.exe`：连接测试临时创建的 `127.0.0.1` 随机端口，验证收发、优雅关闭、自行退出、长输入期间的 MCP EOF，以及 MCP 强杀后的回收。只连接本机，不需要账号或外部服务，也不需要安装 Telnet 服务端。未安装 Telnet 时，这组测试会明确标记为 skipped。

## 文件结构

- `src/index.js`：MCP 工具、会话管理和 MCP stdio transport
- `src/windows-console-worker.ps1`：Win32 Console API、可见进程启动及实时读写
- `test/mcp.test.js`：MCP 握手和真实 Telnet 本机集成测试
- `test/worker.test.js`：真实可见控制台读写和进程回收回归测试
- `test/session.test.js`：会话生命周期与竞态单元测试
- `test-support/windows.js`：测试用 PowerShell 检测和进程退出检查
- `docs/design.md`：方案研究与取舍
