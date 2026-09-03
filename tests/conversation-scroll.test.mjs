import assert from "node:assert/strict";
import test from "node:test";
import { followConversationScroll, isNearConversationBottom } from "../app/easywork/features/conversation/conversation-scroll.ts";

function fixture(t, saved) {
  const original = Object.fromEntries(["ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame"].map((name) => [name, globalThis[name]]));
  const frames = new Map();
  let frameId = 0;
  let observer;
  globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.ResizeObserver = class {
    targets = [];
    disconnected = false;
    constructor(callback) { this.callback = callback; observer = this; }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  const listeners = new Map();
  const viewport = {
    clientHeight: 400, scrollHeight: 1000, scrollTop: 0,
    scrollTo({ top }) { this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const content = {};
  const positions = [];
  const cleanup = followConversationScroll(viewport, content, saved, (position) => positions.push(position));
  t.after(() => { cleanup(); Object.assign(globalThis, original); });
  return {
    viewport, content, observer, frames, listeners, positions, cleanup,
    emit: (type, event = {}) => listeners.get(type)?.(event),
    resize: () => observer.callback(),
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()); },
  };
}

test("底部附近的 80px 允许跟随，远离底部则停止", () => {
  assert.equal(isNearConversationBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 520 }), true);
  assert.equal(isNearConversationBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 519 }), false);
  assert.equal(isNearConversationBottom({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 }), true);
});

test("初次载入停在底部，流式内容或展开详情增高后每帧只跟随一次", (t) => {
  const f = fixture(t);
  assert.equal(f.viewport.scrollTop, 600);
  assert.deepEqual(f.observer.targets, [f.content, f.viewport]);
  f.viewport.scrollHeight = 1400;
  f.resize();
  f.resize();
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.viewport.scrollTop, 1000);
  assert.deepEqual(f.positions.at(-1), { top: 1000, following: true });
});

test("用户在较早内容处阅读时，新内容和工作台尺寸变化都不拉回底部", (t) => {
  const f = fixture(t);
  f.viewport.scrollTop = 180;
  f.emit("scroll");
  f.viewport.scrollHeight = 1700;
  f.resize();
  f.viewport.clientHeight = 220;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 180);
  assert.equal(f.frames.size, 0);
  assert.equal(f.positions.at(-1).following, false);
});

test("回到底部附近后恢复跟随，打开工作台和输入框增高时保持末尾可见", (t) => {
  const f = fixture(t);
  f.viewport.scrollTop = 100;
  f.emit("scroll");
  f.viewport.scrollTop = 550;
  f.emit("scroll");
  f.viewport.clientHeight = 200;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 800);
  f.viewport.clientHeight = 400;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 600);
});

test("尺寸变化早于 scroll 或 ResizeObserver 的回调时不丢失跟随状态", (t) => {
  const f = fixture(t);
  f.viewport.scrollHeight = 1800;
  f.emit("scroll");
  f.resize();
  f.emit("scroll");
  f.flush();
  assert.equal(f.viewport.scrollTop, 1400);
  assert.equal(f.positions.at(-1).following, true);
});

test("向上滚动会取消待执行的跟随，代码块消费的横向滚轮不会影响跟随", (t) => {
  const f = fixture(t);
  f.viewport.scrollHeight = 1300;
  f.resize();
  f.emit("wheel", { deltaY: -100, defaultPrevented: true });
  assert.equal(f.frames.size, 1);
  f.emit("wheel", { deltaY: -100, defaultPrevented: false });
  assert.equal(f.frames.size, 0);
  f.viewport.scrollTop = 400;
  f.emit("scroll");
  f.flush();
  assert.equal(f.viewport.scrollTop, 400);
});

test("切换对话后恢复阅读位置，不强制把离底部较远的位置拉走", (t) => {
  const f = fixture(t, { top: 211, following: false });
  f.viewport.scrollHeight = 1700;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 211);
});

test("滚动条拖动或触摸滚动也能打断正在排队的底部跟随", (t) => {
  const f = fixture(t);
  f.viewport.scrollHeight = 1400;
  f.resize();
  assert.equal(f.frames.size, 1);
  f.viewport.scrollTop = 200;
  f.emit("scroll");
  assert.equal(f.frames.size, 0);
  f.flush();
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 200);
  assert.equal(f.positions.at(-1).following, false);
});

test("上次停在底部的对话重新进入后继续跟随新增内容", (t) => {
  const f = fixture(t, { top: 100, following: true });
  assert.equal(f.viewport.scrollTop, 600);
  f.viewport.scrollHeight = 1500;
  f.resize();
  f.flush();
  assert.equal(f.viewport.scrollTop, 1100);
});

test("离开对话时取消帧、尺寸监听和滚动事件", (t) => {
  const f = fixture(t);
  f.resize();
  f.cleanup();
  assert.equal(f.frames.size, 0);
  assert.equal(f.observer.disconnected, true);
  assert.equal(f.listeners.size, 0);
});
