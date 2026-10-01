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
 * A labelled field for a form.
 *
 * @param {string} label
 * @param {HTMLElement} input
 * @param {string} [hint]
 * @returns {HTMLElement}
 */
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

/**
 * A modal form with Save and Cancel. `save` runs on Save, or Enter in a
 * field. It returns a message to keep the form open and show it, or nothing
 * to close. Cancel and Escape close without saving. Resolves with whether it
 * saved.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {any[]} spec.fields                    h() children
 * @param {() => Promise<string|void>} spec.save
 * @returns {Promise<boolean>}
 */
export function editDialog({ title, fields, save }) {
  const problem = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const saveButton = /** @type {HTMLButtonElement} */ (h('button', { value: 'save', class: 'button' }, 'Save'));
  const form = h(
    'form',
    { method: 'dialog', class: 'edit-form' },
    h('h2', null, title),
    fields,
    problem,
    h('div', { class: 'ask-choices' }, saveButton, h('button', { value: 'cancel' }, 'Cancel')),
  );
  const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { class: 'ask' }, form));

  return new Promise((resolve) => {
    let saved = false;
    form.addEventListener('submit', async (event) => {
      // Cancel closes the dialog by itself, as method="dialog" does.
      if (/** @type {HTMLButtonElement|null} */ (/** @type {SubmitEvent} */ (event).submitter)?.value === 'cancel') return;
      event.preventDefault();
      if (saveButton.disabled) return;
      saveButton.disabled = true;
      try {
        const message = await save();
        if (message) {
          problem.textContent = message;
          problem.hidden = false;
          return;
        }
        saved = true;
        dialog.close();
      } finally {
        saveButton.disabled = false;
      }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(saved);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** How close to the top or bottom of the window a dragged row scrolls the page. */
const SCROLL_EDGE = 60;

/**
 * Drag a list row by its handle; call from the handle's pointerdown. The
 * row moves among its siblings as the pointer passes their middles, and the
 * page scrolls while the pointer is near the top or bottom of the window.
 * `drop` gets the row's index before and after. They are equal when it ended
 * where it started, or the browser cancelled the drag; either way the caller
 * should redraw, since the row may have moved on screen.
 *
 * The handle needs `touch-action: none`, or a touch scrolls the page instead.
 *
 * @param {PointerEvent} event
 * @param {(from: number, to: number) => void} drop
 */
export function dragRow(event, drop) {
  const handle = /** @type {HTMLElement} */ (event.currentTarget);
  const row = handle.closest('li');
  const list = row?.parentElement;
  if (!row || !list || event.button !== 0) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  row.classList.add('dragging');

  const from = [...list.children].indexOf(row);
  let y = event.clientY;

  // The siblings move around the row, never the row itself: moving an
  // element takes it out of the page for a moment, which releases the
  // pointer capture, and the drag would never hear the pointer come up.
  const place = () => {
    const children = [...list.children];
    const at = children.indexOf(row);
    const others = children.filter((el) => el !== row);
    let to = others.findIndex((el) => {
      const box = el.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    if (to === -1) to = others.length;
    if (to < at) {
      const after = row.nextSibling;
      for (const el of others.slice(to, at)) list.insertBefore(el, after);
    } else if (to > at) {
      for (const el of others.slice(at, to)) list.insertBefore(el, row);
    }
  };

  // The sticky top bar covers the top of the window, so the scroll zone starts below it.
  const top = (document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + SCROLL_EDGE;
  /** @type {number} */
  let frame;
  const scroll = () => {
    const step = y < top ? -8 : y > window.innerHeight - SCROLL_EDGE ? 8 : 0;
    if (step) {
      window.scrollBy(0, step);
      place();
    }
    frame = requestAnimationFrame(scroll);
  };
  frame = requestAnimationFrame(scroll);

  /** @param {PointerEvent} e */
  const move = (e) => {
    y = e.clientY;
    place();
  };

  /** @param {Event} e */
  const end = (e) => {
    cancelAnimationFrame(frame);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.removeEventListener(type, end);
    handle.removeEventListener('pointermove', move);
    row.classList.remove('dragging');
    // Capture lost before the pointer came up means the drag did not finish.
    drop(from, e.type === 'pointerup' ? [...list.children].indexOf(row) : from);
  };

  handle.addEventListener('pointermove', move);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, end);
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
