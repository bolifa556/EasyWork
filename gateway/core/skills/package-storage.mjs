import fs from "node:fs/promises";
import path from "node:path";
import { invariant } from "../errors.mjs";
import { atomicWriteJson } from "../repository.mjs";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function skillStoragePath(root, relativePath) {
  root = path.resolve(root);
  const target = path.resolve(root, relativePath);
  invariant(inside(root, target), "SKILL_STORAGE_PATH_ESCAPE", "技能存储路径越界", { status: 500 });
  for (let current = target; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    invariant(!stat?.isSymbolicLink(), "SKILL_STORAGE_LINK_UNSAFE", "技能存储路径不能包含符号链接", { status: 500 });
    if (current === root) break;
  }
  return target;
}

export async function removeSkillDirectory(root, relativePath) {
  const target = await skillStoragePath(root, relativePath);
  await fs.rm(target, { recursive: true, force: true });
}

async function descriptorAt(root) {
  return fs.readFile(path.join(root, "package.json"), "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

// This directory is an in-flight transaction, removed after commit or recovery.
// It is never retained as an editable skill version or a backup.
const TRANSACTION = ".pending-package-edit";

async function renameDirectory(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (attempt >= 7 || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      // Windows indexers can briefly hold a directory just after its files close.
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

export async function recoverSkillPackageEdit(root, readExpectedHash) {
  const transaction = await skillStoragePath(root, TRANSACTION);
  let intent;
  try { intent = JSON.parse(await fs.readFile(path.join(transaction, "intent.json"), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await removeSkillDirectory(root, TRANSACTION);
    return;
  }
  invariant(typeof intent.relativeRoot === "string" && intent.relativeRoot.startsWith("packages/")
    && /^[a-f0-9]{64}$/.test(intent.previousHash) && /^[a-f0-9]{64}$/.test(intent.nextHash),
  "SKILL_PACKAGE_TRANSACTION_INVALID", "技能更新事务无效", { status: 500 });
  const target = await skillStoragePath(root, intent.relativeRoot);
  const previous = await skillStoragePath(root, `${TRANSACTION}/previous`);
  const expected = await readExpectedHash(intent.relativeRoot);
  if (expected === intent.previousHash) {
    if (await descriptorAt(previous)) {
      await removeSkillDirectory(root, intent.relativeRoot);
      await renameDirectory(previous, target);
    }
  } else if (expected !== intent.nextHash) {
    invariant(expected === null, "SKILL_PACKAGE_TRANSACTION_CONFLICT", "技能更新事务与索引不一致", { status: 500 });
    await removeSkillDirectory(root, intent.relativeRoot);
  }
  if (expected !== null) invariant((await descriptorAt(target))?.sha256 === expected,
    "SKILL_PACKAGE_TRANSACTION_CORRUPT", "技能更新恢复失败", { status: 500 });
  await removeSkillDirectory(root, TRANSACTION);
}

export async function replaceSkillPackage({ root, relativeRoot, descriptor, files, readExpectedHash, commit }) {
  await recoverSkillPackageEdit(root, readExpectedHash);
  const target = await skillStoragePath(root, relativeRoot);
  const prior = await descriptorAt(target);
  invariant(prior, "SKILL_PACKAGE_NOT_FOUND", "待更新的技能包不存在", { status: 404 });
  const transaction = await skillStoragePath(root, TRANSACTION);
  const staged = await skillStoragePath(root, `${TRANSACTION}/next`);
  const previous = await skillStoragePath(root, `${TRANSACTION}/previous`);
  try {
    await fs.mkdir(path.join(staged, "files"), { recursive: true });
    for (const file of files) {
      const destination = await skillStoragePath(path.join(staged, "files"), file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, { mode: 0o600 });
    }
    await atomicWriteJson(path.join(staged, "package.json"), descriptor);
    await atomicWriteJson(path.join(transaction, "intent.json"), {
      relativeRoot, previousHash: prior.sha256, nextHash: descriptor.sha256,
    });
    await renameDirectory(target, previous);
    await renameDirectory(staged, target);
    const result = await commit();
    await recoverSkillPackageEdit(root, readExpectedHash);
    return result;
  } catch (error) {
    await recoverSkillPackageEdit(root, readExpectedHash);
    throw error;
  }
}
