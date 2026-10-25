// Source copied verbatim from the approved HTML prototype. See provenance.json.
export default function initialize(window, document, location, requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout) {
// BEGIN APPROVED SOURCE
/* Motion layer: only reacts to the visitor's actions (filtering, calculating, errors). */
(() => {
  'use strict';
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ease = 'cubic-bezier(.2,.75,.25,1)';
  let lastCards = 0;

  function indicator(instant) {
    const bar = document.querySelector('.category-bar');
    const active = bar && bar.querySelector('.category-button.active');
    if (!bar || !active) return;
    let line = bar.querySelector('.category-indicator');
    if (!line) {
      line = document.createElement('span');
      line.className = 'category-indicator';
      line.setAttribute('aria-hidden', 'true');
      bar.append(line);
      instant = true;
    }
    if (instant || reduce()) line.classList.remove('is-ready');
    line.style.width = active.offsetWidth + 'px';
    line.style.transform = `translateX(${active.offsetLeft}px)`;
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => line.classList.add('is-ready')));
    const r = active.getBoundingClientRect(), b = bar.getBoundingClientRect();
    if (r.left < b.left || r.right > b.right) active.scrollIntoView({block: 'nearest', inline: 'center', behavior: reduce() ? 'auto' : 'smooth'});
  }

  function directory(root) {
    indicator(false);
    if (!root || reduce()) return;
    const now = performance.now();
    const quick = now - lastCards < 260; // typing in search: no stagger
    lastCards = now;
    root.querySelectorAll('.tool-card, .no-results, .filtered-label').forEach((el, i) => {
      el.animate(
        [{opacity: 0, transform: 'translateY(8px)'}, {opacity: 1, transform: 'none'}],
        {duration: quick ? 160 : 320, delay: quick ? 0 : Math.min(i, 9) * 32, easing: ease, fill: 'backwards'}
      );
    });
  }

  function countUp(node) {
    const text = node.nodeValue;
    if (/[<>]/.test(text)) return;
    const match = text.match(/-?[\d,]*\d(\.\d+)?/);
    if (!match) return;
    const target = Number(match[0].replace(/,/g, ''));
    if (!Number.isFinite(target) || target === 0) return;
    const decimals = match[1] ? match[1].length - 1 : 0;
    const grouped = match[0].includes(',') || Math.abs(target) >= 1000;
    const fmt = v => v.toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped});
    const before = text.slice(0, match.index), after = text.slice(match.index + match[0].length);
    const start = performance.now(), duration = 560;
    const step = t => {
      const p = Math.min(1, (t - start) / duration), k = 1 - Math.pow(1 - p, 3);
      node.nodeValue = before + fmt(target * k) + after;
      if (p < 1) requestAnimationFrame(step); else node.nodeValue = text;
    };
    requestAnimationFrame(step);
  }

  function result(panel) {
    if (!panel || reduce()) return;
    panel.querySelectorAll('.primary-number, .metric-value').forEach(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) if (/\d/.test(n.nodeValue)) { countUp(n); break; }
    });
    panel.querySelectorAll('.metric, .hook-row, .destination-card, .parameter-row').forEach((el, i) => {
      el.animate([{opacity: 0, transform: 'translateY(6px)'}, {opacity: 1, transform: 'none'}],
        {duration: 300, delay: 80 + Math.min(i, 9) * 35, easing: ease, fill: 'backwards'});
    });
  }

  function nudge(field) {
    if (!field || reduce()) return;
    field.animate([{transform: 'translateX(0)'}, {transform: 'translateX(-5px)'}, {transform: 'translateX(4px)'}, {transform: 'translateX(-2px)'}, {transform: 'translateX(0)'}],
      {duration: 320, easing: 'ease-out'});
  }

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => indicator(true), 80); });
  document.fonts?.ready.then(() => indicator(true));

  window.FreeMotion = {directory, result, nudge, indicator};
})();

// END APPROVED SOURCE
}
