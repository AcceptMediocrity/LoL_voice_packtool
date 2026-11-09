/**
 * 关掉软件 = 关掉"对局前选人语音"与"客户端界面文字", 并（按需）重启一次客户端。
 *
 * 局内语音 / 局内文字是写进游戏目录的补丁文件, 退出时**一律不动** ——
 * 那是用户"这次开启"的结果, 要还原请点界面上的『恢复原版』。
 *
 * 两个功能现在是**同一个插件里的两个开关**, 所以关闭只需要改配置:
 *   1. voice.enabled = false（选人语音）;
 *   2. text.enabled  = false（客户端界面文字, 插件会在几秒内把文字还原成原文）;
 *   3. 两个都不用了才撤加载器激活项（注册表 Debugger, 需要一次管理员授权）;
 *   4. 以上有任何改动且客户端正在运行, 才重启客户端。
 *
 * 插件文件一律保留: 下次开启不用重新复制, 也不会出现"注册表还指着已删除 core.dll"。
 */
import { createLogger } from "../core/logger.ts";
import { isClientRunning, isGameRunning } from "../core/win/processes.ts";
import { restartClientUx, waitForClientUp } from "../core/win/lcu.ts";
import {
  clientFeaturesInUse,
  readClientConfig,
  unmountVoiceAssets,
  writeClientConfig
} from "../packs/clientPlugin.ts";
import { rollbackLoaderIfIdle } from "../textpack/deploy.ts";

const logger = createLogger("shutdown");

export interface ShutdownResult {
  /** 是否真的关掉了什么（没有开启过就什么都不做, 也不重启客户端）。 */
  changed: boolean;
  /** 是否已经触发客户端重启。 */
  restarted: boolean;
  notes: string[];
}

/**
 * 可注入的探测/重启动作（测试用；生产一律走真实实现）。
 * 不写成全局开关, 是为了让测试之间互不影响 —— 测试文件是并发跑的。
 */
export interface ShutdownOptions {
  clientRunning?: () => Promise<boolean>;
  gameRunning?: () => Promise<boolean>;
  restart?: () => Promise<{ ok: boolean; message: string }>;
  waitForClient?: (timeoutMs: number) => Promise<boolean>;
}

async function turnOffLobbyVoice(notes: string[]): Promise<boolean> {
  const before = await readClientConfig();
  if (!before.voice.enabled) return false;
  const written = await writeClientConfig({ voice: { enabled: false, locale: "zh_CN", cdn_locale: "zh_cn" } });
  await unmountVoiceAssets();
  notes.push(written.ok ? "已关闭对局前选人语音" : `关闭对局前选人语音失败：${written.message}`);
  if (written.ok) logger.info(`退出清理: 已关闭对局前选人语音（原语种 ${before.voice.locale}）`);
  return written.ok;
}

async function turnOffClientText(notes: string[]): Promise<boolean> {
  const config = await readClientConfig();
  if (!config.text.enabled) return false;
  // 只关开关: 插件会自己把页面文字还原成原文, 不用重启客户端
  const written = await writeClientConfig({ text: { enabled: false } });
  notes.push(written.ok ? "已关闭客户端界面文字" : `关闭客户端界面文字失败：${written.message}`);
  if (written.ok) logger.info("退出清理: 已关闭客户端界面文字");
  return written.ok;
}

/**
 * 关闭两个"客户端内"功能。
 * 只改插件开关/挂载/注册表, 不碰 Game\DATA\FINAL 里的任何文件。
 */
export async function shutDownClientFeatures(reason = "退出清理", options: ShutdownOptions = {}): Promise<ShutdownResult> {
  const notes: string[] = [];
  const isClientUp = options.clientRunning ?? isClientRunning;
  const isGameOn = options.gameRunning ?? isGameRunning;
  const restart = options.restart ?? restartClientUx;
  const waitForClient = options.waitForClient ?? waitForClientUp;
  const clientRunning = await isClientUp();
  let changed = false;

  try {
    if (await turnOffLobbyVoice(notes)) changed = true;
  } catch (error) {
    notes.push(`关闭对局前选人语音失败：${String((error as Error).message ?? error)}`);
  }

  try {
    if (await turnOffClientText(notes)) changed = true;
  } catch (error) {
    notes.push(`关闭客户端界面文字失败：${String((error as Error).message ?? error)}`);
  }

  // 什么都没关过就不要再动注册表: 启动自检(healStaleLoader)会在下次启动时处理残留。
  // 两个功能是否还需要加载器, 以**插件配置**为准(写入失败时不会误撤)。
  if (changed) {
    try {
      const inUse = await clientFeaturesInUse();
      if (inUse.voice || inUse.text) {
        notes.push("还有功能在用加载器，保留激活项");
      } else {
        const rolled = await rollbackLoaderIfIdle(reason);
        if (rolled.rolledBack) notes.push(rolled.message);
        else if (!/本来就没激活|保留/.test(rolled.message)) notes.push(rolled.message);
      }
    } catch (error) {
      notes.push(`撤销加载器激活失败：${String((error as Error).message ?? error)}`);
    }
  }

  let restarted = false;
  if (changed && clientRunning) {
    try {
      if (await isGameOn()) {
        // 对局中重启客户端会打断玩家; 插件自己会重读配置, 声音已经停了,
        // 文字会在插件下一次轮询时还原, 下次启动客户端即完全恢复。
        notes.push("对局进行中，未自动重启客户端；下次启动客户端即为关闭状态");
      } else {
        const restartResult = await restart();
        if (restartResult.ok) {
          restarted = true;
          await waitForClient(20000);
          notes.push("已重启客户端，关闭立即生效");
        } else {
          notes.push(`关闭成功，但客户端没能自动重启：${restartResult.message}`);
        }
      }
    } catch (error) {
      notes.push(`重启客户端失败：${String((error as Error).message ?? error)}`);
    }
  } else if (changed) {
    notes.push("客户端未运行，下次启动即为关闭状态");
  }

  return { changed, restarted, notes };
}
