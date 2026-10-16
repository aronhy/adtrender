import {describe,it,expect} from 'vitest';
import {validatePinterestBatch} from './import';
const batch=()=>({version:'pinterest-public-dom-1',sourceKey:'pinterest_ads_repository',platform:'PINTEREST',observedAt:'2026-10-07T08:00:00Z',query:{keyword:'Nike',country:'DE',limit:1},status:'SUCCEEDED',errorCode:null,ads:[{sourceAdId:'4600427147308611200',sourceUrl:'https://ads.pinterest.com/ads-repository/4600427147308611200/',advertiserName:'Nike',headline:'Polo',body:null,bodyTruncated:false,media:[],observedAt:'2026-10-07T08:00:00Z',reportedCountries:['DE'],sourceFields:{'Advertiser name':'Nike'},rawText:'Nike',rawHtml:'<div>Nike</div>'}],evidence:[{url:'https://ads.pinterest.com/ads-repository/4600427147308611200/',httpStatus:200,text:'Nike',html:'<div>Nike</div>'}],diagnostics:[],coverage:{complete:false,observedCards:1,selected:1}});
describe('Pinterest import validation',()=>{
 it('accepts HEX64 with exact detail evidence while preserving case',()=>{
  const b=batch(),id='Ab'.repeat(32),url=`https://ads.pinterest.com/ads-repository/${id}/`;
  b.ads[0].sourceAdId=id;b.ads[0].sourceUrl=url;b.evidence[0].url=url;
  expect(()=>validatePinterestBatch(b)).not.toThrow();
 });
 it('rejects malformed HEX identity and mismatched HEX detail evidence',()=>{
  for(const id of ['a'.repeat(63),'a'.repeat(65),'g'.repeat(64)]){
   const b=batch(),url=`https://ads.pinterest.com/ads-repository/${id}/`;b.ads[0].sourceAdId=id;b.ads[0].sourceUrl=url;b.evidence[0].url=url;
   expect(()=>validatePinterestBatch(b)).toThrow('PINTEREST_AD_INVALID');
  }
  for(const suffix of ['?next=evil','#fragment']){
   const b=batch(),id='ab'.repeat(32),url=`https://ads.pinterest.com/ads-repository/${id}/`;b.ads[0].sourceAdId=id;b.ads[0].sourceUrl=url+suffix;b.evidence[0].url=url+suffix;
   expect(()=>validatePinterestBatch(b)).toThrow('PINTEREST_AD_INVALID');
  }
  const b=batch(),id='ab'.repeat(32);b.ads[0].sourceAdId=id;b.ads[0].sourceUrl=`https://ads.pinterest.com/ads-repository/${id}/`;
  expect(()=>validatePinterestBatch(b)).toThrow('PINTEREST_AD_INVALID');
 });
 it('requires matching source, stable identity and evidence before writes',()=>{
  expect(()=>validatePinterestBatch(batch())).not.toThrow();
  const b=batch();b.sourceKey='meta_ad_library';expect(()=>validatePinterestBatch(b)).toThrow();
 });
 it('rejects duplicate IDs and unproven detail pages',()=>{
  const b=batch();b.ads.push(b.ads[0]);expect(()=>validatePinterestBatch(b)).toThrow();
  const c=batch();c.evidence=[];expect(()=>validatePinterestBatch(c)).toThrow();
 });
 it('preserves source-redacted disapproved records without inventing advertiser identity',()=>{
  const b:any=batch();b.ads[0].advertiserName='';b.ads[0].sourceFields={'Ad status':'Disapproved','Statement of reasons':'Content rejected'};
  expect(()=>validatePinterestBatch(b)).not.toThrow();
 });
 it('rejects failed batches and hostile media destinations',()=>{
  const b=batch();b.status='FAILED';expect(()=>validatePinterestBatch(b)).toThrow();
  const c:any=batch();c.ads[0].media=[{url:'http://127.0.0.1/secret',type:'IMAGE'}];expect(()=>validatePinterestBatch(c)).toThrow();
 });
 it('accepts a complete public MP4 observed in the matching repository detail evidence',()=>{
  const b:any=batch(),url='https://v.pinimg.com/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4?token=synthetic&source=public';
  b.ads[0].media=[{url,type:'VIDEO'}];b.ads[0].rawHtml=`<video><source src="${url.replaceAll('&','&amp;')}" type="video/mp4"></video>`;b.evidence[0].html=b.ads[0].rawHtml;
  expect(()=>validatePinterestBatch(b)).not.toThrow();
 });
 it('requires the actual video URL in source evidence and rejects guessed files',()=>{
  const b:any=batch();b.ads[0].media=[{url:'https://v.pinimg.com/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4',type:'VIDEO'}];
  expect(()=>validatePinterestBatch(b)).toThrow('PINTEREST_MEDIA_INVALID');
 });
 it('rejects a URL mentioned in text rather than an actual media source',()=>{
  const b:any=batch(),url='https://v.pinimg.com/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4';b.ads[0].media=[{url,type:'VIDEO'}];b.ads[0].rawHtml=`<div>${url}</div><video data-src="${url}"></video>`;b.evidence[0].html=b.ads[0].rawHtml;
  expect(()=>validatePinterestBatch(b)).toThrow('PINTEREST_MEDIA_INVALID');
 });
 it('rejects videos outside the observed CDN file path even with matching HTML evidence',()=>{
  for(const url of ['https://v.pinimg.com/profile/avatar.mp4','https://v.pinimg.com/videos/mc/hls/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.m3u8','https://v.pinimg.com.evil.test/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4']){
   const b:any=batch();b.ads[0].media=[{url,type:'VIDEO'}];b.ads[0].rawHtml=`<video src="${url}"></video>`;b.evidence[0].html=b.ads[0].rawHtml;
   expect(()=>validatePinterestBatch(b)).toThrow('PINTEREST_MEDIA_INVALID');
  }
 });
});
