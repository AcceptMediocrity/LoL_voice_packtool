/**
 * @name chosen-voice
 * @description 选人语音替换 + 客户端界面文字翻译（**一个插件，两个独立开关**）
 *
 * 为什么合成一个插件：加载器会把 plugins 下的每个目录各执行一次。拆成两个插件时，
 * 客户端里会同时挂两套定时器 / 两套样式 / 两次 fetch 改写，排障时分不清是谁改的页面，
 * 也更容易让客户端在启动阶段被两套脚本拖住。合并后只有一份脚本、一份 config.json。
 *
 * 两个功能互不影响：
 *   voice.enabled / voice.locale  选人台词（choose-vo / ban-vo）在客户端内替换
 *   text.enabled  / text.locale   客户端页面文字替换（接口文字，不动局内）
 * 开关只改配置，插件每 3 秒重读一次：语音立刻生效；文字关掉时会把改过的文字还原成原文。
 *
 * 配置由软件写（同目录 config.json）：
 *   { "voice": { "enabled": true, "locale": "ja_JP", "cdn_locale": "ja_jp" },
 *     "text":  { "enabled": true, "locale": "ja_jp" } }
 *
 * 音频兜底顺序：本地语音包 -> 社区数据源 -> 客户端原声（任何一步失败都不会静音）
 */
(function initChosenVoice() {
  "use strict";

  var TAG = "[chosen-voice]";
  var SELF = "chosen-voice";
  // 加载器把插件目录映射成 https://plugins/<目录名>/。目录名固定, 不依赖 import.meta
  // (万一被当普通脚本加载, import.meta 会直接语法错误)。
  var BASE = "https://plugins/" + SELF + "/";
  var CDN = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global";

  /** 只认选人台词这两类，其余音频一律不碰。 */
  var KIND_RE = /\/lol-game-data\/assets\/v1\/(champion-choose-vo|champion-ban-vo)\/(\d+)\.ogg$/i;

  /** 默认全关：配置文件读不到时客户端保持原样。 */
  var config = {
    voice: { enabled: false, locale: "zh_CN", cdn_locale: "zh_cn" },
    text: { enabled: false, locale: "en_us" }
  };

  /* ------------------------------------------------------------ 选人语音 */

  var voiceStat = { hits: 0, at: 0, kind: "", id: "" };

  function localUrl(kind, id) {
    return BASE + "voice_assets/" + kind + "/" + id + ".ogg";
  }

  function cdnUrl(kind, id) {
    return CDN + "/" + (config.voice.cdn_locale || "default") + "/v1/" + kind + "/" + id + ".ogg";
  }

  /** 把客户端要的原始地址换成我们本地的；不是选人台词就原样返回。 */
  function rewrite(url) {
    if (!config.voice.enabled || typeof url !== "string") return url;
    if (config.voice.locale === "zh_CN") return url;
    var m = url.match(KIND_RE);
    if (!m) return url;
    voiceStat.hits += 1;
    voiceStat.at = Math.floor(Date.now() / 1000);
    voiceStat.kind = m[1];
    voiceStat.id = m[2];
    return localUrl(m[1], m[2]);
  }

  function hookAudioRequests() {
    try {
      var origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          var args = Array.prototype.slice.call(arguments);
          args[1] = rewrite(url);
          return origOpen.apply(this, args);
        } catch (e) {
          return origOpen.apply(this, arguments);
        }
      };
    } catch (e) { /* 忽略 */ }

    try {
      if (typeof window.fetch === "function") {
        var origFetch = window.fetch;
        window.fetch = function (input, init) {
          try {
            if (typeof input === "string") {
              input = rewrite(input);
            } else if (input && input.url) {
              var next = rewrite(input.url);
              if (next !== input.url) input = new Request(next, input);
            }
          } catch (e) { /* 忽略 */ }
          return origFetch.call(this, input, init);
        };
      }
    } catch (e) { /* 忽略 */ }

    // <audio src> 是客户端播选人台词最可能走的路径，这里做三级兜底
    try {
      var desc = Object.getOwnPropertyDescriptor(HTMLAudioElement.prototype, "src");
      if (desc && desc.set) {
        Object.defineProperty(HTMLAudioElement.prototype, "src", {
          configurable: true,
          enumerable: desc.enumerable,
          get: function () {
            return desc.get.call(this);
          },
          set: function (value) {
            var original = value;
            var next = rewrite(value);
            var el = this;
            if (next !== original) {
              el.addEventListener("error", function onLocalFail() {
                var m = String(el.src || "").match(/voice_assets\/(champion-(?:choose|ban)-vo)\/(\d+)\.ogg/);
                if (!m) return;
                el.addEventListener("error", function onCdnFail() {
                  console.warn(TAG + " 本地与数据源都失败，回退客户端原声");
                  desc.set.call(el, original);
                  try { el.load(); el.play().catch(function () {}); } catch (e) { /* 忽略 */ }
                }, { once: true });
                var fallback = cdnUrl(m[1], m[2]);
                console.warn(TAG + " 本地音频失败，改用数据源: " + fallback);
                desc.set.call(el, fallback);
                try { el.load(); el.play().catch(function () {}); } catch (e) { /* 忽略 */ }
              }, { once: true });
            }
            return desc.set.call(this, next);
          }
        });
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------ 界面文字 */

  var textCore = null;
  var textReplacer = null;
  var textDict = null;
  var textLocale = "";
  var textLoading = false;

  function stopText() {
    if (!textReplacer) return;
    try {
      textReplacer.revert();   // 先把改过的文字还原成原文
      textReplacer.off();
    } catch (e) { /* 忽略 */ }
    textReplacer = null;
    textDict = null;
    textLocale = "";
  }

  async function ensureText() {
    var want = config.text;
    if (!want.enabled) {
      stopText();
      return;
    }
    if (textLoading) return;
    if (textReplacer && textReplacer.on && textLocale === want.locale) return;
    textLoading = true;
    try {
      if (!textCore) textCore = await import(BASE + "text.js");
      if (!textDict || textLocale !== want.locale) {
        var mod = await import(BASE + "lang/" + want.locale + ".js");
        textDict = (mod && mod.default) || {};
        textLocale = want.locale;
      }
      if (!textReplacer) {
        // hideLoaderUi: 由本插件统一处理，避免两处样式
        textReplacer = textCore.createTextReplacer({ dict: textDict, patterns: [], collect: true, hideLoaderUi: false });
      } else {
        textReplacer.setDict(textDict);
        textReplacer.on_();
      }
      console.info(TAG + " 界面文字已启用: " + want.locale);
    } catch (e) {
      console.warn(TAG + " 文字模块加载失败（界面保持原样）:", e);
    } finally {
      textLoading = false;
    }
  }

  /* ------------------------------------------------------------ 配置 */

  function normalize(raw) {
    var v = (raw && raw.voice) || raw || {};
    var t = (raw && raw.text) || {};
    var locale = typeof v.locale === "string" && v.locale ? v.locale : "zh_CN";
    return {
      voice: {
        enabled: v.enabled === true,
        locale: locale,
        cdn_locale: typeof v.cdn_locale === "string" && v.cdn_locale ? v.cdn_locale : "zh_cn"
      },
      text: {
        enabled: t.enabled === true,
        locale: typeof t.locale === "string" && t.locale ? t.locale : "en_us"
      }
    };
  }

  var ready = false;

  function applyConfig(raw) {
    config = normalize(raw);
    void ensureText();
    report(true);
    if (!ready) {
      ready = true;
      console.log(TAG + " 已就绪 voice=" + (config.voice.enabled ? config.voice.locale : "off") + " text=" + (config.text.enabled ? config.text.locale : "off"));
    }
  }

  async function loadConfig() {
    try {
      var res = await fetch(BASE + "config.json", { cache: "no-store" });
      if (!res || !res.ok) return;
      applyConfig(await res.json());
    } catch (e) { /* 软件没写配置就保持全关 */ }
  }

  /* ------------------------------------------------------------ 运行痕迹 */

  var lastTrace = "";

  /** 计数器写进加载器的 DataStore(落盘)，软件读它就知道插件真的在客户端里干活。 */
  function report(force) {
    try {
      if (!window.DataStore || typeof window.DataStore.set !== "function") return;
      var stats = textReplacer && typeof textReplacer.stats === "function" ? textReplacer.stats() : { replaced: 0 };
      var payload = JSON.stringify({
        voiceHits: voiceStat.hits,
        textReplaced: stats.replaced || 0,
        at: Math.floor(Date.now() / 1000),
        voice: { enabled: config.voice.enabled, locale: config.voice.locale, kind: voiceStat.kind, id: voiceStat.id },
        text: { enabled: config.text.enabled, locale: config.text.locale }
      });
      if (!force && payload === lastTrace) return;
      lastTrace = payload;
      window.DataStore.set(SELF + ".trace", payload);
    } catch (e) { /* 没有加载器接口就算了 */ }
  }

  /* ------------------------------------------------------------ 隐藏加载器界面 */

  /**
   * 加载器会往 body 挂 <div id="pengu-root">（企鹅图标、欢迎窗、左下角那些），
   * 还改了客户端的启动加载画面。用户要的是"除了语言以外和原版客户端一样"，
   * 所以这里只加一层样式把它们藏掉 —— 不改任何文件。
   */
  function hideLoaderUi() {
    var STYLE_ID = "lol-voice-hide-loader-ui";
    if (document.getElementById(STYLE_ID)) return;
    if (document.getElementById("text-replacer-hide-loader-ui")) return;
    try {
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        "#pengu-root, pengu-root { display: none !important; visibility: hidden !important; }",
        "div[id^=index_loading_div] > img { display: block !important; }",
        "div[id^=index_loading_div]::before { content: none !important; background-image: none !important; width: 0 !important; height: 0 !important; border-radius: 0 !important; }",
        "div[id^=index_loading_div]::after { content: none !important; margin-top: 0 !important; }"
      ].join("\n");
      (document.head || document.documentElement).appendChild(style);
    } catch (e) { /* 加不上就算 */ }
  }

  hideLoaderUi();
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hideLoaderUi);
    var tries = 0;
    var timer = setInterval(function () {
      hideLoaderUi();
      tries += 1;
      if (tries > 20) clearInterval(timer);
    }, 500);
  }

  /* ------------------------------------------------------------ 启动 */

  hookAudioRequests();
  void loadConfig();
  // 软件里改开关/换语种后，几秒内跟上（不用重启客户端）
  setInterval(loadConfig, 3000);
  setInterval(report, 5000);
})();
