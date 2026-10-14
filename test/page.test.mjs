// node test/page.test.mjs: seed/scripts/page.js with a fake page (keys, scrolling, the 全屏 quick reply, message frames out of view)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const listeners = {};
const windowListeners = {};
const scrolled = [];
const requests = [];
const pressed = [];
const element = (tag, attrs = {}) => ({ tagName: tag, id: "", textContent: "", isConnected: true, removed: false, remove() { this.removed = true; }, ...attrs });
const fakeFrame = (id) => {
  const handlers = [];
  const inner = {
    keydown: [],
    animationstart: [],
    animations: [],
    getAnimations() { return this.animations; },
    addEventListener(type, fn) { if (this[type] && !this[type].includes(fn)) this[type].push(fn); },
    removeEventListener() {},
  };
  return { ...element("IFRAME", { id }), contentDocument: inner, addEventListener: (type, fn) => handlers.push(fn), load: () => handlers.forEach((fn) => fn()), inner };
};
const message = fakeFrame("TH-message--0--0");
const script = fakeFrame("TH-script--x--1");
let intersect;
let mutate;
let syncStop;
const created = [];
const stopBox = { width: 0, right: 380, top: 740 };
const stopButton = { getBoundingClientRect: () => stopBox };
const events = {};
const intervals = [];
const cleared = [];
let now = 1_000_000;
const inputBox = { value: "草稿", focused: 0, range: null, focus() { this.focused += 1; }, setSelectionRange(from, to) { this.range = [from, to]; } };
const doc = {
  body: { append() {} },
  head: { append() {} },
  defaultView: { innerWidth: 400, innerHeight: 800 },
  createElement: (tag) => (created.push(element(tag, { style: {} })), created.at(-1)),
  fullscreenElement: null,
  documentElement: { requestFullscreen: async (options) => requests.push(options) },
  exitFullscreen: async () => requests.push("exit"),
  querySelectorAll: (selector) => (selector === "iframe" ? [message, script] : []),
  getElementById: (id) => ({ chat: { clientHeight: 1000, scrollBy: (options) => scrolled.push(options.top) }, mes_stop: stopButton, send_textarea: inputBox })[id] ?? null,
  addEventListener: (type, handler) => (listeners[type] ??= []).push(handler),
  removeEventListener: (type, handler) => (listeners[type] = listeners[type].filter((h) => h !== handler)),
};
runInNewContext(readFileSync(new URL("../seed/scripts/page.js", import.meta.url), "utf8"), {
  console,
  window: {
    parent: {
      document: doc,
      toastr: { warning() {}, error() {} },
      quickReplyApi: {
        getQrByLabel: (set, id) => (set === "quick-replies" ? { label: { 2: "代写", 3: "更多", 4: "全屏" }[id] } : undefined),
        executeQuickReply: async (set, id) => pressed.push([set, id]),
      },
    },
    addEventListener: (type, handler) => (windowListeners[type] = handler),
  },
  IntersectionObserver: class { constructor(cb) { intersect = cb; } observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class {
    constructor(cb) { this.cb = cb; }
    observe(target) { if (target === stopButton) syncStop = this.cb; else mutate = this.cb; }
    disconnect() {}
  },
  eventOn: (type, handler) => (events[type] = handler),
  tavern_events: { STREAM_TOKEN_RECEIVED: "stream_token_received" },
  Date: { now: () => now },
  setInterval: (fn) => intervals.push(fn),
  clearInterval: (id) => cleared.push(id),
});

// --- keys
const key = (code, extra = {}, handlers = listeners.keydown) => {
  const event = { code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, target: { closest: () => null }, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  handlers.forEach((handler) => handler(event));
  return event;
};
let blurred = 0;
const field = { closest: () => ({}), blur: () => blurred++ };
const chatInput = { id: "send_textarea", closest: () => ({}), blur: () => blurred++ };
for (const [code, top] of [["KeyD", 400], ["KeyU", -400], ["Period", 400], ["Comma", -400]]) {
  const before = scrolled.length;
  assert.equal(key(code).prevented, true);
  assert.deepEqual(scrolled.slice(before), [top], `a plain ${code} scrolls by 0.4 of the chat height when nothing is being typed`);
}
key("KeyD", { repeat: true });
assert.equal(scrolled.length, 4, "holding the key acts once");
for (const code of ["KeyD", "KeyU", "Period", "Comma"]) {
  const before = scrolled.length;
  assert.equal(key(code, { target: field }).prevented, false, `${code} is typed while a text field has the focus`);
  assert.equal(scrolled.length, before);
}
assert.equal(key("Period", { shiftKey: true }).prevented, false, "Shift+. is a > and left alone");
assert.equal(key("KeyD", { shiftKey: true }).prevented, false, "Shift+D is a capital D and left alone");
for (const extra of [{ ctrlKey: true }, { metaKey: true }]) {
  const before = scrolled.length;
  assert.equal(key("KeyD", extra).prevented, false, "Ctrl+D (a bookmark) and Cmd+D are the browser's");
  assert.equal(key("KeyU", extra).prevented, false, "Ctrl+U (view source) too");
  assert.equal(scrolled.length, before);
}
assert.equal(key("Comma", { altKey: true }).prevented, false, "Alt+, and Alt+. are no longer used");
assert.equal(key("Slash").prevented, true);
assert.deepEqual([inputBox.focused, inputBox.range], [1, [2, 2]], "a plain / focuses the input box, caret at the end");
key("Slash", { repeat: true });
assert.equal(inputBox.focused, 1, "holding it acts once");
assert.equal(key("Slash", { target: field }).prevented, false, "and types a / while a text field has the focus");
// Shift+/ leaves the chat input, and only that
assert.equal(key("Slash", { shiftKey: true, key: "?", target: chatInput }).prevented, true);
assert.equal(blurred, 1, "Shift+/ takes the focus out of the chat input");
key("Slash", { shiftKey: true, key: "?", target: chatInput, repeat: true });
assert.equal(blurred, 1, "holding it acts once");
assert.equal(key("Slash", { shiftKey: true, key: "?", target: field }).prevented, false, "another text field keeps its ?");
assert.equal(key("Slash", { shiftKey: true, key: "Process", target: chatInput }).prevented, false, "an input method composing a ？ is left alone");
assert.equal(key("Slash", { shiftKey: true, key: "?" }).prevented, false, "and with no field focused Shift+/ does nothing");
assert.equal(inputBox.focused, 1);
key("Slash", { altKey: true });
assert.deepEqual(JSON.parse(JSON.stringify(pressed)), [["quick-replies", 2]], "Alt+/ runs the 代写 quick reply through SillyTavern's API, by its id");
assert.equal(key("Slash", { altKey: true, ctrlKey: true }).prevented, false, "Ctrl+Alt+/ is not Alt+/");
assert.equal(message.inner.keydown.length, 1, "a message frame has the key listener too: key events inside it never reach the page");
const beforeFrame = scrolled.length;
key("KeyD", {}, message.inner.keydown);
assert.equal(scrolled.length, beforeFrame + 1, "and it scrolls the page's chat");
assert.equal(script.inner.keydown.length, 1, "every frame, not only the messages");

// --- fullscreen
const click = (label) => {
  const button = { querySelector: () => ({ textContent: ` ${label} ` }) };
  listeners.click.forEach((handler) => handler({ target: { closest: (selector) => (selector === ".qr--button" ? button : null) } }));
};
click("更多");
assert.deepEqual(requests, [], "other quick replies are left alone");
click("全屏");
assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ navigationUI: "hide" }], "the 全屏 quick reply asks for fullscreen inside its own click");
doc.fullscreenElement = {};
click("全屏");
assert.equal(requests.at(-1), "exit", "and leaves it the next time");
listeners.click.forEach((handler) => handler({ target: {} }));
assert.equal(requests.length, 2, "a click on something that is no button is ignored");

// --- message frames out of view
const animation = (iterations, playState = "running") => ({ playState, calls: [], effect: { getComputedTiming: () => ({ iterations }) }, pause() { this.playState = "paused"; this.calls.push("pause"); }, play() { this.playState = "running"; this.calls.push("play"); } });
const endless = animation(Infinity);
const oneShot = animation(1); // reveals content (opacity 0 until it ends): frozen at its start the content would stay invisible
const pausedByPage = animation(Infinity, "paused"); // somebody else's: not ours to resume
message.inner.animations.push(endless, oneShot, pausedByPage);
assert.deepEqual([endless.calls, oneShot.calls], [[], []], "a frame is left running until it is known to be off screen");
intersect([{ target: message, isIntersecting: false }]);
assert.deepEqual([endless.playState, oneShot.playState], ["paused", "running"], "off screen: the endless animation is paused, the one-shot one is left to finish");
intersect([{ target: message, isIntersecting: false }]);
assert.deepEqual(endless.calls, ["pause"], "once, not again for the same animation");
intersect([{ target: message, isIntersecting: true }]);
assert.deepEqual([endless.playState, endless.calls, oneShot.calls, pausedByPage.calls], ["running", ["pause", "play"], [], []], "back on screen: only what was paused here runs again");
intersect([{ target: message, isIntersecting: false }]);
const late = animation(Infinity);
message.inner.animations.push(late);
message.inner.animationstart.forEach((handler) => handler());
assert.equal(late.playState, "paused", "an endless animation that starts later in a frame out of view is paused too");
const rerendered = animation(Infinity);
message.inner.animations = [rerendered];
message.load();
assert.equal(rerendered.playState, "paused", "a re-rendered message (new document) is paused again while it is off screen");
const added = fakeFrame("TH-message--1--0");
const addedAnimation = animation(Infinity);
added.inner.animations.push(addedAnimation);
mutate([{ addedNodes: [added] }]);
intersect([{ target: added, isIntersecting: false }]);
assert.equal(addedAnimation.playState, "paused", "a frame added later is watched too");
const scriptAnimation = animation(Infinity);
script.inner.animations.push(scriptAnimation);
script.load();
assert.equal(scriptAnimation.playState, "running", "only message frames are touched");
assert.equal(added.inner.keydown.length, 1, "and gets the key listener");

// --- the pill above the stop button
const [style, pill] = created;
assert.match(style.textContent, /#page-generating \{/, "the pill's own style");
assert.equal(pill.id, "page-generating");
assert.equal(pill.style.display, undefined, "nothing is shown before the first change");
syncStop();
assert.equal(intervals.length, 0, "no stop button on screen: no clock");
stopBox.width = 40;
syncStop();
assert.equal(pill.style.display, "flex", "the stop button appears: a reply is being written");
assert.deepEqual([pill.textContent, pill.style.left, pill.style.top], ["0s", "380px", "734px"], "the pill's corner goes to the stop button's top right corner, 6px up");
assert.match(style.textContent, /transform: translate\(-100%, -100%\)/, "and the pill lies up and to the left of that corner");
assert.deepEqual([pill.style.right, pill.style.bottom], [undefined, undefined], "placed by left/top only: right/bottom put it off screen on the phone");
const after = (seconds, text, why) => {
  now += seconds * 1000;
  intervals[0]();
  assert.equal(pill.textContent, text, why);
};
after(12.4, "12s", "before the first chunk there is only the time, however long it takes");
events.stream_token_received("字".repeat(1240));
after(0, "12s · 1240 字", "the characters streamed so far");
after(4, "16s · 1240 字", "a short pause is no stall");
after(2, "无新内容 6s", "nothing new for 5 seconds: only how long, instead of the elapsed time and the characters");
after(3, "无新内容 9s", "and it keeps counting");
events.stream_token_received("字".repeat(1300));
after(0, "21s · 1300 字", "text flows again: back to the elapsed time, which never stopped, and the characters");
after(5, "无新内容 5s", "the next stall counts from its own start");
events.stream_token_received("字".repeat(1300));
after(1, "无新内容 6s", "the same text again is not new");
stopBox.width = 0;
syncStop();
assert.deepEqual([pill.style.display, cleared.length], ["none", 2], "the stop button goes away: the pill hides and the clock stops");
events.stream_token_received("x".repeat(50));
stopBox.width = 40;
syncStop();
assert.equal(pill.textContent, "0s", "the next reply starts from zero, with no characters yet");

// --- leaving the page lets what was paused run again
assert.deepEqual([rerendered.playState, addedAnimation.playState], ["paused", "paused"]);
windowListeners.pagehide();
assert.deepEqual([rerendered.playState, addedAnimation.playState, oneShot.calls], ["running", "running", []], "pagehide resumes the animations this script paused and touches nothing else");
console.log("page tests passed");
