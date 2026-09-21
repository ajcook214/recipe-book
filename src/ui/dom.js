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
    } else if (key === 'for') {
      el.setAttribute('for', value);
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
