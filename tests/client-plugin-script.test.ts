import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

/**
 * 合并后的客户端插件(assets/client-plugin/index.js)的冒烟测试。
 *
 * 这里只验证"脚本本身"的关键行为, 不模拟真实客户端:
 *   - 配置读取后 voice 开关能改写 choose-vo / ban-vo 的地址;
 *   - 关掉 voice / locale 是 zh_CN 时一个字节都不改;
 *   - 两个开关互不影响(只开语音不会去加载文字模块)。
 */
const source = await fs.readFile(new URL("../assets/client-plugin/index.js", import.meta.url), "utf8");

async function boot(config: Record<string, unknown>) {
  const opened: string[] = [];
  class XHR {
    open(_method: string, url: string) {
      opened.push(url);
    }
  }
  class AudioElement {
    src = "";
    addEventListener() {}
    load() {}
    play() {
      return Promise.resolve();
    }
  }
  const element = () => ({
    id: "",
    style: {},
    textContent: "",
    appendChild() {},
    addEventListener() {},
    closest: () => null
  });
  const documentStub = {
    readyState: "complete",
    documentElement: { ...element(), appendChild() {} },
    body: { ...element(), appendChild() {} },
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => element(),
    addEventListener() {}
  };
  const timers: unknown[] = [];
  const context = vm.createContext({
    window: {
      fetch: async () => ({ ok: true, json: async () => config }),
      DataStore: { set() {} }
    },
    // 浏览器里全局 fetch 就是 window.fetch; 这里分开给, 配置读取走全局这一个
    fetch: async () => ({ ok: true, json: async () => config }),
    document: documentStub,
    XMLHttpRequest: XHR,
    HTMLAudioElement: AudioElement,
    Request: class {},
    URL,
    console,
    JSON,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Promise,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn: Function) => { timers.push(fn); return 0; }
  });
  vm.runInContext(source, context);
  // 等 loadConfig 的 promise 链跑完
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));

  const probe = new XHR();
  probe.open("GET", "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-choose-vo/103.ogg");
  probe.open("GET", "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-ban-vo/103.ogg");
  probe.open("GET", "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-skins/103.json");
  return opened;
}

test("插件: voice 开启时只改写选人/禁用台词地址", async () => {
  const opened = await boot({ voice: { enabled: true, locale: "ja_JP", cdn_locale: "ja_jp" }, text: { enabled: false, locale: "en_us" } });
  assert.deepEqual(opened, [
    "https://plugins/chosen-voice/voice_assets/champion-choose-vo/103.ogg",
    "https://plugins/chosen-voice/voice_assets/champion-ban-vo/103.ogg",
    "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-skins/103.json"
  ], "只动两类台词, 其它请求原样放过");
});

test("插件: voice 关闭时一个地址都不改", async () => {
  const opened = await boot({ voice: { enabled: false, locale: "ja_JP", cdn_locale: "ja_jp" }, text: { enabled: true, locale: "ja_jp" } });
  assert.deepEqual(opened, [
    "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-choose-vo/103.ogg",
    "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-ban-vo/103.ogg",
    "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-skins/103.json"
  ], "文字开着也不能影响音频");
});

test("插件: 中文原声(locale=zh_CN)不做替换", async () => {
  const opened = await boot({ voice: { enabled: true, locale: "zh_CN", cdn_locale: "zh_cn" }, text: { enabled: false, locale: "en_us" } });
  assert.equal(opened[0], "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-choose-vo/103.ogg");
  assert.equal(opened[1], "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-ban-vo/103.ogg");
});

test("插件: 配置缺失/格式不对时保持全关, 不改任何请求", async () => {
  const opened = await boot({});
  assert.equal(opened[0], "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-choose-vo/103.ogg");
  assert.equal(opened[1], "https://127.0.0.1:1234/lol-game-data/assets/v1/champion-ban-vo/103.ogg");
});
