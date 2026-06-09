// Pre-paint theme resolver. Rendered into <head> as a raw, parser-blocking
// inline <script> so it runs synchronously before first paint — no flash.
//
// Resolves the active theme and stamps [data-theme] / [data-theme-pref] on
// <html>: a stored choice ('light' | 'dark') wins, otherwise it follows the OS
// ('system' — the default). Exposes window.BaselineTheme and fires a
// 'baseline-theme-change' CustomEvent on document after any change so React UI
// (e.g. the toggle) can reflect the current theme. Sourced verbatim from the
// design handoff's theme-toggle.js.
const THEME_SCRIPT = `(function () {
  var KEY = 'baseline-theme';
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var animTimer;
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function pref() { return stored() || 'system'; }
  function resolve(p) { return (p === 'dark' || p === 'light') ? p : (mq.matches ? 'dark' : 'light'); }
  function apply(animate) {
    var p = pref();
    var active = resolve(p);
    var root = document.documentElement;
    // Enable the cross-fade only for an explicit/OS change — never first paint —
    // so unrelated runtime color changes don't animate. CSS keys off the attr.
    if (animate) {
      root.setAttribute('data-theme-animating', '');
      if (animTimer) clearTimeout(animTimer);
      animTimer = setTimeout(function () { root.removeAttribute('data-theme-animating'); }, 280);
    }
    root.setAttribute('data-theme', active);
    root.setAttribute('data-theme-pref', p);
    try {
      document.dispatchEvent(new CustomEvent('baseline-theme-change', { detail: { pref: p, resolved: active } }));
    } catch (e) {}
  }
  apply(false);
  var onMq = function () { if (pref() === 'system') apply(true); };
  if (mq.addEventListener) mq.addEventListener('change', onMq);
  else if (mq.addListener) mq.addListener(onMq);
  window.BaselineTheme = {
    get: function () { return pref(); },
    resolved: function () { return resolve(pref()); },
    set: function (p) {
      try {
        if (p === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, p);
      } catch (e) {}
      apply(true);
    },
    toggle: function () { this.set(this.resolved() === 'dark' ? 'light' : 'dark'); },
  };
})();`;

// The app sets a strict, nonce-based CSP (script-src 'nonce-…' 'strict-dynamic'),
// so this inline script only executes if it carries the per-request nonce minted
// in proxy.ts. The layout reads it from the x-nonce header and passes it in.
export function ThemeScript({ nonce }: { nonce?: string }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
