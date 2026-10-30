// The functions of story.js wired to the page: SillyTavern's own generateRaw (a clean request, nothing of the preset), the input box, toasts
// and the window of the summary. The buttons of the panel and the card call these.
import { story } from "./story.js";

const inputBox = () => document.getElementById("send_textarea");

export function createActions({ context }) {
    const toastr = window.toastr;
    // story.js gives the messages as ordered_prompts; SillyTavern's own generateRaw takes them as the prompt and returns the text.
    const generateRaw = ({ ordered_prompts }) => context().generateRaw({ prompt: ordered_prompts });
    const deps = { context, generateRaw, toastr };

    // Assigned, and an input event for SillyTavern to notice (its counters and draft saving listen to it).
    const setInput = (text) => {
        const box = inputBox();
        box.value = text;
        box.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const focusInput = () => {
        const box = inputBox();
        box?.focus();
        box?.setSelectionRange(box.value.length, box.value.length);
    };

    // Runs inside the click of the popup's button, which a copy needs. Selecting the text box and copying also works where the clipboard API
    // does not exist (a page opened as http://192.168… on the phone).
    function copyText() {
        try {
            document.getElementById(story.SUM_TEXT_ID).select();
            if (!document.execCommand("copy")) throw new Error("浏览器拒绝了复制");
            toastr.success("已复制");
        } catch (error) {
            toastr.error(`复制失败，请在文本框里全选复制: ${error?.message ?? error}`);
        }
    }
    const show = (text) => {
        const { callGenericPopup, POPUP_TYPE } = context();
        // A custom button without a result does not close the popup.
        return callGenericPopup(story.sumPopupHtml(text), POPUP_TYPE.TEXT, "", {
            wide: true,
            okButton: "关闭",
            allowVerticalScrolling: true,
            customButtons: [{ text: "复制", appendAtEnd: true, action: copyText }],
        });
    };

    const pic = story.createPic({ ...deps, setInput, focusInput });
    const imp = story.createImp({ ...deps, setInput, focusInput });
    const sum = story.createSum({ ...deps, show });
    return {
        // The seed's settings.story.pictures is false where there is nothing to draw with.
        pictures: () => context().extensionSettings?.story?.pictures !== false,
        // The box is the draft of imp (empty: the player's next step), and what pic draws when it is not one of the kinds.
        imp: () => imp(inputBox()?.value ?? ""),
        pic: (kind) => pic(kind ?? inputBox()?.value ?? ""),
        suggest: story.createImpChoices(deps),
        sum,
        // The Edge TTS provider reads the story, not the whole reply.
        installTts: () => story.installTts((path) => import(path)),
    };
}
