/** 对局端: 游戏内文本语言包切换/还原(目标槽位跟随客户端基准语种)。 */
import path from "node:path";
import { backupPath, pathExists, replaceFile, restoreFileVerbose, targetDirState, walkFiles } from "../core/fsx.ts";
import { makeResult, SLOT_MISSING_REASON, type ModuleResult } from "../core/result.ts";
import type { ModuleContext } from "../core/types.ts";
import { isGameRunning } from "../core/win/processes.ts";
import { wadSuffix } from "../packs/baselocale.ts";
import { localeDisplayName } from "../packs/locales.ts";
import { availableSuffixes, buildSlotIndex, langSources, pickTargetSuffix, slotFileName } from "../packs/wad.ts";
import { applyIngameFont, restoreIngameFont } from "./ingameFont.ts";

const MODULE = "ingame_lang" as const;

/** 首选目标: Localized/Global.<基准语种>.wad.client(国服 zh_CN, 国际服按实际语种)。 */
function preferredName(context: ModuleContext): string {
  return `Global${wadSuffix(context.baseLocale)}`;
}

interface LangTarget {
  name: string;
  dst: string;
  /** 首选槽位对不上、且游戏里有多个语种槽位时的候选列表(空 = 不歧义)。 */
  ambiguous: string[];
}

/**
 * 解析要替换的文本槽位。
 *
 * 为什么不能只拼 `Global.<基准语种>`: 国际服常见"默认语种用无后缀文件"
 * (Global.wad.client), 或者客户端语言与文件槽位不一致。这里和语音一样先看游戏里
 * 实际存在哪些槽位: 首选在就用首选; 只有唯一槽位就用它; 多个且对不上才报歧义。
 */
async function resolveTarget(destDir: string, context: ModuleContext): Promise<LangTarget> {
  const preferred = preferredName(context);
  const index = await buildSlotIndex(destDir);
  const suffix = pickTargetSuffix(index, "Global", wadSuffix(context.baseLocale));
  if (suffix !== null) {
    const name = slotFileName("Global", suffix);
    return { name, dst: path.join(destDir, name), ambiguous: [] };
  }
  // 首选文件没了但备份还在: 说明槽位本来就是首选那个, 让 replaceFile 用备份兜底
  if (await pathExists(backupPath(path.join(destDir, preferred)))) {
    return { name: preferred, dst: path.join(destDir, preferred), ambiguous: [] };
  }
  return { name: preferred, dst: path.join(destDir, preferred), ambiguous: availableSuffixes(index, "Global") };
}

/** 切换游戏内文本语言包。 */
export async function applyIngameLang(locale: string, context: ModuleContext): Promise<ModuleResult> {
  if (await isGameRunning()) {
    return makeResult(MODULE, false, {
      reason: "对局中",
      message: "检测到英雄联盟游戏对局进程正在运行，请退出对局后再切换。"
    });
  }
  const sources = await langSources(locale, context.voiceRoot);
  if (!sources.length) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message:
        `未找到 ${locale} 的游戏内语言包文件 Localized/Global.${locale}.wad.client\n` +
        `期望目录：${path.join(context.voiceRoot, locale, "DATA", "FINAL", "Localized")}`
    });
  }
  if (!context.finalDir) {
    return makeResult(MODULE, false, { reason: "游戏路径未就绪", message: "未能解析游戏文件目录 Game\\DATA\\FINAL。" });
  }

  const destDir = path.join(context.finalDir, "Localized");
  context.progress?.(0, 1);

  const [usable, why] = await targetDirState(destDir);
  if (!usable) {
    return makeResult(MODULE, false, {
      planned: 1,
      success: 0,
      failed: 1,
      reason: `替换失败 1 个：${why}`,
      message: `替换失败 1 个：${why}`,
      errors: [`${preferredName(context)}: ${why}`]
    });
  }

  const target = await resolveTarget(destDir, context);
  const { name, dst } = target;
  if (target.ambiguous.length > 1) {
    const slots = target.ambiguous.map((item) => item.replace(".wad.client", "")).join(" / ");
    return makeResult(MODULE, false, {
      planned: 1,
      success: 0,
      failed: 1,
      reason: `替换失败 1 个：${SLOT_MISSING_REASON}`,
      message:
        `游戏内 Global 文本有多个语种槽位（${slots}），无法确定当前客户端用哪一个。\n` +
        `请把客户端切成对应语种，或在工具配置里指定 baseLocale（当前基准语种 ${context.baseLocale}）。`,
      errors: [`${name}: 多个语种槽位 ${slots}`]
    });
  }

  if (!(await pathExists(dst)) && !(await pathExists(backupPath(dst)))) {
    return makeResult(MODULE, false, {
      planned: 1,
      success: 0,
      failed: 1,
      reason: `替换失败 1 个：${SLOT_MISSING_REASON}`,
      message: `游戏内没有本客户端语种对应的文本文件（${name}），请确认客户端路径与语种设置。`,
      errors: [`${name}: ${SLOT_MISSING_REASON}`]
    });
  }

  const [ok, reason] = await replaceFile(sources[0]!, dst);
  context.progress?.(1, 1, name);
  if (ok) {
    // 文字换完之后接着换字体: 局内字体跟着语言走, 不额外占界面选项
    const font = await applyIngameFont(locale, context.finalDir);
    const fontNote = font.ok ? `，${font.message}` : `，但字体未切换：${font.message}`;
    return makeResult(MODULE, true, {
      planned: 1,
      success: 1,
      failed: 0,
      message: `游戏内语言 1/1 已切换为 ${localeDisplayName(locale)}${fontNote}`,
      detail: { target: dst, slot: name, base_locale: context.baseLocale, font_changed: font.changed }
    });
  }
  return makeResult(MODULE, false, {
    planned: 1,
    success: 0,
    failed: 1,
    reason: `替换失败 1 个：${reason}`,
    message: `替换失败 1 个：${reason}`,
    errors: [`${name}: ${reason}`]
  });
}

/** 还原游戏内文本为客户端原版(匹配任意语种的文本备份)。 */
export async function restoreIngameLang(context: ModuleContext): Promise<ModuleResult> {
  if (await isGameRunning()) {
    return makeResult(MODULE, false, {
      action: "restore",
      reason: "对局中",
      message: "检测到英雄联盟游戏对局进程正在运行，请退出对局后再还原。"
    });
  }
  if (!context.finalDir) {
    return makeResult(MODULE, false, { action: "restore", reason: "游戏路径未就绪", message: "未能解析游戏文件目录 Game\\DATA\\FINAL。" });
  }

  // 先还原局内字体(UI.wad.client), 再还原文本语言包
  const fontRestore = await restoreIngameFont(context.finalDir);

  const destDir = path.join(context.finalDir, "Localized");
  const targets = (await walkFiles(destDir, { match: (file) => file.endsWith(".wad.client.chosen_bak") }))
    .filter((file) => path.basename(file).startsWith("Global."))
    .sort();
  context.progress?.(0, targets.length || 1);
  if (!targets.length) {
    context.progress?.(1, 1);
    return makeResult(MODULE, true, {
      action: "restore",
      planned: 0,
      success: 0,
      failed: 0,
      message: `未发现需要还原的语言包备份文件${fontRestore.changed ? `（${fontRestore.message}）` : ""}`
    });
  }

  let success = 0;
  let done = 0;
  const errors: string[] = [];
  for (const bak of targets) {
    const original = bak.slice(0, -".chosen_bak".length);
    const [ok, reason] = await restoreFileVerbose(original);
    done += 1;
    if (ok) success += 1;
    else errors.push(`${path.basename(original)}: ${reason}`);
    context.progress?.(done, targets.length, path.basename(original));
  }
  if (errors.length) {
    return makeResult(MODULE, false, {
      action: "restore",
      planned: targets.length,
      success,
      failed: errors.length,
      reason: `还原失败 ${errors.length} 个`,
      message: `还原失败 ${errors.length} 个`,
      errors
    });
  }
  return makeResult(MODULE, true, {
    action: "restore",
    planned: targets.length,
    success,
    failed: 0,
    message: targets.length > 1 ? `已还原 ${success} 个文本文件` : "游戏内文本已恢复为客户端原版"
  });
}
