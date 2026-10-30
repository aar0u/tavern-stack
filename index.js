// Tavern Stack: prompts that follow the character (profiles), a floating panel and a settings page, as one SillyTavern extension.
// It uses SillyTavern's own extension context only (SillyTavern.getContext()), not the Tavern Helper scripts.
import { createActions } from "./actions.js";
import { fill, h } from "./dom.js";
import { IN_CHAT, ROLES, activePrompts, nameMatches, newId, normalizeSettings } from "./profiles.js";
import { mountTail } from "./tail.js";

const MODULE = "tavern_stack";
const context = () => SillyTavern.getContext();
const settings = () => context().extensionSettings[MODULE];
const save = () => context().saveSettingsDebounced();
let tail = null;
let actions = null;

// Prompts: the ones set last time are cleared when they no longer apply (an empty text removes an extension prompt).
let applied = new Set();
const characterName = () => {
    const { groupId, characters, characterId } = context();
    return groupId ? null : (characters?.[characterId]?.name ?? null);
};

function apply() {
    const { setExtensionPrompt } = context();
    const active = activePrompts(settings(), characterName());
    const keys = new Set(active.map((prompt) => prompt.key));
    for (const key of applied) if (!keys.has(key)) setExtensionPrompt(key, "", IN_CHAT, 0, false, ROLES.system);
    for (const { key, text, depth, role } of active) setExtensionPrompt(key, text, IN_CHAT, depth, false, role);
    applied = keys;
    if (panel) drawPanel();
}

const commit = () => {
    save();
    apply();
    placeBall();
    tail?.refresh();
};

// Settings page, inside the extensions drawer.
function settingsPage() {
    const root = h("div", { class: "ts-settings" });
    let selected = settings().profiles[0]?.id;

    const field = (label, input) => h("label", { class: "ts-field" }, h("span", {}, label), input);
    const check = (label, value, set) => h("label", { class: "ts-check" }, h("input", { type: "checkbox", checked: value, onchange: (e) => set(e.target.checked) }), h("span", {}, label));

    const draw = () => {
        const s = settings();
        const profile = s.profiles.find((item) => item.id === selected) ?? s.profiles[0];
        selected = profile?.id;
        fill(
            root,
            check("启用（关掉后不再发送任何规则）", s.enabled, (value) => ((s.enabled = value), commit())),
            check("显示悬浮按钮", s.ball.show, (value) => ((s.ball.show = value), commit())),
            check("在最新回复下显示代写候选", s.tail.show, (value) => ((s.tail.show = value), commit())),
            h(
                "div",
                { class: "ts-row" },
                h("select", { onchange: (e) => ((selected = e.target.value), draw()) }, s.profiles.map((item) => h("option", { value: item.id, ...(item.id === selected ? { selected: "" } : {}) }, item.name))),
                h("button", { class: "menu_button", onclick: () => {
                    const item = { id: newId("p", s.profiles), name: "新规则", match: "", enabled: true, prompts: [] };
                    s.profiles.push(item);
                    selected = item.id;
                    commit();
                    draw();
                } }, "新建"),
                profile && h("button", { class: "menu_button", onclick: () => {
                    if (!confirm(`删除规则「${profile.name}」？`)) return;
                    s.profiles.splice(s.profiles.indexOf(profile), 1);
                    selected = s.profiles[0]?.id;
                    commit();
                    draw();
                } }, "删除"),
            ),
            profile ? profileEditor(profile) : h("p", {}, "还没有规则。"),
        );
    };

    const profileEditor = (profile) =>
        h(
            "div",
            { class: "ts-profile" },
            field("名称", h("input", { class: "text_pole", value: profile.name, onchange: (e) => ((profile.name = e.target.value), commit(), draw()) })),
            field("适用角色（名字里包含的文字，或 /正则/）", h("input", { class: "text_pole", value: profile.match, placeholder: "例如 大凉龙虎传", onchange: (e) => ((profile.match = e.target.value), commit()) })),
            check("这条规则启用", profile.enabled, (value) => ((profile.enabled = value), commit())),
            profile.prompts.map((prompt) =>
                h(
                    "div",
                    { class: "ts-prompt" },
                    h(
                        "div",
                        { class: "ts-row" },
                        h("input", { type: "checkbox", checked: prompt.enabled, onchange: (e) => ((prompt.enabled = e.target.checked), commit()) }),
                        h("input", { class: "text_pole", value: prompt.label, onchange: (e) => ((prompt.label = e.target.value), commit()) }),
                        h("span", {}, "深度"),
                        h("input", { class: "text_pole ts-depth", type: "number", min: "0", value: String(prompt.depth), onchange: (e) => ((prompt.depth = Math.max(0, parseInt(e.target.value, 10) || 0)), commit()) }),
                        h("select", { onchange: (e) => ((prompt.role = e.target.value), commit()) }, Object.keys(ROLES).map((role) => h("option", { value: role, ...(role === prompt.role ? { selected: "" } : {}) }, role))),
                        h("button", { class: "menu_button", onclick: () => ((profile.prompts = profile.prompts.filter((item) => item !== prompt)), commit(), draw()) }, "删"),
                    ),
                    h("textarea", { class: "text_pole", rows: "4", value: prompt.text, onchange: (e) => ((prompt.text = e.target.value), commit()) }),
                ),
            ),
            h("button", { class: "menu_button", onclick: () => (profile.prompts.push({ id: newId("q", profile.prompts), label: "新提示词", enabled: true, depth: 0, role: "system", text: "" }), commit(), draw()) }, "添加提示词"),
            h("small", {}, "深度 0 表示接在聊天最后一条消息之后；数字越大离最后越远。role 是这条提示词以什么身份发给模型。"),
        );

    draw();
    return root;
}

function mountSettings() {
    const host = document.getElementById("extensions_settings2") ?? document.getElementById("extensions_settings");
    if (!host || document.getElementById("tavern-stack-drawer")) return;
    host.append(
        h(
            "div",
            { id: "tavern-stack-drawer", class: "inline-drawer" },
            h("div", { class: "inline-drawer-toggle inline-drawer-header" }, h("b", {}, "Tavern Stack"), h("div", { class: "inline-drawer-icon fa-solid fa-circle-chevron-down down" })),
            h("div", { class: "inline-drawer-content" }, settingsPage()),
        ),
    );
}

// The floating button and its panel.
let ball = null;
let panel = null;
const BALL = 44;
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

function placeBall() {
    const s = settings();
    ball.hidden = !s.ball.show;
    if (!s.ball.show) return closePanel();
    const x = s.ball.x ?? window.innerWidth - BALL - 12;
    const y = s.ball.y ?? window.innerHeight * 0.6;
    ball.style.left = `${clamp(x, 4, window.innerWidth - BALL - 4)}px`;
    ball.style.top = `${clamp(y, 4, window.innerHeight - BALL - 4)}px`;
    if (panel) drawPanel();
}

function buildBall() {
    ball = h("div", { id: "ts-ball", title: "Tavern Stack" }, "🧰");
    let start = null;
    ball.addEventListener("pointerdown", (e) => {
        start = { x: e.clientX, y: e.clientY, left: ball.offsetLeft, top: ball.offsetTop, moved: false };
        ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener("pointermove", (e) => {
        if (!start) return;
        if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 6) start.moved = true;
        if (!start.moved) return;
        ball.style.left = `${clamp(start.left + e.clientX - start.x, 4, window.innerWidth - BALL - 4)}px`;
        ball.style.top = `${clamp(start.top + e.clientY - start.y, 4, window.innerHeight - BALL - 4)}px`;
    });
    ball.addEventListener("pointerup", () => {
        if (!start) return;
        const { moved } = start;
        start = null;
        if (moved) {
            Object.assign(settings().ball, { x: ball.offsetLeft, y: ball.offsetTop });
            save();
            if (panel) drawPanel();
        } else panel ? closePanel() : openPanel();
    });
    document.body.append(ball);
    window.addEventListener("resize", placeBall);
}

const closePanel = () => (panel?.remove(), (panel = null));

function openPanel() {
    panel = h("div", { id: "ts-panel" });
    document.body.append(panel);
    drawPanel();
}

// The choices are written into the card under the latest reply, so the chat is scrolled there.
function suggestHere() {
    const chat = document.getElementById("chat");
    chat?.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
    return tail.generate();
}

function toggleFullscreen() {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (!document.documentElement.requestFullscreen) return window.toastr?.warning("这个浏览器不支持全屏");
    return document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch((error) => window.toastr?.error(`全屏失败：${error.message}`));
}

function openSettings() {
    document.querySelector("#extensions-settings-button .drawer-toggle")?.click();
    setTimeout(() => {
        const drawer = document.getElementById("tavern-stack-drawer");
        if (drawer && getComputedStyle(drawer.querySelector(".inline-drawer-content")).display === "none") drawer.querySelector(".inline-drawer-toggle").click();
        drawer?.scrollIntoView({ block: "center" });
    }, 250);
}

function drawPanel() {
    const s = settings();
    const name = characterName();
    const profiles = s.profiles.filter((profile) => profile.enabled && nameMatches(profile.match, name));
    // Everything is on the panel, none of it behind a menu. It closes first: what a button writes goes into the input box, and fullscreen
    // wants the page to itself.
    const button = (label, action) => h("button", { class: "menu_button ts-action", onclick: () => (closePanel(), action()) }, label);
    const group = (title, ...buttons) => h("div", { class: "ts-group" }, h("div", { class: "ts-title" }, title), h("div", { class: "ts-actions" }, buttons));
    fill(
        panel,
        h("div", { class: "ts-head" }, h("b", {}, "Tavern Stack"), h("span", { class: "ts-close", onclick: closePanel }, "✕")),
        h("div", { class: "ts-meta" }, `当前角色：${name ?? "（群聊或未选）"}`),
        !s.enabled && h("div", { class: "ts-meta" }, "扩展已在设置里关闭"),
        profiles.length
            ? profiles.map((profile) => h("div", { class: "ts-group" }, h("div", { class: "ts-title" }, profile.name), profile.prompts.map((prompt) => h("label", { class: "ts-check" }, h("input", { type: "checkbox", checked: prompt.enabled, onchange: (e) => ((prompt.enabled = e.target.checked), commit()) }), h("span", {}, prompt.label)))))
            : h("div", { class: "ts-meta" }, "这个角色没有匹配的规则"),
        group("写", button("代写候选", suggestHere)),
        actions.pictures() &&
            group(
                "画（标签放进输入框，改完回车出图）",
                button("此刻", () => actions.pic("last")),
                button("POV", () => actions.pic("pov")),
                button("我", () => actions.pic("me")),
                button("NPC", () => actions.pic("you")),
                button("特写", () => actions.pic("face")),
                button("景", () => actions.pic("bg")),
                button("输入框", () => actions.pic()),
            ),
        group("其他", button("总结", actions.sum), button("全屏", toggleFullscreen), button("设置", openSettings)),
    );
    // Always the same place, whatever the button is: the right edge, just above the input bar. (By left and top, not bottom and right:
    // SillyTavern's style.css puts a transform on <html>, which makes it the containing block of fixed elements.)
    const bar = document.getElementById("send_form")?.offsetHeight ?? 0;
    Object.assign(panel.style, {
        left: `${Math.max(8, window.innerWidth - panel.offsetWidth - 8)}px`,
        top: `${Math.max(8, window.innerHeight - bar - panel.offsetHeight - 12)}px`,
    });
}

function init() {
    const store = context().extensionSettings;
    store[MODULE] = normalizeSettings(store[MODULE]);
    mountSettings();
    buildBall();
    actions = createActions({ context });
    actions.installTts();
    // For the scripts of the page (Alt+/ in page.js), which are not modules of the extension.
    window.tavernStack = { suggest: suggestHere };
    tail = mountTail({ context, enabled: () => settings().tail.show, suggest: actions.suggest });
    placeBall();
    apply();
    const { eventSource, eventTypes } = context();
    for (const name of ["CHAT_CHANGED", "CHARACTER_EDITED", "GENERATION_STARTED"]) if (eventTypes[name]) eventSource.on(eventTypes[name], apply);
}

// The emitter calls a late listener of APP_READY at once, so this works whenever the extension is loaded.
context().eventSource.on(context().eventTypes.APP_READY, init);
