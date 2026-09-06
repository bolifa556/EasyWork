import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const sourceUrl = new URL("../app/easywork/shell/mobile-drawers.ts", import.meta.url);
const source = (await readFile(sourceUrl, "utf8")).replace(/from "([^"]+)"/g, (_, path) => `from "${new URL(`${path}.ts`, sourceUrl).href}"`);
const { bindMobileDrawers } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const originalElement = globalThis.Element;

function fixture(t, { side = "left", open = false, reduced = false, animated = true, width = 390, lateRight = false } = {}) {
  class FakeElement extends EventTarget {
    attrs = new Map();
    writes = [];
    reads = 0;
    animations = [];
    rect = { width: 320, left: 0, right: 320 };
    style = new Proxy({
      setProperty: (key, value) => { this.style[key] = value; },
      removeProperty: (key) => { delete this.style[key]; },
    }, { set: (target, key, value) => { this.writes.push({ key, value }); target[key] = value; return true; } });
    setAttribute(key, value) { this.attrs.set(key, value); }
    removeAttribute(key) { this.attrs.delete(key); }
    closest() { return null; }
    contains() { return true; }
    getBoundingClientRect() { this.reads++; return this.rect; }
    animate(keyframes, options) {
      const animation = { keyframes, options, onfinish: null, cancel() { this.cancelled = true; } };
      this.animations.push(animation);
      return animation;
    }
  }
  globalThis.Element = FakeElement;
  const surface = new FakeElement();
  const panel = new FakeElement();
  if (!animated) panel.animate = undefined;
  let rightMounted = !lateRight;
  surface.querySelector = selector => selector.includes('"right"') && !rightMounted ? null : panel;
  const frames = new Map();
  const timers = new Map();
  let id = 0;
  const win = new EventTarget();
  Object.assign(win, {
    innerWidth: width,
    requestAnimationFrame: (callback) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (key) => frames.delete(key),
    setTimeout: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    clearTimeout: (key) => timers.delete(key),
    matchMedia: () => ({ matches: reduced }),
  });
  surface.ownerDocument = { defaultView: win };
  const state = { left: side === "left" && open, right: side === "right" && open, allowRight: true, disabled: false };
  const commits = [];
  const controller = bindMobileDrawers(surface, {
    getState: () => state,
    setOpen: (drawer, value) => { commits.push({ side: drawer, open: value }); if (state[drawer] !== value) { state[drawer] = value; controller.sync(); } },
  });
  t.after(() => { controller.dispose(); globalThis.Element = originalElement; });
  const emit = (type, dx = 0, dy = 0) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, isPrimary: true, pointerType: "mouse", clientX: 195 + dx, clientY: 250 + dy });
    surface.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return {
    surface, panel, frames, timers, commits, controller, emit, mountRight: () => { rightMounted = true; },
    flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); },
    finish: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(({ callback }) => callback()); },
  };
}

test("高频拖动每帧只绘制最后的位置，且不重算整页或修改整页样式", (t) => {
  const f = fixture(t);
  const initialRootWrites = f.surface.writes.length;
  f.emit("pointerdown");
  for (const dx of [6, 12, 20, 36, 48]) f.emit("pointermove", dx);
  assert.equal(f.frames.size, 1);
  assert.equal(f.panel.writes.filter(({ key }) => key === "transform").length, 0);
  f.flush();
  assert.equal(f.panel.style.transform, "translate3d(-272px,0,0)");
  assert.equal(f.panel.reads, 1);
  assert.equal(f.surface.reads, 0);
  assert.equal(f.surface.writes.length, initialRootWrites);
  assert.equal(f.surface.attrs.get("data-mobile-drawer-side"), "left");
  assert.equal(f.commits.length, 0);
  f.emit("pointerup", 48);
  assert.equal(f.surface.reads, 0);
  assert.equal(f.panel.reads, 1);
  assert.equal(f.panel.animations[0].keyframes[0].transform, "translate3d(-272px,0,0)");
  f.finish();
  assert.deepEqual(f.commits, [{ side: "left", open: false }]);
});

for (const side of ["left", "right"]) {
  for (const open of [false, true]) {
    test(`${side} 侧栏从${open ? "展开" : "收起"}状态拖动，动画结束才提交，短滑恢复原位`, (t) => {
      const f = fixture(t, { side, open });
      const direction = (side === "left" ? 1 : -1) * (open ? -1 : 1);
      f.emit("pointerdown");
      f.emit("pointermove", direction * 20);
      f.flush();
      f.emit("pointerup", direction * 20);
      f.finish();
      assert.deepEqual(f.commits, [{ side, open }]);
      assert.equal(f.panel.attrs.has("data-mobile-drawer-active"), false);
      assert.equal(f.panel.attrs.has("data-mobile-drawer-tracking"), false);
      f.emit("pointerdown");
      f.emit("pointermove", direction * 170);
      f.flush();
      f.emit("pointerup", direction * 170);
      assert.equal(f.commits.length, 1);
      f.panel.animations.at(-1).onfinish();
      assert.deepEqual(f.commits.at(-1), { side, open: !open });
      assert.equal(f.panel.style.transform, undefined);
      assert.equal(f.timers.size, 0);
    });
  }
}

test("松手取消未绘制的旧帧，结束后不会被旧位置拉回", (t) => {
  const f = fixture(t);
  f.emit("pointerdown");
  f.emit("pointermove", 180);
  f.emit("pointerup", 180);
  assert.equal(f.frames.size, 0);
  f.finish();
  f.flush();
  assert.deepEqual(f.commits, [{ side: "left", open: true }]);
  assert.equal(f.panel.style.transform, undefined);
});

test("拖动结束的误点击被拦截，下一次主动轻点立即可用", (t) => {
  const f = fixture(t);
  f.emit("pointerdown");
  f.emit("pointermove", 20);
  f.flush();
  f.emit("pointerup", 20);
  f.finish();
  assert.equal(f.emit("click", 20), true);
  f.emit("pointerdown");
  f.emit("pointerup");
  assert.equal(f.emit("click"), false);
});

for (const side of ["left", "right"]) {
  test(`${side} 回弹中可以重新抓住侧栏，从屏幕上的当前位置继续拉动`, (t) => {
    const f = fixture(t, { side });
    const direction = side === "left" ? 1 : -1;
    f.emit("pointerdown");
    f.emit("pointermove", direction * 30);
    f.flush();
    f.emit("pointerup", direction * 30);
    const bounce = f.panel.animations.at(-1);
    // The short swipe is partway through its closing animation: 20px visible.
    f.panel.rect = side === "left" ? { width: 320, left: -300, right: 20 } : { width: 320, left: 370, right: 690 };
    f.emit("pointerdown");
    assert.equal(bounce.cancelled, true);
    assert.equal(f.timers.size, 0);
    f.emit("pointermove", direction * 150);
    f.flush();
    assert.equal(f.panel.style.transform, `translate3d(${direction * -150}px,0,0)`);
    f.emit("pointerup", direction * 150);
    f.finish();
    assert.deepEqual(f.commits, [{ side, open: true }]);
  });
}

test("动画中轻点或纵向滚动不会让侧栏停在半途，也不拦截原来的动作", (t) => {
  const f = fixture(t);
  for (const dy of [0, 20]) {
    f.emit("pointerdown");
    f.emit("pointermove", 30);
    f.flush();
    f.emit("pointerup", 30);
    f.panel.rect = { width: 320, left: -300, right: 20 };
    f.emit("pointerdown");
    if (dy) assert.equal(f.emit("pointermove", 0, dy), false);
    assert.equal(f.emit("pointerup", 0, dy), false);
    f.finish();
    assert.equal(f.panel.attrs.has("data-mobile-drawer-active"), false);
      assert.equal(f.panel.attrs.has("data-mobile-drawer-tracking"), false);
    assert.deepEqual(f.commits.at(-1), { side: "left", open: false });
  }
});

test("关闭动画偏好即时落位，旧浏览器使用相同的 CSS 位移动画", (t) => {
  for (const reduced of [true, false]) {
    const f = fixture(t, { reduced, animated: false });
    f.emit("pointerdown");
    f.emit("pointermove", 180);
    f.flush();
    f.emit("pointerup", 180);
    assert.equal(f.panel.animations.length, 0);
    if (reduced) assert.equal([...f.timers.values()][0].delay, 0);
    else assert.match(f.panel.style.transition, /^transform \d+ms cubic-bezier/);
    f.finish();
    assert.deepEqual(f.commits, [{ side: "left", open: true }]);
    f.controller.dispose();
  }
});

test("页面切换会清理排队帧和动画，PC 不接管拖动", (t) => {
  const f = fixture(t);
  f.emit("pointerdown");
  f.emit("pointermove", 180);
  f.controller.sync();
  f.flush();
  assert.equal(f.frames.size, 0);
  assert.equal(f.panel.attrs.has("data-mobile-drawer-active"), false);
      assert.equal(f.panel.attrs.has("data-mobile-drawer-tracking"), false);
  assert.equal(f.commits.length, 0);
  const desktop = fixture(t, { width: 1440 });
  desktop.emit("pointerdown");
  desktop.emit("pointermove", 200);
  desktop.emit("pointerup", 200);
  assert.equal(desktop.panel.reads, 0);
  assert.equal(desktop.frames.size, 0);
  assert.equal(desktop.commits.length, 0);
});

test("对话延迟加载后，首次左滑就能拉出新挂载的功能栏", t => {
  const f = fixture(t, { lateRight: true });
  f.mountRight();
  f.emit("pointerdown");
  f.emit("pointermove", -190);
  f.flush();
  assert.equal(f.panel.style.transform, "translate3d(130px,0,0)");
  f.emit("pointerup", -190);
  f.finish();
  assert.deepEqual(f.commits, [{ side: "right", open: true }]);
});
