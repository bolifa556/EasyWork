import { GatewayError } from "../contracts";
import type { GatewayClient } from "./client";

export async function deleteResourceBindings(
  api: GatewayClient,
  owner: { type: "collection" | "project"; id: string },
  bindingIds: string[],
  onRemoved: (bindingId: string, revision: number) => void,
) {
  const query = new URLSearchParams({ ownerType: owner.type, ownerId: owner.id, limit: "1" });
  const currentRevision = async () => (await api.get<{ revision: number }>(`/api/resources?${query}`)).data.revision;
  let revision = await currentRevision();

  for (const bindingId of new Set(bindingIds)) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await api.delete<{ revision: number }>(`/api/resource-bindings/${encodeURIComponent(bindingId)}`, { expectedRevision: revision });
        revision = result.data.revision;
      } catch (reason) {
        if (reason instanceof GatewayError && reason.code === "REVISION_CONFLICT" && attempt < 2) {
          // Indexing can advance the resource revision while the dialog is open.
          revision = await currentRevision();
          continue;
        }
        if (!(reason instanceof GatewayError && reason.code === "RESOURCE_BINDING_NOT_FOUND")) throw reason;
        revision = await currentRevision();
      }
      onRemoved(bindingId, revision);
      break;
    }
  }
}
