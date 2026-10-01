// @ts-check

/**
 * A tiny element builder.
 *
 * Recipe content arrives from the web, via an LLM, so nothing in the UI ever
 * touches innerHTML: children are appended as nodes, and strings become text
 * nodes. That makes injected markup inert by construction rather than by
 * remembering to escape it.
 *
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'for' || key === 'list' || key === 'form') {
      // Read-only as properties: assigning `input.list` is silently ignored.
      el.setAttribute(key, value);
    } else if (key in el && !key.includes('-')) {
      /** @type {any} */ (el)[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/**
 * A modal question with more answers than confirm() allows. Resolves with the
 * chosen value; Escape gives `dismiss`, which should be the safe answer. The
 * safe answer's button also takes the focus, so a stray Enter cannot pick a
 * destructive one.
 *
 * @template {string} T
 * @param {object} spec
 * @param {string} spec.title
 * @param {any[]} spec.body                      paragraphs, as h() children
 * @param {Array<{ value: T, label: string, danger?: boolean }>} spec.choices
 * @param {T} spec.dismiss
 * @returns {Promise<T>}
 */
export function ask({ title, body, choices, dismiss }) {
  const dialog = /** @type {HTMLDialogElement} */ (
    h(
      'dialog',
      { class: 'ask' },
      h(
        'form',
        { method: 'dialog' },
        h('h2', null, title),
        body.map((part) => h('p', null, part)),
        h(
          'div',
          { class: 'ask-choices' },
          choices.map((c) =>
            h('button', { value: c.value, class: c.danger ? 'danger' : null, autofocus: c.value === dismiss }, c.label),
          ),
        ),
      ),
    )
  );
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const chosen = choices.find((c) => c.value === dialog.returnValue);
      dialog.remove();
      resolve(chosen ? chosen.value : dismiss);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * 45 -> "45 min", 75 -> "1 hr 15 min".
 *
 * @param {number|null} minutes
 * @returns {string}
 */
export function formatMinutes(minutes) {
  if (!minutes) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/**
 * Split a source like "Natasha's Kitchen - https://..." into a label and a URL.
 * Only http(s) URLs are linkified; anything else stays plain text.
 *
 * @param {string|null} source
 * @returns {{ label: string, url: string|null }}
 */
export function sourceParts(source) {
  if (!source) return { label: '', url: null };
  const match = source.match(/https?:\/\/\S+/);
  if (!match) return { label: source, url: null };
  const label = source.replace(match[0], '').replace(/[\s\-–—:]+$/, '').trim();
  let host = match[0];
  try {
    host = new URL(match[0]).hostname.replace(/^www\./, '');
  } catch {
    return { label: source, url: null };
  }
  return { label: label || host, url: match[0] };
}

/** @returns {string} */
export function nowIso() {
  return new Date().toISOString();
}
