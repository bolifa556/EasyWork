import assert from "node:assert/strict";
import test from "node:test";
import { bindMobileViewport } from "../app/easywork/shell/mobile-viewport.ts";

function fixture(t, width = 390) {
  const win = new EventTarget();
  const doc = new EventTarget();
  const viewport = new EventTarget();
  const values = new Map();
  const frames = new Map();
  const timers = new Map();
  let id = 0;
  Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
  Object.assign(doc, { visibilityState: "visible", documentElement: { style: {
    getPropertyValue: key => values.get(key), setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key),
  } } });
  Object.assign(win, { document: doc, visualViewport: viewport, innerWidth: width, innerHeight: 844,
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; }, cancelAnimationFrame: key => frames.delete(key),
    setTimeout: callback => { timers.set(++id, callback); return id; }, clearTimeout: key => timers.delete(key),
  });
  const dispose = bindMobileViewport(win);
  t.after(dispose);
  return { win, doc, viewport, values, frames, timers, dispose,
    flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); },
    finishTimers: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); },
  };
}

test("键盘只缩小 visualViewport 时，应用高度跟随并在关掉键盘后恢复", t => {
  const f = fixture(t);
  f.viewport.height = 480;
  f.viewport.offsetTop = 26;
  f.viewport.dispatchEvent(new Event("resize"));
  f.viewport.dispatchEvent(new Event("scroll"));
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.values.get("--ew-viewport-height"), "480px");
  assert.equal(f.values.get("--ew-viewport-top"), "26px");
  Object.assign(f.viewport, { height: 844, offsetTop: 0 });
  f.viewport.dispatchEvent(new Event("resize"));
  f.flush();
  assert.equal(f.values.get("--ew-viewport-height"), "844px");
});

test("切回网页后的延迟键盘尺寸也会重新读取，不依赖 resize 事件", t => {
  const f = fixture(t);
  f.doc.visibilityState = "hidden";
  f.doc.dispatchEvent(new Event("visibilitychange"));
  f.flush();
  f.doc.visibilityState = "visible";
  f.win.dispatchEvent(new Event("pageshow"));
  f.flush();
  f.viewport.height = 450;
  f.finishTimers();
  f.flush();
  assert.equal(f.values.get("--ew-viewport-height"), "450px");
});

test("浏览器缩放不重排应用，切回 PC 或卸载清理手机高度", t => {
  const f = fixture(t);
  Object.assign(f.viewport, { scale: 2, height: 422 });
  f.viewport.dispatchEvent(new Event("resize"));
  f.flush();
  assert.equal(f.values.get("--ew-viewport-height"), "844px");
  f.win.innerWidth = 1440;
  f.win.dispatchEvent(new Event("resize"));
  f.flush();
  assert.equal(f.values.size, 0);
  f.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(fixture(t, 1440).values.size, 0);
});
