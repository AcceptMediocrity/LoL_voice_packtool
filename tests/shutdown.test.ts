import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { cleanupSuite, exists, makeFinalDir, makeTempDir, readFile, useSuite, writeFile } from "./helpers.ts";
import { readClientConfig } from "../src/packs/clientPlugin.ts";
import { shutDownClientFeatures, type ShutdownOptions } from "../src/modules/shutdown.ts";

useSuite("shutdown");

const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA };

/** 客户端不在运行: 退出清理不应该真的去重启/连 LCU。 */
const clientDown: ShutdownOptions = { clientRunning: async () => false };

/** 临时把 LOCALAPPDATA 指向测试目录, 跑完立刻还原(测试文件是并发跑的, 别把环境留给别人)。 */
async function withLocalAppData<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = dir;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = before;
  }
}

/** 造一个"两个客户端内功能都开着"的加载器目录(合并后的单插件布局)。 */
async function makeLoader(localAppData: string): Promise<string> {
  const dir = path.join(localAppData, "LoL_Voice", "loader");
  const plugin = path.join(dir, "plugins", "chosen-voice");
  await writeFile(path.join(plugin, "index.js"), "/* chosen-voice */\n");
  await writeFile(path.join(plugin, "text.js"), "export const x = 1;\n");
  await writeFile(
    path.join(plugin, "config.json"),
    JSON.stringify(
      {
        voice: { enabled: true, locale: "ja_JP", cdn_locale: "ja_jp" },
        text: { enabled: true, locale: "ja_jp" }
      },
      null,
      2
    )
  );
  await writeFile(path.join(plugin, "lang", "ja_jp.js"), "export default {};\n");
  await writeFile(path.join(dir, "core.dll"), "fake-loader-core");
  await writeFile(path.join(dir, "config"), "optimized_client=false\n");
  await writeFile(path.join(dir, "install.cmd"), "@echo off\r\nexit /b 0\r\n");
  await writeFile(path.join(dir, "uninstall.cmd"), "@echo off\r\nexit /b 0\r\n");
  return dir;
}

after(async () => {
  if (saved.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
  await cleanupSuite();
});

test("退出清理: 关掉两个开关, 保留插件与加载器, 不碰局内补丁", async () => {
  const root = await makeTempDir("all-on");
  const localAppData = path.join(root, "localappdata");
  await withLocalAppData(localAppData, async () => {
    const loader = await makeLoader(localAppData);

    // 局内补丁: 退出清理一个字节都不能动
    const finalDir = path.join(root, "Game", "DATA", "FINAL");
    await makeFinalDir(finalDir, { champions: ["Ahri"], maps: ["Map11"] });
    const ingameBefore = await readFile(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client"));

    const result = await shutDownClientFeatures("退出清理", clientDown);

    assert.equal(result.changed, true, "开着的时候必须真的关掉");
    assert.equal(result.restarted, false, "客户端没在运行就不重启");
    assert.ok(result.notes.some((line) => line.includes("选人语音")), result.notes.join(" | "));
    assert.ok(result.notes.some((line) => line.includes("客户端界面文字")), result.notes.join(" | "));

    // 两个开关都关了, 但插件文件保留(下次开启不用重新复制)
    const config = await readClientConfig();
    assert.equal(config.voice.enabled, false);
    assert.equal(config.text.enabled, false);
    assert.equal(await exists(path.join(loader, "plugins", "chosen-voice", "index.js")), true);

    // 加载器本体保留: 授权被取消时客户端仍然能启动, 下次启动可以再撤
    assert.equal(await exists(path.join(loader, "core.dll")), true);
    assert.equal(await exists(path.join(loader, "install.cmd")), true);
    assert.equal(await exists(path.join(loader, "uninstall.cmd")), true);

    // 局内语音/文字补丁: 完全不动
    assert.equal(await readFile(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client")), ingameBefore);
    assert.equal(await exists(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client.chosen_bak")), false);
  });
});

test("退出清理: 两个功能都没开时什么都不做, 也不碰加载器文件", async () => {
  const root = await makeTempDir("all-off");
  await withLocalAppData(path.join(root, "localappdata"), async () => {
    const result = await shutDownClientFeatures("退出清理", clientDown);
    assert.equal(result.changed, false);
    assert.equal(result.restarted, false);
    assert.deepEqual(result.notes, []);
  });
});

test("退出清理: 只开了选人语音也能关掉, 不会误报关过文字", async () => {
  const root = await makeTempDir("lobby-only");
  const localAppData = path.join(root, "localappdata");
  await withLocalAppData(localAppData, async () => {
    const loader = await makeLoader(localAppData);
    await writeFile(
      path.join(loader, "plugins", "chosen-voice", "config.json"),
      JSON.stringify({ voice: { enabled: true, locale: "ja_JP", cdn_locale: "ja_jp" }, text: { enabled: false, locale: "en_us" } })
    );

    const result = await shutDownClientFeatures("退出清理", clientDown);

    assert.equal(result.changed, true);
    assert.equal((await readClientConfig()).voice.enabled, false);
    assert.ok(!result.notes.some((line) => line.includes("客户端界面文字")), result.notes.join(" | "));
    assert.equal(await exists(path.join(loader, "core.dll")), true);
  });
});

test("退出清理: 客户端在运行时会重启一次, 让关闭立即生效", async () => {
  const root = await makeTempDir("restart");
  const localAppData = path.join(root, "localappdata");
  await withLocalAppData(localAppData, async () => {
    await makeLoader(localAppData);
    let restarts = 0;
    const result = await shutDownClientFeatures("退出清理", {
      clientRunning: async () => true,
      gameRunning: async () => false,
      restart: async () => {
        restarts += 1;
        return { ok: true, message: "已重启" };
      },
      waitForClient: async () => true
    });

    assert.equal(result.changed, true);
    assert.equal(result.restarted, true);
    assert.equal(restarts, 1, "只重启一次");
    assert.ok(result.notes.some((line) => line.includes("已重启客户端")), result.notes.join(" | "));
  });
});

test("退出清理: 对局进行中不重启客户端, 只关功能", async () => {
  const root = await makeTempDir("in-game");
  const localAppData = path.join(root, "localappdata");
  await withLocalAppData(localAppData, async () => {
    await makeLoader(localAppData);
    let restarts = 0;
    const result = await shutDownClientFeatures("退出清理", {
      clientRunning: async () => true,
      gameRunning: async () => true,
      restart: async () => {
        restarts += 1;
        return { ok: true, message: "已重启" };
      }
    });

    assert.equal(result.changed, true);
    assert.equal(result.restarted, false);
    assert.equal(restarts, 0, "对局中不能打断玩家");
    assert.equal((await readClientConfig()).voice.enabled, false);
  });
});
