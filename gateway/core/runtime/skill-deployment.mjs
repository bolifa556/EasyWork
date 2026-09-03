import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { invariant } from "../errors.mjs";
import { resolveActorPath } from "../paths.mjs";

const MAX_SKILL_FILE_BYTES = 64 * 1024 * 1024;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function segment(value, field) {
  const result = String(value || "");
  invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result), "REMOTE_SKILL_IDENTIFIER_INVALID", `${field} 无效`, { status: 400 });
  return result;
}

function exactObject(value, keys, field) {
  invariant(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key)), "REMOTE_SKILL_PLAN_INVALID", `${field} 无效`, { status: 400 });
  return value;
}

export class SshSkillDeployment {
  constructor({ executor, actor, dataRoot, serverId, serverIdentity, clock = () => new Date() }) {
    invariant(executor?.home && executor?.upload && executor?.readFile && actor?.actorId && path.isAbsolute(dataRoot), "REMOTE_SKILL_DEPENDENCY_INVALID", "Skill 部署依赖无效", { status: 500, expose: false });
    this.executor = executor;
    this.actor = actor;
    this.dataRoot = dataRoot;
    this.serverId = String(serverId);
    this.serverIdentity = String(serverIdentity);
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(this.serverId) && /^ssh_[A-Za-z0-9_-]{43}$/.test(this.serverIdentity), "REMOTE_SKILL_SCOPE_INVALID", "Skill 部署服务器身份无效", { status: 500, expose: false });
    this.clock = clock;
    this.homePath = null;
    this.root = null;
    this.indexPath = null;
    this.initialization = null;
  }

  async initialize() {
    if (this.root) return this;
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      this.homePath = path.posix.normalize(await this.executor.home()).replace(/\/$/, "");
      invariant(path.posix.isAbsolute(this.homePath) && this.homePath !== "/", "REMOTE_SKILL_HOME_INVALID", "远端 HOME 无效", { status: 502 });
      this.root = `${this.homePath}/.easywork/skills`;
      this.indexPath = `${this.root}/deployments.json`;
      const result = await this.executor.exec(`mkdir -p -- '${this.root.replace(/'/g, `'"'"'`)}' && chmod 0700 -- '${this.root.replace(/'/g, `'"'"'`)}'`, { maxOutputBytes: 16 * 1024 });
      invariant(result.code === 0, "REMOTE_SKILL_ROOT_FAILED", "无法创建远端 Skill 目录", { status: 502 });
      return this;
    })();
    try { return await this.initialization; }
    catch (error) {
      this.homePath = null;
      this.root = null;
      this.indexPath = null;
      throw error;
    } finally {
      this.initialization = null;
    }
  }

  async ensure(plan) {
    if (plan === null || plan === undefined) return [];
    if (Array.isArray(plan)) {
      if (plan.length === 0) return [];
      await this.initialize();
      return this.#validateRefs(plan);
    }
    const value = exactObject(plan, ["schemaVersion", "taskId", "actorId", "remoteBase", "skills", "agentSkillRefs"], "Skill deployment plan");
    invariant(value.schemaVersion === 1 && value.actorId === this.actor.actorId && value.remoteBase === "~/.easywork/skills" && Array.isArray(value.skills), "REMOTE_SKILL_PLAN_SCOPE_MISMATCH", "Skill deployment plan 不属于当前 Actor 或远端目录", { status: 403 });
    if (value.skills.length === 0) return [];
    await this.initialize();
    const index = await this.#readIndex();
    const results = [];
    for (const skill of value.skills) {
      const skillId = segment(skill?.skillId, "skillId");
      const version = segment(skill?.version, "version");
      const expectedPackageHash = String(skill?.sha256 || "");
      invariant(/^[a-f0-9]{64}$/.test(expectedPackageHash) && Array.isArray(skill.files) && Array.isArray(skill.operations), "REMOTE_SKILL_PLAN_INVALID", "Skill deployment plan 内容无效", { status: 400 });
      const targetRoot = `${this.root}/${skillId}/${version}`;
      const expectedTildeRoot = `~/.easywork/skills/${skillId}/${version}`;
      invariant(skill.targetRoot === expectedTildeRoot && skill.entrypoint?.startsWith(`${expectedTildeRoot}/`), "REMOTE_SKILL_TARGET_ESCAPE", "Skill 目标路径越界", { status: 403 });
      const files = [];
      for (const file of skill.files) {
        const relativePath = this.#relative(file?.relativePath);
        const source = exactObject(file?.source, ["actorRelativePath", "sha256", "size"], "Skill source");
        const target = exactObject(file?.target, ["path", "expectedSha256"], "Skill target");
        const expectedTarget = `~/.easywork/skills/${skillId}/${version}/${relativePath}`;
        invariant(target.path === expectedTarget && target.expectedSha256 === source.sha256 && /^[a-f0-9]{64}$/.test(source.sha256), "REMOTE_SKILL_TARGET_ESCAPE", "Skill 文件目标或摘要无效", { status: 403 });
        const localPath = resolveActorPath(this.dataRoot, this.actor, source.actorRelativePath);
        const localBytes = await fs.readFile(localPath);
        invariant(localBytes.length <= MAX_SKILL_FILE_BYTES && localBytes.length === source.size && sha256(localBytes) === source.sha256, "REMOTE_SKILL_SOURCE_CHANGED", "Skill 源文件与固定版本不一致", { status: 409, details: { skillId, version, path: relativePath } });
        const remotePath = `${targetRoot}/${relativePath}`;
        let currentHash = null;
        try { currentHash = sha256(await this.executor.readFile(remotePath)); } catch (error) { if (!["ENOENT", "NO_SUCH_FILE", 2].includes(error?.code)) throw error; }
        let status = "up-to-date";
        if (currentHash !== source.sha256) {
          await this.executor.upload(localPath, remotePath);
          const verified = await this.executor.readFile(remotePath);
          invariant(verified.length <= MAX_SKILL_FILE_BYTES && sha256(verified) === source.sha256, "REMOTE_SKILL_VERIFY_FAILED", "远端 Skill 文件校验失败", { status: 502, details: { skillId, version, path: relativePath } });
          status = "deployed";
        }
        files.push({ path: relativePath, sha256: source.sha256, size: source.size, status });
      }
      const entrypoint = `${targetRoot}/${this.#relative(path.posix.relative(expectedTildeRoot, skill.entrypoint))}`;
      const chmod = await this.executor.exec(`chmod 0700 -- '${entrypoint.replace(/'/g, `'"'"'`)}'`, { maxOutputBytes: 16 * 1024 });
      invariant(chmod.code === 0, "REMOTE_SKILL_ENTRYPOINT_INVALID", "远端 Skill 入口不可执行", { status: 502, details: { skillId, version } });
      const record = {
        actorId: this.actor.actorId,
        serverId: this.serverId,
        serverIdentity: this.serverIdentity,
        skillId,
        version,
        sha256: expectedPackageHash,
        remotePath: targetRoot,
        entrypoint,
        files,
        status: files.some((file) => file.status === "deployed") ? "deployed" : "up-to-date",
        updatedAt: new Date(this.clock()).toISOString(),
      };
      const prior = index.items.findIndex((entry) => entry.actorId === record.actorId && entry.skillId === skillId && entry.version === version);
      if (prior >= 0) index.items[prior] = record;
      else index.items.push(record);
      results.push(record);
    }
    await this.executor.writeAtomic(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    return results.map(({ skillId, version, sha256: hash, remotePath }) => ({ skillId, version, sha256: hash, remotePath }));
  }

  async inspect() {
    await this.initialize();
    const index = await this.#readIndex();
    return {
      serverId: this.serverId,
      serverIdentity: this.serverIdentity,
      items: index.items.filter((entry) => entry.actorId === this.actor.actorId).map((entry) => structuredClone(entry)),
    };
  }

  async #readIndex() {
    let value;
    try {
      const bytes = await this.executor.readFile(this.indexPath);
      invariant(bytes.length <= 4 * 1024 * 1024, "REMOTE_SKILL_INDEX_TOO_LARGE", "远端 Skill 部署索引过大", { status: 413 });
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (["ENOENT", "NO_SUCH_FILE", 2].includes(error?.code)) return { schemaVersion: 1, items: [] };
      if (error instanceof SyntaxError) invariant(false, "REMOTE_SKILL_INDEX_INVALID", "远端 Skill 部署索引损坏", { status: 500, expose: false });
      throw error;
    }
    invariant(value?.schemaVersion === 1 && Array.isArray(value.items), "REMOTE_SKILL_INDEX_INVALID", "远端 Skill 部署索引损坏", { status: 500, expose: false });
    return value;
  }

  #relative(value) {
    const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/"));
    invariant(normalized && normalized !== "." && !normalized.startsWith("../") && !path.posix.isAbsolute(normalized) && !normalized.includes("\0") && !normalized.split("/").some((entry) => [".git", ".easywork"].includes(entry)), "REMOTE_SKILL_PATH_INVALID", "Skill 文件路径无效", { status: 400 });
    return normalized;
  }

  #validateRefs(refs) {
    return refs.map((entry) => {
      const skillId = segment(entry?.skillId, "skillId");
      const version = segment(entry?.version, "version");
      const remotePath = path.posix.normalize(String(entry?.remotePath || ""));
      invariant(remotePath === `${this.root}/${skillId}/${version}`, "REMOTE_SKILL_TARGET_ESCAPE", "Skill 引用越界", { status: 403 });
      return { skillId, version, sha256: String(entry.sha256 || ""), remotePath };
    });
  }
}

export const skillDeploymentLimits = Object.freeze({ maxFileBytes: MAX_SKILL_FILE_BYTES });
