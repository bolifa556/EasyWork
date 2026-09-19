import assert from "node:assert/strict";
import test from "node:test";
import { imageUserContent, rejectsImageInput, withConversationImages } from "../gateway/core/web-agent/image-input.mjs";
import { OpenAIChatModel } from "../gateway/core/web-agent/openai-model.mjs";

const image = { resourceVersionId: "image_1", filename: "截图.png", dataUrl: "data:image/png;base64,AQID" };
const messages = [{ role: "user", content: imageUserContent("这里有什么？", [image]) }];

test("vision models receive the original image in the user question without OCR", async () => {
  const model = withConversationImages({ async complete(input) { assert.deepEqual(input.messages, messages); return { content: "图片回答" }; } }, {
    images: [image], resolveVision: async () => true, readText: () => { throw new Error("must not OCR"); },
  });
  assert.equal((await model.complete({ messages })).content, "图片回答");
});

test("text-only models receive cached OCR text and no image URL, even on later tool rounds", async () => {
  let ocr = 0;
  const model = withConversationImages({ async complete(input) {
    assert.equal(typeof input.messages[0].content, "string");
    assert.match(input.messages[0].content, /这里有什么.*设备编号 42/s);
    assert.doesNotMatch(JSON.stringify(input.messages), /image_url|data:image|base64/);
    return { content: "42" };
  } }, { images: [image], resolveVision: async () => false, readText: async () => { ocr++; return "设备编号 42"; } });
  await model.complete({ messages });
  await model.complete({ messages: [...messages, { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,from-library" } }] }] });
  assert.equal(ocr, 1);
  assert.equal(messages[0].content[2].type, "image_url", "fallback must not mutate the retained multimodal history");
});

test("unknown capabilities fall back once only after an explicit image rejection", async () => {
  let attempts = 0, ocr = 0;
  const model = withConversationImages({ async complete(input) {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("image inputs unsupported"), { code: "MODEL_IMAGE_UNSUPPORTED" });
    assert.doesNotMatch(JSON.stringify(input.messages), /image_url|data:image/);
    return { content: "文字回答" };
  } }, { images: [image], resolveVision: async () => null, readText: async () => { ocr++; return "文字"; } });
  await model.complete({ messages });
  await model.complete({ messages });
  assert.equal(attempts, 3);
  assert.equal(ocr, 1);
  const unavailable = withConversationImages({ complete: async () => { throw Object.assign(new Error("network"), { code: "MODEL_REQUEST_FAILED" }); } }, {
    images: [image], resolveVision: async () => null, readText: () => { throw new Error("must not OCR"); },
  });
  await assert.rejects(unavailable.complete({ messages }), /network/);
});

test("the HTTP adapter classifies modality rejection without treating malformed images or server failures as missing vision", async () => {
  assert.equal(rejectsImageInput(400, "Invalid content type. image_url is only supported by certain models."), true);
  assert.equal(rejectsImageInput(400, "This model does not support image inputs"), true);
  assert.equal(rejectsImageInput(400, "Invalid image data"), false);
  assert.equal(rejectsImageInput(500, "image input not supported"), false);
  assert.equal(rejectsImageInput(401, "image input not supported"), false);
  const model = new OpenAIChatModel({ baseUrl: "https://model.invalid", apiKey: "test", model: "text", systemMessageSeparator: "\n", fetchImpl: async () => Response.json({ error: { message: "This model does not support image inputs" } }, { status: 400 }) });
  await assert.rejects(model.complete({ messages }), (error) => error.code === "MODEL_IMAGE_UNSUPPORTED");
});
