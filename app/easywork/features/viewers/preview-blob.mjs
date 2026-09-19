export async function readPreviewBlob(api, previewId, descriptor, signal) {
  if (descriptor.size > 16 * 1024 * 1024) throw new Error("此文件需要分段渲染，当前查看器暂不支持");
  const endpoint = `/api/previews/${encodeURIComponent(previewId)}/content`;
  if (descriptor.size > (descriptor.maxPreviewBytes || Number.POSITIVE_INFINITY)) {
    if (!descriptor.acceptsRange || !descriptor.maxPreviewBytes) throw new Error("此文件来源不支持安全的分段预览");
    const chunks = [];
    for (let start = 0; start < descriptor.size; start += descriptor.maxPreviewBytes) {
      const endExclusive = Math.min(descriptor.size, start + descriptor.maxPreviewBytes);
      const response = await api.raw(endpoint, { method: "GET", signal, headers: { range: `bytes=${start}-${endExclusive - 1}` } });
      if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${endExclusive - 1}/${descriptor.size}`) throw new Error("预览来源没有返回预期的分段内容");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== endExclusive - start) throw new Error("预览分段长度不一致");
      chunks.push(bytes);
    }
    return new Blob(chunks, { type: descriptor.mime || "application/octet-stream" });
  }
  return (await api.raw(endpoint, { method: "GET", signal })).blob();
}
