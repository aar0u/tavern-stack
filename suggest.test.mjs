// node --test suggest.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { insertText, showsFor, suggestionKey } from "./suggest.js";

test("a choice goes after what is typed and never over it", () => {
    assert.equal(insertText("", "我拔刀"), "我拔刀");
    assert.equal(insertText("  \n", "我拔刀"), "我拔刀");
    assert.equal(insertText("先问他一句", "我拔刀"), "先问他一句\n我拔刀");
    assert.equal(insertText("先问他一句\n\n", "我拔刀"), "先问他一句\n我拔刀", "trailing blank lines are not doubled");
});

test("the key changes with a new reply, a swipe, an edit or a deletion", () => {
    const chat = [{ mes: "a" }, { mes: "b", swipe_id: 0 }];
    const key = suggestionKey(chat);
    assert.equal(suggestionKey([...chat]), key, "the same chat has the same key");
    assert.notEqual(suggestionKey([...chat, { mes: "c" }]), key, "a new message");
    assert.notEqual(suggestionKey([chat[0], { mes: "b", swipe_id: 1 }]), key, "a swipe");
    assert.notEqual(suggestionKey([chat[0], { mes: "b edited", swipe_id: 0 }]), key, "an edit");
    assert.notEqual(suggestionKey([chat[0]]), key, "a deletion");
    assert.equal(suggestionKey([]), null);
});

test("the card is for the latest reply of the character only", () => {
    assert.equal(showsFor([{ is_user: true, mes: "hi" }, { is_user: false, mes: "reply" }]), true);
    assert.equal(showsFor([{ is_user: false, mes: "reply" }, { is_user: true, mes: "next" }]), false);
    assert.equal(showsFor([{ is_user: false, is_system: true, mes: "note" }]), false);
    assert.equal(showsFor([]), false);
});
