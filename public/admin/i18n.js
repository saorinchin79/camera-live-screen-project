/**
 * Language of the admin: English or Khmer (ខ្មែរ), switched in the header and remembered by this browser.
 *
 * The page and the code are written in English, and km.js gives the Khmer for each English text. With Khmer on,
 * every text the admin shows (text, and title / aria-label / placeholder / alt) is translated as it appears, by a
 * MutationObserver, so the rest of the admin does not have to know; English comes back as it was. A text with values
 * is a pattern such as "{n} layers · {n2} on program": {n…} stands for a number, any other placeholder for any text,
 * put back as it is, or in Khmer when it is itself a text of km.js ("Camera offline · {message}") except {name} and
 * {file}, which are names as typed. Names, the program preview and the switch sit in translate="no" and stay as they
 * are; a text that km.js lacks stays English.
 *
 * t(text, values) is for the texts the code uses itself: a confirm(), the name it gives a new layer.
 */
import KM from './km.js';

const STORE = 'stream-studio:lang';
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
/** Placeholders that hold a name as it was typed: a camera called "Front gate" stays "Front gate". */
const NAMES = new Set(['name', 'file']);

const exact = new Map(Object.entries(KM).filter(([en]) => !en.includes('{')));
const patterns = Object.entries(KM)
  .filter(([en]) => en.includes('{'))
  .map(([en, km]) => compile(en, km))
  // the most specific first: "Live · {size} · {n} viewers" before "Live · {info}"
  .sort((a, b) => b.literal - a.literal);

function compile(en, km) {
  const names = [];
  let literal = 0;
  const source = en
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m) {
        literal += part.length;
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      names.push(m[1]);
      return /^n\d*$/.test(m[1]) ? '(\\d+)' : '(.+?)';
    })
    .join('');
  return { re: new RegExp(`^${source}$`), names, km, literal };
}

/** The Khmer for an English text (its own spaces around it kept), or null. */
function khmer(en) {
  const text = en.trim();
  if (!text) return null;
  let km = exact.get(text);
  if (km === undefined) {
    for (const p of patterns) {
      const m = p.re.exec(text);
      if (!m) continue;
      km = p.km.replace(/\{(\w+)\}/g, (all, name) => {
        const value = m[p.names.indexOf(name) + 1];
        if (value === undefined) return all;
        return NAMES.has(name) ? value : exact.get(value) || value;
      });
      break;
    }
  }
  if (km === undefined) return null;
  return en.slice(0, en.length - en.trimStart().length) + km + en.slice(en.trimEnd().length);
}

let lang = 'en';
const texts = new WeakMap(); // text node -> { en, km } it was translated with
const attrs = new WeakMap(); // element -> { attribute: { en, km } }
const title = document.title;

function skip(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !el || !!el.closest('[translate="no"], script, style');
}

function translateText(node) {
  const rec = texts.get(node);
  if ((rec && node.data === rec.km) || skip(node)) return;
  const km = khmer(node.data);
  if (km === null) return;
  texts.set(node, { en: node.data, km });
  node.data = km;
}

function translateAttrs(el) {
  if (!ATTRS.some((name) => el.hasAttribute(name)) || skip(el)) return;
  let recs = attrs.get(el);
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (value === null || (recs && recs[name] && recs[name].km === value)) continue;
    const km = khmer(value);
    if (km === null) continue;
    if (!recs) attrs.set(el, (recs = {}));
    recs[name] = { en: value, km };
    el.setAttribute(name, km);
  }
}

function eachNode(root, fn) {
  fn(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) fn(n);
}

function translate(node) {
  if (node.nodeType === Node.TEXT_NODE) translateText(node);
  else if (node.nodeType === Node.ELEMENT_NODE) translateAttrs(node);
}

function restore(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const rec = texts.get(node);
    if (rec && node.data === rec.km) node.data = rec.en;
    return;
  }
  const recs = node.nodeType === Node.ELEMENT_NODE && attrs.get(node);
  if (!recs) return;
  for (const [name, rec] of Object.entries(recs)) {
    if (node.getAttribute(name) === rec.km) node.setAttribute(name, rec.en);
  }
}

// what the admin writes is translated before the browser paints it
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'childList') for (const n of m.addedNodes) eachNode(n, translate);
    else if (m.type === 'characterData') translateText(m.target);
    else translateAttrs(m.target);
  }
});

function setLanguage(next) {
  lang = next === 'km' ? 'km' : 'en';
  document.documentElement.lang = lang;
  observer.disconnect();
  if (lang === 'km') {
    eachNode(document.body, translate);
    document.title = khmer(title) || title;
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  } else {
    eachNode(document.body, restore);
    document.title = title;
  }
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  document.documentElement.classList.remove('i18n-pending');
  try {
    localStorage.setItem(STORE, lang);
  } catch (_) {
    // private mode: the choice lasts until the page closes
  }
}

/** A text for the code to use itself: in Khmer when Khmer is on, with its {values} filled in. */
export function t(en, values) {
  const template = lang === 'km' && KM[en] !== undefined ? KM[en] : en;
  return template.replace(/\{(\w+)\}/g, (all, name) => (values && name in values ? String(values[name]) : all));
}

function savedLanguage() {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved === 'en' || saved === 'km') return saved;
  } catch (_) {
    // no storage: follow the browser
  }
  return /^km\b/i.test(navigator.language || '') ? 'km' : 'en';
}

for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => setLanguage(b.dataset.lang));
setLanguage(savedLanguage());
