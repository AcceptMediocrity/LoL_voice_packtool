/**
 * 加载器(Pengu / Rose core.dll)的公共路径与 DataStore 读取。
 *
 * 单独一个模块是为了避免"部署模块 ↔ 插件模块"互相 import 形成环:
 *   部署(textpack/deploy.ts)  ->  loader 路径
 *   插件部署(packs/clientPlugin.ts) ->  loader 路径
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 加载器装到用户目录, 而不是软件目录 —— 软件可能装在只读位置。 */
export function loaderDir(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "LoL_Voice", "loader");
}

/** 软件包内的资源目录(core.dll 与插件都在这里)。 */
export function assetDir(): string {
  return path.join(import.meta.dirname, "..", "..", "assets");
}

/**
 * 加载器的 datastore 文件是**异或混淆**过的(源码 core/src/renderer/v8_datastore.cc 里
 * transform_data(): buffer[i] ^= key[i % len], key = "A5dgY6lz9fpG9kGNiH1mZ")。
 * 我们要读它, 就得照抄这个异或 —— 只读不写, 免得不小心抹掉别的插件的数据。
 */
const DATASTORE_KEY = "A5dgY6lz9fpG9kGNiH1mZ";

function transformData(buffer: Buffer): Buffer {
  const out = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) out[i] = buffer[i]! ^ DATASTORE_KEY.charCodeAt(i % DATASTORE_KEY.length);
  return out;
}

/** 把加载器的 datastore 整个读出来(异或解密后是 JSON 对象)。 */
export async function readDatastoreMap(): Promise<Record<string, string>> {
  const file = path.join(loaderDir(), "datastore");
  try {
    const raw = transformData(await fs.readFile(file)).toString("utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
