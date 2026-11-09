import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { APP_VERSION } from "../src/version.ts";

// 版本号只有一个来源(src/version.ts): 界面、CLI、日志都读它。
// 以前它停在 1.0.0, 而 package.json / 发布包是 1.22 —— 用户看到的就是 "v1.0.0"。
test("APP_VERSION 与 package.json 保持一致", async () => {
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  assert.equal(APP_VERSION, pkg.version);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});
