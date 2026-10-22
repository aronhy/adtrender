import type { AdView } from '../types';
import { customerAdOriginUrl, customerLandingUrl } from './customer-ad-origin';

const cell=(value:unknown)=>{const text=String(value??'');return '"'+(/^[=+\-@\t\r]/.test(text)?"'":'')+text.replace(/"/g,'""')+'"';};
export function studioAdsCsv(ads:AdView[]):string {
  const rows=[['素材编号','广告主','标题','文案','渠道','投放状态','首次收录','最近观测','广告原帖','落地页'],...ads.map(ad=>[ad.id,ad.advertiserName,ad.headline,ad.copy,(ad.publisherPlatforms||[]).join(' / '),ad.status,ad.firstObservedAt?new Date(ad.firstObservedAt).toISOString():'',ad.lastObservedAt?new Date(ad.lastObservedAt).toISOString():'',customerAdOriginUrl(ad),customerLandingUrl(ad.landingPageUrl)])];
  return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
