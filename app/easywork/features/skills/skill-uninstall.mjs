/** @typedef {{ id: string, skillId: string, revision?: number }} InstalledSkill */
/** @typedef {{ skillId: string, revision: number }} UninstallResult */

/**
 * Installed rows share the actor's skill-store revision, not a per-skill revision.
 * @template {InstalledSkill} T
 * @param {T[]} items
 * @param {UninstallResult} result
 * @returns {T[]}
 */
export function installedSkillsAfterUninstall(items, result) {
  return items
    .filter((item) => item.skillId !== result.skillId)
    .map((item) => ({ ...item, revision: result.revision }));
}

/**
 * Refresh a stale catalog once, retaining the installation identity the user
 * confirmed. An uninstall/reinstall in another tab requires fresh confirmation.
 * @template {InstalledSkill} T
 * @param {{
 *   get: (path: string) => Promise<{ data: { revision: number, items: T[] } }>,
 *   delete: (path: string, options: { expectedRevision: number }) => Promise<{ data: UninstallResult }>
 * }} api
 * @param {T} item
 * @param {(items: T[]) => void} onRefresh
 * @returns {Promise<UninstallResult>}
 */
export async function uninstallInstalledSkill(api, item, onRefresh) {
  const endpoint = `/api/skill-center/installed/${encodeURIComponent(item.skillId)}`;
  try {
    return (await api.delete(endpoint, { expectedRevision: item.revision ?? 0 })).data;
  } catch (error) {
    if (error?.code !== "REVISION_CONFLICT" && error?.code !== "SKILL_REGISTRY_NOT_FOUND") throw error;
  }

  const { data: latest } = await api.get("/api/skill-center/installed");
  onRefresh(latest.items);
  const current = latest.items.find((entry) => entry.skillId === item.skillId);
  if (!current) return { skillId: item.skillId, revision: latest.revision };
  if (current.id !== item.id) {
    throw Object.assign(new Error("该技能已重新安装，请确认后再卸载"), { code: "SKILL_INSTALLATION_CHANGED" });
  }
  return (await api.delete(endpoint, { expectedRevision: latest.revision })).data;
}
