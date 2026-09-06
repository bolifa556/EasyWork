import assert from "node:assert/strict";
import test from "node:test";
import { codeWheelPosition } from "../app/easywork/features/conversation/code-scroll.ts";

test("正文及文件代码在左右尽头归还页面滚动", () => {
  const viewport = { scrollLeft: 0, clientWidth: 300, scrollWidth: 800 };
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: -30, deltaMode: 0 }), null);
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 30, deltaMode: 0 }), 30);
  viewport.scrollLeft = 500;
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 30, deltaMode: 0 }), null);
  assert.equal(codeWheelPosition(viewport, { deltaX: -30, deltaY: 0, deltaMode: 0 }), 470);
});
test("滚动单位兼容触控板、鼠标滚轮且保留缩放", () => {
  const viewport = { scrollLeft: 50, clientWidth: 300, scrollWidth: 800 };
  assert.equal(codeWheelPosition(viewport, { deltaX: 3, deltaY: 1, deltaMode: 1 }), 98);
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 1, deltaMode: 2 }), 350);
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 1, deltaMode: 0, ctrlKey: true }), null);
  assert.equal(codeWheelPosition({ ...viewport, scrollWidth: 300 }, { deltaX: 0, deltaY: 20, deltaMode: 0 }), null);
});
