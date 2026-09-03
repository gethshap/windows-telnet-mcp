$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 otherwise uses the active OEM code page for redirected
# Console.In/Out. MCP JSON is UTF-8, and Telnet screens may contain non-ASCII
# text, so pin both sides of the worker protocol before attaching a console.
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

# This worker is intentionally windowless. It owns API handles for exactly one
# visible console session; conhost.exe and telnet.exe remain ordinary desktop
# processes that the user can see and operate at the same time.

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct Coord {
    public short X;
    public short Y;
    public Coord(short x, short y) { X = x; Y = y; }
}

[StructLayout(LayoutKind.Sequential)]
public struct SmallRect {
    public short Left;
    public short Top;
    public short Right;
    public short Bottom;
}

[StructLayout(LayoutKind.Sequential)]
public struct ConsoleScreenBufferInfo {
    public Coord Size;
    public Coord CursorPosition;
    public ushort Attributes;
    public SmallRect Window;
    public Coord MaximumWindowSize;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct KeyEventRecord {
    [MarshalAs(UnmanagedType.Bool)] public bool KeyDown;
    public ushort RepeatCount;
    public ushort VirtualKeyCode;
    public ushort VirtualScanCode;
    public char UnicodeChar;
    public uint ControlKeyState;
}

[StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
public struct InputRecord {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KeyEventRecord KeyEvent;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct ProcessEntry32 {
    public uint Size;
    public uint Usage;
    public uint ProcessId;
    public IntPtr DefaultHeapId;
    public uint ModuleId;
    public uint Threads;
    public uint ParentProcessId;
    public int BasePriority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
}

public static class ConsoleNative {
    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint OPEN_EXISTING = 3;
    public const ushort KEY_EVENT = 0x0001;
    public const uint TH32CS_SNAPPROCESS = 0x00000002;
    public const uint LEFT_ALT_PRESSED = 0x0002;
    public const uint LEFT_CTRL_PRESSED = 0x0008;
    public const uint SHIFT_PRESSED = 0x0010;
    public const uint ENHANCED_KEY = 0x0100;
    public const int SW_RESTORE = 9;
    public const uint WM_CLOSE = 0x0010;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleScreenBufferInfo(IntPtr output, out ConsoleScreenBufferInfo info);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ReadConsoleOutputCharacterW(IntPtr output, StringBuilder text,
        uint length, Coord coord, out uint read);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool WriteConsoleInputW(IntPtr input, InputRecord[] records,
        uint length, out uint written);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetConsoleTitleW(string title);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern short VkKeyScanW(char character);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKeyW(uint code, uint mapType);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

    public static int FindDescendantProcess(int rootPid, string executableName) {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) return 0;
        try {
            var entries = new List<ProcessEntry32>();
            var entry = new ProcessEntry32();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
            if (!Process32FirstW(snapshot, ref entry)) return 0;
            do {
                entries.Add(entry);
                entry = new ProcessEntry32();
                entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
            } while (Process32NextW(snapshot, ref entry));

            var frontier = new Queue<uint>();
            var visited = new HashSet<uint>();
            frontier.Enqueue((uint)rootPid);
            visited.Add((uint)rootPid);
            while (frontier.Count > 0) {
                uint parent = frontier.Dequeue();
                foreach (var item in entries) {
                    if (item.ParentProcessId != parent || !visited.Add(item.ProcessId)) continue;
                    if (String.Equals(item.ExeFile, executableName, StringComparison.OrdinalIgnoreCase))
                        return (int)item.ProcessId;
                    frontier.Enqueue(item.ProcessId);
                }
            }
            return 0;
        } finally {
            CloseHandle(snapshot);
        }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp

$script:hostProcess = $null
$script:clientPid = 0
$script:inputHandle = [IntPtr]::Zero
$script:outputHandle = [IntPtr]::Zero
$script:windowHandle = [IntPtr]::Zero
$script:sessionTitle = ''

function Write-Reply([object]$reply) {
    $json = $reply | ConvertTo-Json -Compress -Depth 12
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Get-Win32Error([string]$operation) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $message = [ComponentModel.Win32Exception]::new($code).Message
    return "$operation failed (Win32 $code): $message"
}

function Assert-Session {
    if ($script:clientPid -eq 0) { throw 'No console client is attached.' }
    $process = Get-Process -Id $script:clientPid -ErrorAction SilentlyContinue
    if ($null -eq $process) { throw "Console client process $($script:clientPid) has exited." }
}

function Open-ConsoleHandles([int]$processId) {
    [void][ConsoleNative]::FreeConsole()
    if (-not [ConsoleNative]::AttachConsole([uint32]$processId)) {
        throw (Get-Win32Error "AttachConsole($processId)")
    }

    $share = [ConsoleNative]::FILE_SHARE_READ -bor [ConsoleNative]::FILE_SHARE_WRITE
    $script:inputHandle = [ConsoleNative]::CreateFileW(
        'CONIN$', [ConsoleNative]::GENERIC_READ -bor [ConsoleNative]::GENERIC_WRITE,
        $share, [IntPtr]::Zero, [ConsoleNative]::OPEN_EXISTING, 0, [IntPtr]::Zero)
    $script:outputHandle = [ConsoleNative]::CreateFileW(
        'CONOUT$', [ConsoleNative]::GENERIC_READ -bor [ConsoleNative]::GENERIC_WRITE,
        $share, [IntPtr]::Zero, [ConsoleNative]::OPEN_EXISTING, 0, [IntPtr]::Zero)

    if ($script:inputHandle -eq [IntPtr](-1) -or $script:outputHandle -eq [IntPtr](-1)) {
        throw (Get-Win32Error 'CreateFile(CONIN$/CONOUT$)')
    }
    $script:windowHandle = [ConsoleNative]::GetConsoleWindow()
}

function Close-ConsoleHandles {
    if ($script:inputHandle -ne [IntPtr]::Zero -and $script:inputHandle -ne [IntPtr](-1)) {
        [void][ConsoleNative]::CloseHandle($script:inputHandle)
    }
    if ($script:outputHandle -ne [IntPtr]::Zero -and $script:outputHandle -ne [IntPtr](-1)) {
        [void][ConsoleNative]::CloseHandle($script:outputHandle)
    }
    $script:inputHandle = [IntPtr]::Zero
    $script:outputHandle = [IntPtr]::Zero
    [void][ConsoleNative]::FreeConsole()
}

function Read-Screen([int]$rows, [string]$mode) {
    Assert-Session
    $info = [ConsoleScreenBufferInfo]::new()
    if (-not [ConsoleNative]::GetConsoleScreenBufferInfo($script:outputHandle, [ref]$info)) {
        throw (Get-Win32Error 'GetConsoleScreenBufferInfo')
    }

    if ($mode -eq 'visible') {
        $left = [int]$info.Window.Left
        $right = [int]$info.Window.Right
        $top = [int]$info.Window.Top
        $bottom = [int]$info.Window.Bottom
        if ($rows -gt 0) { $top = [Math]::Max($top, $bottom - $rows + 1) }
    } else {
        $left = 0
        $right = [int]$info.Size.X - 1
        $bottom = [int]$info.CursorPosition.Y
        $take = if ($rows -gt 0) { $rows } else { 40 }
        $top = [Math]::Max(0, $bottom - $take + 1)
    }

    $width = [Math]::Max(1, $right - $left + 1)
    $lines = [Collections.Generic.List[string]]::new()
    for ($y = $top; $y -le $bottom; $y++) {
        $builder = [Text.StringBuilder]::new($width)
        [uint32]$read = 0
        $coord = [Coord]::new([int16]$left, [int16]$y)
        if (-not [ConsoleNative]::ReadConsoleOutputCharacterW(
            $script:outputHandle, $builder, [uint32]$width, $coord, [ref]$read)) {
            throw (Get-Win32Error 'ReadConsoleOutputCharacterW')
        }
        $line = $builder.ToString().TrimEnd([char]0, [char]' ')
        $lines.Add($line)
    }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Length -eq 0) {
        $lines.RemoveAt($lines.Count - 1)
    }

    return [ordered]@{
        text = [string]::Join("`n", $lines)
        window = [ordered]@{ left = $left; top = $top; right = $right; bottom = $bottom }
        cursor = [ordered]@{ x = [int]$info.CursorPosition.X; y = [int]$info.CursorPosition.Y }
        buffer = [ordered]@{ width = [int]$info.Size.X; height = [int]$info.Size.Y }
    }
}

function New-KeyRecord([bool]$down, [uint16]$virtualKey, [char]$character, [uint32]$state) {
    $event = [KeyEventRecord]::new()
    $event.KeyDown = $down
    $event.RepeatCount = 1
    $event.VirtualKeyCode = $virtualKey
    $event.VirtualScanCode = [uint16][ConsoleNative]::MapVirtualKeyW($virtualKey, 0)
    $event.UnicodeChar = $character
    $event.ControlKeyState = $state
    $record = [InputRecord]::new()
    $record.EventType = [ConsoleNative]::KEY_EVENT
    $record.KeyEvent = $event
    return $record
}

function Write-KeyRecords([InputRecord[]]$records) {
    Assert-Session
    [uint32]$written = 0
    if (-not [ConsoleNative]::WriteConsoleInputW(
        $script:inputHandle, $records, [uint32]$records.Length, [ref]$written)) {
        throw (Get-Win32Error 'WriteConsoleInputW')
    }
    if ($written -ne $records.Length) {
        throw "WriteConsoleInputW wrote $written of $($records.Length) input records."
    }
}

function Send-Character([char]$character) {
    $scan = [int][ConsoleNative]::VkKeyScanW($character)
    [uint16]$virtualKey = 0
    [uint32]$state = 0
    if ($scan -ne -1) {
        $virtualKey = [uint16]($scan -band 0xFF)
        $modifiers = ($scan -shr 8) -band 0xFF
        if (($modifiers -band 1) -ne 0) { $state = $state -bor [ConsoleNative]::SHIFT_PRESSED }
        if (($modifiers -band 2) -ne 0) { $state = $state -bor [ConsoleNative]::LEFT_CTRL_PRESSED }
        if (($modifiers -band 4) -ne 0) { $state = $state -bor [ConsoleNative]::LEFT_ALT_PRESSED }
    }
    $records = [InputRecord[]]@(
        (New-KeyRecord $true $virtualKey $character $state),
        (New-KeyRecord $false $virtualKey $character $state)
    )
    Write-KeyRecords $records
}

function Send-NamedKey([string]$key) {
    $name = $key.ToUpperInvariant().Replace(' ', '')
    [uint16]$vk = 0
    [char]$character = [char]0
    [uint32]$state = 0
    switch ($name) {
        'ENTER' { $vk = 0x0D; $character = [char]13 }
        'TAB' { $vk = 0x09; $character = [char]9 }
        'BACKSPACE' { $vk = 0x08; $character = [char]8 }
        'ESCAPE' { $vk = 0x1B; $character = [char]27 }
        'UP' { $vk = 0x26; $state = [ConsoleNative]::ENHANCED_KEY }
        'DOWN' { $vk = 0x28; $state = [ConsoleNative]::ENHANCED_KEY }
        'LEFT' { $vk = 0x25; $state = [ConsoleNative]::ENHANCED_KEY }
        'RIGHT' { $vk = 0x27; $state = [ConsoleNative]::ENHANCED_KEY }
        'DELETE' { $vk = 0x2E; $state = [ConsoleNative]::ENHANCED_KEY }
        'HOME' { $vk = 0x24; $state = [ConsoleNative]::ENHANCED_KEY }
        'END' { $vk = 0x23; $state = [ConsoleNative]::ENHANCED_KEY }
        'PAGEUP' { $vk = 0x21; $state = [ConsoleNative]::ENHANCED_KEY }
        'PAGEDOWN' { $vk = 0x22; $state = [ConsoleNative]::ENHANCED_KEY }
        'CTRL+]' { $vk = 0xDD; $character = [char]29; $state = [ConsoleNative]::LEFT_CTRL_PRESSED }
        'CTRL+C' { $vk = 0x43; $character = [char]3; $state = [ConsoleNative]::LEFT_CTRL_PRESSED }
        'CTRL+BREAK' { $vk = 0x03; $character = [char]0; $state = [ConsoleNative]::LEFT_CTRL_PRESSED }
        default { throw "Unsupported key '$key'." }
    }
    $records = [InputRecord[]]@(
        (New-KeyRecord $true $vk $character $state),
        (New-KeyRecord $false $vk $character $state)
    )
    Write-KeyRecords $records
}

function ConvertTo-WindowsCommandLineArgument([string]$value) {
    # ProcessStartInfo.ArgumentList only exists on modern .NET. This implements
    # the CommandLineToArgvW quoting rules so the same code is safe on Windows
    # PowerShell 5.1 (.NET Framework) and PowerShell 7+.
    if ($null -eq $value -or $value.Length -eq 0) { return '""' }
    if ($value -notmatch '[\s"]') { return $value }

    $builder = New-Object Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $value.ToCharArray()) {
        if ($character -eq [char]'\') {
            $backslashes++
            continue
        }
        if ($character -eq [char]'"') {
            [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Start-VisibleClient([object]$request) {
    if ($script:clientPid -ne 0) { throw 'This worker already owns a console session.' }

    $systemDirectory = [Environment]::SystemDirectory
    $conhostPath = Join-Path $systemDirectory 'conhost.exe'
    $clientPath = if ($request.clientPath) { [string]$request.clientPath } else { Join-Path $systemDirectory 'telnet.exe' }
    if (-not (Test-Path -LiteralPath $conhostPath -PathType Leaf)) { throw "conhost.exe was not found at $conhostPath" }
    if (-not (Test-Path -LiteralPath $clientPath -PathType Leaf)) {
        throw "Windows Telnet Client is not installed ($clientPath is missing). Enable the TelnetClient optional feature first."
    }

    $arguments = [Collections.Generic.List[string]]::new()
    if ($request.clientArgs) {
        foreach ($arg in $request.clientArgs) { $arguments.Add([string]$arg) }
    }
    $script:sessionTitle = if ($request.title) { [string]$request.title } else { 'MCP Windows Telnet' }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $conhostPath
    # ShellExecute gives conhost a desktop launch with no inheritance from the
    # worker's JSON stdio pipes. Without this separation, terminal VT control
    # sequences can corrupt the MCP protocol stream.
    $startInfo.UseShellExecute = $true
    $startInfo.CreateNoWindow = $false
    $quotedArguments = [Collections.Generic.List[string]]::new()
    $quotedArguments.Add((ConvertTo-WindowsCommandLineArgument $clientPath))
    foreach ($arg in $arguments) {
        $quotedArguments.Add((ConvertTo-WindowsCommandLineArgument ([string]$arg)))
    }
    $startInfo.Arguments = [string]::Join(' ', $quotedArguments)

    $script:hostProcess = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $script:hostProcess) { throw 'Failed to start conhost.exe.' }

    $leafName = [IO.Path]::GetFileName($clientPath)
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 50
        $script:clientPid = [ConsoleNative]::FindDescendantProcess($script:hostProcess.Id, $leafName)
    } while ($script:clientPid -eq 0 -and [DateTime]::UtcNow -lt $deadline -and -not $script:hostProcess.HasExited)

    if ($script:clientPid -eq 0) {
        throw "The visible console opened, but its $leafName child process could not be located."
    }

    Open-ConsoleHandles $script:clientPid
    if (-not [ConsoleNative]::SetConsoleTitleW($script:sessionTitle)) {
        throw (Get-Win32Error 'SetConsoleTitleW')
    }
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        try { $screen = Read-Screen 40 'visible'; break } catch { Start-Sleep -Milliseconds 50 }
    } while ([DateTime]::UtcNow -lt $readyDeadline)
    if ($null -eq $screen) { throw 'The console started but its screen buffer did not become readable.' }

    return [ordered]@{
        clientPid = $script:clientPid
        consoleHostPid = $script:hostProcess.Id
        windowHandle = $script:windowHandle.ToInt64()
        title = $script:sessionTitle
        visible = ($script:windowHandle -ne [IntPtr]::Zero -and [ConsoleNative]::IsWindow($script:windowHandle))
        screen = $screen
    }
}

function Stop-Session([bool]$force, [string]$escapeCharacter) {
    if ($script:clientPid -eq 0) { return [ordered]@{ closed = $true; alreadyExited = $true } }
    $process = Get-Process -Id $script:clientPid -ErrorAction SilentlyContinue
    if ($null -eq $process) { return [ordered]@{ closed = $true; alreadyExited = $true } }

    if (-not $force) {
        if ([string]::IsNullOrEmpty($escapeCharacter)) {
            Send-NamedKey 'CTRL+]'
        } else {
            Send-Character $escapeCharacter[0]
        }
        Start-Sleep -Milliseconds 120
        foreach ($character in 'quit'.ToCharArray()) { Send-Character $character }
        Send-NamedKey 'ENTER'
        # Detach before telnet exits. Otherwise Windows delivers the console's
        # CTRL_CLOSE_EVENT to this worker too, killing it before it can reply.
        Close-ConsoleHandles
        if ($process.WaitForExit(2500)) { return [ordered]@{ closed = $true; forced = $false } }
        Open-ConsoleHandles $script:clientPid
        return [ordered]@{ closed = $false; forced = $false; message = 'Graceful quit was sent, but the process is still running.' }
    }

    $window = $script:windowHandle
    Close-ConsoleHandles
    if ($window -ne [IntPtr]::Zero) {
        [void][ConsoleNative]::PostMessageW($window, [ConsoleNative]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    if (-not $process.WaitForExit(1500)) {
        $killTree = $process.GetType().GetMethod('Kill', [type[]]@([bool]))
        if ($null -ne $killTree) {
            [void]$killTree.Invoke($process, [object[]]@($true))
        } else {
            # Windows PowerShell 5.1 exposes only Process.Kill(). The console
            # client is the direct child and conhost exits with it.
            $process.Kill()
        }
        [void]$process.WaitForExit(1500)
    }
    return [ordered]@{ closed = $process.HasExited; forced = $true }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $id = $null
    try {
        $request = $line | ConvertFrom-Json
        $id = $request.id
        switch ([string]$request.op) {
            'launch' {
                $result = Start-VisibleClient $request
            }
            'read' {
                $rows = if ($request.rows) { [int]$request.rows } else { 40 }
                $mode = if ($request.mode) { [string]$request.mode } else { 'visible' }
                $result = Read-Screen $rows $mode
            }
            'sendText' {
                Assert-Session
                foreach ($character in ([string]$request.text).ToCharArray()) { Send-Character $character }
                if ([bool]$request.appendEnter) { Send-NamedKey 'ENTER' }
                $result = [ordered]@{ sent = ([string]$request.text).Length; enterSent = [bool]$request.appendEnter }
            }
            'sendKey' {
                Send-NamedKey ([string]$request.key)
                $result = [ordered]@{ keySent = [string]$request.key }
            }
            'focus' {
                Assert-Session
                if ($script:windowHandle -eq [IntPtr]::Zero -or -not [ConsoleNative]::IsWindow($script:windowHandle)) {
                    throw 'The console does not expose a visible top-level window handle.'
                }
                [void][ConsoleNative]::ShowWindow($script:windowHandle, [ConsoleNative]::SW_RESTORE)
                $focused = [ConsoleNative]::SetForegroundWindow($script:windowHandle)
                $result = [ordered]@{ focused = $focused; windowHandle = $script:windowHandle.ToInt64() }
            }
            'status' {
                $process = if ($script:clientPid) { Get-Process -Id $script:clientPid -ErrorAction SilentlyContinue } else { $null }
                $result = [ordered]@{
                    running = ($null -ne $process)
                    clientPid = $script:clientPid
                    consoleHostPid = if ($script:hostProcess) { $script:hostProcess.Id } else { 0 }
                    windowHandle = $script:windowHandle.ToInt64()
                    title = $script:sessionTitle
                }
            }
            'close' {
                $result = Stop-Session ([bool]$request.force) ([string]$request.escapeCharacter)
            }
            default { throw "Unknown worker operation '$($request.op)'." }
        }
        Write-Reply ([ordered]@{ id = $id; ok = $true; result = $result })
    } catch {
        Write-Reply ([ordered]@{ id = $id; ok = $false; error = $_.Exception.Message })
    }
}

# EOF means the MCP parent closed or crashed. Reap the visible session here as
# a second line of defence, even if Node did not get a chance to call close.
try {
    if ($script:clientPid -ne 0 -and $null -ne (Get-Process -Id $script:clientPid -ErrorAction SilentlyContinue)) {
        [void](Stop-Session $true '')
    }
} catch {
    # The control pipe is already closed, so there is nowhere useful to report
    # cleanup errors. Close handles below and let Windows release the console.
}
Close-ConsoleHandles
