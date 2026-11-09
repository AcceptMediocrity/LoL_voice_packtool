/**
 * 检测"另一个加载器"是否正在注入客户端。
 *
 * 为什么需要: Pengu 的 core.dll 是靠**扫描 libcef 里的字节特征**来下钩子的。
 * 同一个客户端进程里如果已经有另一个 loader 先注入了, libcef 的代码已经被改过,
 * 第二份 core.dll 就扫不到特征, 扫描会走到未映射内存 -> 0xc0000005,
 * 表现就是"客户端进不去"（实测崩溃点 core.dll+0x13a50 正是特征扫描循环）。
 *
 * 所以激活前先看一眼: 有别的加载器就**不要再激活自己**。
 * 这里只做只读检查, 不修改任何其它软件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isDirectory, isFile } from "../core/fsx.ts";
import { loaderDir } from "../core/loader.ts";
import { run } from "../core/win/shell.ts";

/** 已知的代理 DLL 名字(各种 Pengu 分支用它们把 core.dll 带进客户端进程)。 */
const PROXY_NAMES = ["winhttp.dll", "d3d9.dll", "version.dll", "dwrite.dll", "dxgi.dll", "winmm.dll", "dinput8.dll"];

/** 已知的 Pengu core.dll 体积: 官方 1.16 / 1.17-dev / 玫瑰 2.0。真实系统 DLL 的体积差很远。 */
const CORE_SIZES = new Set([455864, 454656, 505464]);

export interface ForeignLoaderInfo {
  foreign: boolean;
  details: string[];
}

/** IFEO 里是不是别人的 Debugger 值。 */
async function detectForeignIfeo(): Promise<string | null> {
  if (process.env.LEAGUE_VOICE_SKIP_ELEVATION === "1") return null;
  const key = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\LeagueClientUx.exe";
  const result = await run("reg", ["query", key, "/v", "Debugger"], { timeoutMs: 8000 });
  if (!result.ok) return null;
  const match = /Debugger\s+REG_SZ\s+(.+)/i.exec(result.stdout);
  if (!match) return null;
  const value = match[1]!.trim();
  if (!value) return null;
  const own = path.join(loaderDir(), "core.dll").toLowerCase();
  if (value.toLowerCase().includes(own)) return null;
  return `注册表里已挂着另一个加载器（${value}）`;
}

/** 客户端目录里的代理 DLL(符号链接, 或体积和 core.dll 一样)。 */
async function detectProxyDll(clientDir: string | null): Promise<string | null> {
  if (!clientDir || !(await isDirectory(clientDir))) return null;
  for (const name of PROXY_NAMES) {
    const file = path.join(clientDir, name);
    if (!(await isFile(file))) continue;
    try {
      const info = await fs.lstat(file);
      if (info.isSymbolicLink()) return `客户端目录里有代理 DLL 符号链接（${name}）`;
      if (CORE_SIZES.has(info.size)) return `客户端目录里的 ${name} 是加载器核心（${info.size} 字节）`;
    } catch {
      /* 读不到就当没有 */
    }
  }
  return null;
}

/** 检查是否存在会和我们抢注入的加载器(只读)。 */
export async function detectForeignLoader(clientDir: string | null = null): Promise<ForeignLoaderInfo> {
  const details: string[] = [];
  for (const check of [await detectForeignIfeo(), await detectProxyDll(clientDir)]) {
    if (check) details.push(check);
  }
  return { foreign: details.length > 0, details };
}

export interface ConflictGuard {
  ok: boolean;
  message: string;
}

/**
 * 激活前的闸门: 已有别的加载器就不要再写 IFEO, 否则客户端会崩在 core.dll。
 * 返回的 message 直接给用户看(说明为什么不让开)。
 */
export async function assertNoForeignLoader(clientDir: string | null = null): Promise<ConflictGuard> {
  const info = await detectForeignLoader(clientDir);
  if (!info.foreign) return { ok: true, message: "" };
  return {
    ok: false,
    message:
      "检测到另一个加载器正在注入客户端：" + info.details.join("；") + "。\n" +
      "两个加载器同时注入会让客户端启动崩溃（core.dll 特征扫描冲突，0xc0000005）。\n" +
      "请先关闭换肤工具/它的加载器，再点开启；选人语音与客户端界面文字本身可以单独使用。"
  };
}
