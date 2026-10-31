import test from "node:test";
import assert from "node:assert/strict";
import { mountTail } from "./tail.js";

test("the card appears on request and disappears when the chat changes", async () => {
    class Element {
        constructor() { this.children = []; this.parent = null; }
        setAttribute() {}
        addEventListener() {}
        append(...children) {
            for (const child of children) {
                if (child instanceof Element) {
                    child.remove();
                    child.parent = this;
                }
                this.children.push(child);
            }
        }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        remove() {
            if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
            this.parent = null;
        }
        get lastElementChild() { return this.children.filter((child) => child instanceof Element).at(-1); }
    }
    const chatElement = new Element();
    globalThis.document = { createElement: () => new Element(), getElementById: (id) => id === "chat" ? chatElement : null };
    globalThis.MutationObserver = class { observe() {} };
    globalThis.requestAnimationFrame = (callback) => callback();
    globalThis.window = {};
    const chat = [{ mes: "first" }];
    let resolve;
    const tail = mountTail({ context: () => ({ chat, eventSource: {}, eventTypes: {} }), suggest: () => new Promise((done) => { resolve = done; }) });
    assert.equal(chatElement.children.length, 0);
    const pending = tail.generate();
    assert.equal(chatElement.children.length, 1);
    chat.push({ mes: "second" });
    tail.refresh();
    assert.equal(chatElement.children.length, 0);
    resolve(["old choice"]);
    await pending;
    assert.equal(chatElement.children.length, 0);
});
