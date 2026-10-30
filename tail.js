// The 代写 card under the latest reply, in the flow of the chat: a button asks for four different next steps; a click on one puts it into
// the input box. It never sends, and never writes over what is typed. Text
// already in the box is the draft: the four are then ways to write it out.
import { fill, h } from "./dom.js";
import { insertText, showsFor, suggestionKey } from "./suggest.js";

const ID = "ts-tail";

// suggest() gives the four choices (and throws a reason when it cannot).
export function mountTail({ context, enabled, suggest }) {
    const state = { key: null, status: "idle", choices: [], error: "" };
    let card = null;
    let scheduled = false;

    const inputBox = () => document.getElementById("send_textarea");

    function put(text) {
        const box = inputBox();
        if (!box) return;
        box.value = insertText(box.value, text);
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
    }

    function draw() {
        const busy = state.status === "busy";
        fill(
            card,
            h(
                "div",
                { class: "ts-tail-head" },
                h("b", {}, "代写"),
                h("button", { class: "menu_button", disabled: busy ? "" : null, onclick: generate }, busy ? "生成中…" : state.status === "done" ? "重新生成" : "生成候选"),
                state.status === "done" && h("button", { class: "menu_button", onclick: () => put(state.choices.join("\n")) }, "填入整段"),
            ),
            state.status === "error" && h("div", { class: "ts-tail-error" }, state.error),
            state.status === "done" && state.choices.map((text) => h("button", { class: "menu_button ts-choice", onclick: () => put(text) }, text)),
        );
    }

    // Choices belong to one state of the chat; another one starts from nothing.
    function sync() {
        const chat = context().chat;
        const key = suggestionKey(chat);
        if (key !== state.key) Object.assign(state, { key, status: state.status === "busy" ? "busy" : "idle", choices: [], error: "" });
        return showsFor(chat);
    }

    function refresh() {
        scheduled = false;
        const chat = document.getElementById("chat");
        if (!chat || !enabled() || !sync()) return card?.remove();
        card ??= h("div", { id: ID });
        if (chat.lastElementChild !== card) chat.append(card);
        draw();
    }

    // Appending the card changes the chat too: one pass per frame, and the card is moved only when it is not the last element.
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(refresh);
    };

    async function generate() {
        if (state.status === "busy") return;
        // Without a card (switched off, or the player's own message is last) the answer would have nowhere to show.
        if (!enabled() || !sync()) return window.toastr?.info("代写卡没有显示（设置里关了，或最新一条是你自己的消息），没有可接的剧情");
        const key = state.key;
        Object.assign(state, { status: "busy", choices: [], error: "" });
        draw();
        let outcome;
        try {
            outcome = { status: "done", choices: await suggest() };
        } catch (error) {
            outcome = { status: "error", error: String(error?.message ?? error) };
        }
        if (state.key !== key) {
            // The chat moved on while the model was writing: the answer is for another state and is dropped.
            state.status = "idle";
            return refresh();
        }
        Object.assign(state, outcome);
        refresh();
    }

    // The chat element exists from the start; its children are replaced as messages come and go.
    const chat = document.getElementById("chat");
    if (chat) new MutationObserver(schedule).observe(chat, { childList: true });
    const { eventSource, eventTypes } = context();
    for (const name of ["CHAT_CHANGED", "MESSAGE_RECEIVED", "MESSAGE_SWIPED", "MESSAGE_EDITED", "MESSAGE_DELETED", "CHARACTER_MESSAGE_RENDERED", "USER_MESSAGE_RENDERED", "GENERATION_ENDED", "GENERATION_STOPPED"]) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], schedule);
    }
    schedule();

    return { refresh: schedule, generate };
}
