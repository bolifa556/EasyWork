import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const asModule = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`;
const contractUrl = asModule(await readFile(new URL("../app/core/contracts/http.ts", import.meta.url), "utf8"));
const { GatewayError } = await import(contractUrl);
const source = await readFile(new URL("../app/core/gateway/resource-delete.ts", import.meta.url), "utf8");
const { deleteResourceBindings } = await import(asModule(source.replace('"../contracts"', JSON.stringify(contractUrl))));
const failure = (code) => new GatewayError(code === "RESOURCE_BINDING_NOT_FOUND" ? 404 : 409, { error: { code, message: code, retryable: false }, meta: { requestId: "delete-test" } });

test("删除按绑定区分同一文件的不同引用，并逐次推进版本", async () => {
  const removed = [];
  const calls = [];
  const api = {
    get: async (path) => { assert.equal(path, "/api/resources?ownerType=collection&ownerId=collection-1&limit=1"); return { data: { revision: 9 } }; },
    delete: async (path, options) => { calls.push([path, options.expectedRevision]); return { data: { revision: options.expectedRevision + 1 } }; },
  };
  await deleteResourceBindings(api, { type: "collection", id: "collection-1" }, ["binding-a", "binding-b", "binding-a"], (...args) => removed.push(args));
  assert.deepEqual(calls, [["/api/resource-bindings/binding-a", 9], ["/api/resource-bindings/binding-b", 10]]);
  assert.deepEqual(removed, [["binding-a", 10], ["binding-b", 11]]);
});

test("索引更新导致版本冲突时重新读取版本后重试同一绑定", async () => {
  let reads = 0;
  const calls = [];
  const removed = [];
  const api = {
    get: async () => ({ data: { revision: ++reads * 10 } }),
    delete: async (path, options) => {
      calls.push([path, options.expectedRevision]);
      if (calls.length === 1) throw failure("REVISION_CONFLICT");
      return { data: { revision: 21 } };
    },
  };
  await deleteResourceBindings(api, { type: "project", id: "project-1" }, ["binding-a"], (...args) => removed.push(args));
  assert.deepEqual(calls, [["/api/resource-bindings/binding-a", 10], ["/api/resource-bindings/binding-a", 20]]);
  assert.deepEqual(removed, [["binding-a", 21]]);
});

test("其他页面已删除的绑定会从列表移除，后续绑定继续删除", async () => {
  const removed = [];
  const api = {
    get: async () => ({ data: { revision: 5 } }),
    delete: async (path) => {
      if (path.endsWith("binding-gone")) throw failure("RESOURCE_BINDING_NOT_FOUND");
      return { data: { revision: 6 } };
    },
  };
  await deleteResourceBindings(api, { type: "collection", id: "collection-1" }, ["binding-gone", "binding-b"], (...args) => removed.push(args));
  assert.deepEqual(removed, [["binding-gone", 5], ["binding-b", 6]]);
});

test("删除失败保留尚未删除的文件，版本冲突重试有上限", async () => {
  const removed = [];
  let calls = 0;
  const api = {
    get: async () => ({ data: { revision: 7 } }),
    delete: async (path) => {
      calls += 1;
      if (path.endsWith("binding-a")) return { data: { revision: 8 } };
      throw failure("REVISION_CONFLICT");
    },
  };
  await assert.rejects(() => deleteResourceBindings(api, { type: "collection", id: "collection-1" }, ["binding-a", "binding-b", "binding-c"], (...args) => removed.push(args)), { code: "REVISION_CONFLICT" });
  assert.equal(calls, 4);
  assert.deepEqual(removed, [["binding-a", 8]]);
});
