// Small DOM helpers shared by the settings page, the panel and the card under the latest reply.

// Children may be nested arrays, and false, null or undefined where a part is left out.
export const nodes = (children) => children.flat().filter((child) => child != null && child !== false);
export const fill = (element, ...children) => element.replaceChildren(...nodes(children));
export const h = (tag, props = {}, ...children) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
        if (name === "class") element.className = value;
        else if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
        else if (name === "value" || name === "checked") element[name] = value;
        else if (value != null && value !== false) element.setAttribute(name, value); // an attribute left out is not "null"
    }
    element.append(...nodes(children));
    return element;
};
