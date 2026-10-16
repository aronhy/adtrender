/** Source-native repository IDs stay exact strings, including HEX letter case. */
export function isPinterestAdId(value:unknown):value is string {
 return typeof value==='string'&&/^(?:[0-9]+|[A-Fa-f0-9]{64})$/.test(value);
}
/** Only the repository's fixed, relative ad-detail path is an identity source. */
export function pinterestAdIdFromPath(href:string):string|null {
 const match=/^\/ads-repository\/([^/]+)\/$/.exec(href);
 return match&&isPinterestAdId(match[1])?match[1]:null;
}
export interface PinterestCard {
 sourceAdId:string;sourceUrl:string;advertiserName:string;headline:string;body:string|null;bodyTruncated:boolean;
 media:Array<{url:string;type:'IMAGE'|'VIDEO'}>;
}
/** Complete MP4 shape exposed by a public Pinterest Pin and verified on its CDN. */
export function pinterestVideoUrl(value:string):string|null {
 try{const u=new URL(value);return value.startsWith('https://v.pinimg.com/')&&!/[\\\u0000-\u0020]/.test(value)&&!u.hash&&u.origin==='https://v.pinimg.com'&&/^\/videos\/mc\/[0-9]+p\/([a-f0-9]{2}\/){3}[a-f0-9]{32}[.]mp4$/.test(u.pathname)?u.href:null;}catch{return null;}
}
/** Read only media elements already present in this ad's public DOM. */
export function parsePinterestMedia(root:ParentNode):PinterestCard['media'] {
 const media:PinterestCard['media']=[];
 for(const img of Array.from(root.querySelectorAll('img[alt="Ad image"]'))){const url=img.getAttribute('src');if(url&&/^https:\/\/i\.pinimg\.com\//.test(url)&&!media.some(m=>m.url===url))media.push({url,type:'IMAGE'});}
 for(const node of Array.from(root.querySelectorAll('video[src],video source[src]'))){const url=pinterestVideoUrl(node.getAttribute('src')??'');if(url&&!media.some(m=>m.url===url))media.push({url,type:'VIDEO'});}
 return media;
}
/** Selectors come from the public Ads Repository, observed 2026-10-07. */
export function parsePinterestCards(doc:Document):PinterestCard[] {
 const cards:PinterestCard[]=[];
 for(const link of Array.from(doc.querySelectorAll('a[href]'))) {
  const href=link.getAttribute('href')??'';
  const id=pinterestAdIdFromPath(href);if(id===null)continue;
  const root=link.parentElement;if(!root||root.querySelectorAll('a[href*="/ads-repository/"]').length!==1)continue;
  const titles=Array.from(root.querySelectorAll('[title]')).map(e=>e.getAttribute('title')?.trim()??'').filter(Boolean);
  if(titles.length<2||cards.some(a=>a.sourceAdId===id))continue;
  const media=parsePinterestMedia(root);
  cards.push({sourceAdId:id,sourceUrl:`https://ads.pinterest.com/ads-repository/${id}/`,advertiserName:titles[0],headline:titles[1],body:titles[2]??null,bodyTruncated:/…|\.\.\.$/.test(titles[2]??''),media});
 }
 return cards;
}
export function pinterestParserRuntimeSource(){return 'const __name=f=>f;'+[isPinterestAdId,pinterestAdIdFromPath,pinterestVideoUrl,parsePinterestMedia,parsePinterestCards,parsePinterestDetails].map(f=>f.toString()).join('\n');}
export function parsePinterestDetails(doc:Document):Record<string,string> {
 const fields:Record<string,string>={};
 for(const heading of Array.from(doc.querySelectorAll('[data-test-id="ad-details-content"] h2'))) {
  const value=heading.parentElement?.nextElementSibling;
  const key=heading.textContent?.trim();
  if(key&&value)fields[key]=(value.getAttribute('title')??value.textContent??'').trim();
 }
 return fields;
}
