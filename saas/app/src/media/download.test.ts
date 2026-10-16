import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isPublicAddress, safeDownload, type DownloadNetwork } from './download';
import { mediaDownloadPolicy } from './source-policy';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const options = { allowedHosts: [{ hostname: 'fbcdn.net', includeSubdomains: true }], maxBytes: 64, timeoutMs: 500 };
function network(responses: Array<{ status?: number; headers?: Record<string, string | undefined>; chunks?: Buffer[] }>, addresses = ['1.1.1.1']) {
  const calls: Array<{ hostname: string; pinned: unknown }> = [];
  const boundary: DownloadNetwork = {
    resolve: async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })),
    request: (url, requestOptions, callback) => {
      const request = new EventEmitter() as ClientRequest;
      request.end = (() => {
        const next = responses.shift() ?? {};
        const response = Readable.from(next.chunks ?? [png]) as IncomingMessage;
        response.statusCode = next.status ?? 200;
        response.headers = next.headers ?? { 'content-type': 'image/png' };
        queueMicrotask(() => {
          requestOptions.lookup!(url.hostname, { all: true }, ((error: Error | null, pinned: unknown) => {
            if (error) request.emit('error', error);
            else { calls.push({ hostname: url.hostname, pinned }); callback(response); }
          }) as never);
        });
        return request;
      }) as typeof request.end;
      request.destroy = (() => request) as typeof request.destroy;
      return request;
    },
  };
  return { boundary, calls };
}

describe('public IP validation', () => {
  it.each(['127.0.0.1', '0.1.2.3', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.169.254',
    '100.64.0.1', '198.18.0.1', '192.0.2.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1',
    'fe80::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::1', '168.63.129.16', 'invalid'])('rejects reserved or unsafe address %s', address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])('accepts global address %s', address => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('safe media download', () => {
  it.each([
    ['image/jpeg', Buffer.from([255, 216, 255, 224])],
    ['image/gif', Buffer.from('GIF89a')],
    ['image/webp', Buffer.from('RIFF0000WEBP')],
    ['video/mp4', Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109])],
    ['video/webm', Buffer.from([26, 69, 223, 163])],
  ])('accepts the explicitly supported %s signature', async (mimeType, bytes) => {
    const response = { headers: { 'content-type': mimeType as string }, chunks: [bytes as Buffer] };
    expect(await safeDownload('https://fbcdn.net/a', options, network([response]).boundary)).toMatchObject({ ok: true, mimeType });
  });
  it('pins the checked DNS address and returns verified bytes with no signed source URL', async () => {
    const { boundary, calls } = network([{}]);
    const result = await safeDownload('https://video.fbcdn.net/a?token=SECRET', options, boundary);
    expect(result).toMatchObject({ ok: true, mimeType: 'image/png', sizeBytes: 12, bytes: png });
    expect(calls).toEqual([{ hostname: 'video.fbcdn.net', pinned: [{ address: '1.1.1.1', family: 4 }] }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it.each(['http://video.fbcdn.net/a', 'https://user:SECRET@video.fbcdn.net/a', 'https://video.fbcdn.net:443/a',
    'https://video.fbcdn.net:8443/a', 'https://fbcdn.net.evil.test/a', 'https://127.0.0.1/a'])('rejects untrusted URL before DNS: %s', async url => {
    let dnsCalls = 0;
    const boundary = network([{}]).boundary; boundary.resolve = async () => { dnsCalls++; return []; };
    expect(await safeDownload(url, options, boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
    expect(dnsCalls).toBe(0);
  });
  it('rejects the entire DNS answer if any address is private', async () => {
    const { boundary, calls } = network([{}], ['1.1.1.1', '169.254.169.254']);
    expect(await safeDownload('https://fbcdn.net/a', options, boundary)).toEqual({ ok: false, errorCode: 'MEDIA_ADDRESS_REJECTED' });
    expect(calls).toHaveLength(0);
  });
  it('enforces source path restrictions before DNS and after redirects', async () => {
    const restricted = { ...options, allowedHosts: [{ hostname: 'library.tiktok.com', pathPattern: '^/api/v1/cdn/[0-9]+/video/[A-Za-z0-9_+/=-]+/[A-Za-z0-9-]+$' }] };
    const start = 'https://library.tiktok.com/api/v1/cdn/123/video/Ynl0ZXM=/123abc';
    for (const url of ['https://library.tiktok.com/ads', 'https://library.tiktok.com/api/v1/cdn/123/other/a/b', 'https://library.tiktok.com/api/v1/cdn/123/video/%2e%2e/123abc']) {
      const { boundary, calls } = network([{}]);
      expect(await safeDownload(url, restricted, boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
      expect(calls).toHaveLength(0);
    }
    const { boundary, calls } = network([{ status: 302, headers: { location: '/login' } }, {}]);
    expect(await safeDownload(start, restricted, boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
    expect(calls).toHaveLength(1);
  });
  it('rejects a valid video returned from an image-only source', async () => {
    const bytes = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]);
    expect(await safeDownload('https://fbcdn.net/a', { ...options, allowedMimeTypes: ['image/png'] }, network([{ headers: { 'content-type': 'video/mp4' }, chunks: [bytes] }]).boundary))
      .toEqual({ ok: false, errorCode: 'MEDIA_TYPE_REJECTED' });
  });
  it('only accepts a redirect-only CDN after a permitted source URL', async () => {
    const restricted = { ...options, allowedHosts: [{ hostname: 'library.tiktok.com' }, { hostname: 'v16m.tiktokcdn.com', redirectOnly: true }] };
    const direct = network([{}]);
    expect(await safeDownload('https://v16m.tiktokcdn.com/video', restricted, direct.boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
    expect(direct.calls).toHaveLength(0);
    const redirected = network([{ status: 302, headers: { location: 'https://v16m.tiktokcdn.com/video' } }, {}]);
    expect(await safeDownload('https://library.tiktok.com/source', restricted, redirected.boundary)).toMatchObject({ ok: true });
    expect(redirected.calls).toHaveLength(2);
  });
  it('follows the observed TikTok video CDN redirect without admitting direct CDN or avatar URLs', async () => {
    const policy = mediaDownloadPolicy('tiktok_commercial_library', 'VIDEO')!;
    const start = 'https://library.tiktok.com/api/v1/cdn/123/video/Ynl0ZXM=/123abc';
    const cdn = `https://v16m.tiktokcdn.com/${'a'.repeat(32)}/${'b'.repeat(8)}/video/tos/useast2a/tos-useast2a-ve-68c810-euttp/synthetic-id/`;
    const bytes = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]);
    const redirect = { status: 302, headers: { location: cdn } };
    expect(await safeDownload(start, policy, network([redirect, { headers: { 'content-type': 'video/mp4' }, chunks: [bytes] }]).boundary)).toMatchObject({ ok: true, mimeType: 'video/mp4' });
    expect(await safeDownload(cdn, policy, network([{}]).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
    expect(await safeDownload(start, policy, network([{ status: 302, headers: { location: 'https://v16m.tiktokcdn.com/avatars/person.jpg' } }]).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
    expect(await safeDownload(start, policy, network([redirect, {}]).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_TYPE_REJECTED' });
    const rebinding = network([redirect]);
    rebinding.boundary.resolve = async host => [{ address: host === 'library.tiktok.com' ? '1.1.1.1' : '10.0.0.1', family: 4 }];
    expect(await safeDownload(start, policy, rebinding.boundary)).toEqual({ ok: false, errorCode: 'MEDIA_ADDRESS_REJECTED' });
  });
  it('stores a public TikTok photomode JPEG but rejects avatar and private DNS targets', async () => {
    const policy = mediaDownloadPolicy('tiktok_commercial_library', 'IMAGE');
    expect(policy).not.toBeNull();
    const url = `https://p16-common-sign.tiktokcdn.com/tos-no1a-i-photomode-no/${'a'.repeat(32)}~tplv-tiktokx-origin.jpeg?x-expires=1790000000`;
    const bytes=Buffer.from([255,216,255,224]);
    expect(await safeDownload(url,policy!,network([{headers:{'content-type':'image/jpeg'},chunks:[bytes]}]).boundary)).toMatchObject({ok:true,mimeType:'image/jpeg',bytes});
    expect(await safeDownload(url,policy!,network([{}],['10.0.0.1']).boundary)).toEqual({ok:false,errorCode:'MEDIA_ADDRESS_REJECTED'});
    expect(await safeDownload(url.replace('tos-no1a-i-photomode-no','tos-alisg-avt-0068'),policy!,network([{}]).boundary)).toEqual({ok:false,errorCode:'MEDIA_URL_REJECTED'});
  });
  it.each(['v77.tiktokcdn.com','v99.tiktokcdn.com'])('follows a validated library redirect to platform-owned node %s', async hostname => {
    const policy = mediaDownloadPolicy('tiktok_commercial_library', 'VIDEO')!;
    const start = 'https://library.tiktok.com/api/v1/cdn/123/video/Ynl0ZXM=/123abc';
    const cdn = `https://${hostname}/${'a'.repeat(32)}/${'b'.repeat(8)}/video/tos/alisg/tosalisgpve0068/syntheticpublicvideo/`;
    const bytes = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]);
    const redirect = { status: 302, headers: { location: cdn } };
    expect(await safeDownload(start, policy, network([redirect, { headers: { 'content-type': 'video/mp4' }, chunks: [bytes] }]).boundary)).toMatchObject({ ok: true, mimeType: 'video/mp4' });
    expect(await safeDownload(cdn, policy, network([{}]).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
    expect(await safeDownload(start, policy, network([{ status: 302, headers: { location: 'https://v77.tiktokcdn.com/avatars/person.mp4' } }]).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
    const rebinding = network([redirect]);
    rebinding.boundary.resolve = async host => [{ address: host === 'library.tiktok.com' ? '1.1.1.1' : '10.0.0.1', family: 4 }];
    expect(await safeDownload(start, policy, rebinding.boundary)).toEqual({ ok: false, errorCode: 'MEDIA_ADDRESS_REJECTED' });
  });
  it.each([
    ['pinterest_ads_repository', 'IMAGE', 'https://i.pinimg.com/474x/35/b9/b2/35b9b254ac1604d6420df4069d3d7892.jpg', 'image/png'],
    ['google_ads_transparency', 'IMAGE', 'https://tpc.googlesyndication.com/archive/simgad/12345', 'image/png'],
    ['google_ads_transparency', 'IMAGE', 'https://i.ytimg.com/vi/abc_DEF-123/hqdefault.jpg', 'image/png'],
    ['google_ads_transparency', 'IMAGE', 'https://i3.ytimg.com/vi/abc_DEF-123/hqdefault.jpg', 'image/png'],
    ['google_ads_transparency', 'VIDEO', 'https://rr1---sn-5oxmp55u-8pxl.googlevideo.com/videoplayback?id=synthetic', 'video/mp4'],
    ['google_ads_transparency', 'VIDEO', 'https://rr2---sn-5oxmp55u-8pxl.googlevideo.com/videoplayback?id=synthetic', 'video/mp4'],
    ['google_ads_transparency', 'VIDEO', 'https://rr5---sn-a5mekn6z.googlevideo.com/videoplayback?id=synthetic', 'video/mp4'],
    ['snapchat_ads_gallery', 'IMAGE', 'https://cf-st.sc-cdn.net/d/KRvdWssx1Z2fhF5eLXIlM.1023', 'image/png'],
    ['snapchat_ads_gallery', 'VIDEO', 'https://cf-st.sc-cdn.net/d/1oVXl3SGc2CUwdXIWEVIN.67', 'video/mp4'],
    ['pinterest_ads_repository', 'VIDEO', 'https://v.pinimg.com/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4', 'video/mp4'],
    ['tiktok_commercial_library', 'VIDEO', 'https://library.tiktok.com/api/v1/cdn/123/video/Ynl0ZXM=/123abc', 'video/mp4'],
  ])('validates bytes, MIME and public DNS for %s %s', async (key, type, url, mimeType) => {
    const policy = mediaDownloadPolicy(key, type)!;
    expect(policy).not.toBeNull();
    const bytes = type === 'VIDEO' ? Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]) : png;
    expect(await safeDownload(url, policy, network([{ headers: { 'content-type': mimeType }, chunks: [bytes] }]).boundary)).toMatchObject({ ok: true, mimeType, bytes });
    expect(await safeDownload(url, policy, network([{}], ['127.0.0.1']).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_ADDRESS_REJECTED' });
    expect(await safeDownload(url, policy, network([{ headers: { 'content-type': mimeType }, chunks: [Buffer.from('<html>not media</html>')] }]).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_TYPE_REJECTED' });
    expect(await safeDownload(url, policy, network([{ status: 302, headers: { location: 'https://evil.test/media' } }]).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
  });
  it('validates a changed Google video CDN node after redirect before storing bytes', async () => {
    const policy = mediaDownloadPolicy('google_ads_transparency', 'VIDEO')!;
    const start = 'https://rr1---sn-5oxmp55u-8pxl.googlevideo.com/videoplayback?id=synthetic';
    const target = 'https://rr5---sn-a5mekn6z.googlevideo.com/videoplayback?id=synthetic';
    const bytes = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]);
    const redirect = { status: 302, headers: { location: target } };
    expect(await safeDownload(start, policy, network([redirect, { headers: { 'content-type': 'video/mp4' }, chunks: [bytes] }]).boundary)).toMatchObject({ ok: true, bytes });
    const rebinding = network([redirect]);
    rebinding.boundary.resolve = async host => [{ address: host.startsWith('rr1---') ? '1.1.1.1' : '10.0.0.1', family: 4 }];
    expect(await safeDownload(start, policy, rebinding.boundary)).toEqual({ ok: false, errorCode: 'MEDIA_ADDRESS_REJECTED' });
    expect(await safeDownload(start, policy, network([{ status: 302, headers: { location: target.replace('/videoplayback', '/player') } }]).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
  });
  it('revalidates each redirect and stops before requesting a private DNS target', async () => {
    const { boundary, calls } = network([{ status: 302, headers: { location: 'https://second.fbcdn.net/a' } }]);
    boundary.resolve = async host => [{ address: host === 'fbcdn.net' ? '1.1.1.1' : '10.0.0.1', family: 4 }];
    expect(await safeDownload('https://fbcdn.net/a', options, boundary)).toEqual({ ok: false, errorCode: 'MEDIA_ADDRESS_REJECTED' });
    expect(calls).toHaveLength(1);
  });
  it('permits three redirects but refuses a fourth', async () => {
    const redirect = { status: 302, headers: { location: '/next' } };
    const success = network([redirect, redirect, redirect, {}]);
    expect(await safeDownload('https://fbcdn.net/a', options, success.boundary)).toMatchObject({ ok: true });
    const fail = network([redirect, redirect, redirect, redirect]);
    expect(await safeDownload('https://fbcdn.net/a', options, fail.boundary)).toEqual({ ok: false, errorCode: 'MEDIA_REDIRECT_LIMIT' });
  });
  it('rejects an explicit port in a protocol-relative redirect', async () => {
    const { boundary, calls } = network([{ status: 302, headers: { location: '//fbcdn.net:443/next' } }, {}]);
    expect(await safeDownload('https://fbcdn.net/a', options, boundary)).toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
    expect(calls).toHaveLength(1);
  });
  it.each([' https://fbcdn.net:443/next', '\\\\fbcdn.net:443\\next'])('rejects normalization tricks in redirect %s', async location => {
    expect(await safeDownload('https://fbcdn.net/a', options, network([{ status: 302, headers: { location } }, {}]).boundary))
      .toEqual({ ok: false, errorCode: 'MEDIA_URL_REJECTED' });
  });
  it('enforces both declared and streamed byte limits', async () => {
    expect(await safeDownload('https://fbcdn.net/a', options, network([{ headers: { 'content-type': 'image/png', 'content-length': '65' } }]).boundary))
      .toEqual({ ok: false, errorCode: 'MEDIA_TOO_LARGE' });
    expect(await safeDownload('https://fbcdn.net/a', options, network([{ chunks: [png, Buffer.alloc(60)] }]).boundary))
      .toEqual({ ok: false, errorCode: 'MEDIA_TOO_LARGE' });
  });
  it('rejects MIME spoofing, compressed responses and truncated content', async () => {
    for (const response of [
      { headers: { 'content-type': 'text/html' } },
      { headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' } },
      { headers: { 'content-type': 'image/png' }, chunks: [Buffer.from('<html>SECRET</html>')] },
    ]) expect(await safeDownload('https://fbcdn.net/a', options, network([response]).boundary)).toEqual({ ok: false, errorCode: 'MEDIA_TYPE_REJECTED' });
    expect(await safeDownload('https://fbcdn.net/a', options, network([{ headers: { 'content-type': 'image/png', 'content-length': '20' } }]).boundary))
      .toEqual({ ok: false, errorCode: 'MEDIA_LENGTH_MISMATCH' });
  });
  it('times out even during a stalled DNS lookup without exposing errors or tokens', async () => {
    const boundary = network([]).boundary; boundary.resolve = () => new Promise(() => {});
    expect(await safeDownload('https://fbcdn.net/a?token=SECRET', { ...options, timeoutMs: 10 }, boundary))
      .toEqual({ ok: false, errorCode: 'MEDIA_TIMEOUT' });
    boundary.resolve = async () => { throw new Error('provider error SECRET'); };
    expect(await safeDownload('https://fbcdn.net/a?token=SECRET', options, boundary))
      .toEqual({ ok: false, errorCode: 'MEDIA_NETWORK_FAILED' });
  });
  it('destroys a stalled response stream when the total timeout elapses', async () => {
    const response = new Readable({ read() {} }) as IncomingMessage;
    response.statusCode = 200; response.headers = { 'content-type': 'image/png' };
    const boundary = network([]).boundary;
    boundary.request = (_url, _options, callback) => {
      const request = new EventEmitter() as ClientRequest;
      request.end = (() => { queueMicrotask(() => callback(response)); return request; }) as typeof request.end;
      return request;
    };
    expect(await safeDownload('https://fbcdn.net/a', { ...options, timeoutMs: 10 }, boundary)).toEqual({ ok: false, errorCode: 'MEDIA_TIMEOUT' });
    expect(response.destroyed).toBe(true);
  });
});
it('permits a bounded 256MiB budget for verified larger source videos',async()=>{
 const policy={...options,maxBytes:256*1024*1024};
 const video=Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109]);
 const result=await safeDownload('https://fbcdn.net/video',policy,network([{headers:{'content-type':'video/mp4','content-length':'214681842'},chunks:[video]}]).boundary);
 expect(result).toEqual({ok:false,errorCode:'MEDIA_LENGTH_MISMATCH'});
});
