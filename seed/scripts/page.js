// @name 懒人快捷键
// Helpers for the page itself, not for the chat model:
//   u d , . scroll the chat up / down by 0.4 of a page (u and , up, d and . down) while no text field has the focus; / focuses the input box,
//   Esc (SillyTavern's own) and Shift+/ leave it; Alt+/ runs the 代写 quick reply;
//   the 全屏 quick reply (its message is empty) toggles browser fullscreen;
//   while a reply is being written, a pill above the stop button shows a pulsing dot, the elapsed time and the characters streamed so far
//   (or how long nothing new has come, when it has stalled);
//   message frames outside the viewport get their endless animations paused (not the one-shot ones: see pause below).
// Alt+/ works whatever has the focus (SillyTavern puts it back into the input box after every send). Holding a key acts once.
// The key listener runs in the capture phase, ahead of other handlers that might stop the event.
// Message bodies are srcdoc iframes (the card's renderer). Key events in them never reach the page, so every frame gets the key listener;
// and they keep animating after being scrolled out of view (about 100 running animations measured, one core busy, gone when the tab was
// hidden), so message frames are watched for visibility. Frames are re-created on every render, hence the observer.
const doc = window.parent.document;
// The quick replies are known by their ids in seed/QuickReplies/quick-replies.json, which SillyTavern's own API takes in place of a label.
// A button on the page carries no id, only its label, so that is looked up from the id when a button has to be recognised.
const QR_SET = "quick-replies";
const QR_IMPERSONATE = 2;
const QR_FULLSCREEN = 4;
const qrLabel = (id) => window.parent.quickReplyApi?.getQrByLabel(QR_SET, id)?.label;
const QUICK_REPLIES = { Slash: QR_IMPERSONATE };
const SCROLL = { Comma: -1, Period: 1, KeyU: -1, KeyD: 1 };
const isTyping = (el) => !!el?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");
const onKey = (e) => {
  if (e.ctrlKey || e.metaKey) return;
  const quickReply = e.altKey && QUICK_REPLIES[e.code];
  const plain = !e.altKey && !e.shiftKey && !isTyping(e.target);
  const scroll = plain && SCROLL[e.code];
  const focusInput = plain && e.code === "Slash";
  // Shift+/ in the input box is the other way out of it besides Esc: the right hand can do it. The key is checked, not the code, so an input
  // method composing a ？ (key "Process") is left alone, and only the chat input is, since other text fields need their ?
  const leaveInput = e.shiftKey && !e.altKey && e.key === "?" && e.target?.id === "send_textarea";
  if (!quickReply && !scroll && !focusInput && !leaveInput) return;
  e.preventDefault();
  if (e.repeat) return;
  if (leaveInput) return e.target.blur();
  if (focusInput) {
    const box = doc.getElementById("send_textarea");
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
    return;
  }
  if (quickReply) {
    // Run through the API: it needs no button on the page, and a missing quick reply is an error to report, not a silent no-op.
    const api = window.parent.quickReplyApi;
    if (!api) console.warn("[page] the quick reply extension is not loaded");
    else api.executeQuickReply(QR_SET, quickReply).catch((error) => console.warn("[page] quick reply failed:", quickReply, error));
    return;
  }
  const chat = doc.getElementById("chat");
  if (chat) chat.scrollBy({ top: scroll * chat.clientHeight * 0.4, behavior: "smooth" });
  else console.warn("[page] #chat not found");
};

// requestFullscreen has to run inside the click itself, not after a quick reply and a slash command have been run, so this listens for
// the click on the button. iPhone Safari has no element fullscreen, so there it only warns.
const onFullscreenClick = (e) => {
  const button = e.target.closest?.(".qr--button");
  if (!button || button.querySelector(".qr--button-label")?.textContent.trim() !== qrLabel(QR_FULLSCREEN)) return;
  if (doc.fullscreenElement) return doc.exitFullscreen();
  if (!doc.documentElement.requestFullscreen) return window.parent.toastr?.warning("这个浏览器不支持全屏（iPhone 可以用 Safari 的“添加到主屏幕”）");
  doc.documentElement.requestFullscreen({ navigationUI: "hide" }).catch((error) => window.parent.toastr?.error(`全屏失败：${error.message}`));
};

const keyTargets = new Set();
const onScreen = new Map(); // message frame -> whether it is in (or near) the viewport
const watched = new WeakSet();

const bindKeys = (target) => {
  if (!target || keyTargets.has(target)) return;
  target.addEventListener("keydown", onKey, true);
  keyTargets.add(target);
};

// Only endless animations are paused: a one-shot animation that reveals content (opacity 0 until it ends, fill forwards) frozen at its start
// would leave that content invisible until the frame is scrolled into view (measured in Chrome: opacity 0.07 to 0.22 for good).
const frozen = new WeakSet(); // the animations this script paused
const freeze = (animation) => {
  if (animation.playState !== "running" || animation.effect?.getComputedTiming().iterations !== Infinity) return;
  animation.pause();
  frozen.add(animation);
};
const pause = (frame) => {
  if (!onScreen.has(frame)) return;
  try {
    const target = frame.contentDocument;
    if (!target) return;
    for (const animation of target.getAnimations()) {
      if (onScreen.get(frame) === false) freeze(animation);
      else if (frozen.has(animation)) {
        frozen.delete(animation);
        animation.play();
      }
    }
  } catch {}
};

const visibility = new IntersectionObserver(
  (entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!target.isConnected) {
        onScreen.delete(target);
        visibility.unobserve(target);
      } else {
        onScreen.set(target, isIntersecting);
        pause(target);
      }
    }
  },
  { rootMargin: "300px 0px" },
);

const watch = (frame) => {
  if (watched.has(frame)) return;
  watched.add(frame);
  if (frame.id.startsWith("TH-message")) {
    onScreen.set(frame, true);
    visibility.observe(frame);
  }
  const onStart = () => pause(frame); // an animation that starts later (a class toggled, a script) is paused too while the frame is out of view
  const attach = () => {
    try {
      bindKeys(frame.contentDocument); // null for a cross-origin frame
      frame.contentDocument.addEventListener("animationstart", onStart, true);
    } catch {}
    pause(frame);
  };
  attach();
  frame.addEventListener("load", attach); // a srcdoc frame gets a new document when it loads
};
const watchFrames = (root) => root.querySelectorAll?.("iframe").forEach(watch);

const PAGE_CSS = `
#page-generating { position: fixed; z-index: 1000; display: none; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px;
  white-space: nowrap; max-width: calc(100vw - 24px); overflow: hidden; pointer-events: none; transform: translate(-100%, -100%); background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); }
#page-generating::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--SmartThemeQuoteColor, orange);
  animation: page-generating-pulse 1s ease-in-out infinite; }
@keyframes page-generating-pulse { 50% { opacity: 0.25; transform: scale(0.7); } }`;
const style = doc.createElement("style");
style.textContent = PAGE_CSS;
doc.head.append(style);

// The stop button is on screen exactly while a reply is being written (SillyTavern shows and hides it), so it is the signal: its style
// changes are observed, and the clock runs only while it is there. The pill shows the elapsed time and the characters streamed so far;
// once nothing new has come for STALL_AFTER seconds it shows only how long that has lasted instead (the shorter text stays clear of the
// quick reply buttons), and the elapsed time and the characters are back when text flows again. Before the first chunk, and when the
// reply is not streamed, there is only the elapsed time.
const STALL_AFTER = 5;
const pill = doc.createElement("div");
pill.id = "page-generating";
doc.body.append(pill);
const stopButton = doc.getElementById("mes_stop");
let since = 0;
let streamed = 0;
let lastGrowth = 0;
let ticker;
const stopBox = () => {
  const box = stopButton?.getBoundingClientRect();
  return box?.width > 0 ? box : null;
};
const tick = () => {
  const box = stopBox();
  if (!box) return;
  const idle = Math.floor((Date.now() - lastGrowth) / 1000);
  const total = `${Math.floor((Date.now() - since) / 1000)}s`;
  pill.textContent = !streamed ? total : idle >= STALL_AFTER ? `无新内容 ${idle}s` : `${total} · ${streamed} 字`;
  // The pill's corner goes to the stop button's top right corner by left/top (the translate in the style moves it up and to the left of
  // that point). Not by right/bottom: SillyTavern's style.css puts a transform on <html> (a Chrome flicker fix), which makes <html>, not
  // the viewport, the containing block of fixed elements. On the phone its box was empty at the origin (a pill placed with right=2px,
  // bottom=40px ended up at -50px, -64px), so only offsets from the left and the top land where they should.
  pill.style.left = `${box.right}px`;
  pill.style.top = `${box.top - 6}px`;
};
const syncGenerating = () => {
  const active = Boolean(stopBox());
  if (active === (since > 0)) return;
  clearInterval(ticker);
  since = active ? Date.now() : 0;
  lastGrowth = since;
  streamed = 0;
  pill.style.display = active ? "flex" : "none";
  if (!active) return;
  tick();
  ticker = setInterval(tick, 250);
};
const stopObserver = new MutationObserver(syncGenerating);
if (stopButton) stopObserver.observe(stopButton, { attributes: true, attributeFilter: ["style", "class"] });
eventOn(tavern_events.STREAM_TOKEN_RECEIVED, (text) => {
  const length = String(text ?? "").length;
  if (since > 0 && length !== streamed) {
    streamed = length;
    lastGrowth = Date.now();
  }
});

bindKeys(doc);
doc.addEventListener("click", onFullscreenClick, true);
watchFrames(doc);
const mutations = new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.tagName === "IFRAME") watch(node);
      else watchFrames(node);
    }
  }
});
mutations.observe(doc.body, { childList: true, subtree: true });
window.addEventListener("pagehide", () => {
  doc.removeEventListener("click", onFullscreenClick, true);
  mutations.disconnect();
  stopObserver.disconnect();
  clearInterval(ticker);
  pill.remove();
  style.remove();
  visibility.disconnect();
  for (const target of keyTargets) target.removeEventListener("keydown", onKey, true);
  for (const frame of onScreen.keys()) {
    onScreen.set(frame, true);
    pause(frame);
  }
});
