/**
 * 大厅选人语音("对局前选人语音")。
 *
 * 机制: **加载器插件在运行时替换客户端要播的那两句台词** —— 客户端资源包一个字节都不改。
 *
 * 插件是 `chosen-voice`(和"客户端界面文字"共用同一个插件, 各自一个开关):
 *   本次只负责写 voice.enabled / voice.locale, 并把语音包的 assets 目录挂给插件。
 * 客户端没开也能部署; 客户端开着的话重启一次才生效。
 */
import path from "node:path";
import { isClientRunning } from "../core/win/processes.ts";
import { isDirectory } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { makeResult, type ModuleResult } from "../core/result.ts";
import { localeDisplayName } from "../packs/locales.ts";
import { CHAMPION_BAN, CHAMPION_CHOOSE } from "../packs/championIds.ts";
import { locateClientAssetWad } from "../packs/wadfile.ts";
import { lobbyPatchState, restoreLobbyVoiceWad } from "../packs/lobbyWad.ts";
import {
  cdnLocaleOf,
  countVoiceLines,
  isClientPluginStaged,
  mountVoiceAssets,
  readClientConfig,
  readClientTrace,
  stageClientPlugin,
  unmountVoiceAssets,
  writeClientConfig
} from "../packs/clientPlugin.ts";
import { readRegistry, runElevated, stageLoader } from "../textpack/deploy.ts";
import { assertNoForeignLoader } from "../packs/loaderConflict.ts";
import type { SwitchEnv } from "./context.ts";

const logger = createLogger("lobby_voice");
const MODULE = "lobby_voice" as const;

export interface LobbyVoiceOptions {
  progress?: import("../core/types.ts").ProgressReporter;
  signal?: AbortSignal;
  /** 兼容旧参数: 插件模式下"别人的禁用台词"由客户端自己决定, 这里不再使用。 */
  includeOthers?: boolean;
}

/** 语音包里该语种的音频根目录(下面有 champion-choose-vo / champion-ban-vo)。 */
export function lobbyAssetsRoot(env: SwitchEnv, locale: string): string {
  return path.join(env.voiceRoot, locale, "assets");
}

/** 旧方案(改写客户端资源包)留下的补丁: 有备份就写回去。 */
async function cleanupLegacyPatch(env: SwitchEnv): Promise<string | null> {
  const located = await locateClientAssetWad(env.leagueDir, env.baseLocale);
  if (!located.ok || !located.path) return null;
  const state = await lobbyPatchState(located.path);
  if (!state.patched) return null;
  if (await isClientRunning()) {
    logger.warn("检测到旧的资源包补丁, 但客户端正在运行 —— 请退出客户端后再还原");
    return "检测到旧的资源包补丁（" + located.path + "），客户端退出后请重新执行还原";
  }
  const result = await restoreLobbyVoiceWad(located.path);
  logger.info("已回滚旧的资源包补丁: " + result.message);
  return "已回滚旧的资源包补丁（" + result.message + "）";
}

/**
 * 开启: 部署加载器 + 单一客户端插件 + 把语音包音频联接给插件 + 打开 voice 开关。
 * 全程不要求客户端运行; 客户端开着的话, 重启一次才生效。
 */
export async function applyLobbyVoice(
  locale: string,
  env: SwitchEnv,
  options: LobbyVoiceOptions = {}
): Promise<ModuleResult> {
  const progress = options.progress;
  progress?.(0, 4, "检查语音包");

  const assetsRoot = lobbyAssetsRoot(env, locale);
  const available = (await isDirectory(assetsRoot)) ? await countVoiceLines(assetsRoot) : 0;
  if (available === 0) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message: "语音包里没有 " + localeDisplayName(locale) + " 的选人语音：" + assetsRoot
    });
  }

  const notes: string[] = [];
  const legacy = await cleanupLegacyPatch(env);
  if (legacy) notes.push(legacy);

  progress?.(1, 4, "部署插件");
  const loader = await stageLoader();
  if (!loader.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: "部署失败", message: loader.message });
  }
  if (loader.locked.length) notes.push(loader.locked.join("、"));
  const staged = await stageClientPlugin();
  if (!staged.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: "部署失败", message: staged.message });
  }

  progress?.(2, 4, "挂载语音资源");
  const mounted = await mountVoiceAssets(assetsRoot);
  if (!mounted.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: "挂载失败", message: mounted.message });
  }

  progress?.(3, 4, "写入开关");
  const written = await writeClientConfig({ voice: { enabled: true, locale, cdn_locale: cdnLocaleOf(locale) } });
  if (!written.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: "写入失败", message: written.message });
  }

  // 加载器没激活 => core.dll 不会注入 => 插件根本跑不起来(只能听到原声)。
  // 这一步必须当场做掉: 文字和选人语音共用同一个注册表项, 用户只开语音时没人替他激活。
  let registry = await readRegistry();
  const clientRunning = await isClientRunning();
  if (registry !== "set") {
    // 已有别的加载器在注入客户端时, 再写 IFEO 会变成"两个 core.dll 抢着 hook",
    // 实测会让 LeagueClientUx 崩在 core.dll 的特征扫描里, 直接进不去客户端。
    const guard = await assertNoForeignLoader(env.leagueDir);
    if (!guard.ok) {
      return makeResult(MODULE, false, {
        planned: 1,
        success: 0,
        failed: 1,
        reason: "激活被阻止",
        message: guard.message,
        detail: { mechanism: "client-plugin", locale, available, notes }
      });
    }
    progress?.(3, 5, "等待管理员授权");
    const elevated = await runElevated("install");
    if (!elevated.ok) {
      return makeResult(MODULE, false, {
        planned: 1,
        success: 0,
        failed: 1,
        reason: "激活失败",
        message: "已复制文件，但加载器没有激活（需要管理员授权一次）：" + elevated.message,
        detail: { mechanism: "client-plugin", locale, available, notes }
      });
    }
    registry = await readRegistry();
    notes.push("已激活加载器（刚才弹了一次管理员授权）");
  }
  progress?.(4, 4, "完成");

  const message =
    "已开启选人语音（" + localeDisplayName(locale) + "，共 " + available + " 条台词）" +
    (clientRunning ? "，重启客户端后生效" : "，下次启动客户端时生效");

  logger.info("选人语音已开启: locale=" + locale + " lines=" + available + " registry=" + registry);
  return makeResult(MODULE, true, {
    planned: 1,
    success: 1,
    failed: 0,
    message,
    detail: {
      mechanism: "client-plugin",
      plugin: "chosen-voice",
      locale,
      available,
      assets_root: assetsRoot,
      loader: loader.dir,
      registry,
      client_running: clientRunning,
      notes
    }
  });
}

/** 关闭: 只关 voice 开关 + 拆掉联接(插件文件留着, 下次开启不用重新复制)。 */
export async function restoreLobbyVoice(env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  const progress = options.progress;
  progress?.(0, 3, "关闭开关");

  const before = await readClientConfig();
  const wasEnabled = before.voice.enabled && before.voice.locale !== "zh_CN";

  const written = await writeClientConfig({ voice: { enabled: false, locale: "zh_CN", cdn_locale: "zh_cn" } });
  progress?.(1, 3, "拆除联接");
  await unmountVoiceAssets();

  progress?.(2, 3, "检查历史补丁");
  const notes: string[] = [];
  const legacy = await cleanupLegacyPatch(env);
  if (legacy) notes.push(legacy);
  progress?.(3, 3, "完成");

  if (!written.ok) {
    return makeResult(MODULE, false, { action: "restore", planned: 1, success: 0, failed: 1, reason: "还原失败", message: written.message });
  }
  return makeResult(MODULE, true, {
    action: "restore",
    planned: 1,
    success: 1,
    failed: 0,
    message: wasEnabled ? "已关闭选人语音" : "选人语音本来就未开启",
    detail: { mechanism: "client-plugin", stopped: wasEnabled, notes }
  });
}

export interface LobbyStatus {
  ok: boolean;
  voice: string;
  lang: string;
  enabled: boolean;
  locale: string;
  /** 实现机制: 加载器插件在运行时替换音频, 不改客户端资源包。 */
  mechanism: "client-plugin";
  /** 语音包里该语种的选人/禁用台词条数。 */
  available: number;
  /** 兼容旧字段: 插件模式不轮询, 恒为 false。 */
  listening: boolean;
  presence: string;
  played: number;
  client_running: boolean;
  /** 旧方案(资源包补丁)是否还挂着备份, 需要回滚。 */
  legacy_wad_patch: boolean;
  wad_file: string | null;
  /** 插件上报的拦截计数(证明客户端真的在用我们的插件)。 */
  trace: { hits: number; at: number } | null;
  message: string;
}

/** 选人语音当前是否开着(插件就位 + voice 开关打开 + 不是中文原样)。 */
export async function lobbyVoiceEnabled(): Promise<boolean> {
  const config = await readClientConfig();
  if (!config.voice.enabled || config.voice.locale === "zh_CN") return false;
  return isClientPluginStaged();
}

/** 大厅端状态(界面"对局前选人语音"卡片用)。 */
export async function getLobbyStatus(env: SwitchEnv): Promise<LobbyStatus> {
  const config = await readClientConfig();
  const staged = await isClientPluginStaged();
  const enabled = staged && config.voice.enabled && config.voice.locale !== "zh_CN";
  const locale = enabled ? config.voice.locale : env.config.defaultLocale;
  const available = await countVoiceLines(lobbyAssetsRoot(env, locale));
  const [clientRunning, located] = await Promise.all([
    isClientRunning(),
    locateClientAssetWad(env.leagueDir, env.baseLocale)
  ]);
  const legacy = located.path ? (await lobbyPatchState(located.path)).patched : false;
  const trace = await readClientTrace();
  const hits = trace?.voiceHits ?? 0;

  const parts: string[] = [];
  if (enabled) {
    parts.push("已开启（" + localeDisplayName(config.voice.locale) + "）");
    parts.push("共 " + available + " 条台词");
  } else {
    parts.push("未开启");
  }
  if (enabled && hits > 0) parts.push("已拦截 " + hits + " 次");
  else if (enabled && !trace) parts.push("等待客户端注入");
  if (legacy) parts.push("检测到旧资源包补丁, 还原即可回滚");

  return {
    ok: true,
    voice: enabled ? "已开启（" + localeDisplayName(config.voice.locale) + "）" : "未开启",
    lang: "未知",
    enabled,
    locale,
    mechanism: "client-plugin",
    available,
    listening: false,
    presence: clientRunning ? "out" : "offline",
    played: 0,
    client_running: clientRunning,
    legacy_wad_patch: legacy,
    wad_file: located.path,
    trace: trace ? { hits, at: trace.at } : null,
    message: parts.join(" · ")
  };
}

export { CHAMPION_BAN, CHAMPION_CHOOSE };
