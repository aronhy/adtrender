// Source copied verbatim from the approved HTML prototype. See provenance.json.
export default function initialize(window, document, location, requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout) {
// BEGIN APPROVED SOURCE
/* Local SVG rendering. Source geometry belongs to the original icon authors;
 * attribution and licenses are kept under assets/icons/. */
(() => {
  'use strict';
  const toolNames = {
    chart:'chart-line-up',profit:'wallet',percent:'percent',roi:'trend-up',
    users:'users-three',shop:'storefront',target:'target',traffic:'funnel',
    budget:'calculator',spark:'lightning',library:'browsers',link:'link-simple',
    privacy:'shield-check',refund:'arrow-u-up-left',terms:'file-text',
    returns:'arrows-counter-clockwise',shipping:'truck'
  };
  const operationNames = {
    arrow:'arrow-right',chevron:'caret-down',search:'magnifying-glass',
    copy:'copy',reset:'arrow-counter-clockwise',shield:'shield-check',
    calc:'calculator',info:'info',check:'check',external:'arrow-square-out',
    clock:'clock',menu:'list',close:'x','chevron-right':'caret-right',
    'brand-meta':'meta-logo','brand-google':'google-logo',
    'brand-tiktok':'tiktok-logo','brand-pinterest':'pinterest-logo'
  };
  const escapeAttribute=value=>String(value).replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));
  function decorate(svg,className='') {
    if(!svg) return '';
    return svg.replace(/<svg\b([^>]*)>/,(_,attributes)=>{
      attributes=attributes.replace(/\s(?:width|height|class|aria-hidden|focusable)\s*=\s*(["']).*?\1/g,'');
      return `<svg${attributes} width="24" height="24" class="icon ${escapeAttribute(className)}" aria-hidden="true" focusable="false">`;
    });
  }
  function render(name,{className='',weight}={}) {
    const assets=window.FreeIconAssets;
    if(!assets)return '';
    const isTool=Object.hasOwn(toolNames,name);
    const chosenWeight=weight||(isTool?'duotone':'regular');
    const iconName=toolNames[name]||operationNames[name]||'calculator';
    const family=chosenWeight==='duotone'?'phosphorDuotone':'phosphorRegular';
    const svg=assets[family]?.[iconName]||assets.phosphorRegular?.[iconName];
    return decorate(svg,`icon-${chosenWeight} ${className}`.trim());
  }
  window.FreeIcons=Object.freeze({render,decorate,toolNames,operationNames});
  document.querySelectorAll('[data-ui-icon]').forEach(element=>{
    element.innerHTML=render(element.dataset.uiIcon);
  });
})();

// END APPROVED SOURCE
}
