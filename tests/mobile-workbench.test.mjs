import assert from "node:assert/strict";
import test from "node:test";
import { bindMobileWorkbench, mobileWorkbenchBounds } from "../app/easywork/features/workbench/mobile-workbench.ts";

function fixture(t, width = 390) {
  const original = globalThis.Element;
  class Element extends EventTarget {
    parentElement = null;
    scrollTop = 0;
    attrs = new Map();
    style = { setProperty: (name, value) => { this.style[name] = value; } };
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
    closest() { return null; }
    getBoundingClientRect() { return { height: 400 }; }
    setAttribute(key, value) { this.attrs.set(key, value); }
    removeAttribute(key) { this.attrs.delete(key); }
  }
  globalThis.Element = Element;
  const win = new EventTarget();
  const doc = new EventTarget();
  const drawer = new Element();
  const header = new Element();
  const body = new Element();
  const outside = new Element();
  header.parentElement = body.parentElement = drawer;
  drawer.parentElement = { clientHeight: 844 };
  drawer.ownerDocument = doc;
  doc.defaultView = win;
  const frames = new Map();
  const timers = new Map();
  const storage = new Map();
  let id = 0;
  let closed = 0;
  Object.assign(win, { innerWidth: width, innerHeight: 844,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: key => frames.delete(key),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: key => timers.delete(key),
  });
  const dispose = bindMobileWorkbench(drawer, header, () => { closed++; });
  t.after(() => { dispose(); globalThis.Element = original; });
  const emit = (type, target, x, y) => {
    const event = new Event(type, { cancelable: true });
    const touch = { identifier: 1, clientX: x, clientY: y };
    Object.assign(event, { touches: type === "touchend" || type === "touchcancel" ? [] : [touch], changedTouches: [touch] });
    Object.defineProperty(event, "target", { value: target });
    (type === "click" ? doc : drawer).dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { drawer, header, body, outside, win, frames, storage, emit, get closed() { return closed; },
    flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); },
    finish: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); },
  };
}

test("工作台拖动标题栏逐帧调整高度，保留独立手机高度", t => {
  const f = fixture(t);
  f.emit("touchstart", f.header, 195, 444);
  f.emit("touchmove", f.header, 195, 420);
  assert.equal(f.emit("touchmove", f.header, 195, 344), true);
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.drawer.style["--mobile-workbench-height"], "500px");
  f.emit("touchend", f.header, 195, 344);
  assert.equal(f.storage.get("easywork.mobile-workbench-height"), "500");
  assert.equal(f.storage.has("easywork.workbench-height"), false);
  assert.equal(f.closed, 0);
});

test("工作台页面下拉足够距离后收回，短滑恢复原高", t => {
  const f = fixture(t);
  f.emit("touchstart", f.body, 180, 600);
  f.emit("touchmove", f.body, 180, 625);
  f.emit("touchend", f.body, 180, 625);
  assert.equal(f.drawer.style["--mobile-workbench-height"], "400px");
  f.emit("touchstart", f.body, 180, 600);
  f.emit("touchmove", f.body, 180, 740);
  f.emit("touchend", f.body, 180, 740);
  assert.equal(f.drawer.style["--mobile-workbench-height"], "0px");
  f.finish();
  assert.equal(f.closed, 1);
});

test("滚动列表尚未到顶时不劫持下拉，点击聊天区域收回工作台", t => {
  const f = fixture(t);
  f.body.scrollTop = 200;
  f.emit("touchstart", f.body, 180, 600);
  assert.equal(f.emit("touchmove", f.body, 180, 740), false);
  f.emit("touchend", f.body, 180, 740);
  f.finish();
  assert.equal(f.closed, 0);
  f.emit("click", f.outside, 180, 200);
  assert.equal(f.closed, 1);
});

test("键盘缩小时保留聊天空间，PC 不使用手机拖动或外部点击收起", t => {
  assert.deepEqual(mobileWorkbenchBounds(400), { min: 160, max: 268 });
  const f = fixture(t, 1440);
  f.emit("touchstart", f.header, 180, 600);
  assert.equal(f.emit("touchmove", f.header, 180, 440), false);
  f.emit("touchend", f.header, 180, 440);
  f.emit("click", f.outside, 180, 200);
  assert.equal(f.closed, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.drawer.style["--mobile-workbench-height"], undefined);
});
