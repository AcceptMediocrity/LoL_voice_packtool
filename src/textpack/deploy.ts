/**
 * 加载器(Pengu core.dll)的部署 + 客户端插件开关。
 *
 * 范围: 只作用于英雄联盟**客户端**界面与大厅; 与局内游戏无关。
 *
 * 做什么:
 *   1. 把官方 core.dll(未修改)复制到本地目录(不需要管理员);
 *   2. 生成 install.cmd / uninstall.cmd(可读、可审计), 需要管理员时由界面触发 UAC 执行;
 *   3. 读取注册表判断是否已激活(读注册表不需要管理员);
 *   4. 文字/语音两个功能的状态都读**插件自己的 config.json**, 不再靠增删插件目录。
 *
 * 为什么发 core.dll 而不是整套 Pengu: 发行包里真正必需的只有这一个 455 KB 的文件,
 * 启动器(4 MB 的 WPF 界面)在游戏期间根本不需要运行。许可为 MIT, 原样收录并附声明。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { assetDir, loaderDir, readDatastoreMap } from "../core/loader.ts";
import { clearMountPoint } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { isClientRunning, killClientUx } from "../core/win/processes.ts";
import {
  CLIENT_PLUGIN_NAME,
  LEGACY_PLUGIN_NAMES,
  clientAssetsLink,
  clientFeaturesInUse,
  clientPluginDir,
  isClientPluginStaged,
  readClientConfig,
  stageClientPlugin,
  unmountVoiceAssets,
  writeClientConfig,
  writeLangDict
} from "../packs/clientPlugin.ts";

const logger = createLogger("textpack");

export { assetDir, loaderDir, readDatastoreMap };

/**
 * 测试环境必须跳过提权。
 * 踩过的坑: 测试跑的 LOCALAPPDATA 是临时目录, 但提权脚本写的是**真实 HKLM**,
 * 结果 Debugger 指向了一个随后被删掉的临时 core.dll —— 客户端直接启动不起来。
 */
function elevationDisabled(): boolean {
  return process.env.LEAGUE_VOICE_SKIP_ELEVATION === "1";
}

/** 激活用的注册表位置: 把 LeagueClientUx.exe 的调试器换成 rundll32 调用 core.dll。 */
export const IFEO_KEY =
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\LeagueClientUx.exe";

/** 写进注册表的 Debugger 值。 */
export function debuggerValue(dir: string): string {
  return `rundll32 "${path.join(dir, "core.dll")}", #6000`;
}

export interface TextPackState {
  /** 可用的目标语言(来自 assets/textpack/<语言>/dict.json)。 */
  supported: string[];
  /** 已配置的文字语言("" = 没开)。 */
  staged: string;
  /** 注册表激活项的状态。 */
  registry: "set" | "missing" | "unknown";
  /** 装好且已激活。 */
  active: boolean;
  /** 英雄联盟客户端此刻是否在运行 —— 注入发生在客户端启动时。 */
  clientRunning: boolean;
  dir: string;
  message: string;
}

/** 扫描随包分发的字典。 */
export async function supportedLocales(): Promise<string[]> {
  const base = path.join(assetDir(), "textpack");
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "plugin") continue;
      const dict = path.join(base, entry.name, "dict.json");
      if (await fs.stat(dict).then(() => true).catch(() => false)) found.push(entry.name);
    }
    return found.sort();
  } catch {
    return [];
  }
}

/** 读取注册表里的激活项(只读, 不需要管理员)。 */
export async function readRegistry(): Promise<"set" | "missing" | "unknown"> {
  if (elevationDisabled()) return "set";   // 测试环境: 不去读真实注册表
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("reg", ["query", IFEO_KEY, "/v", "Debugger"], { windowsHide: true });
    } catch {
      // 受限环境(杀软/沙箱)里连进程都起不来: 当作"读不到", 不要抛到接口上
      resolve("unknown");
      return;
    }
    let out = "";
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.on("error", () => resolve("unknown"));
    child.on("close", (code) => {
      if (code === 0 && /Debugger\s+REG_SZ/i.test(out)) resolve("set");
      else if (code === 1) resolve("missing");
      else resolve("unknown");
    });
  });
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true).catch(() => false);
}

/** 文字功能当前状态(界面"客户端界面文字"卡片用)。 */
export async function getState(): Promise<TextPackState> {
  await syncCollectedFromLoader().catch(() => 0);   // 顺手把插件交上来的清单收下来
  const supported = await supportedLocales();
  const registry = await readRegistry();
  const config = await readClientConfig();
  const pluginReady = await isClientPluginStaged();
  const staged = pluginReady && config.text.enabled ? config.text.locale : "";
  const active = staged !== "" && registry === "set";
  const clientRunning = await isClientRunning();
  const message = active
    ? clientRunning
      ? `已开启（目标语言 ${staged}）—— 客户端正在运行, 重启客户端后才会完全生效`
      : `已开启（目标语言 ${staged}）—— 下次启动客户端时生效`
    : config.text.enabled && pluginReady
      ? "已配置, 但还没激活（需要管理员权限写一次注册表）"
      : "未开启";
  return { supported, staged, registry, active, clientRunning, dir: loaderDir(), message };
}

/** 配置文件: 关掉它会往客户端追加的那批 Chromium 开关(含 --no-sandbox), 也不要热键。 */
function configText(): string {
  return [
    "# LoL Voice 客户端插件 —— 使用官方 Pengu Loader 的 core.dll(未修改)",
    "# 关掉默认开启的 optimized_client: 它会向客户端追加一批 Chromium 开关(含 --no-sandbox),",
    "# 我们只借用「把插件注入页面」这一个能力, 不需要它改动客户端的启动方式。",
    "optimized_client=false",
    "use_hotkeys=false",
    ""
  ].join("\r\n");
}

function scripts(dir: string): { install: string; uninstall: string } {
  const value = debuggerValue(dir).replace(/"/g, '\\"');
  const key = IFEO_KEY.replace(/\\\\/g, "\\");
  return {
    install: [
      "@echo off",
      "chcp 65001 >nul",
      "rem 由 LoL Voice 生成: 只写一个注册表项, 让 core.dll 能在客户端启动时注入我们的插件",
      `reg add "${key}" /v Debugger /t REG_SZ /d "${value}" /f`,
      "if errorlevel 1 (echo 激活失败 & exit /b 1)",
      "echo 已开启客户端插件（重启客户端后生效）",
      "exit /b 0",
      ""
    ].join("\r\n"),
    uninstall: [
      "@echo off",
      "chcp 65001 >nul",
      "rem 由 LoL Voice 生成: 删除激活项, 客户端恢复原样",
      `reg delete "${key}" /v Debugger /f`,
      "echo 已关闭客户端插件",
      "exit /b 0",
      ""
    ].join("\r\n")
  };
}

export interface StageResult {
  ok: boolean;
  dir: string;
  locale: string;
  message: string;
}

/** 复制加载器 + 单一客户端插件, 并把文字语言写成 locale(不需要管理员)。 */
export async function stage(locale: string): Promise<StageResult> {
  const dir = loaderDir();
  const code = String(locale || "").trim().toLowerCase();
  const loader = await stageLoader();
  if (!loader.ok) return { ok: false, dir, locale: code, message: loader.message };
  const plugin = await stageClientPlugin({ textLocale: code });
  if (!plugin.ok) return { ok: false, dir, locale: code, message: plugin.message };
  const lang = await writeLangDict(code);
  if (!lang.ok) return { ok: false, dir, locale: code, message: lang.message };
  const written = await writeClientConfig({ text: { enabled: true, locale: code } });
  if (!written.ok) return { ok: false, dir, locale: code, message: written.message };
  const notes = [...loader.locked, ...plugin.locked];
  return {
    ok: true,
    dir,
    locale: code,
    message: `文件已复制${notes.length ? `（${notes.join("、")}）` : ""}，接着需要管理员权限激活一次`
  };
}

/**
 * 只部署**加载器本体**(core.dll + 激活脚本), 不放任何插件配置。
 * 两个功能共用同一个加载器, 谁先开都能用。
 */
export async function stageLoader(): Promise<{ ok: boolean; dir: string; message: string; locked: string[] }> {
  const dir = loaderDir();
  const core = path.join(assetDir(), "loader", "core.dll");
  if (!(await exists(core))) return { ok: false, dir, message: "软件包里的 core.dll 缺失", locked: [] };
  const locked: string[] = [];
  try {
    await fs.mkdir(path.join(dir, "plugins"), { recursive: true });
    try {
      await fs.copyFile(core, path.join(dir, "core.dll"));
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code ?? "");
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") locked.push("core.dll（客户端正在运行，已跳过）");
      else throw error;
    }
    if (!(await exists(path.join(dir, "config")))) await fs.writeFile(path.join(dir, "config"), configText(), "utf8");
    const { install, uninstall } = scripts(dir);
    await fs.writeFile(path.join(dir, "install.cmd"), install, "utf8");
    await fs.writeFile(path.join(dir, "uninstall.cmd"), uninstall, "utf8");
    return { ok: true, dir, message: "加载器已就位", locked };
  } catch (error) {
    return { ok: false, dir, message: `复制加载器失败：${String((error as Error).message).slice(0, 120)}`, locked };
  }
}

/**
 * 彻底移除我们放的文件(两个功能都不用时才调用)。
 *
 * keepLoader = true 时不删 core.dll / 激活脚本: 授权被取消时注册表还指着它,
 * 删了客户端就起不来。插件目录里的 voice_assets 是目录联接, 必须先把联接拆掉
 * (否则递归删除会删到用户的语音包)。
 */
export async function unstage(options: { keepLoader?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const dir = loaderDir();
  try {
    const link = clientAssetsLink();
    if (!(await clearMountPoint(link))) {
      return { ok: false, message: "语音资源联接仍被占用，暂时无法移除插件（请先关闭客户端）" };
    }
    await fs.rm(clientPluginDir(), { recursive: true, force: true });
    for (const legacy of LEGACY_PLUGIN_NAMES) {
      await fs.rm(path.join(dir, "plugins", legacy), { recursive: true, force: true });
    }
    // 旧版插件目录里可能有指向用户语音包的联接: 先拆联接, 确认拆干净了再删目录,
    // 否则递归删除会跟到目标目录里, 把用户的音频删掉。
    for (const name of await fs.readdir(path.join(dir, "plugins")).catch(() => [] as string[])) {
      if (!name.startsWith("_legacy_")) continue;
      const legacyDir = path.join(dir, "plugins", name);
      const legacyLink = path.join(legacyDir, "voice_assets");
      await clearMountPoint(legacyLink).catch(() => false);
      if (!(await fs.stat(legacyLink).then(() => true).catch(() => false))) {
        await fs.rm(legacyDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const names = options.keepLoader
      ? ["locale.txt", "LICENSE-pengu.txt", "NOTICE.txt"]
      : ["core.dll", "config", "locale.txt", "LICENSE-pengu.txt", "NOTICE.txt", "install.cmd", "uninstall.cmd"];
    for (const name of names) {
      await fs.rm(path.join(dir, name), { force: true });
    }
    // 目录空了就一起删掉, 做到"一键卸干净"; 父目录(LoL_Voice)绝对不动, 那里还有界面内核的运行目录
    const left = await fs.readdir(dir).catch(() => [] as string[]);
    const pluginsLeft = await fs.readdir(path.join(dir, "plugins")).catch(() => [] as string[]);
    if (left.length === 0 || (left.length === 1 && left[0] === "plugins" && pluginsLeft.length === 0)) {
      await fs.rmdir(path.join(dir, "plugins")).catch(() => undefined);
      await fs.rmdir(dir).catch(() => undefined);
    }
    return { ok: true, message: "已移除本地文件" };
  } catch (error) {
    return { ok: false, message: `移除失败: ${String((error as Error).message).slice(0, 120)}` };
  }
}

/** 插件在客户端里"看到但没翻到"的中文清单, 攒在这里供之后补字典。 */
export async function mergeCollected(list: string[]): Promise<number> {
  const file = path.join(loaderDir(), "collected.json");
  const known = new Set<string>();
  try {
    const old = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (Array.isArray(old)) for (const item of old) if (typeof item === "string") known.add(item);
  } catch { /* 第一次没有这个文件 */ }
  const before = known.size;
  for (const item of list) if (item && item.length <= 200) known.add(item);
  try {
    await fs.mkdir(loaderDir(), { recursive: true });
    await fs.writeFile(file, JSON.stringify([...known].sort(), null, 1), "utf8");
  } catch { /* 写不进去也不影响客户端 */ }
  return known.size - before;
}

/** 从加载器的 datastore 文件里把插件交上来的"没翻到"清单取回来。 */
export async function syncCollectedFromLoader(): Promise<number> {
  try {
    const map = await readDatastoreMap();
    const value = map["chosen-voice.collected"];
    if (typeof value !== "string") return 0;
    const parsed = JSON.parse(value) as { collected?: unknown };
    if (!Array.isArray(parsed.collected)) return 0;
    const list = parsed.collected.filter((item): item is string => typeof item === "string");
    return list.length ? await mergeCollected(list) : 0;
  } catch {
    return 0;
  }
}

/**
 * 兜底回滚: 注册表里还挂着激活项, 但两个功能都不再需要它时, 把它撤掉。
 *
 * 为什么必须有这条路径: "恢复原版"里如果只按 staged 判断, 只开过选人语音的用户
 * 会漏掉卸载, Debugger 一直指着 core.dll; 外服 core.dll 注入失败, 客户端就再也起不来。
 */
export async function rollbackLoaderIfIdle(
  reason: string,
  extraInUse?: () => Promise<boolean>
): Promise<{ rolledBack: boolean; message: string }> {
  let registry: "set" | "missing" | "unknown";
  try {
    registry = await readRegistry();
  } catch {
    return { rolledBack: false, message: "读取激活项失败, 跳过回滚" };
  }
  if (registry !== "set") return { rolledBack: false, message: "加载器本来就没激活" };

  const inUse = await clientFeaturesInUse().catch(() => ({ voice: false, text: false }));
  if (inUse.voice || inUse.text) return { rolledBack: false, message: "客户端插件还在用加载器, 保留激活项" };
  if (extraInUse) {
    const busy = await extraInUse().catch(() => false);
    if (busy) return { rolledBack: false, message: "选人语音还在用加载器, 保留激活项" };
  }

  const result = await runElevated("uninstall");
  if (result.ok) return { rolledBack: true, message: `已撤销加载器激活(${reason}), 客户端可以正常启动了` };
  return { rolledBack: false, message: `撤销加载器失败(${reason}): ${result.message}` };
}

/** 重启客户端: 注入只发生在客户端启动时, 所以运行中开启后必须重启一次。 */
export async function restartClient(): Promise<{ ok: boolean; message: string }> {
  const result = await killClientUx();
  return {
    ok: result.ok,
    message: result.ok
      ? "已关闭客户端（注入只在启动时发生）。如果它没有自己重新打开，请手动点一次启动。"
      : result.message
  };
}

/**
 * 本机有没有 Riot Vanguard。
 * Vanguard 会拦住"用调试器/注入方式启动客户端"这套做法, 表现是客户端起不来。
 */
export async function detectVanguard(): Promise<boolean> {
  const roots = [
    path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Riot Vanguard"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Riot Vanguard")
  ];
  for (const root of roots) {
    if (await exists(path.join(root, "vgc.exe"))) return true;
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("sc", ["query", "vgc"], { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let out = "";
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(/RUNNING|STOPPED|START_PENDING/i.test(out) && !/FAILED\s+1060/i.test(out)));
  });
}

/** 用 UAC 执行我们生成的那个脚本(会弹一次系统授权框)。 */
export async function runElevated(script: "install" | "uninstall"): Promise<{ ok: boolean; message: string }> {
  if (elevationDisabled()) return { ok: true, message: `已跳过真实提权（测试环境，${script}）` };
  // 装了 Vanguard 不等于一定拦: 它只保护受它管辖的客户端(国服 LoL 不受它管, 我们实测正常)。
  // 所以这里只记一条警告, 不拒绝 —— 真正的保护是"起不来就自动回滚"(rollbackLoaderIfIdle)。
  if (script === "install" && (await detectVanguard())) {
    logger.warn("本机装有 Riot Vanguard: 若目标客户端受它保护, 注入可能导致客户端无法启动(软件会在下次启动时自动撤销)");
  }
  const file = path.join(loaderDir(), script + ".cmd");
  if (!(await exists(file))) return { ok: false, message: "找不到脚本, 请先复制文件" };
  // 取消激活时如果本来就没激活, 不必弹 UAC
  if (script === "uninstall" && (await readRegistry()) === "missing") {
    return { ok: true, message: "本来就没有激活, 不需要授权" };
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Start-Process -FilePath '${file}' -Verb RunAs -Wait`], { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, message: String((error as Error).message ?? error).slice(0, 120) });
      return;
    }
    child.on("error", (error) => resolve({ ok: false, message: String(error.message).slice(0, 120) }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, message: script === "install" ? "已激活" : "已取消激活" });
      else resolve({ ok: false, message: "授权被取消或写入失败" });
    });
  });
}

// 供状态展示使用: 当前加载器里的插件目录名(只有这一个)。
export const STAGED_PLUGIN_NAME = CLIENT_PLUGIN_NAME;

/** 卸载语音资源联接(供退出清理复用)。 */
export { unmountVoiceAssets };
