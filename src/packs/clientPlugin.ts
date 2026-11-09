/**
 * 客户端插件(chosen-voice)的部署与配置。
 *
 * **一个插件同时提供两个功能**, 各自独立开关:
 *   - voice: 对局前选人语音(客户端内替换 choose-vo / ban-vo)
 *   - text : 客户端界面文字翻译(只改客户端页面, 不动局内)
 *
 * 为什么合成一个: 每个插件都会被加载器执行一次。拆成两个插件时, 客户端里会同时挂两套
 * 定时器/样式/监听器, 排障时分不清是谁改的页面, 还多一份加载开销。
 * 合并后只有一个插件目录、一份 config.json, 两个开关互不影响:
 *   换语种/开关功能 = 改配置; 不用重装插件, 也不用重新弹授权。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { clearMountPoint, isDirectory, isFile, readJsonFile, writeFileAtomic } from "../core/fsx.ts";
import { assetDir, loaderDir, readDatastoreMap } from "../core/loader.ts";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("client-plugin");

/** 插件目录名(也是它在客户端里的虚拟源前缀 https://plugins/<名字>/)。 */
export const CLIENT_PLUGIN_NAME = "chosen-voice";

/** 旧版拆开的两个插件目录: 部署时改名隐藏, 保证客户端里只跑一个插件。 */
export const LEGACY_PLUGIN_NAMES = ["voice-sync", "text-replacer"];

export interface ClientVoiceConfig {
  enabled: boolean;
  locale: string;
  cdn_locale: string;
}

export interface ClientTextConfig {
  enabled: boolean;
  locale: string;
}

export interface ClientPluginConfig {
  voice: ClientVoiceConfig;
  text: ClientTextConfig;
}

export const DEFAULT_CLIENT_CONFIG: ClientPluginConfig = {
  voice: { enabled: false, locale: "zh_CN", cdn_locale: "zh_cn" },
  text: { enabled: false, locale: "en_us" }
};

/** 语言代码 -> 社区数据源使用的目录名。 */
export const CDN_LOCALE_MAP: Record<string, string> = {
  zh_CN: "zh_cn",
  zh_TW: "zh_tw",
  en_US: "default",
  ja_JP: "ja_jp",
  ko_KR: "ko_kr",
  de_DE: "de_de",
  fr_FR: "fr_fr",
  es_ES: "es_es",
  es_MX: "es_mx",
  ru_RU: "ru_ru",
  pt_BR: "pt_br",
  tr_TR: "tr_tr",
  pl_PL: "pl_pl",
  it_IT: "it_it",
  vi_VN: "vi_vn",
  th_TH: "th_th"
};

export function cdnLocaleOf(locale: string): string {
  return CDN_LOCALE_MAP[locale] ?? "default";
}

export function clientPluginDir(): string {
  return path.join(loaderDir(), "plugins", CLIENT_PLUGIN_NAME);
}

export function clientAssetsLink(): string {
  return path.join(clientPluginDir(), "voice_assets");
}

export function clientConfigFile(): string {
  return path.join(clientPluginDir(), "config.json");
}

export function clientLangDir(): string {
  return path.join(clientPluginDir(), "lang");
}

/** 插件本体是否已就位(index.js 存在就算)。 */
export async function isClientPluginStaged(): Promise<boolean> {
  return isFile(path.join(clientPluginDir(), "index.js"));
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 读配置(带旧版扁平格式迁移: {enabled,locale,cdn_locale} 视为 voice)。 */
export async function readClientConfig(): Promise<ClientPluginConfig> {
  const raw = await readJsonFile<Record<string, unknown>>(clientConfigFile());
  if (!raw) return structuredClone(DEFAULT_CLIENT_CONFIG);
  const legacy = typeof raw["enabled"] === "boolean";
  const voiceRaw = raw["voice"] !== undefined ? asRecord(raw["voice"]) : legacy ? raw : {};
  const textRaw = asRecord(raw["text"]);
  return {
    voice: {
      enabled: voiceRaw["enabled"] === true,
      locale: typeof voiceRaw["locale"] === "string" && voiceRaw["locale"] ? voiceRaw["locale"] : DEFAULT_CLIENT_CONFIG.voice.locale,
      cdn_locale:
        typeof voiceRaw["cdn_locale"] === "string" && voiceRaw["cdn_locale"]
          ? voiceRaw["cdn_locale"]
          : cdnLocaleOf(typeof voiceRaw["locale"] === "string" ? voiceRaw["locale"] : DEFAULT_CLIENT_CONFIG.voice.locale)
    },
    text: {
      enabled: textRaw["enabled"] === true,
      locale: typeof textRaw["locale"] === "string" && textRaw["locale"] ? textRaw["locale"] : DEFAULT_CLIENT_CONFIG.text.locale
    }
  };
}

/**
 * 合并写入配置(只改传进来的字段)。
 * 插件每 3 秒重读一次, 所以写完即生效(语音立刻; 文字在几秒内重扫/还原)。
 */
export async function writeClientConfig(
  patch: { voice?: Partial<ClientVoiceConfig>; text?: Partial<ClientTextConfig> }
): Promise<{ ok: boolean; message: string; config: ClientPluginConfig }> {
  const current = await readClientConfig();
  const next: ClientPluginConfig = {
    voice: { ...current.voice, ...(patch.voice ?? {}) },
    text: { ...current.text, ...(patch.text ?? {}) }
  };
  if (patch.voice?.locale && !patch.voice.cdn_locale) next.voice.cdn_locale = cdnLocaleOf(patch.voice.locale);
  try {
    await fs.mkdir(clientPluginDir(), { recursive: true });
    await writeFileAtomic(clientConfigFile(), JSON.stringify(next, null, 2) + "\n");
    return { ok: true, message: "已写入插件配置", config: next };
  } catch (error) {
    return { ok: false, message: "写入插件配置失败：" + String((error as Error).message).slice(0, 120), config: current };
  }
}

/**
 * 旧版拆开的插件目录会被加载器当成第二个插件执行。
 * 这里把它们改名成 `_legacy_xxx`(加载器会跳过 `_` 开头的目录), 不删除任何用户文件。
 */
export async function migrateLegacyPlugins(): Promise<string[]> {
  const plugins = path.join(loaderDir(), "plugins");
  const renamed: string[] = [];
  for (const name of LEGACY_PLUGIN_NAMES) {
    const from = path.join(plugins, name);
    if (!(await isDirectory(from))) continue;
    // 目标已存在就换一个唯一名字(绝不递归删除旧目录: 里面可能有指向语音包的目录联接)
    let to = path.join(plugins, `_legacy_${name}`);
    if (await isDirectory(to)) to = path.join(plugins, `_legacy_${name}_${Date.now()}`);
    try {
      await fs.rename(from, to);
      renamed.push(`${name} -> ${path.basename(to)}`);
    } catch (error) {
      logger.warn(`迁移旧插件目录失败 ${name}: ${String((error as Error).message ?? error)}`);
    }
  }
  if (renamed.length) logger.info(`已停用旧插件目录(避免同时注入两个插件): ${renamed.join(", ")}`);
  return renamed;
}

export interface StagePluginResult {
  ok: boolean;
  dir: string;
  message: string;
  /** 因客户端正在运行而没能覆盖的文件。 */
  locked: string[];
}

/** 复制插件本体(index.js + 文字内核 text.js)到加载器目录。不需要管理员。 */
export async function stageClientPlugin(options: { textLocale?: string } = {}): Promise<StagePluginResult> {
  const dir = clientPluginDir();
  const source = path.join(assetDir(), "client-plugin", "index.js");
  const textCore = path.join(assetDir(), "textpack", "plugin", "runtime.mjs");
  if (!(await isFile(source))) return { ok: false, dir, message: "软件包里缺少客户端插件", locked: [] };
  if (!(await isFile(textCore))) return { ok: false, dir, message: "软件包里缺少文字内核", locked: [] };
  const locked: string[] = [];
  async function put(from: string, to: string, label: string): Promise<void> {
    try {
      await fs.writeFile(to, await fs.readFile(from));
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code ?? "");
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") locked.push(label);
      else throw error;
    }
  }
  try {
    await fs.mkdir(path.join(dir, "lang"), { recursive: true });
    await migrateLegacyPlugins();
    await put(source, path.join(dir, "index.js"), "插件脚本（客户端正在运行，已跳过）");
    await put(textCore, path.join(dir, "text.js"), "文字内核（客户端正在运行，已跳过）");
    // 配置只在缺失时写默认值: 已经开着的东西不能被一次 stage 覆盖掉
    if (!(await isFile(clientConfigFile()))) {
      await writeFileAtomic(clientConfigFile(), JSON.stringify(DEFAULT_CLIENT_CONFIG, null, 2) + "\n");
    }
    if (options.textLocale) await writeLangDict(options.textLocale);
    return { ok: true, dir, message: locked.length ? `插件已就位（${locked.join("、")}）` : "插件已就位", locked };
  } catch (error) {
    return { ok: false, dir, message: `复制插件失败：${String((error as Error).message).slice(0, 120)}`, locked };
  }
}

/**
 * 把一个语种的字典写成插件里的模块 `lang/<locale>.js`。
 * 只保留当前语种的那一份: 一个语种 2~3 MB, 没必要把四种都堆在用户目录里。
 */
export async function writeLangDict(locale: string): Promise<{ ok: boolean; message: string }> {
  // 字典目录名一直是小写(en_us / ja_jp / ko_kr / ru_ru); 外部传 "ja_JP" 也能用
  const code = String(locale || "").trim().toLowerCase();
  const dictFile = path.join(assetDir(), "textpack", code, "dict.json");
  if (!(await isFile(dictFile))) return { ok: false, message: `没有 ${code} 的文字字典` };
  let dict: Record<string, string>;
  try {
    dict = JSON.parse(await fs.readFile(dictFile, "utf8")) as Record<string, string>;
  } catch (error) {
    return { ok: false, message: `读取 ${code} 字典失败：${String((error as Error).message).slice(0, 120)}` };
  }
  const dir = clientLangDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (name.endsWith(".js")) await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
    }
    await writeFileAtomic(path.join(dir, `${code}.js`), `export default ${JSON.stringify(dict)};\n`);
    return { ok: true, message: `已写入 ${code} 文字字典（${Object.keys(dict).length} 条）` };
  } catch (error) {
    return { ok: false, message: `写入文字字典失败：${String((error as Error).message).slice(0, 120)}` };
  }
}

/** 建目录联接(不需要管理员权限); 已存在则先拆, 换语种就是"拆了重挂"。 */
export async function mountVoiceAssets(sourceDir: string): Promise<{ ok: boolean; message: string }> {
  if (!(await isDirectory(sourceDir))) return { ok: false, message: "语音资源目录不存在：" + sourceDir };
  const link = clientAssetsLink();
  await unmountVoiceAssets();
  try {
    await fs.symlink(path.resolve(sourceDir), link, "junction");
  } catch (error) {
    return { ok: false, message: "挂载语音资源失败：" + String((error as Error).message).slice(0, 120) };
  }
  if (!(await isDirectory(link))) return { ok: false, message: "挂载语音资源失败(联接未生效)：" + link };
  logger.info("已挂载语音资源 " + sourceDir + " -> " + link);
  return { ok: true, message: "已挂载语音资源" };
}

/**
 * 拆联接。
 * 对 junction 用 fs.rmdir / cmd rmdir 都只删链接本身; 绝不 fs.rm(recursive) ——
 * 那会删到目标目录里的音频, 那是用户的语音包。
 */
export async function unmountVoiceAssets(): Promise<void> {
  const link = clientAssetsLink();
  if (!(await isDirectory(link))) return;
  await clearMountPoint(link).catch(() => false);
}

export interface ClientTrace {
  /** 选人台词被替换了多少次(0 = 插件可能没注入)。 */
  voiceHits: number;
  /** 界面文字替换了多少处。 */
  textReplaced: number;
  at: number;
  voice: { enabled: boolean; locale: string; kind: string; id: string };
  text: { enabled: boolean; locale: string };
}

/**
 * 读插件上报的运行状态(DataStore, 会落盘)。
 * 这是**唯一能证明"客户端真的用了我们的插件"的证据**, 靠看文件看不出来。
 */
export async function readClientTrace(): Promise<ClientTrace | null> {
  const map = await readDatastoreMap();
  const raw = map[`${CLIENT_PLUGIN_NAME}.trace`];
  if (!raw) return null;
  try {
    const parsed = asRecord(JSON.parse(raw));
    const voice = asRecord(parsed["voice"]);
    const text = asRecord(parsed["text"]);
    return {
      voiceHits: numberOr(parsed["voiceHits"], 0),
      textReplaced: numberOr(parsed["textReplaced"], 0),
      at: numberOr(parsed["at"], 0),
      voice: {
        enabled: voice["enabled"] === true,
        locale: typeof voice["locale"] === "string" ? voice["locale"] : "",
        kind: typeof voice["kind"] === "string" ? voice["kind"] : "",
        id: typeof voice["id"] === "string" ? voice["id"] : ""
      },
      text: {
        enabled: text["enabled"] === true,
        locale: typeof text["locale"] === "string" ? text["locale"] : ""
      }
    };
  } catch {
    return null;
  }
}

/** 统计某语种语音包里的台词条数。 */
export async function countVoiceLines(assetsRoot: string): Promise<number> {
  let total = 0;
  for (const kind of ["champion-choose-vo", "champion-ban-vo"]) {
    try {
      const names = await fs.readdir(path.join(assetsRoot, kind));
      total += names.filter((n) => n.toLowerCase().endsWith(".ogg")).length;
    } catch {
      // 目录不存在就跳过
    }
  }
  return total;
}

/** 选人语音或客户端界面文字是否有一个开着(决定加载器能不能撤)。 */
export async function clientFeaturesInUse(): Promise<{ voice: boolean; text: boolean }> {
  const config = await readClientConfig();
  const staged = await isClientPluginStaged();
  return {
    voice: staged && config.voice.enabled && config.voice.locale !== "zh_CN",
    text: staged && config.text.enabled && config.text.locale !== ""
  };
}
