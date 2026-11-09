import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { cleanupSuite, makeTempDir, useSuite, writeFile } from "./helpers.ts";
import { assertNoForeignLoader, detectForeignLoader } from "../src/packs/loaderConflict.ts";

useSuite("loader-conflict");

after(async () => {
  await cleanupSuite();
});

async function makeSizedFile(file: string, size: number): Promise<void> {
  await writeFile(file, "x");
  await fs.truncate(file, size);
}

test("冲突检测: 客户端目录里有加载器代理 DLL(体积和 core.dll 一样)要拦住", async () => {
  const root = await makeTempDir("proxy");
  const clientDir = path.join(root, "LeagueClient");
  await makeSizedFile(path.join(clientDir, "winhttp.dll"), 505464); // 另一套加载器 core 的体积

  const info = await detectForeignLoader(clientDir);
  assert.equal(info.foreign, true, info.details.join(" | "));
  assert.match(info.details.join(" | "), /winhttp\.dll/);

  const guard = await assertNoForeignLoader(clientDir);
  assert.equal(guard.ok, false);
  assert.match(guard.message, /另一个加载器/);
  assert.match(guard.message, /0xc0000005/, "要说明为什么不能同时开");
});

test("冲突检测: 体积正常的系统 DLL 不误报", async () => {
  const root = await makeTempDir("normal-dll");
  const clientDir = path.join(root, "LeagueClient");
  await makeSizedFile(path.join(clientDir, "version.dll"), 30000); // 系统 version.dll 的量级

  const info = await detectForeignLoader(clientDir);
  assert.equal(info.foreign, false, info.details.join(" | "));
  assert.equal((await assertNoForeignLoader(clientDir)).ok, true);
});

test("冲突检测: 客户端目录不存在/没有代理 DLL 时放行", async () => {
  const root = await makeTempDir("clean");
  const dir = path.join(root, "LeagueClient");
  await writeFile(path.join(dir, "LeagueClient.exe"), "x");
  const info = await detectForeignLoader(dir);
  assert.equal(info.foreign, false, info.details.join(" | "));
});
