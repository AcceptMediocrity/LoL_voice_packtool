/**
 * 已废弃: 旧版构建脚本会为每个语种生成一个独立插件(assets/textpack/<语种>/plugin/index.js)。
 *
 * 现在只有一个插件(assets/client-plugin/index.js), 字典在部署时按需写成
 * plugins/chosen-voice/lang/<语种>.js(见 packs/clientPlugin.ts 的 writeLangDict)。
 */
console.log("build-text-plugin.ts 已废弃: 插件已合并为 assets/client-plugin/index.js");
