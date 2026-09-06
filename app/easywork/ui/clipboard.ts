export async function copyText(content: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(content); return; } catch { /* Older/insecure mobile pages use native copy below. */ }
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = document.createElement("textarea");
  input.value = content;
  input.readOnly = true;
  input.tabIndex = -1;
  input.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(input);
  input.select();
  try { if (!document.execCommand("copy")) throw new Error("复制失败，请长按文字复制"); }
  finally { input.remove(); focused?.focus({ preventScroll: true }); }
}

export async function copyTextWhenReady(content: Promise<string>) {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      // Start during the click gesture, while large histories are still loading.
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": content.then((text) => new Blob([text], { type: "text/plain" })) })]);
      return;
    } catch { /* Fall back for browsers without promise-backed clipboard items. */ }
  }
  await copyText(await content);
}

export async function copyLink(content: { text: string; html: string }) {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([content.text], { type: "text/plain" }),
        "text/html": new Blob([content.html], { type: "text/html" }),
      })]);
      return;
    } catch { /* Plain URLs still paste as structured references in EasyWork. */ }
  }
  await copyText(content.text);
}
