import assert from "node:assert/strict";
import test from "node:test";
import { mobileMenuPosition } from "../app/easywork/ui/menu-position.ts";
const viewport = { width: 390, height: 844, top: 0, left: 0 };
test("省略号菜单右边缘对齐触发器，默认向下展开", () => {
  const result = mobileMenuPosition({ left: 267, right: 307, top: 496, bottom: 536 }, { width: 198, height: 194 }, viewport);
  assert.equal(result.left + 198, 307);
  assert.equal(result.top, 540);
});
test("靠近屏幕底部时，菜单紧贴省略号向上展开", () => {
  const result = mobileMenuPosition({ left: 267, right: 307, top: 780, bottom: 820 }, { width: 214, height: 330 }, viewport);
  assert.equal(result.top + 330, 776);
  assert.equal(result.left, 93);
});
test("键盘遮挡时，长文件菜单缩小并在可视范围内滚动", () => {
  const result = mobileMenuPosition({ left: 267, right: 307, top: 120, bottom: 160 }, { width: 214, height: 420 }, { ...viewport, height: 380, top: 20 });
  assert.equal(result.top, 164);
  assert.equal(result.maxHeight, 228);
  assert.ok(result.top + result.maxHeight <= 392);
});
