import type { TikTokAd } from './types';

// These DOM readers are serialized into an anonymous browser. Keep each self-contained.
export function parseListing(doc: Document): Array<{id: string; url: string}> {
  const results = new Map<string, {id: string; url: string}>();
  for (const a of doc.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.getAttribute('href')!, 'https://library.tiktok.com');
      const id = u.searchParams.get('ad_id');
      if (u.origin === 'https://library.tiktok.com' && /^\/ads\/detail\/?$/.test(u.pathname) && id && /^\d{5,}$/.test(id)) {
        results.set(id, {id, url: `https://library.tiktok.com/ads/detail/?ad_id=${id}`});
      }
    } catch { /* Non-URL public links are not ad identities. */ }
  }
  return [...results.values()];
}

export function parseDetail(doc: Document, sourceUrl: string, observedAt: string): TikTokAd {
  const text = doc.body?.textContent ?? '';
  const sourceAdId = text.match(/Ad ID\s*[:：]\s*(\d{5,})/)?.[1];
  const requestedId = new URL(sourceUrl).searchParams.get('ad_id');
  if (!sourceAdId || sourceAdId !== requestedId) throw Error('TIKTOK_DETAIL_ID_MISMATCH');
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const sourceFields: Record<string,string> = {};
  for (const li of doc.querySelectorAll('.ad_detail_summary_container .ad_detail_module_item')) {
    const key = norm(li.querySelector('.item_title')?.textContent).replace(/[:：]$/, '').trim();
    if (key) sourceFields[key] = norm(li.querySelector('.item_value')?.textContent);
  }
  for (const label of ['Advertiser', 'Ad paid for by', "Advertiser's registered location", 'Ad caption', 'Call to action', 'External website linked']) {
    const el = [...doc.querySelectorAll('div,span,h2,h3')].find(e => norm(e.textContent) === label && ![...e.children].some(c => norm(c.textContent) === label));
    if (!el) continue;
    // Caption wraps a tooltip together with its label; the value is after that wrapper.
    const root = el.parentElement && norm(el.parentElement.textContent) === label ? el.parentElement : el;
    let next = root.nextSibling;
    while (next && !norm(next.textContent)) next = next.nextSibling;
    if (next) sourceFields[label] = norm(next.textContent);
  }
  const optional = (value: string | undefined) => !value || value === '-' ? null : value;
  const advertiserName = optional(sourceFields.Advertiser);
  const date = (value: string | undefined) => {
    const m = value?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const iso = `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0,10) === iso ? iso : null;
  };
  const firstShown = date(sourceFields['First shown']), lastShown = date(sourceFields['Last shown']);
  if (!advertiserName || !firstShown || !lastShown) throw Error('TIKTOK_DETAIL_INCOMPLETE');
  let sourceAdvertiserId: string | null = null;
  for (const a of doc.querySelectorAll('a[href]')) {
    if (norm(a.textContent) !== 'See all ads') continue;
    const u = new URL(a.getAttribute('href')!, 'https://library.tiktok.com');
    const id = u.searchParams.get('adv_biz_ids');
    if (u.origin === 'https://library.tiktok.com' && u.pathname === '/ads' && id && /^\d+$/.test(id)) sourceAdvertiserId = id;
  }
  const countryNames = new Map<string,string>();
  const names = new Intl.DisplayNames(['en'], {type:'region'});
  for (const code of 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH TR GB'.split(' ')) countryNames.set(names.of(code)!, code);
  countryNames.set('Türkiye','TR'); countryNames.set('Turkey','TR'); countryNames.set('Czech Republic','CZ');countryNames.set('Slovak','SK');
  const countries = new Set<string>();
  for (const container of doc.querySelectorAll('.targeting-table-container')) {
    if (!/Reach by location, age and gender/.test(container.querySelector('h2')?.textContent??'')) continue;
    for (const row of container.querySelector('table')?.querySelectorAll('tbody tr')??[]) {
      const code=countryNames.get(norm(row.querySelector('td')?.textContent)); if(code) countries.add(code);
    }
  }
  // Older details have a separate Location table, identified by reach columns.
  if(!countries.size)for(const table of doc.querySelectorAll('table')){
    const headers=[...table.querySelectorAll('thead th')].map(e=>norm(e.textContent));
    const countryIndex=headers.indexOf('Country');
    if(countryIndex<0||!headers.includes('Unique users seen'))continue;
    for(const row of table.querySelectorAll('tbody tr')){const code=countryNames.get(norm(row.querySelectorAll('td')[countryIndex]?.textContent));if(code)countries.add(code);}
  }
  const media: TikTokAd['media'] = [];
  const avatarUrls = new Set<string>();
  for (const el of doc.querySelectorAll('video, video source, img')) {
    const src = el.getAttribute('src'); if (!src) continue;
    try {
      const u = new URL(src, 'https://library.tiktok.com');
      // Observed advertiser avatars use this bucket or the 168px profile crop.
      // Keep other creative image paths on the same CDN eligible.
      if (el.tagName === 'IMG') {
        const imagePath = decodeURIComponent(u.pathname);
        if (imagePath.includes('/tos-alisg-avt-0068/')
          || /(?:^|[-~:/])cropcenter:168:168(?:[./~:-]|$)/.test(imagePath)) {
          if (u.protocol === 'https:' && !u.username && !u.password && /(^|\.)tiktokcdn(?:-(?:us|eu))?\.com$/.test(u.hostname)) avatarUrls.add(u.href);
          continue;
        }
      }
      // Only the public media proxy observed in the library DOM is supported here.
      const libraryMedia=u.origin==='https://library.tiktok.com'&&u.pathname.startsWith('/api/v1/cdn/');
      const observedImage=el.tagName==='IMG'&&u.origin==='https://p16-common-sign.tiktokcdn.com';
      if (!libraryMedia&&!observedImage) continue;
      const type = el.tagName === 'IMG' ? 'IMAGE' as const : 'VIDEO' as const;
      if (!media.some(m => m.url === u.href)) media.push({url:u.href,type});
    } catch { /* blob and invalid sources are not durable public media URLs. */ }
  }
  let landingPageUrl: string | null = null;
  const external = optional(sourceFields['External website linked']);
  if (external) try {const u=new URL(external);if (['https:','http:'].includes(u.protocol)) landingPageUrl=u.href;} catch { /* Unknown stays unknown. */ }
  const advertiserAvatarUrl = avatarUrls.size === 1 ? [...avatarUrls][0] : null;
  return {sourceAdId, sourceUrl:`https://library.tiktok.com/ads/detail/?ad_id=${sourceAdId}`, advertiserName, advertiserAvatarUrl, sourceAdvertiserId, body:optional(sourceFields['Ad caption']), headline:null, cta:optional(sourceFields['Call to action']), landingPageUrl, firstShown, lastShown, reportedCountries:[...countries], media, sourceFields, observedAt};
}

export function sanitizeEvidence(doc: Document) {
  const body = doc.body?.cloneNode(true) as HTMLElement | undefined;
  if (!body) return {html:'',text:''};
  body.querySelectorAll('script,style,noscript,iframe,input,textarea,svg').forEach(e=>e.remove());
  body.querySelectorAll('*').forEach(e=>{for(const a of [...e.attributes]) if(!['href','src','alt','title','role','aria-label','aria-disabled','data-testid'].includes(a.name))e.removeAttribute(a.name);});
  return {html:body.outerHTML,text:body.textContent?.trim()??''};
}

export function classifyPage(input: {status:number|null;text:string;count:number;loading:boolean}) {
  if (input.status === 429) return 'RATE_LIMITED';
  if (input.status === 403) return 'ACCESS_BLOCKED';
  if (input.status !== null && input.status >= 400) return 'HTTP_ERROR';
  if (/verify you are human|complete the captcha|security check|captcha verification/i.test(input.text)) return 'CHALLENGE';
  if (/log in to continue|login required|sign in to continue/i.test(input.text)) return 'LOGIN_REQUIRED';
  if (input.loading) return 'LOADING';
  if (input.count > 0) return 'READY';
  if (/No ads found|No results found|No ads match your search/i.test(input.text)) return 'EMPTY';
  return 'LOADING';
}

export function readRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/[A-Za-z]{3},/.test(value)) return;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0,date-now);
}
