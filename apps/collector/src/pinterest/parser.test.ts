// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parsePinterestDetails,parsePinterestCards,pinterestParserRuntimeSource} from './parser';
const fixture=readFileSync('apps/collector/src/pinterest/detail.fixture.html','utf8');
describe('Pinterest observed DOM',()=>{
 it('preserves source HEX64 identities and numeric identities on their own cards',()=>{
  const hex='Ab'.repeat(32);
  document.body.innerHTML=`<section><div title="Synthetic HEX advertiser"></div><div title="HEX headline"></div><a target="_blank" href="/ads-repository/${hex}/">Details</a></section><section><div title="Synthetic numeric advertiser"></div><div title="Numeric headline"></div><a target="_blank" href="/ads-repository/1234567890123456789/">Details</a></section>`;
  const expected=[{sourceAdId:hex,advertiserName:'Synthetic HEX advertiser',sourceUrl:`https://ads.pinterest.com/ads-repository/${hex}/`},{sourceAdId:'1234567890123456789',advertiserName:'Synthetic numeric advertiser',sourceUrl:'https://ads.pinterest.com/ads-repository/1234567890123456789/'}];
  expect(parsePinterestCards(document)).toMatchObject(expected);
  const collect=new Function('document',pinterestParserRuntimeSource()+';return parsePinterestCards(document);');
  expect(collect(document)).toMatchObject(expected);
  const listing=new Function('document',pinterestParserRuntimeSource()+`;return Array.from(document.querySelectorAll('a[href^="/ads-repository/"][target="_blank"]')).map(a=>a.getAttribute('href')??'').filter(h=>pinterestAdIdFromPath(h)!==null);`);
  expect(listing(document)).toEqual([`/ads-repository/${hex}/`,'/ads-repository/1234567890123456789/']);
 });
 it('keeps malformed IDs and noncanonical repository paths out of cards',()=>{
  for(const href of ['/ads-repository/'+ 'a'.repeat(63)+'/', '/ads-repository/'+ 'a'.repeat(65)+'/', '/ads-repository/'+ 'g'.repeat(64)+'/', '/ads-repository/'+ 'a'.repeat(64)+'/?next=evil', '/ads-repository/'+ 'a'.repeat(64)+'/#x', '/ads-repository/'+ 'a'.repeat(64), '/pin/123456/']){
   document.body.innerHTML=`<section><div title="Synthetic"></div><div title="Synthetic"></div><a href="${href}">Details</a></section>`;
   expect(parsePinterestCards(document)).toHaveLength(0);
  }
 });
 it('preserves every disclosed targeting field without turning None into missing',()=>{
  document.body.innerHTML=fixture;
  const fields=parsePinterestDetails(document);
  expect(fields['Countries']).toBe('Germany');
  expect(fields['Carriers']).toBe('None');
  expect(fields['Reach throughout the European Union']).toBe('0 - 10000');
  expect(Object.keys(fields).length).toBeGreaterThan(15);
 });
 it('keeps 19 digit source IDs as strings and rejects unrelated pin links',()=>{
  document.body.innerHTML='<section><div title="Nike">Nike</div><div title="Polo">Polo</div><div title="Truncated…">Truncated…</div><img alt="Ad image" src="https://i.pinimg.com/example.jpg"><a href="/ads-repository/4600427147308611200/">Details</a></section><a href="/pin/123/">Pin</a>';
  const cards=parsePinterestCards(document);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({sourceAdId:'4600427147308611200',advertiserName:'Nike',headline:'Polo',body:'Truncated…',bodyTruncated:true});
 });
 it('never attributes neighbouring cards to a malformed record',()=>{
  document.body.innerHTML='<main><section><a href="/ads-repository/123/">Details</a></section><section><div title="Other">Other</div><a href="/ads-repository/456/">Details</a></section></main>';
  expect(parsePinterestCards(document)).toHaveLength(0);
 });
 it('keeps actual public video sources on their advertiser card together with its preview',()=>{
  const image='https://i.pinimg.com/474x/3c/3e/ea/3c3eea112233445566778899aabbccdd.jpg';
  const video='https://v.pinimg.com/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4';
  document.body.innerHTML=`<video src="https://v.pinimg.com/videos/mc/720p/aa/bb/cc/aabbcc112233445566778899aabbccdd.mp4"></video><section><div title="Nike">Nike</div><div title="Shoes">Shoes</div><img alt="Ad image" src="${image}"><video><source src="${video}" type="video/mp4"></video><a href="/ads-repository/4600427147308611200/">Details</a></section>`;
  expect(parsePinterestCards(document)[0].media).toEqual([{url:image,type:'IMAGE'},{url:video,type:'VIDEO'}]);
 });
 it('rejects video watch pages, playlists, unrelated hosts and inferred poster videos',()=>{
  document.body.innerHTML='<section><div title="Nike">Nike</div><div title="Shoes">Shoes</div><video poster="https://i.pinimg.com/474x/aa/bb/cc/aabbcc.jpg" src="https://www.pinterest.com/pin/123/"><source src="https://v.pinimg.com/videos/mc/hls/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.m3u8"><source src="https://v.pinimg.com.evil.test/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4"></video><a href="/ads-repository/12345/">Details</a></section>';
  expect(parsePinterestCards(document)[0].media).toEqual([]);
 });
 it('reads detail video source from the archived HTML through the serialized browser parser',()=>{
  const video='https://v.pinimg.com/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4?token=synthetic&source=public';
  const doc=new DOMParser().parseFromString(`<section><video controls><source src="${video.replaceAll('&','&amp;')}" type="video/mp4"></video></section>`,'text/html');
  const collect=new Function('document',pinterestParserRuntimeSource()+';return parsePinterestMedia(document);');
  expect(collect(doc)).toEqual([{url:video,type:'VIDEO'}]);
 });
});
