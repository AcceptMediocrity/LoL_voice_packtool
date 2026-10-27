/**
 * wad 资源匹配与目标命名。
 *
 * 只接受 <名字>.<locale>.wad.client 或完全没有语种后缀的 <名字>.wad.client,
 * 绝不把 ko_KR 之类其它语种的文件当成本语种资源替换进国服目录。
 */
import path from "node:path";
import { walkFiles } from "../core/fsx.ts";
import { isWadFile } from "./locales.ts";

export const WAD_EXT = ".wad.client";

/** 取 wad 的"资源名": 去掉 .wad.client 后再取第一个点之前的部分。 */
export function wadStem(input: string): string {
  const name = path.basename(input);
  const withoutExt = name.endsWith(WAD_EXT) ? name.slice(0, -WAD_EXT.length) : name;
  return withoutExt.split(".")[0] ?? withoutExt;
}

/** 目标文件名: <资源名>.<基准语种>.wad.client(国服是 .zh_CN, 国际服是客户端实际语种)。 */
export function targetFileName(src: string, suffix = ".zh_CN.wad.client"): string {
  return `${wadStem(src)}${suffix}`;
}


/**
 * 目录里真实存在的槽位索引。
 *
 * 为什么需要: 基准语种是靠"客户端语种"推出来的, 但**游戏实际用哪个语种槽位**可能不一样
 * (外服常见 en_GB / es_MX / pt_BR 这类, 或者客户端语种改了但游戏文件没重装)。
 * 以前只会拼 `<名字><基准后缀>`, 一不匹配就整批"目标槽位缺失", 用户看到的就是
 * "点了开启没反应"。现在改成: 先看游戏里到底有哪些文件, 按实际槽位替换。
 */
export interface SlotIndex {
  /** 语种后缀(如 ".en_US.wad.client") -> 目录里该类文件数量。"" 表示无后缀。 */
  suffixes: Map<string, number>;
  /** 资源名 -> 该名字在目录里出现过的后缀集合。 */
  byStem: Map<string, Set<string>>;
}

/** 拆出 <名字>.<locale>.wad.client 里的后缀; 无后缀返回 ""。 */
export function slotSuffixOf(name: string): string {
  const lower = name.toLowerCase();
  const bare = lower.endsWith(WAD_EXT) ? name.slice(0, -WAD_EXT.length) : name;
  const dot = bare.indexOf(".");
  return dot < 0 ? "" : bare.slice(dot) + WAD_EXT;
}

export async function buildSlotIndex(directory: string): Promise<SlotIndex> {
  const index: SlotIndex = { suffixes: new Map(), byStem: new Map() };
  const files = await walkFiles(directory, { match: isWadFile });
  for (const file of files) {
    const name = path.basename(file);
    const stem = wadStem(name);
    const suffix = slotSuffixOf(name);
    index.suffixes.set(suffix, (index.suffixes.get(suffix) ?? 0) + 1);
    const set = index.byStem.get(stem);
    if (set) set.add(suffix);
    else index.byStem.set(stem, new Set([suffix]));
  }
  return index;
}

/**
 * 给某个资源名挑一个真实存在的槽位。规则刻意保守, 因为写错槽位等于"看起来成功但游戏没变":
 *   1. 首选后缀存在 -> 用它(探测正确时的正常情况, 行为完全不变);
 *   2. 首选不存在, 但这个名字只有**唯一一个**槽位 -> 用它(安装只有单语种, 无可争议);
 *   3. 有多个语种槽位(外服常见 22 个) -> 返回 null, 不猜。
 *      猜错会静默写到别的语种上, 用户只会看到"开启成功但没变", 比报错更难查。
 */
export function pickTargetSuffix(index: SlotIndex, stem: string, preferred: string): string | null {
  const candidates = index.byStem.get(stem);
  if (!candidates || !candidates.size) return null;
  if (candidates.has(preferred)) return preferred;
  if (candidates.size === 1) return [...candidates][0]!;
  return null;
}

/** 该资源名在目录里有哪些槽位(报错时列给用户看, 便于确认客户端语种)。 */
export function availableSuffixes(index: SlotIndex, stem: string): string[] {
  const set = index.byStem.get(stem);
  return set ? [...set].sort() : [];
}

/** 目标槽位文件名: <资源名><后缀>(后缀为 "" 时就是 <资源名>.wad.client)。 */
export function slotFileName(stem: string, suffix: string): string {
  return suffix ? `${stem}${suffix}` : `${stem}${WAD_EXT}`;
}

export interface MatchOptions {
  recursive?: boolean;
  /** 只接受指定资源名(语言包必须限定 Global, 否则会把别的 wad 写到错误目标)。 */
  stem?: string;
}

/** 按语种匹配目录里的 wad 资源(语种精确匹配优先于无后缀)。 */
export async function matchLocaleFiles(directory: string, locale: string, options: MatchOptions = {}): Promise<string[]> {
  const files = await walkFiles(directory, { recursive: options.recursive ?? false, match: isWadFile });
  const suffix = `.${locale}${WAD_EXT}`;
  const exact = new Map<string, string>();
  const plain = new Map<string, string>();
  for (const file of files) {
    const name = path.basename(file);
    if (name.endsWith(suffix)) {
      const key = name.slice(0, -suffix.length);
      if (!exact.has(key)) exact.set(key, file);
      continue;
    }
    const withoutExt = name.slice(0, -WAD_EXT.length);
    if (withoutExt.includes(".")) continue; // 带别的语种后缀: 不收
    if (!plain.has(withoutExt)) plain.set(withoutExt, file);
  }
  const merged = new Map<string, string>([...plain, ...exact]);
  return [...merged.keys()]
    .filter((key) => !options.stem || key === options.stem)
    .sort()
    .map((key) => merged.get(key)!);
}

/**
 * 目标槽位数量(资源缺失时界面显示 0/N 用)。
 * suffix 为空时统计所有带语种后缀的槽位, 便于跨语种诊断。
 */
export async function targetSlotCount(directory: string, suffix = ""): Promise<number> {
  const files = await walkFiles(directory, {
    match: (name) => (suffix ? name.endsWith(suffix) : /\.[a-z]{2}_[A-Z]{2}\.wad\.client$/.test(name))
  });
  return files.length;
}

export interface ResourceGroup {
  name: string;
  sources: string[];
  destDir: string;
}

/** 对局语音的两组替换计划: 英雄台词 + 地图/播报员。 */
export async function voiceGroups(locale: string, voiceRoot: string, finalDir: string): Promise<ResourceGroup[]> {
  const resFinal = path.join(voiceRoot, locale, "DATA", "FINAL");
  const [champions, maps] = await Promise.all([
    matchLocaleFiles(path.join(resFinal, "Champions"), locale),
    matchLocaleFiles(path.join(resFinal, "Maps", "Shipping"), locale, { recursive: true })
  ]);
  return [
    { name: "champions", sources: champions, destDir: path.join(finalDir, "Champions") },
    { name: "maps", sources: maps, destDir: path.join(finalDir, "Maps", "Shipping") }
  ];
}

/** 游戏内语言包源文件(限定 Global)。 */
export async function langSources(locale: string, voiceRoot: string): Promise<string[]> {
  const dir = path.join(voiceRoot, locale, "DATA", "FINAL", "Localized");
  return matchLocaleFiles(dir, locale, { stem: "Global" });
}
