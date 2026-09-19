/** Only an explicit modality rejection warrants retrying a model request. */
export function rejectsImageInput(status, message) {
  if (![400, 415, 422].includes(status)) return false;
  const text = String(message || "");
  return /(?:image(?:_url| input| content|s)?|vision|multimodal|多模态|图片|图像)/i.test(text)
    && /(?:not support|unsupported|doesn't support|only support(?:s|ed)? (?:text|by)|not (?:a )?(?:vision|multimodal)|not allowed|不支持|仅支持文本)/i.test(text);
}

export function imageUserContent(text, images = []) {
  if (!images.length) return String(text || "");
  return [
    { type: "text", text: String(text || "请查看附图。") },
    ...images.flatMap((image) => [
      { type: "text", text: `用户附图：${image.filename}` },
      { type: "image_url", image_url: { url: image.dataUrl, detail: "high" } },
    ]),
  ];
}

export function withConversationImages(model, { images, resolveVision, readText, onUnsupported = () => {} }) {
  const byUrl = new Map(images.map((image) => [image.dataUrl, image]));
  const recognized = new Map();
  let vision;
  const textMessages = async (messages, signal) => Promise.all(messages.map(async (message) => {
    if (!Array.isArray(message.content)) return message;
    const parts = await Promise.all(message.content.map(async (part) => {
      if (part.type !== "image_url") return part;
      const image = byUrl.get(part.image_url?.url);
      // resource_read already supplies OCR text in its tool result. A text-only
      // model must never receive the supplemental image URL either.
      if (!image) return null;
      if (!recognized.has(image.resourceVersionId)) recognized.set(image.resourceVersionId, readText(image, signal));
      const text = await recognized.get(image.resourceVersionId);
      return { type: "text", text: `图片“${image.filename}”中的文字（OCR）：\n${text || "未识别到可见文字。"}` };
    }));
    return { ...message, content: parts.filter(Boolean).map((part) => part.text || "").filter(Boolean).join("\n\n") };
  }));
  return {
    async complete(input) {
      if (vision === undefined) vision = await resolveVision(input.signal);
      if (vision === false) return model.complete({ ...input, messages: await textMessages(input.messages, input.signal) });
      try {
        return await model.complete(input);
      } catch (error) {
        if (error?.code !== "MODEL_IMAGE_UNSUPPORTED") throw error;
        vision = false;
        onUnsupported();
        return model.complete({ ...input, messages: await textMessages(input.messages, input.signal) });
      }
    },
  };
}
