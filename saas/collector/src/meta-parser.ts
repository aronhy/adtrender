import type { ParsedAd, ParsedMedia } from '../../contracts/src/collection';
export const META_PARSER_VERSION = 'meta-dom-1';
export type MetaPageState = 'ready' | 'no-results' | 'challenge' | 'login-required' | 'unknown';
export interface MetaParseResult { ads: ParsedAd[]; observedCardCount: number; rejectedCardCount: number }

export interface MetaEmbeddedAdvertiser { sourceAdId: string; pageId: string; pageName: string | null; pageProfileUri: string | null; advertiserAvatarUrl?: string }
export interface MetaEmbeddedResult { advertisers: MetaEmbeddedAdvertiser[]; resultCount: number | null }

/** Self-contained: serialized into a Playwright page; no imported runtime helpers.
 *  Reads the listing payload the page already ships. It carries the numeric
 *  page_id even when the rendered advertiser link is a custom handle, so the
 *  advertiser lane no longer depends on the href shape. Nothing here issues a
 *  request; absent or changed payloads simply yield no records. */
export function parseMetaEmbeddedAdvertisers(root: Document): MetaEmbeddedResult {
  const blob = [...root.querySelectorAll('script')]
    .map(node => node.textContent ?? '')
    .filter(text => text.includes('ad_archive_id') || text.includes('search_results_connection'))
    .join('\n');
  const unescape = (value: string): string => value.replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const count = blob.match(/"search_results_connection"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
  const advertisers = new Map<string, MetaEmbeddedAdvertiser>();
  const chunks = blob.split('"ad_archive_id"');
  for (let index = 1; index < chunks.length; index++) {
    const chunk = chunks[index].slice(0, 4000);
    const sourceAdId = chunk.match(/^\s*:\s*"(\d{5,})"/)?.[1];
    const pageId = chunk.match(/"page_id"\s*:\s*"(\d{5,})"/)?.[1];
    if (!sourceAdId || !pageId || advertisers.has(sourceAdId)) continue;
    const pageName = chunk.match(/"page_name"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    const pageProfileUri = chunk.match(/"page_profile_uri"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    const picture = chunk.match(/"page_profile_picture_(?:url|uri)"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    let advertiserAvatarUrl: string | undefined;
    if (picture) try {
      const url = new URL(JSON.parse(`"${picture}"`));
      if (url.protocol === 'https:' && !url.username && !url.password) advertiserAvatarUrl = url.href;
    } catch { /* Missing or malformed source avatars remain unavailable. */ }
    advertisers.set(sourceAdId, {
      sourceAdId,
      pageId,
      pageName: pageName ? unescape(pageName) : null,
      pageProfileUri: pageProfileUri ? unescape(pageProfileUri) : null,
      ...(advertiserAvatarUrl ? { advertiserAvatarUrl } : {}),
    });
  }
  return { advertisers: [...advertisers.values()], resultCount: count ? Number(count[1]) : null };
}

export function classifyMetaPage(text: string): MetaPageState {
  if (/Security Check|安全检查|captcha|checkpoint|Enter the code from your image/i.test(text)) return 'challenge';
  if (/Log in to Facebook|登录 Facebook|登录以继续|Log in to continue/i.test(text)) return 'login-required';
  if (/资料库编号|Library ID/i.test(text)) return 'ready';
  if (/没有符合搜索条件的广告|No ads match your search criteria|No results found/i.test(text)) return 'no-results';
  return 'unknown';
}

/** Self-contained: serialized into a Playwright page; no imported runtime helpers. */
export function parseMetaDocument(root: Document, queryCountry: string): MetaParseResult {
  const markerPattern = /(?:资料库编号|Library ID)\s*[：:]\s*(\d{5,})\b/i;
  const clean = (value: string | null | undefined): string | null => value?.trim() || null;
  const safeUrl = (value: string | null | undefined): string | null => {
    if (!value) return null;
    try {
      let url = new URL(value);
      if (url.hostname === 'l.facebook.com' && url.pathname === '/l.php') {
        const target = url.searchParams.get('u');
        if (!target) return null;
        url = new URL(target);
      }
      if (!['https:','http:'].includes(url.protocol) || url.username || url.password) return null;
      return url.toString();
    } catch { return null; }
  };
  const date = (value: string | undefined): string | null => {
    if (!value) return null;
    let y: number, m: number, d: number;
    const zh = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    const en = value.match(/(?:Started running on|Stopped running on|Ended on)\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (zh) { y=Number(zh[1]);m=Number(zh[2]);d=Number(zh[3]); }
    else if (en) { y=Number(en[3]);m=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(en[1].slice(0,3).toLowerCase())+1;d=Number(en[2]); }
    else return null;
    const dt=new Date(Date.UTC(y,m-1,d));
    return y>=1900 && m>=1 && m<=12 && dt.getUTCFullYear()===y && dt.getUTCMonth()===m-1 && dt.getUTCDate()===d ? dt.toISOString().slice(0,10) : null;
  };
  const labelPattern = /(?:资料库编号|Library ID)\s*[：:]/i;
  const markers = [...root.querySelectorAll('span')].filter(node=>labelPattern.test(node.textContent??'') && ![...node.querySelectorAll('span')].some(child=>labelPattern.test(child.textContent??'')));
  const ads = new Map<string, ParsedAd>();
  let rejectedCardCount=0;
  for (const marker of markers) {
    const sourceAdId=marker.textContent?.match(markerPattern)?.[1];
    if (!sourceAdId) {rejectedCardCount++;continue;}
    let card:Element=marker.parentElement??marker;
    while (card.parentElement && !['BODY','HTML'].includes(card.parentElement.tagName) && markers.filter(item=>card.parentElement!.contains(item)).length===1) card=card.parentElement;
    const lines = [...card.querySelectorAll<HTMLElement>('div,span,strong,a')].filter(node=>!node.querySelector('div,span,strong,a')).map(node=>clean(node.innerText||node.textContent)).filter((line):line is string=>Boolean(line));
    const statusText=lines.find(line=>/^(?:投放中|已停止|停止投放|active|inactive)(?:\s|$)/i.test(line))??null;
    const status=/已停止|停止投放|\binactive\b/i.test(statusText??'')?'inactive':/投放中|\bactive\b/i.test(statusText??'')?'active':'unknown';
    const anchors=[...card.querySelectorAll<HTMLAnchorElement>('a[href]')];
    const avatar=[...card.querySelectorAll<HTMLImageElement>('img[alt]')].find(img=>clean(img.alt) && img.width<180);
    const nameAnchor=anchors.find(anchor=>clean(anchor.textContent) && !anchor.querySelector('img,video'));
    const advertiserName=clean(avatar?.alt)??clean(nameAnchor?.textContent);
    const avatarUrl=safeUrl(avatar?.currentSrc||avatar?.getAttribute('src'));
    const advertiserAvatarUrl=avatarUrl?.startsWith('https:')?avatarUrl:null;
    const pageAnchor=anchors.find(anchor=>clean(anchor.textContent)===advertiserName && advertiserName!==null);
    const advertiserPageUrl=safeUrl(pageAnchor?.getAttribute('href'));
    const copyNode=card.querySelector<HTMLElement>('[style*="white-space: pre-wrap"],[style*="white-space:pre-wrap"]');
    const body=clean(copyNode?.innerText||copyNode?.textContent);
    const content=card.querySelector('[data-testid="ad-library-dynamic-content-container"]')??card;
    const meta=/(?:资料库编号|Library ID|开始投放|Started running|停止投放|Stopped running|Ended on|投放中|已停止|\bactive\b|\binactive\b|赞助内容|Sponsored)/i;
    const controls=/^(?:\d+:\d{2}|播放|暂停|静音|取消静音|打开下拉菜单|查看广告详情|查看更多|广告选项|play|pause|mute|unmute|see ad details|view ad details|see more|ad options|platforms|EU transparency|This ad has multiple versions|See summary details|投放平台|平台)$/i;
    const texts=[...content.querySelectorAll<HTMLElement>('div,span,strong')].filter(node=>!node.querySelector('div,span,strong,img,video')).map(node=>clean(node.innerText||node.textContent)).filter((line):line is string=>Boolean(line) && line!==body && line!==advertiserName && !meta.test(line!) && !controls.test(line!));
    const unique=[...new Set(texts)];
    const cta=unique.find(line=>/^(?:shop now|learn more|contact us|send message|send whatsapp message|get quote|sign up|subscribe|apply now|book now|download|watch more|order now|buy now|see menu|call now|get offer|whatsapp|立即购买|了解更多|联系我们|发送消息|获取报价|注册|下载|预订)$/i.test(line))??null;
    const displayUrl=unique.find(line=>/^(?:https?:\/\/)?(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?:\/\S*)?$/u.test(line))??null;
    const headline=unique.find(line=>line!==cta&&line!==displayUrl&&line.length>=3&&line.length<=160)??null;
    const description=unique.find(line=>line!==cta&&line!==displayUrl&&line!==headline&&line.length>=3&&line.length<=240)??null;
    const media:ParsedMedia[]=[];
    for (const node of card.querySelectorAll<HTMLImageElement|HTMLVideoElement>('img,video')) {
      if(node===avatar)continue;
      const type=node.tagName==='VIDEO'?'video':'image';
      if(type==='image' && (node as HTMLImageElement).width<180 && (node as HTMLImageElement).naturalWidth<180)continue;
      const url=safeUrl(node.currentSrc||node.getAttribute('src')||(type==='video'?node.querySelector('source')?.getAttribute('src'):null));
      if(!url || media.some(item=>item.url===url))continue;
      media.push({type,url,posterUrl:type==='video'?safeUrl((node as HTMLVideoElement).poster):null});
    }
    const landing=anchors.find(anchor=>anchor.querySelector('img,video') && anchor!==pageAnchor)??anchors.find(anchor=>anchor.getAttribute('href')?.includes('l.facebook.com/l.php') && anchor!==pageAnchor);
    const platformText=[...card.querySelectorAll('[aria-label],[title]')].flatMap(node=>[node.getAttribute('aria-label'),node.getAttribute('title')]).filter(Boolean).join(' ');
    const platforms=['Facebook','Instagram','Messenger','Audience Network'].filter(platform=>new RegExp(`\\b${platform.replace(' ','\\s+')}\\b`,'i').test(platformText));
    const ad:ParsedAd={source:'meta',sourceAdId,sourceUrl:`https://www.facebook.com/ads/library/?id=${sourceAdId}`,advertiserName,advertiserPageUrl,advertiserAvatarUrl,body,headline,description,displayUrl,cta,landingPageUrl:safeUrl(landing?.getAttribute('href')),status,sourceStatusText:statusText,startDate:date(lines.find(line=>/开始投放|Started running/i.test(line))),endDate:date(lines.find(line=>/停止投放|Stopped running|Ended on/i.test(line))),platforms:platforms.length?platforms:null,queryCountry,media};
    const previous=ads.get(sourceAdId);
    if(previous) {
      previous.media.push(...media.filter(item=>!previous.media.some(existing=>existing.url===item.url)));
      for(const key of ['advertiserName','advertiserPageUrl','advertiserAvatarUrl','body','headline','description','displayUrl','cta','landingPageUrl','sourceStatusText','startDate','endDate'] as const) if(previous[key]==null)previous[key]=ad[key]??null;
      if(previous.status==='unknown')previous.status=ad.status;
      if(ad.platforms)previous.platforms=[...new Set([...(previous.platforms??[]),...ad.platforms])];
    } else ads.set(sourceAdId,ad);
  }
  return {ads:[...ads.values()],observedCardCount:markers.length,rejectedCardCount};
}
