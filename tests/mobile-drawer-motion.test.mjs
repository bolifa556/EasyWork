import assert from "node:assert/strict";
import test from "node:test";
import { drawerProgress, drawerShouldOpen } from "../app/easywork/shell/mobile-drawer-motion.ts";

test("左右侧栏都按手指位移逐像素拉出和拉入", () => {
  for (const width of [280, 320, 350]) {
    for (const [side, direction] of [["left", 1], ["right", -1]]) {
      assert.equal(drawerProgress(side, false, direction * 35, width) * width, 35);
      assert.ok(Math.abs((1 - drawerProgress(side, true, -direction * 35, width)) * width - 35) < 1e-10);
    }
  }
});

test("两边都短滑回弹、足量滑动后展开或关闭，连续反向拖动仍可回弹", () => {
  for (const width of [280, 320, 350]) {
    for (const [side, direction] of [["left", 1], ["right", -1]]) {
      for (const wasOpen of [false, true]) {
        const dx = direction * (wasOpen ? -1 : 1);
        assert.equal(drawerShouldOpen(drawerProgress(side, wasOpen, dx * 30, width)), wasOpen);
        assert.equal(drawerShouldOpen(drawerProgress(side, wasOpen, dx * 200, width)), !wasOpen);
        assert.equal(drawerShouldOpen(drawerProgress(side, wasOpen, dx * 10, width)), wasOpen);
      }
    }
  }
});

test("拖到边界后两侧都不会过冲，也不会向错误方向滑出", () => {
  for (const [side, direction] of [["left", 1], ["right", -1]]) {
    assert.equal(drawerProgress(side, false, direction * 1000, 320), 1);
    assert.equal(drawerProgress(side, false, -direction * 100, 320), 0);
    assert.equal(drawerProgress(side, true, -direction * 1000, 320), 0);
    assert.equal(drawerProgress(side, true, direction * 100, 320), 1);
  }
});


test("只有超过一半才展开，临界点和快速短滑均回收", () => {
  assert.equal(drawerShouldOpen(0.5), false);
  assert.equal(drawerShouldOpen(0.501), true);
  for (const progress of [0, 0.04, 0.2, 0.499]) assert.equal(drawerShouldOpen(progress), false);
});
