// The language of the user interface (2026-11-20, the user's wish: the app in the languages other apps offer,
// chosen once per PC from the start screen, the host window, the list of PCs or a remote session's toolbar).
//
// The Korean text in the code is the source and the key (as gettext does): t('키 복사') looks the text up in a
// catalog, host/i18n/<surface>.json, of the form { "<Korean source>": { "en": "...", "ja": "...", ... } }, and
// falls back to English, then to the Korean source itself. {0}, {1}... are filled from the arguments. A value
// may be an object of plural forms by Intl.PluralRules category ({ "one": "{0} file", "other": "{0} files" }),
// chosen by the first argument. Text that carries a few tags (a bold word, a key cap) goes through safeHtml.
//
// One file for every place that shows text: required by the main processes, loaded by the host window as a
// script, inlined into the client page and the loader by build-client.js (`/*__I18N_JS__*/`).
(function (root) {
  'use strict';
  // In the order the menus show them; `name` is the language's own name. RTL languages (Arabic, Hebrew) and Thai
  // are not offered yet: the layouts are not mirrored, and Thai line breaking has not been checked.
  const LANGS = [
    { code: 'ko', name: '한국어' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
    { code: 'zh-CN', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'pt-BR', name: 'Português (Brasil)' },
    { code: 'ru', name: 'Русский' },
    { code: 'vi', name: 'Tiếng Việt' },
    { code: 'id', name: 'Bahasa Indonesia' },
  ];
  const CODES = LANGS.map((l) => l.code);
  // A BCP 47 tag (en-US, zh-Hant-HK, pt-PT, in) -> one of CODES, or '' when none fits.
  function normalize(tag) {
    const s = String(tag || '').trim().replace(/_/g, '-').toLowerCase();
    if (!s) return '';
    const exact = CODES.find((c) => c.toLowerCase() === s);
    if (exact) return exact;
    const [lang, ...rest] = s.split('-');
    if (lang === 'zh') {
      // Traditional: the Hant script, or Taiwan, Hong Kong, Macau; anything else Simplified.
      return rest.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo') ? 'zh-TW' : 'zh-CN';
    }
    if (lang === 'pt') return 'pt-BR'; // the one Portuguese offered (the Brazilian, which most Portuguese apps choose)
    if (lang === 'in') return 'id'; // the old code for Indonesian, still sent by some systems
    if (lang === 'nb' || lang === 'no') return '';
    return CODES.includes(lang) ? lang : '';
  }
  // The first of the system's preferred languages that is offered, else English.
  function pick(tags) {
    for (const t of tags || []) { const n = normalize(t); if (n) return n; }
    return 'en';
  }
  // The catalog's entries for `lang` as { source: value }: the language, else English. Korean needs none.
  function table(catalog, lang) {
    const out = {};
    if (!catalog || lang === 'ko') return out;
    for (const [src, e] of Object.entries(catalog)) {
      if (!e || typeof e !== 'object') continue;
      const v = e[lang] != null ? e[lang] : e.en;
      if (v != null) out[src] = v;
    }
    return out;
  }
  const fill = (s, args) => String(s).replace(/\{(\d+)\}/g, (m, i) => (args[i] != null ? String(args[i]) : m));
  // t(source, ...args) for one language and its table (see table()); `tables` later in the list win.
  function translator(lang, ...tables) {
    const merged = Object.assign({}, ...tables.filter(Boolean));
    let rules = null;
    try { rules = new Intl.PluralRules(lang === 'ko' ? 'ko' : lang); } catch {}
    const t = (src, ...args) => {
      let v = Object.prototype.hasOwnProperty.call(merged, src) ? merged[src] : src;
      if (v && typeof v === 'object') {
        const n = Number(args[0]);
        const cat = rules && Number.isFinite(n) ? rules.select(n) : 'other';
        v = v[cat] != null ? v[cat] : v.other != null ? v.other : src;
      }
      return fill(v, args);
    };
    t.lang = lang;
    t.has = (src) => Object.prototype.hasOwnProperty.call(merged, src);
    return t;
  }
  // Text with a few tags of its own (no attributes): everything else is escaped. The catalogs are this program's;
  // this keeps a mistake in one (or a page's table from elsewhere) from becoming markup.
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]); // text that must stay text (a name)
  function safeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ESC[c]).replace(/&lt;(\/?)(b|i|kbd|small|code)&gt;|&lt;br\s*\/?&gt;/g, (m, slash, tag) => (tag ? `<${slash}${tag}>` : '<br>'));
  }
  // Elements marked in the HTML: data-i18n (the text), data-i18n-html (text with tags), data-i18n-title,
  // data-i18n-placeholder, data-i18n-aria (aria-label). The Korean source is kept on the element the first time.
  const ATTRS = [['title', 'title'], ['placeholder', 'placeholder'], ['aria', 'aria-label']];
  function apply(root, t) {
    const doc = root.ownerDocument || root;
    if (doc.documentElement) doc.documentElement.lang = t.lang;
    const each = (sel, f) => { if (root.matches && root.matches(sel)) f(root); root.querySelectorAll(sel).forEach(f); };
    each('[data-i18n]', (el) => {
      if (el.dataset.i18nSrc == null) el.dataset.i18nSrc = el.textContent.trim();
      el.textContent = t(el.dataset.i18nSrc);
    });
    each('[data-i18n-html]', (el) => {
      if (el.dataset.i18nSrcHtml == null) el.dataset.i18nSrcHtml = el.innerHTML.trim().replace(/\s+/g, ' ');
      el.innerHTML = safeHtml(t(el.dataset.i18nSrcHtml));
    });
    for (const [key, attr] of ATTRS) {
      const flag = 'i18n' + key[0].toUpperCase() + key.slice(1), keep = flag + 'Src';
      each(`[data-i18n-${key}]`, (el) => {
        if (el.dataset[keep] == null) el.dataset[keep] = el.getAttribute(attr) || '';
        if (el.dataset[keep]) el.setAttribute(attr, t(el.dataset[keep]));
      });
    }
  }
  // The flag beside each language's name (the user's wish, 2026-11-20), drawn here: no image files to ship, and no
  // emoji (Windows draws a flag emoji as two letters). Each stands for the country whose code the language carries:
  // English the United States (the translations' spelling), Traditional Chinese Taiwan (zh-TW), Portuguese Brazil.
  // viewBox 0 0 30 20, every flag fitted to 3:2 as emoji do; made by a script from each flag's construction.
  const FLAGS = {
    "ko": '<rect width="30" height="20" fill="#fff"/><g transform="rotate(33.69 15 10)"><circle cx="15" cy="10" r="5" fill="#0047A0"/><path d="M10 10a5 5 0 0 1 10 0z" fill="#CD2E3A"/><circle cx="12.5" cy="10" r="2.5" fill="#CD2E3A"/><circle cx="17.5" cy="10" r="2.5" fill="#0047A0"/><g fill="#000"><rect x="6.67" y="7.5" width="0.83" height="5"/><rect x="5.42" y="7.5" width="0.83" height="5"/><rect x="4.17" y="7.5" width="0.83" height="5"/><rect x="22.5" y="7.5" width="0.83" height="2.29"/><rect x="22.5" y="10.21" width="0.83" height="2.29"/><rect x="23.75" y="7.5" width="0.83" height="2.29"/><rect x="23.75" y="10.21" width="0.83" height="2.29"/><rect x="25" y="7.5" width="0.83" height="2.29"/><rect x="25" y="10.21" width="0.83" height="2.29"/></g></g><g transform="rotate(-33.69 15 10)" fill="#000"><rect x="22.5" y="7.5" width="0.83" height="2.29"/><rect x="22.5" y="10.21" width="0.83" height="2.29"/><rect x="23.75" y="7.5" width="0.83" height="5"/><rect x="25" y="7.5" width="0.83" height="2.29"/><rect x="25" y="10.21" width="0.83" height="2.29"/><rect x="6.67" y="7.5" width="0.83" height="5"/><rect x="5.42" y="7.5" width="0.83" height="2.29"/><rect x="5.42" y="10.21" width="0.83" height="2.29"/><rect x="4.17" y="7.5" width="0.83" height="5"/></g>',
    "en": '<rect width="30" height="20" fill="#B22234"/><rect y="1.54" width="30" height="1.54" fill="#fff"/><rect y="4.62" width="30" height="1.54" fill="#fff"/><rect y="7.69" width="30" height="1.54" fill="#fff"/><rect y="10.77" width="30" height="1.54" fill="#fff"/><rect y="13.85" width="30" height="1.54" fill="#fff"/><rect y="16.92" width="30" height="1.54" fill="#fff"/><rect width="12" height="10.77" fill="#3C3B6E"/><g fill="#fff"><circle cx="1.3" cy="1.35" r=".55"/><circle cx="3.65" cy="1.35" r=".55"/><circle cx="6" cy="1.35" r=".55"/><circle cx="8.35" cy="1.35" r=".55"/><circle cx="10.7" cy="1.35" r=".55"/><circle cx="2.48" cy="3.85" r=".55"/><circle cx="4.83" cy="3.85" r=".55"/><circle cx="7.18" cy="3.85" r=".55"/><circle cx="9.53" cy="3.85" r=".55"/><circle cx="1.3" cy="6.35" r=".55"/><circle cx="3.65" cy="6.35" r=".55"/><circle cx="6" cy="6.35" r=".55"/><circle cx="8.35" cy="6.35" r=".55"/><circle cx="10.7" cy="6.35" r=".55"/><circle cx="2.48" cy="8.85" r=".55"/><circle cx="4.83" cy="8.85" r=".55"/><circle cx="7.18" cy="8.85" r=".55"/><circle cx="9.53" cy="8.85" r=".55"/></g>',
    "ja": '<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#BC002D"/>',
    "zh-CN": '<rect width="30" height="20" fill="#EE1C25"/><g fill="#FFFF00"><polygon points="5,2 5.67,4.07 7.85,4.07 6.09,5.35 6.76,7.43 5,6.15 3.24,7.43 3.91,5.35 2.15,4.07 4.33,4.07"/><polygon points="9.14,2.51 9.62,1.97 9.25,1.34 9.91,1.63 10.39,1.08 10.33,1.8 11,2.09 10.29,2.25 10.22,2.97 9.85,2.35"/><polygon points="11.01,4.14 11.66,3.82 11.56,3.1 12.07,3.62 12.72,3.3 12.38,3.95 12.88,4.47 12.17,4.34 11.83,4.99 11.73,4.27"/><polygon points="11.04,6.73 11.76,6.7 11.96,6 12.21,6.68 12.94,6.66 12.37,7.1 12.62,7.79 12.01,7.38 11.44,7.83 11.64,7.13"/><polygon points="9.22,8.38 9.9,8.63 10.35,8.06 10.32,8.79 11,9.05 10.3,9.24 10.26,9.96 9.87,9.36 9.16,9.55 9.62,8.98"/></g>',
    "zh-TW": '<rect width="30" height="20" fill="#FE0000"/><rect width="15" height="10" fill="#000095"/><polygon points="7.5,1.25 8.01,3.08 9.38,1.75 8.91,3.59 10.75,3.13 9.42,4.49 11.25,5 9.42,5.51 10.75,6.88 8.91,6.41 9.38,8.25 8.01,6.92 7.5,8.75 6.99,6.92 5.63,8.25 6.09,6.41 4.25,6.88 5.58,5.51 3.75,5 5.58,4.49 4.25,3.12 6.09,3.59 5.62,1.75 6.99,3.08" fill="#fff"/><circle cx="7.5" cy="5" r="2.12" fill="#000095"/><circle cx="7.5" cy="5" r="1.88" fill="#fff"/>',
    "es": '<rect width="30" height="20" fill="#AA151B"/><rect y="5" width="30" height="10" fill="#F1BF00"/>',
    "fr": '<rect width="30" height="20" fill="#EF4135"/><rect width="20" height="20" fill="#fff"/><rect width="10" height="20" fill="#0055A4"/>',
    "de": '<rect width="30" height="20" fill="#FFCE00"/><rect width="30" height="13.33" fill="#DD0000"/><rect width="30" height="6.67" fill="#000"/>',
    "pt-BR": '<rect width="30" height="20" fill="#009C3B"/><polygon points="2.6,10 15,1.8 27.4,10 15,18.2" fill="#FFDF00"/><circle cx="15" cy="10" r="5.2" fill="#002776"/><path d="M10.1 8.6a10 10 0 0 1 9.75 3.3" fill="none" stroke="#fff" stroke-width=".9"/>',
    "ru": '<rect width="30" height="20" fill="#D52B1E"/><rect width="30" height="13.33" fill="#0039A6"/><rect width="30" height="6.67" fill="#fff"/>',
    "vi": '<rect width="30" height="20" fill="#DA251D"/><polygon points="15,4.6 16.35,8.75 20.71,8.75 17.18,11.31 18.53,15.45 15,12.89 11.47,15.45 12.82,11.31 9.29,8.75 13.65,8.75" fill="#FFFF00"/>',
    "id": '<rect width="30" height="20" fill="#fff"/><rect width="30" height="10" fill="#CE1126"/>',
  };
  const flagSvg = (code) => (FLAGS[code] ? `<svg class="mrFlag" viewBox="0 0 30 20" aria-hidden="true" focusable="false">${FLAGS[code]}</svg>` : '');
  const PICKER_CSS = [
    '.mrLangBtn { display: inline-flex; align-items: center; gap: 7px; font: inherit; font-size: 13px; font-weight: 400; line-height: 1.3; color: #e6e9ee; background: #1f252d; border: 1px solid #343c48; border-radius: 6px; padding: 3px 8px; margin: 0; cursor: pointer; white-space: nowrap; }',
    '.mrLangBtn:hover { background: #2a313b; } .mrLangBtn:focus-visible { outline: 2px solid #4a8dff; outline-offset: 1px; }',
    '.mrLangBtn::after { content: ""; border: 4px solid transparent; border-top-color: currentColor; margin: 4px 0 0 1px; opacity: .7; }',
    '.mrFlag { width: 21px; height: 14px; flex: none; border-radius: 2px; box-shadow: 0 0 0 1px rgba(255,255,255,.16); }',
    '.mrLangList { position: fixed; z-index: 2147483000; box-sizing: border-box; min-width: 200px; max-height: calc(100vh - 16px); overflow-y: auto; margin: 0; padding: 4px; outline: 0;',
    '  background: #1f252d; border: 1px solid #3a4350; border-radius: 8px; box-shadow: 0 10px 28px rgba(0,0,0,.5); color: #e6e9ee; font: 13.5px/1.3 var(--mr-font, sans-serif); user-select: none; }',
    '.mrLangList [role=option] { display: flex; align-items: center; gap: 9px; padding: 6px 28px 6px 10px; border-radius: 5px; cursor: pointer; white-space: nowrap; position: relative; }',
    '.mrLangList [role=option].on { background: rgba(43,108,255,.28); }',
    '.mrLangList [role=option][aria-selected=true]::after { content: "✓"; position: absolute; right: 10px; color: #8fb4ff; }',
  ].join('\n');
  // A <select> of the languages (kept, hidden, for its value and its change event: the pages' code reads those), shown
  // as a button with the flag and the language's own name that opens a list of them all. The list is the page's
  // own (a native select's list cannot show a picture): keyboard (arrows, Home/End, Enter/Space, Esc), a screen
  // reader's listbox, outside the page's toolbars (it is fixed to the window: a toolbar that scrolls would cut it).
  function fillSelect(sel, lang) {
    if (!sel.options.length) for (const l of LANGS) { const o = sel.ownerDocument.createElement('option'); o.value = l.code; o.textContent = l.name; o.lang = l.code; sel.appendChild(o); }
    sel.value = lang;
    picker(sel);
  }
  function picker(sel) {
    const doc = sel.ownerDocument, win = doc.defaultView;
    let btn = sel.mrPicker;
    if (!btn) {
      if (!doc.getElementById('mr-picker')) { const s = doc.createElement('style'); s.id = 'mr-picker'; s.textContent = PICKER_CSS; (doc.head || doc.documentElement).appendChild(s); }
      btn = sel.mrPicker = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'mrLangBtn';
      btn.setAttribute('aria-haspopup', 'listbox');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', sel.getAttribute('aria-label') || 'Language');
      sel.parentNode.insertBefore(btn, sel); // first in its label: a click on the label's 🌐 opens the list too
      sel.style.display = 'none';
      sel.tabIndex = -1;
      let list = null, active = 0;
      const items = () => (list ? [...list.children] : []);
      const mark = (i) => {
        const all = items();
        active = Math.max(0, Math.min(all.length - 1, i));
        all.forEach((o, j) => o.classList.toggle('on', j === active));
        if (all[active]) { list.setAttribute('aria-activedescendant', all[active].id); all[active].scrollIntoView({ block: 'nearest' }); }
      };
      const outside = (e) => { if (list && !list.contains(e.target) && !btn.contains(e.target)) close(false); };
      const away = () => close(false);
      const close = (focus) => {
        if (!list) return;
        list.remove();
        list = null;
        btn.setAttribute('aria-expanded', 'false');
        doc.removeEventListener('pointerdown', outside, true);
        win.removeEventListener('blur', away);
        win.removeEventListener('resize', away);
        if (focus) btn.focus();
      };
      const choose = (code) => {
        close(true);
        if (code && code !== sel.value) { sel.value = code; sel.dispatchEvent(new win.Event('change', { bubbles: true })); }
      };
      const open = () => {
        list = doc.createElement('div');
        list.className = 'mrLangList';
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', btn.getAttribute('aria-label'));
        list.tabIndex = -1;
        LANGS.forEach((l, i) => {
          const o = doc.createElement('div');
          o.id = 'mrLang-' + l.code;
          o.setAttribute('role', 'option');
          o.setAttribute('aria-selected', String(l.code === sel.value));
          o.lang = l.code;
          o.innerHTML = flagSvg(l.code) + '<span>' + esc(l.name) + '</span>';
          o.addEventListener('click', () => choose(l.code));
          o.addEventListener('pointermove', () => { if (active !== i) mark(i); });
          list.appendChild(o);
        });
        list.addEventListener('keydown', (e) => {
          const k = e.key;
          if (k === 'ArrowDown' || k === 'ArrowUp') mark(active + (k === 'ArrowDown' ? 1 : -1));
          else if (k === 'Home' || k === 'End') mark(k === 'Home' ? 0 : LANGS.length - 1);
          else if (k === 'Enter' || k === ' ') choose(LANGS[active].code);
          else if (k === 'Escape') close(true);
          else if (k === 'Tab') { close(false); return; }
          else return;
          e.preventDefault();
          e.stopPropagation();
        });
        doc.body.appendChild(list);
        // Below the button, else above it, always inside the window.
        const r = btn.getBoundingClientRect(), h = list.offsetHeight, w = list.offsetWidth;
        let top = r.bottom + 4;
        if (top + h > win.innerHeight - 8 && r.top - 4 - h >= 8) top = r.top - 4 - h;
        list.style.top = Math.max(8, Math.min(top, win.innerHeight - h - 8)) + 'px';
        list.style.left = Math.max(8, Math.min(r.left, win.innerWidth - w - 8)) + 'px';
        btn.setAttribute('aria-expanded', 'true');
        mark(Math.max(0, CODES.indexOf(sel.value)));
        list.focus();
        doc.addEventListener('pointerdown', outside, true);
        win.addEventListener('blur', away);
        win.addEventListener('resize', away);
      };
      btn.addEventListener('click', () => (list ? close(true) : open()));
      btn.addEventListener('keydown', (e) => { if (!list && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); open(); } });
      sel.mrClose = () => close(false);
    }
    const l = LANGS.find((x) => x.code === sel.value) || LANGS[0];
    btn.innerHTML = flagSvg(l.code) + '<span>' + esc(l.name) + '</span>';
    btn.lang = l.code;
  }
  // The font for each script, as a custom property every page uses (font: 14px var(--mr-font)). Han characters
  // differ in shape between Japanese, Simplified and Traditional Chinese and Korean, and a Korean font first in the
  // list drew Japanese and Chinese text in Korean shapes (and in a second font where it has no glyph).
  const FONT_CSS = [
    // Korean breaks at spaces (as printed Korean does), not inside a word; overflow-wrap still breaks one that is too long.
    ':root:lang(ko) body { word-break: keep-all; }',
    ':root { --mr-font: "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", "Noto Sans KR", sans-serif; }',
    ':root:not(:lang(ko)) { --mr-font: "Segoe UI", system-ui, "Noto Sans", "Helvetica Neue", Arial, sans-serif; }',
    ':root:lang(ja) { --mr-font: "Segoe UI", "Yu Gothic UI", "Meiryo UI", Meiryo, "Hiragino Sans", "Noto Sans CJK JP", "Noto Sans JP", sans-serif; }',
    ':root:lang(zh-CN) { --mr-font: "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", sans-serif; }',
    ':root:lang(zh-TW) { --mr-font: "Segoe UI", "Microsoft JhengHei UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC", "Noto Sans TC", sans-serif; }',
  ].join('\n');
  function fonts(doc) {
    if (doc.getElementById('mr-fonts')) return;
    const s = doc.createElement('style');
    s.id = 'mr-fonts';
    s.textContent = FONT_CSS;
    (doc.head || doc.documentElement).prepend(s);
  }
  // A translated text with tags of its own and a name in bold where it says {0} (the name stays text).
  const withName = (el, text, name) => { el.innerHTML = safeHtml(text).replace('{0}', `<b>${esc(name)}</b>`); };
  const api = { LANGS, CODES, FLAGS, flagSvg, normalize, pick, table, translator, safeHtml, esc, withName, apply, fillSelect, fonts, FONT_CSS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MRI18N = api;
})(typeof window !== 'undefined' ? window : globalThis);
