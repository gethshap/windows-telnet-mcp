# 方案研究与设计取舍

## 需求解释

“不能是无头进程”落实为三个可验证条件：

1. 运行的是 Windows 自带 `telnet.exe`，而不是自行实现的 Telnet socket 客户端。
2. 会话存在独立、可见的桌面终端窗口，用户随时能看到和手工输入。
3. MCP 操作的是该窗口背后的同一控制台会话，而不是旁路复制出来的隐藏会话。

## 研究结论

### 为什么不用 stdin/stdout 重定向

MCP 的 stdio transport 本身占用服务进程的 stdin/stdout。如果再把 `telnet.exe` 绑定到相同管道，不仅 Telnet 会变成无头进程，输出还会破坏 MCP JSON-RPC 数据流。

Windows 的 `CREATE_NEW_CONSOLE` 语义是让新进程获得新控制台，而非继承父进程控制台：

- <https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags>

本项目进一步显式启动系统 `conhost.exe telnet.exe ...`，避免 Windows 11 的“默认终端委托”把顶层窗口合并进已有 Windows Terminal 标签页。微软的设计文档说明了这种显式 `conhost.exe <client>` 启动通道：

- <https://github.com/microsoft/terminal/blob/main/doc/specs/%23492%20-%20Default%20Terminal/spec.md>

### 为什么不用 UI 自动化或坐标点击

字符终端已有更可靠的操作面：Windows Console API。`AttachConsole(pid)` 能让 worker 加入目标控制台；`CONOUT$` 是活动屏幕缓冲区；`WriteConsoleInputW` 能写入目标控制台输入缓冲区。

- <https://learn.microsoft.com/en-us/windows/console/attachconsole>
- <https://learn.microsoft.com/en-us/windows/console/console-screen-buffers>
- <https://learn.microsoft.com/en-us/windows/console/writeconsoleinput>
- <https://learn.microsoft.com/en-us/windows/console/getconsolescreenbufferinfo>

这种方式不依赖分辨率、主题、窗口位置、焦点或 OCR，窗口被遮挡时仍能读取；用户手工敲键盘时也仍是同一个缓冲区。

微软把这类反向读写称为 classic Console API 的 “wrong-way verbs”，建议一般的新终端优先采用 VT/ConPTY；但这里的目标恰好是操纵本机已有的、用户可见的 Windows Telnet 控制台，所以这是其明确列出的本地特权例外场景：

- <https://learn.microsoft.com/en-us/windows/console/classic-vs-vt>

### 为什么不用 ConPTY

ConPTY 的创建者要负责把字符流渲染到某个终端窗口。单独使用 ConPTY 不会产生窗口，天然不满足“必须可见”的要求：

- <https://learn.microsoft.com/en-us/windows/console/pseudoconsoles>

可以再开发一个完整终端 GUI 来显示 ConPTY，但那会重复实现终端模拟器，并且不再是 Windows 自带的可见控制台。本项目直接使用 conhost，范围更小、兼容性更好。

### Windows Telnet 参数

Windows Telnet 支持主机、端口、终端类型、用户名、转义字符与日志文件等参数；不带参数时进入 `Microsoft Telnet>` 上下文：

- <https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/telnet>

### MCP transport

本项目使用官方 TypeScript Server SDK v2 的 `serveStdio`，同时服务当前 2026 协议和旧式 2025 initialize 握手。stdio 适合由本地 MCP Host 启动的 Server，并要求 stdout 只承载协议消息：

- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md>

## 进程结构

```text
MCP Host
  └─ node.exe src/index.js          (stdio JSON-RPC)
       ├─ pwsh.exe worker #1        (隐藏，仅持有 Win32 句柄)
       │    └─ conhost.exe          (可见窗口)
       │         └─ telnet.exe      (真实 Windows Telnet)
       └─ pwsh.exe worker #2
            └─ conhost.exe
                 └─ telnet.exe
```

worker 与 Telnet 一对一，是因为一个 Windows 进程同一时间最多只能附着到一个控制台。这样不需要在一个进程里频繁 `FreeConsole`/`AttachConsole` 切换，也避免并发调用串到错误会话。

## 已处理的 Windows 边界

- conhost 通过 ShellExecute 独立启动，不继承 worker 的 JSON 管道。
- worker 在 Telnet/console 关闭前先 `FreeConsole`，避免自己收到 `CTRL_CLOSE_EVENT` 后被系统一起终止。
- 所有 Telnet 参数先按 `CommandLineToArgvW` 规则逐项转义，再交给 `ProcessStartInfo.Arguments`，不会把参数当作 shell 命令解析。
- Windows PowerShell 5.1 没有 `ProcessStartInfo.ArgumentList` 和 `Process.Kill(bool)`；worker 内置等价的 Windows 参数转义，并在旧版 .NET 上回退到 `Process.Kill()`。
- `telnet_send` 不回显输入内容到工具结果，减少凭据被二次记录的风险。
- MCP Server 正常退出时会先强制关闭全部会话；如果 Node 来不及执行关闭逻辑，worker 在控制管道 EOF 时仍会回收 `telnet.exe` 和 `conhost.exe`，避免孤儿进程。
