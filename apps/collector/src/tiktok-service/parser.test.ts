import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { parseDetail, classifyPage, sanitizeEvidence, parseListing, readRetryAfter } from './parser';

const html = readFileSync('apps/collector/src/tiktok-service/fixtures/detail.redacted.html', 'utf8');
const url = 'https://library.tiktok.com/ads/detail/?ad_id=1878382825663537';
const doc = (text = html) => new JSDOM(text, { url }).window.document;
describe('TikTok public DOM', () => {
  it('keeps source identities, dates, countries and missing caption distinct', () => {
    const ad = parseDetail(doc(), url, '2026-10-07T12:00:00Z');
    expect(ad).toMatchObject({sourceAdId: '1878382825663537', sourceAdvertiserId: '7657915443029508117', advertiserName: 'PHYWE Systeme GmbH & Co. KG', firstShown: '2026-10-07', lastShown: '2026-10-07', body: null, cta: 'Learn more', landingPageUrl: null, reportedCountries: ['DE', 'CH']});
    expect(ad.sourceFields["Advertiser's registered location"]).toBe('Germany');
    expect(ad.sourceFields['Ad paid for by']).toBe('PHYWE Systeme GmbH & Co. KG');
    expect(ad.media).toEqual([]);
  });
  it('rejects a detail identity mismatch and incomplete shell', () => {
    expect(() => parseDetail(doc(), url.replace('3537', '3538'), '2026-10-07T12:00:00Z')).toThrow('TIKTOK_DETAIL_ID_MISMATCH');
    expect(() => parseDetail(doc('<div>Ad ID: 1878382825663537</div>'), url, '2026-10-07T12:00:00Z')).toThrow('TIKTOK_DETAIL_INCOMPLETE');
  });
  it('does not mix targeting parameters or registration with countries actually reached', () => {
    const d=doc();d.querySelector('.targeting-table-container')!.insertAdjacentHTML('beforeend','<h2>Additional parameters</h2><table><thead><tr><th>Country</th></tr></thead><tbody><tr><td>France</td></tr></tbody></table>');
    expect(parseDetail(d,url,'2026-10-07T12:00:00Z').reportedCountries).toEqual(['DE','CH']);
  });
  it('only uses observed public media, not icons, blobs or arbitrary hosts', () => {
    const d = doc();
    const video = d.querySelector('video')!;
    video.setAttribute('src','https://library.tiktok.com/api/v1/cdn/example/video/example?signature=synthetic');
    d.body.insertAdjacentHTML('beforeend', '<img src="https://tracker.example/ad.jpg"><img src="https://library.tiktok.com/logo.svg">');
    expect(parseDetail(d,url,'2026-10-07T12:00:00Z').media).toEqual([{type:'VIDEO',url:'https://library.tiktok.com/api/v1/cdn/example/video/example?signature=synthetic'}]);
    video.setAttribute('src','blob:https://library.tiktok.com/temporary');
    expect(parseDetail(d,url,'2026-10-07T12:00:00Z').media).toEqual([]);
  });
  it.each([
    ['avatar bucket', 'https://p16-common-sign.tiktokcdn.com/tos-alisg-avt-0068/anonymous.jpeg?signature=synthetic'],
    ['avatar crop', 'https://p16-common-sign.tiktokcdn.com/other-image-bucket/anonymous~tplv-tiktokx-cropcenter:168:168.jpeg?signature=synthetic'],
    ['encoded avatar crop', 'https://p16-common-sign.tiktokcdn.com/other-image-bucket/anonymous~tplv-tiktokx-cropcenter%3A168%3A168.jpeg?signature=synthetic'],
  ])('excludes an advertiser %s without dropping creative media on its CDN', (_label, avatarUrl) => {
    const d = doc();
    d.querySelector('video')!.setAttribute('src', 'https://library.tiktok.com/api/v1/cdn/1791420765/video/synthetic-token/synthetic-id');
    const avatar = d.createElement('img');
    avatar.setAttribute('src', avatarUrl);
    d.body.append(avatar);
    const creative = d.createElement('img');
    creative.setAttribute('src', 'https://p16-common-sign.tiktokcdn.com/tos-alisg-p-0037/creative~tplv-tiktokx-cropcenter:512:512.jpeg?signature=synthetic');
    d.body.append(creative);
    const ad=parseDetail(d, url, '2026-10-07T12:00:00Z');
    expect(ad.advertiserAvatarUrl).toBe(avatarUrl);
    expect(ad.media).toEqual([
      { type: 'VIDEO', url: 'https://library.tiktok.com/api/v1/cdn/1791420765/video/synthetic-token/synthetic-id' },
      { type: 'IMAGE', url: 'https://p16-common-sign.tiktokcdn.com/tos-alisg-p-0037/creative~tplv-tiktokx-cropcenter:512:512.jpeg?signature=synthetic' },
    ]);
  });
  it('does not use creative thumbnails or an unrelated avatar host as advertiser identity',()=>{
    const d=doc();
    d.body.insertAdjacentHTML('beforeend','<img src="https://tracker.example/tos-alisg-avt-0068/avatar.jpeg"><img src="https://p16-common-sign.tiktokcdn.com/tos-alisg-p-0037/creative.jpeg">');
    expect(parseDetail(d,url,'2026-10-07T12:00:00Z').advertiserAvatarUrl??null).toBeNull();
  });
  it('extracts string ad IDs from visible detail links and deduplicates cards', () => {
    const d=doc('<a href="/ads/detail/?ad_id=1878382825663537">View ad</a><a href="/ads/detail/?ad_id=1878382825663537">View ad</a><a href="https://evil.example/ads/detail/?ad_id=1878382825663538">Fake</a>');
    expect(parseListing(d)).toEqual([{id:'1878382825663537',url}]);
  });
  it('does not call a loading zero or a missing next button exhausted', () => {
    expect(classifyPage({status:200,text:'Total ads: 0',count:0,loading:true})).toBe('LOADING');
    expect(classifyPage({status:200,text:'Total ads: 0',count:0,loading:false})).toBe('LOADING');
    expect(classifyPage({status:200,text:'No results found',count:0,loading:false})).toBe('EMPTY');
    expect(classifyPage({status:200,text:'verify you are human',count:12,loading:false})).toBe('CHALLENGE');
    expect(classifyPage({status:403,text:'',count:0,loading:false})).toBe('ACCESS_BLOCKED');
    expect(classifyPage({status:429,text:'',count:0,loading:false})).toBe('RATE_LIMITED');
    expect(classifyPage({status:200,text:'Log in to continue',count:0,loading:false})).toBe('LOGIN_REQUIRED');
  });
  it('removes scripts, form values and event handlers from private evidence', () => {
    const clean=sanitizeEvidence(doc('<script>secret</script><input value="secret"><div onclick="secret()">Public</div>'));
    expect(clean.html).not.toContain('secret');
    expect(clean.text).toBe('Public');
  });
  it('honors Retry-After seconds and HTTP date without negative delays', () => {
    expect(readRetryAfter('90',0)).toBe(90000);
    expect(readRetryAfter('Wed, 07 Oct 2026 12:01:00 GMT',Date.parse('2026-10-07T12:00:00Z'))).toBe(60000);
    expect(readRetryAfter('-1',0)).toBeUndefined();
  });
});
