export function resolveWebModelSelection(providers, selection, readStoredModel = () => "") {
  const available = Array.isArray(providers) ? providers : [];
  const requestedProviderId = String(selection?.providerId || "");
  const selectedProvider = available.find((provider) => provider?.id === requestedProviderId) ?? available[0] ?? null;
  const providerChanged = (requestedProviderId || null) !== (selectedProvider?.id || null);
  const activeModelId = providerChanged
    ? selectedProvider ? String(readStoredModel(selectedProvider.id) || "") : ""
    : String(selection?.modelId || "");
  return { selectedProvider, activeModelId };
}
