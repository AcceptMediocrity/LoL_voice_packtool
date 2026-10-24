//! 发布包入口。
//!
//! 发布包结构(用户看到的只有两样东西):
//!   LoL_Voice.exe        启动入口(本程序, 带图标)
//!   resource\            所有东西都在这里面
//!       runtime\node.exe     自带的 Node 运行时(用户不用装任何环境)
//!       src\  web\  assets\  程序本体与界面
//!       desktop\voice-shell.exe  无边框窗口外壳
//!
//! 另外兼容两种老位置(开发目录里直接跑, 或早期没有 resource\ 的包):
//!   exe 旁边直接就有 src\ 与 runtime\。
#![windows_subsystem = "windows"]

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::path::{Path, PathBuf};

/// CREATE_NO_WINDOW: 不留控制台窗口
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 默认端口(与 src/core/config.ts 里的默认值一致)
const DEFAULT_PORT: u16 = 43110;

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    fn FindWindowW(class_name: *const u16, window_name: *const u16) -> isize;
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn alert(text: &str) {
    let body = wide(text);
    let title = wide("LoL Voice");
    unsafe {
        MessageBoxW(0, body.as_ptr(), title.as_ptr(), 0x0001_0000);
    }
}

/// 找到主窗口并显示出来(窗口类名是 tao 注册的 "Window Class")。
fn show_our_window() -> bool {
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_APPWINDOW: isize = 0x0004_0000;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    let class_name = wide("Window Class");
    let title = wide("LoL Voice");
    let hwnd = unsafe { FindWindowW(class_name.as_ptr(), title.as_ptr()) };
    if hwnd == 0 {
        return false;
    }
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let restored = (ex | WS_EX_APPWINDOW) & !WS_EX_TOOLWINDOW;
        if restored != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, restored);
            SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0020);
        }
        ShowWindow(hwnd, 5);
        SetForegroundWindow(hwnd);
    }
    true
}

/// 启动日志: %LOCALAPPDATA%\LoL_Voice\startup.log
///
/// 以前启动器把 node 的 stdout/stderr 全丢掉, 用户报"闪退"时拿不到任何线索。
fn startup_log() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let dir = PathBuf::from(base).join("LoL_Voice");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("startup.log"))
}

/// 读日志尾部(最多 max 字节), 用来弹给用户看。
fn read_tail(path: &Path, max: u64) -> String {
    let mut file = match File::open(path) {
        Ok(handle) => handle,
        Err(_) => return String::from("(日志为空)"),
    };
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = size.saturating_sub(max);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::from("(日志读取失败)");
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return String::from("(日志读取失败)");
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    // 截断点可能切在多字节字符中间, 去掉开头的乱码行
    match text.find('\n') {
        Some(index) if start > 0 => text[index + 1..].trim().to_string(),
        _ => text.trim().to_string(),
    }
}

/// 程序本体在哪: 优先 exe 旁边的 resource\, 否则就用 exe 自己的目录。
fn resolve_root(exe_dir: &Path) -> PathBuf {
    let nested = exe_dir.join("resource");
    if nested.join("src").join("app.ts").exists() {
        return nested;
    }
    exe_dir.to_path_buf()
}

fn main() {
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => {
            alert("无法确定程序位置");
            return;
        }
    };
    let exe_dir = exe.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));

    // 已经在运行? 那就把窗口叫回来, 不要开第二个
    if std::net::TcpStream::connect(("127.0.0.1", DEFAULT_PORT)).is_ok() {
        if !show_our_window() {
            alert("软件已经在运行了, 但没能把窗口叫回来。\n\n可以到任务管理器结束 node.exe 与 voice-shell.exe 再重新打开。");
        }
        return;
    }

    let root = resolve_root(&exe_dir);
    let node = root.join("runtime").join("node.exe");
    let app = root.join("src").join("app.ts");
    if !node.exists() || !app.exists() {
        let missing = if !node.exists() { node.display().to_string() } else { app.display().to_string() };
        alert(&format!(
            "文件不完整，缺少：\n{missing}\n\n请把 LoL_Voice.exe 与 resource 文件夹放在一起，不要只拿一个文件。"
        ));
        return;
    }

    // 输出重定向到日志: 用户闪退时, 这份文件是唯一能说明原因的东西
    let log_path = startup_log();
    let mut log_handle = log_path.as_ref().and_then(|p| {
        OpenOptions::new().create(true).write(true).truncate(true).open(p).ok()
    });
    if let Some(handle) = log_handle.as_mut() {
        let _ = writeln!(
            handle,
            "--- LoL Voice 启动 ---\n程序目录: {}\nNode: {}\n入口: {}",
            root.display(),
            node.display(),
            app.display()
        );
        let _ = handle.flush();
    }
    let out_stdio = match log_handle.as_ref().and_then(|h| h.try_clone().ok()) {
        Some(clone) => Stdio::from(clone),
        None => Stdio::null(),
    };
    let err_stdio = match log_handle.as_ref().and_then(|h| h.try_clone().ok()) {
        Some(clone) => Stdio::from(clone),
        None => Stdio::null(),
    };

    // 限制 V8 堆上限: 默认上限是按机器内存算的(可以很大), 这个程序根本用不到,
    // 限住之后 GC 更早回收, 常驻内存更可控。
    let started = std::process::Command::new(&node)
        .arg("--max-old-space-size=256")
        .arg(&app)
        .current_dir(&root)
        .env("LEAGUE_VOICE_RELEASE", "1")
        .stdin(Stdio::null())
        .stdout(out_stdio)
        .stderr(err_stdio)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();

    let mut child = match started {
        Ok(handle) => handle,
        Err(error) => {
            alert(&format!("启动失败：{error}"));
            return;
        }
    };

    // 盯 10 秒: 如果 node 这么快就退出, 说明是启动失败(缺文件/端口被占/报错),
    // 必须让用户看到原因, 而不是"双击闪一下就没了"。
    let mut early_exit: Option<i32> = None;
    for _ in 0..50 {
        match child.try_wait() {
            Ok(Some(status)) => {
                early_exit = Some(status.code().unwrap_or(-1));
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(_) => break,
        }
    }

    if let Some(code) = early_exit {
        let tail = log_path
            .as_ref()
            .map(|path| read_tail(path, 1400))
            .unwrap_or_else(|| String::from("(没有日志)"));
        // 正常退出(用户开了一下就关)不该弹错误框: 只要走到"HTTP 服务已启动"且退出码为 0 就算正常
        let served = tail.contains("HTTP 服务已启动");
        if code == 0 && served {
            return;
        }
        let where_log = log_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| String::from("(未生成)"));
        alert(&format!(
            "程序启动后立刻退出了(退出码 {code})。\n\n最近日志:\n{tail}\n\n日志文件:\n{where_log}\n\n把上面的日志发给我就能定位问题。"
        ));
    }
}
