// Old saved requests may still contain a release label. Only the user's skill
// choice survives; content is always resolved from their installed catalog.
export function selectedSkillIds(scope = {}) {
  const values = scope.selectedSkillIds ?? scope.selectedSkillVersions?.map((entry) => entry.skillId) ?? [];
  return [...new Set(values.map(String))];
}
