/**
 * 对局端替换计划的执行器: 预检目标槽位 -> 逐文件安全替换 -> 统计 planned/success/failed。
 *
 * 为什么先预检槽位: 游戏里本来就没有的 .zh_CN 文件, 新建出来也不会被加载,
 * 直接算"替换成功"会让用户以为生效了。这类记为"目标槽位缺失"。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { backupPath, pathExists, replaceFile, targetDirState } from "../core/fsx.ts";
import { makeResult, shortReason, slotMissingNote, SLOT_MISSING_REASON, type FailureItem, type ModuleResult } from "../core/result.ts";
import type { ModuleId, ProgressReporter } from "../core/types.ts";
import { localeDisplayName } from "../packs/locales.ts";
import { availableSuffixes, buildSlotIndex, pickTargetSuffix, slotFileName, wadStem } from "../packs/wad.ts";

export interface PlanGroup {
  name: string;
  sources: string[];
  destDir: string;
}

export interface ApplyPlanOptions {
  description: string;
  progress?: ProgressReporter;
  signal?: AbortSignal;
  /** 目标槽位后缀(默认国服 .zh_CN.wad.client, 国际服按客户端实际语种)。 */
  baseSuffix?: string;
}

export async function applyPlan(
  module: ModuleId,
  locale: string,
  groups: PlanGroup[],
  options: ApplyPlanOptions
): Promise<ModuleResult> {
  const suffix = options.baseSuffix || ".zh_CN.wad.client";
  const planTotal = groups.reduce((sum, group) => sum + group.sources.length, 0);
  const failures: FailureItem[] = [];
  let success = 0;
  /** 写完再读回比对大小的文件数: 证明"真的写进去了", 而不是只报告成功。 */
  let verified = 0;
  let done = 0;
  /** 实际替换用到的槽位(和首选语种不一致时写进提示, 便于外服排障)。 */
  const slotsUsed = new Set<string>();
  /** 有多个语种槽位又对不上首选的资源名(外服多语种安装), 报给用户看。 */
  const ambiguousSlots: string[] = [];
  let cancelled = false;

  options.progress?.(0, planTotal);

  for (const group of groups) {
    if (!group.sources.length) continue;
    const [usable, why] = await targetDirState(group.destDir);
    if (!usable) {
      for (const src of group.sources) {
        done += 1;
        failures.push({ file: slotFileName(wadStem(src), suffix), reason: why });
        options.progress?.(done, planTotal, slotFileName(wadStem(src), suffix));
      }
      continue;
    }
    // 目录里的真实槽位建一次索引(外服可能是 en_GB / es_MX, 不等于客户端语种)
    const index = await buildSlotIndex(group.destDir);
    for (const src of group.sources) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      const stem = wadStem(src);
      const resolved = pickTargetSuffix(index, stem, suffix);
      done += 1;
      // 目标槽位必须是游戏里本来就有的(备份还在也算: 说明只是当前文件缺了, 可以补回)
      let dstName = resolved === null ? slotFileName(stem, suffix) : slotFileName(stem, resolved);
      let dst = path.join(group.destDir, dstName);
      if (resolved === null) {
        // 索引里没有, 再看一眼备份: 备份在说明槽位本来存在, 只是当前文件丢了
        if (await pathExists(backupPath(dst))) {
          // 保持首选槽位
        } else {
          const seen = availableSuffixes(index, stem);
          if (seen.length > 1 && ambiguousSlots.length < 3) {
            ambiguousSlots.push(`${stem}: ${seen.map((item) => item.replace(".wad.client", "")).join("/")}`);
          }
          failures.push({ file: dstName, reason: SLOT_MISSING_REASON });
          options.progress?.(done, planTotal, dstName);
          continue;
        }
      }
      if (resolved !== null && resolved !== suffix) slotsUsed.add(resolved);
      const [ok, reason] = await replaceFile(src, dst);
      if (ok) {
        success += 1;
        // 读回校验: 目标文件大小必须和源包一致, 否则等于没换成
        try {
          const [srcSize, dstSize] = await Promise.all([fs.stat(src), fs.stat(dst)]);
          if (srcSize.size === dstSize.size) verified += 1;
          else failures.push({ file: path.basename(dst), reason: "写入后大小不一致" });
        } catch {
          /* 读不到就只记成功, 不额外报错 */
        }
      } else {
        failures.push({ file: path.basename(dst), reason });
      }
      options.progress?.(done, planTotal, path.basename(dst));
    }
    if (cancelled) break;
  }

  const locName = localeDisplayName(locale);
  if (cancelled) {
    return makeResult(module, false, {
      planned: planTotal,
      success,
      failed: failures.length,
      reason: "已取消",
      message: `已取消：${options.description} 完成 ${success}/${planTotal}`,
      errors: failures.map((item) => `${item.file}: ${item.reason}`),
      detail: { plan: planTotal, success, failed: failures.length, cancelled: true }
    });
  }
  if (!failures.length && success > 0) {
    return makeResult(module, true, {
      planned: planTotal,
      success,
      failed: 0,
      message: `${options.description} ${success}/${planTotal} 已切换为 ${locName}${verified ? `（已读回校验 ${verified} 个）` : ""}${slotsUsed.size ? `（实际槽位 ${[...slotsUsed].map((item) => item.replace(".wad.client", "")).join("/")}` : ""}`,
      detail: { plan: planTotal, success, failed: 0, verified, slots: [...slotsUsed] }
    });
  }
  if (!failures.length) {
    return makeResult(module, false, {
      planned: planTotal,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message: `未找到可匹配的 ${locale} 资源文件`
    });
  }
  const reason = shortReason(failures);
  const note = slotMissingNote(failures);
  // 多语种安装对不上首选槽位时, 把候选列出来 —— 用户一眼就能看出客户端语种该填什么
  const ambiguousNote = ambiguousSlots.length
    ? `；游戏内该文件有多个语种槽位（${ambiguousSlots.join("，")}），无法确定用哪个，请在配置里指定 baseLocale 或把客户端切成对应语种`
    : "";
  return makeResult(module, false, {
    planned: planTotal,
    success,
    failed: failures.length,
    reason: `替换失败 ${failures.length} 个：${reason}`,
    message: `${locName} 替换失败 ${failures.length} 个：${reason}${note}${ambiguousNote}`,
    errors: failures.map((item) => `${item.file}: ${item.reason}`),
    detail: { plan: planTotal, success, failed: failures.length, verified }
  });
}
