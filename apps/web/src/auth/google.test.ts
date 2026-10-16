import { describe, expect, it } from 'vitest';
import { googleAuthEnabled, validateGoogleAuthConfig, googleProfile, readGoogleProfile } from './google';

describe('Google login trust and configuration boundaries', () => {
  it('stays disabled unless explicitly enabled with both server credentials', () => {
    expect(googleAuthEnabled({})).toBe(false);
    expect(googleAuthEnabled({GOOGLE_AUTH_ENABLED:'false',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:''})).toBe(false);
    expect(() => validateGoogleAuthConfig({GOOGLE_AUTH_ENABLED:'true'})).toThrow('GOOGLE_AUTH_CONFIGURATION_REQUIRED');
    expect(() => validateGoogleAuthConfig({GOOGLE_AUTH_ENABLED:'yes'})).toThrow('INVALID_GOOGLE_AUTH_ENABLED');
    const env={GOOGLE_AUTH_ENABLED:'true',GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-only'};
    expect(googleAuthEnabled(env)).toBe(true);
    expect(() => validateGoogleAuthConfig(env)).not.toThrow();
  });
  it('uses the stable Google subject and only a verified authoritative mailbox', () => {
    expect(googleProfile({sub:'12345',email:'Owner@Gmail.com',email_verified:true,name:'A'.repeat(100)})).toEqual({sub:'12345',email:'owner@gmail.com',displayName:'A'.repeat(80)});
    expect(googleProfile({sub:'23456',email:'owner@company.test',email_verified:true,hd:'company.test'}).email).toBe('owner@company.test');
  });
  it.each([
    {sub:'1',email:'owner@gmail.com',email_verified:false},
    {sub:'1',email:'owner@gmail.com',email_verified:'true'},
    {sub:'1',email:'owner@external.test',email_verified:true},
    {sub:'1',email:'owner@external.test',email_verified:true,hd:''},
    {email:'owner@gmail.com',email_verified:true},
    {sub:'1',email:'broken',email_verified:true},
  ])('rejects untrusted or incomplete profile %#', profile => {
    expect(() => googleProfile(profile)).toThrow();
  });
  it('loads userinfo only from Google using the bearer header and disallows redirects', async () => {
    const calls: unknown[]=[];
    const result=await readGoogleProfile('fixture-token',async(input,init)=>{calls.push([input,init]);return new Response(JSON.stringify({sub:'1',email:'owner@gmail.com',email_verified:true}),{headers:{'content-type':'application/json'}});});
    expect(result.sub).toBe('1');
    expect(calls).toMatchObject([['https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer fixture-token'},redirect:'error'}]]);
  });
  it('does not expose provider error bodies or tokens', async () => {
    await expect(readGoogleProfile('fixture-token',async()=>new Response('private provider body',{status:401}))).rejects.toThrow('GOOGLE_PROFILE_UNAVAILABLE');
    await expect(readGoogleProfile('fixture-token',async()=>{throw new Error('sensitive-token');})).rejects.toThrow('GOOGLE_PROFILE_UNAVAILABLE');
  });
});
