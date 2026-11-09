import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { cleanupSuite, exists, makeDirSafe, makeTempDir, readFile, useSuite, writeFile } from "./helpers.ts";
import {
  clientPluginDir,
  isClientPluginStaged,
  readClientConfig,
  stageClientPlugin,
  writeClientConfig,
  writeLangDict
} from "../src/packs/clientPlugin.ts";

useSuite("client-plugin");

const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA };

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

after(async () => {
  if (saved.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
  await cleanupSuite();
});

test("部署: 只产生一个插件目录(index.js + text.js + config.json)", async () => {
  const root = await makeTempDir("stage");
  await withLocalAppData(path.join(root, "localappdata"), async () => {
    const staged = await stageClientPlugin({ textLocale: "ja_jp" });
    assert.equal(staged.ok, true, staged.message);

    const dir = clientPluginDir();
    assert.equal(await isClientPluginStaged(), true);
    assert.equal(await exists(path.join(dir, "index.js")), true);
    assert.equal(await exists(path.join(dir, "text.js")), true, "文字内核是同一个插件里的模块");
    assert.equal(await exists(path.join(dir, "config.json")), true);
    assert.equal(await exists(path.join(dir, "lang", "ja_jp.js")), true, "按需写入当前语种字典");

    // 插件脚本里不能出现"第二个插件"的痕迹, 也不应该把开关写死进代码
    const index = await readFile(path.join(dir, "index.js"));
    assert.match(index, /chosen-voice/);
    assert.match(index, /config\.json/);
  });
});

test("配置: 两个开关完全独立, 改一个不会影响另一个", async () => {
  const root = await makeTempDir("config");
  await withLocalAppData(path.join(root, "localappdata"), async () => {
    await stageClientPlugin();

    await writeClientConfig({ voice: { enabled: true, locale: "ja_JP" } });
    let config = await readClientConfig();
    assert.equal(config.voice.enabled, true);
    assert.equal(config.voice.locale, "ja_JP");
    assert.equal(config.voice.cdn_locale, "ja_jp", "cdn 语种跟着 locale 自动补");
    assert.equal(config.text.enabled, false, "开语音不能顺手开文字");

    await writeClientConfig({ text: { enabled: true, locale: "ko_kr" } });
    config = await readClientConfig();
    assert.equal(config.text.enabled, true);
    assert.equal(config.text.locale, "ko_kr");
    assert.equal(config.voice.enabled, true, "开文字不能顺手关语音");

    await writeClientConfig({ voice: { enabled: false, locale: "zh_CN" } });
    config = await readClientConfig();
    assert.equal(config.voice.enabled, false);
    assert.equal(config.text.enabled, true, "关语音不能顺手关文字");
  });
});

test("配置: 旧版扁平格式({enabled,locale,cdn_locale})能读成 voice 开关", async () => {
  const root = await makeTempDir("legacy-config");
  await withLocalAppData(path.join(root, "localappdata"), async () => {
    const dir = clientPluginDir();
    await makeDirSafe(dir);
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ enabled: true, locale: "ja_JP", cdn_locale: "ja_jp" })
    );
    const config = await readClientConfig();
    assert.equal(config.voice.enabled, true);
    assert.equal(config.voice.locale, "ja_JP");
    assert.equal(config.text.enabled, false);
  });
});

test("部署: 旧版两个插件目录会被改名停用(加载器只执行一个插件)", async () => {
  const root = await makeTempDir("legacy-dirs");
  const localAppData = path.join(root, "localappdata");
  await withLocalAppData(localAppData, async () => {
    const plugins = path.join(localAppData, "LoL_Voice", "loader", "plugins");
    await writeFile(path.join(plugins, "voice-sync", "index.js"), "/* old voice */\n");
    await writeFile(path.join(plugins, "text-replacer", "index.js"), "/* old text */\n");

    const staged = await stageClientPlugin();
    assert.equal(staged.ok, true, staged.message);

    assert.equal(await exists(path.join(plugins, "voice-sync")), false, "旧目录不能再被加载器当成插件");
    assert.equal(await exists(path.join(plugins, "text-replacer")), false);
    assert.equal(await exists(path.join(plugins, "_legacy_voice-sync")), true);
    assert.equal(await exists(path.join(plugins, "_legacy_text-replacer")), true);
  });
});

test("字典: 只保留当前语种的一份", async () => {
  const root = await makeTempDir("lang");
  await withLocalAppData(path.join(root, "localappdata"), async () => {
    await stageClientPlugin();
    assert.equal((await writeLangDict("en_us")).ok, true);
    assert.equal((await writeLangDict("ja_jp")).ok, true);
    const files = await fs.readdir(path.join(clientPluginDir(), "lang"));
    assert.deepEqual(files, ["ja_jp.js"], "换语种后旧字典应被清掉");
    const content = await readFile(path.join(clientPluginDir(), "lang", "ja_jp.js"));
    assert.match(content, /^export default \{/);
  });
});
