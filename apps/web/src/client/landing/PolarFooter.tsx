import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Check, ChevronUp, Globe } from 'lucide-react';
import { isLocale, localeNames, locales, localeStorageKey, type Locale } from './messages';
import './polar-footer.css';

export const footerSlogan = 'Find your next winning ad';
const copy = {
  'zh-CN': { navigation: '页脚导航', product: '产品', research: '研究', support: '支持', legal: '法律', search: '广告搜索', library: '广告资料库', pricing: '会员套餐', advertisers: '广告主研究', saved: '收藏与笔记', team: '团队工作区', guide: '使用指南', faq: '常见问题', privacy: '隐私政策', terms: '服务条款', start: '开始研究', language: '选择界面语言', home: 'AdThrender 首页' },
  'zh-TW': { navigation: '頁尾導覽', product: '產品', research: '研究', support: '支援', legal: '法律', search: '廣告搜尋', library: '廣告資料庫', pricing: '會員方案', advertisers: '廣告主研究', saved: '收藏與筆記', team: '團隊工作區', guide: '使用指南', faq: '常見問題', privacy: '隱私政策', terms: '服務條款', start: '開始研究', language: '選擇介面語言', home: 'AdThrender 首頁' },
  en: { navigation: 'Footer navigation', product: 'Product', research: 'Research', support: 'Support', legal: 'Legal', search: 'Ad search', library: 'Ad library', pricing: 'Pricing', advertisers: 'Advertiser research', saved: 'Saved ads & notes', team: 'Team workspace', guide: 'User guide', faq: 'FAQ', privacy: 'Privacy policy', terms: 'Terms of service', start: 'Start researching', language: 'Choose interface language', home: 'AdThrender home' },
  es: { navigation: 'Navegación del pie de página', product: 'Producto', research: 'Investigación', support: 'Ayuda', legal: 'Legal', search: 'Buscar anuncios', library: 'Biblioteca de anuncios', pricing: 'Planes', advertisers: 'Investigar anunciantes', saved: 'Guardados y notas', team: 'Espacio de equipo', guide: 'Guía de uso', faq: 'Preguntas frecuentes', privacy: 'Privacidad', terms: 'Términos del servicio', start: 'Empezar a investigar', language: 'Elegir idioma de la interfaz', home: 'Inicio de AdThrender' },
} as const;

function localizedPath(path: string, locale: Locale) {
  const url = new URL(path, 'https://adtrender.invalid');
  url.searchParams.set('lang', locale);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function PolarFooter({ locale = 'zh-CN', onLocaleChange }: { locale?: Locale; onLocaleChange?: (locale: Locale) => void }) {
  const language = isLocale(locale) ? locale : 'zh-CN';
  const text = copy[language];
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>(`[data-language="${language}"]`)?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, language]);

  const selectLanguage = (next: Locale) => {
    setOpen(false);
    trigger.current?.focus();
    if (onLocaleChange) onLocaleChange(next);
    else {
      try { localStorage.setItem(localeStorageKey, next); } catch { /* URL selection works without storage. */ }
      const url = new URL(window.location.href);
      url.searchParams.set('lang', next);
      window.location.assign(url.toString());
    }
  };

  const menuKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault(); setOpen(false); trigger.current?.focus(); return;
    }
    if (event.key === 'Tab') { setOpen(false); return; }
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
    if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
  };

  const groups = [
    { title: text.product, items: [[text.search, '/app/ads'], [text.library, '/app/ads'], [text.pricing, '/pricing']] },
    { title: text.research, items: [[text.advertisers, '/app/ads'], [text.saved, '/app/research'], [text.team, '/app']] },
    { title: text.support, items: [[text.guide, '/help'], [text.faq, '/help']] },
    { title: text.legal, items: [[text.privacy, '/privacy'], [text.terms, '/terms']] },
  ];

  return <footer className="polar-footer" data-adtrender-polar-footer="true" lang={language}>
    <div className="polar-footer__content">
      <div className="polar-footer__main">
        <div className="polar-footer__identity">
          <a className="polar-footer__brand" href={localizedPath('/', language)} aria-label={text.home}>
            <img src="/homepage-assets/polar-mark.svg" width="60" height="56" alt="" />
            <span>AdThrender</span>
          </a>
          <p className="polar-footer__slogan" lang="en">{footerSlogan}</p>
        </div>
        <nav className="polar-footer__navigation" aria-label={text.navigation}>
          {groups.map(group => <div className="polar-footer__group" key={group.title}>
            <h2>{group.title}</h2>
            <ul>{group.items.map(([label, path]) => <li key={label}><a href={localizedPath(path, language)}>{label}</a></li>)}</ul>
          </div>)}
        </nav>
      </div>
      <div className="polar-footer__meta">
        <small>© {new Date().getFullYear()} AdThrender</small>
        <a className="polar-footer__start" href={localizedPath('/app/ads', language)}>{text.start}<ArrowUpRight size={19} aria-hidden="true" /></a>
      </div>
    </div>
    <img className="polar-footer__panorama" src="/homepage-assets/antarctic-panorama.webp" width="2132" height="737" alt="" loading="lazy" decoding="async" />
    <div className="polar-footer__language" ref={picker}>
      <button ref={trigger} className="polar-footer__language-trigger" type="button" aria-label={text.language} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
      }}><Globe size={21} aria-hidden="true" /><span lang={language}>{localeNames[language]}</span><ChevronUp size={16} aria-hidden="true" /></button>
      {open && <ul id={menuId} ref={menu} className="polar-footer__language-menu" role="menu" aria-label={text.language} onKeyDown={menuKey}>
        {locales.map(value => <li role="none" key={value}><button type="button" role="menuitemradio" aria-checked={value === language} lang={value} data-language={value} tabIndex={-1} onClick={() => selectLanguage(value)}>{localeNames[value]}{value === language && <Check size={16} aria-hidden="true" />}</button></li>)}
      </ul>}
    </div>
  </footer>;
}
