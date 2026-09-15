import assert from "node:assert/strict";
import test from "node:test";
import { codeScrollThumbWidth, codeWheelPosition } from "../app/easywork/features/conversation/code-scroll.ts";

test("横向滑块随可见内容比例变化，轻微溢出不会需要拖动很远", () => {
  const track = 1000;
  for (const contentWidth of [1010, 1100, 2000, 8000]) {
    const thumb = codeScrollThumbWidth(1000, contentWidth, track);
    assert.ok(Math.abs(thumb / track - 1000 / contentWidth) < 1e-8);
    const pixelsScrolledPerDragPixel = (contentWidth - 1000) / (track - thumb);
    assert.ok(Math.abs(pixelsScrolledPerDragPixel - contentWidth / 1000) < 1e-8);
  }
  assert.equal(codeScrollThumbWidth(1000, 1000, track), track);
  assert.equal(codeScrollThumbWidth(1000, 100000, track), 32);
  assert.equal(codeScrollThumbWidth(10, 1000, 10), 10);
});

test("鼠标在滚动条所在行时普通滚轮横移，在边界也不串到页面竖向滚动", () => {
  const viewport = { scrollLeft: 20, clientWidth: 300, scrollWidth: 800 };
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 80, deltaMode: 0 }, true), 100);
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: -80, deltaMode: 0 }, true), 0);
  viewport.scrollLeft = 500;
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 80, deltaMode: 0 }, true), 500);
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 80, deltaMode: 0, ctrlKey: true }, true), null);
  assert.equal(codeWheelPosition({ ...viewport, scrollWidth: 300 }, { deltaX: 0, deltaY: 80, deltaMode: 0 }, true), null);
});

test("正文及文件代码不会把普通竖向滚轮转换成横移", () => {
  for (const scrollLeft of [0, 100, 500]) {
    const viewport = { scrollLeft, clientWidth: 300, scrollWidth: 800 };
    for (const deltaY of [-30, 30]) {
      assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY, deltaMode: 0 }), null);
    }
  }
});
test("横向手势及 Shift 滚轮可以查看长行，到边界后不拦截事件", () => {
  const viewport = { scrollLeft: 0, clientWidth: 300, scrollWidth: 800 };
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: -30, deltaMode: 0, shiftKey: true }), null);
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true }), 30);
  assert.equal(codeWheelPosition(viewport, { deltaX: 30, deltaY: 0, deltaMode: 0, shiftKey: true }), 30);
  viewport.scrollLeft = 500;
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true }), null);
  assert.equal(codeWheelPosition(viewport, { deltaX: -30, deltaY: 0, deltaMode: 0 }), 470);
});
test("滚动单位兼容触控板、鼠标滚轮且保留缩放", () => {
  const viewport = { scrollLeft: 50, clientWidth: 300, scrollWidth: 800 };
  assert.equal(codeWheelPosition(viewport, { deltaX: 3, deltaY: 1, deltaMode: 1 }), 98);
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: true }), 350);
  assert.equal(codeWheelPosition(viewport, { deltaX: 0, deltaY: 1, deltaMode: 0, ctrlKey: true }), null);
  assert.equal(codeWheelPosition({ ...viewport, scrollWidth: 300 }, { deltaX: 0, deltaY: 20, deltaMode: 0 }), null);
});
