import assert from "node:assert/strict";
import test from "node:test";
import { bindMobileTouchSwipe } from "../app/easywork/features/conversation/mobile-touch-swipe.ts";

function fixture(t, { width = 390, accept = true, claimEdge = true, blockVertical = false } = {}) {
  const surface = new EventTarget();
  surface.ownerDocument = { defaultView: { innerWidth: width } };
  const calls = [];
  const cleanup = bindMobileTouchSwipe(surface, {
    start: (point) => { calls.push({ phase: "start", x: point.clientX }); return accept; },
    claimEdge: () => claimEdge,
    blockVertical: () => blockVertical,
    move: (point) => { calls.push({ phase: "move", x: point.clientX }); },
    end: (point, cancelled) => { calls.push({ phase: "end", x: point.clientX, cancelled }); },
  });
  t.after(cleanup);
  const touch = (x, y = 200, identifier = 1) => ({ clientX: x, clientY: y, identifier });
  const emit = (type, touches, { changedTouches = touches, cancelable = true } = {}) => {
    const event = new Event(type, { cancelable });
    Object.assign(event, { touches, changedTouches });
    surface.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { surface, calls, cleanup, touch, emit };
}

test("左右横滑在小幅移动时即拦截默认导航，短滑后仍能连续拖动", (t) => {
  const { calls, emit, touch } = fixture(t);
  for (const endX of [145, 110, 195, 295]) {
    assert.equal(emit("touchstart", [touch(150)]), false);
    assert.equal(emit("touchmove", [touch(endX)]), true);
    assert.equal(emit("touchend", [], { changedTouches: [touch(endX)] }), true);
    assert.deepEqual(calls.at(-1), { phase: "end", x: endX, cancelled: false });
  }
  assert.equal(calls.filter((call) => call.phase === "end").length, 4);
});

test("两侧边缘的应用手势在 touchstart 阶段保留给页面", (t) => {
  const { emit, touch } = fixture(t);
  for (const x of [1, 24, 366, 389]) {
    assert.equal(emit("touchstart", [touch(x)]), true);
    emit("touchcancel", [], { changedTouches: [touch(x)] });
  }
});

test("菜单按钮的边缘轻点保留默认点击，开始横滑后仍可收起菜单", (t) => {
  const { emit, touch } = fixture(t, { claimEdge: false });
  assert.equal(emit("touchstart", [touch(12)]), false);
  assert.equal(emit("touchend", [], { changedTouches: [touch(12)] }), false);
  emit("touchstart", [touch(12)]);
  assert.equal(emit("touchmove", [touch(2)]), true);
  assert.equal(emit("touchend", [], { changedTouches: [touch(2)] }), true);
});

test("纵向滚动一旦识别就退出手势，不因后续斜滑触发横向操作", (t) => {
  const { calls, emit, touch } = fixture(t);
  emit("touchstart", [touch(150)]);
  assert.equal(emit("touchmove", [touch(151, 206)]), false);
  assert.deepEqual(calls.at(-1), { phase: "end", x: 151, cancelled: true });
  assert.equal(emit("touchmove", [touch(280, 240)]), false);
  assert.equal(emit("touchend", [], { changedTouches: [touch(280, 240)] }), false);
  assert.equal(calls.length, 2);
});

test("双指触摸取消单指拖动并允许浏览器缩放", (t) => {
  const { calls, emit, touch } = fixture(t);
  emit("touchstart", [touch(150)]);
  assert.equal(emit("touchstart", [touch(150), touch(240, 200, 2)]), false);
  assert.deepEqual(calls.at(-1), { phase: "end", x: 150, cancelled: true });
  assert.equal(emit("touchmove", [touch(120), touch(270, 200, 2)]), false);
  assert.equal(emit("touchend", [], { changedTouches: [touch(120)] }), false);
});

test("输入框、按钮和代码块等未接受的触摸不被拦截", (t) => {
  const { calls, emit, touch } = fixture(t, { accept: false });
  assert.equal(emit("touchstart", [touch(5)]), false);
  assert.equal(emit("touchmove", [touch(150)]), false);
  assert.equal(emit("touchend", [], { changedTouches: [touch(150)] }), false);
  assert.equal(calls.length, 1);
});

test("PC 宽度下不接管触摸或浏览器默认行为", (t) => {
  const { calls, emit, touch } = fixture(t, { width: 1440 });
  assert.equal(emit("touchstart", [touch(5)]), false);
  assert.equal(emit("touchmove", [touch(150)]), false);
  assert.equal(emit("touchend", [], { changedTouches: [touch(150)] }), false);
  assert.deepEqual(calls, []);
});

test("浏览器取消和组件卸载不会完成手势或保留监听", (t) => {
  const { calls, cleanup, emit, touch } = fixture(t);
  emit("touchstart", [touch(150)]);
  emit("touchmove", [touch(270)]);
  emit("touchcancel", [], { changedTouches: [touch(270)] });
  assert.deepEqual(calls.at(-1), { phase: "end", x: 270, cancelled: true });
  cleanup();
  const count = calls.length;
  assert.equal(emit("touchstart", [touch(5)]), false);
  assert.equal(emit("touchmove", [touch(150)]), false);
  assert.equal(calls.length, count);
});

test("不可取消的浏览器事件不调用 preventDefault", (t) => {
  const { emit, touch } = fixture(t);
  assert.equal(emit("touchstart", [touch(5)], { cancelable: false }), false);
  assert.equal(emit("touchmove", [touch(150)], { cancelable: false }), false);
});

test("侧栏固定标题区阻止下拉页面，按钮轻点仍可触发", (t) => {
  const { emit, touch, calls } = fixture(t, { accept: false, blockVertical: true });
  assert.equal(emit("touchstart", [touch(150)]), false);
  assert.equal(emit("touchend", [], { changedTouches: [touch(150)] }), false);
  emit("touchstart", [touch(150)]);
  assert.equal(emit("touchmove", [touch(150, 220)]), true);
  assert.equal(emit("touchmove", [touch(150, 270)]), true);
  assert.equal(emit("touchend", [], { changedTouches: [touch(150, 270)] }), true);
  assert.equal(calls.some(call => call.phase === "move" || call.phase === "end"), false);
});
