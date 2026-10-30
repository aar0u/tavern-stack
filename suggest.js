// The logic of the 代写 card that needs no SillyTavern or page (tested by suggest.test.mjs).

// Into the input box: the box as it is when empty, else after what is in it on a new line. Never over it.
export const insertText = (current, text) => (current.trim() ? `${current.replace(/\s+$/, "")}\n${text}` : text);

// What the choices were written for: the number of messages and the text and swipe of the last one. They go stale when a reply is swiped,
// edited, deleted or a new one comes, which all change this.
export function suggestionKey(chat) {
    const last = chat?.at(-1);
    if (!last) return null;
    let hash = 5381;
    for (const char of `${last.swipe_id ?? 0}|${last.mes ?? ""}`) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
    return `${chat.length}:${hash}`;
}

// The card is shown under the latest reply of the character: not under the player's own message, not when the chat is empty.
export const showsFor = (chat) => {
    const last = chat?.at(-1);
    return Boolean(last) && !last.is_user && !last.is_system;
};
