import type { MiddlewareConfigFn } from 'wasp/server/middleware';
import type { RequestHandler } from 'express';
import express from 'express';
import { HttpError,prisma } from 'wasp/server';
import { consumeRateLimit } from './rate-limit';
import { resolveClientIp } from './client-ip';
import { completeAuthLink,registerEmailAccount,requestAuthEmail } from '../auth/lifecycle';
import { onBeforeSignup } from '../auth/hooks';
import { DomainError } from '../team/access';
import { ensureValidPassword } from 'wasp/auth/validation';
import { googleAuthEnabled } from '../auth/google';
import { completeOAuthCode } from '../auth/oauth-exchange';
import { googleFailureUrl, useGoogleCallbackRedirect } from '../auth/oauth-http';
import { bindGoogleAdminStart, resolveGoogleAdminCallback } from '../auth/google-admin-target';
import { adminWebOrigin, clientCorsMiddleware } from './admin-web';
import { growthContextMiddleware } from '../growth/context';

const protection:RequestHandler=async(req,res,next)=>{
  let googleTargetOrigin = process.env.WASP_WEB_CLIENT_URL ?? 'http://localhost:3000';
  try {
    // Express routes are case-insensitive and accept a trailing slash by default.
    // Apply exactly the same boundary before handing opaque links to Wasp.
    const route=req.originalUrl.split('?')[0].replace(/\/+$/,'').toLowerCase();
    if (route.startsWith('/auth/')) { res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer'); }
    if (route==='/auth/options'&&['GET','HEAD'].includes(req.method)) { res.json({google:googleAuthEnabled()}); return; }
    const googleRoute=route==='/auth/google/login'||route==='/auth/google/callback';
    if(googleRoute&&['GET','HEAD'].includes(req.method)) {
      if (route.endsWith('/callback')) {
        const target = resolveGoogleAdminCallback(req,res);
        if (target.invalid) { res.redirect(302,googleFailureUrl('GOOGLE_SIGN_IN_FAILED')); return; }
        if (target.targetOrigin) googleTargetOrigin = target.targetOrigin;
      } else {
        bindGoogleAdminStart(req,res);
        if (req.query.app === 'admin') googleTargetOrigin = adminWebOrigin() ?? googleTargetOrigin;
      }
      if (!googleAuthEnabled()) { res.redirect(302,googleFailureUrl('GOOGLE_UNAVAILABLE',googleTargetOrigin)); return; }
      await consumeRateLimit(prisma,route.endsWith('/callback')?'GOOGLE_CALLBACK':'GOOGLE_START',resolveClientIp(req),{limit:30,windowMs:60000});
      if(route.endsWith('/callback')) useGoogleCallbackRedirect(res,{targetOrigin:googleTargetOrigin});
    }
    if(route==='/auth/exchange-code'&&req.method==='POST') {
      if(!googleAuthEnabled()) throw new DomainError(403,'GOOGLE_UNAVAILABLE');
      await consumeRateLimit(prisma,'GOOGLE_EXCHANGE',resolveClientIp(req),{limit:30,windowMs:60000});
      res.json(await completeOAuthCode(prisma,{code:req.body?.code})); return;
    }
    if(route.startsWith('/auth/email/')&&typeof req.body?.email==='string')req.body.email=req.body.email.trim().toLowerCase();
    const scope=googleRoute?null:route.endsWith('/signup')?'REGISTER':route.endsWith('/login')?'LOGIN':/request-password-reset|resend-verification/.test(route)?'EMAIL':null;
    if(scope) {
      await consumeRateLimit(prisma,scope,resolveClientIp(req),{limit:scope==='LOGIN'?30:10,windowMs:60000});
      if(typeof req.body?.email==='string')await consumeRateLimit(prisma,scope+'_IDENTITY',req.body.email.trim().toLowerCase(),{limit:scope==='LOGIN'?10:5,windowMs:60000});
    }
    const purpose=route==='/auth/email/reset-password'?'RESET':route==='/auth/email/verify-email'?'VERIFY':null;
    if(purpose&&req.method==='POST') {
      if(purpose==='RESET')ensureValidPassword(req.body??{});
      res.json(await completeAuthLink(prisma,{token:String(req.body?.token??''),purpose,key:process.env.OUTBOX_ENCRYPTION_KEY??'',password:req.body?.password}));
      return;
    }
    const emailRequest=route==='/auth/email/request-password-reset'?'RESET':route==='/auth/email/resend-verification'?'VERIFY':null;
    if(emailRequest&&req.method==='POST') {
      res.json(await requestAuthEmail(prisma,{email:String(req.body?.email??''),purpose:emailRequest,key:process.env.OUTBOX_ENCRYPTION_KEY??'',origin:process.env.WASP_WEB_CLIENT_URL??'http://localhost:3000'}));
      return;
    }
    if(route==='/auth/email/signup'&&req.method==='POST') {
      await onBeforeSignup({req,prisma,providerId:{providerName:'email',providerUserId:String(req.body?.email??'')}});
      res.json(await registerEmailAccount(prisma,{email:String(req.body?.email??''),password:req.body?.password,key:process.env.OUTBOX_ENCRYPTION_KEY??'',origin:process.env.WASP_WEB_CLIENT_URL??'http://localhost:3000'}));
      return;
    }
    next();
  } catch(error) {
    if(/^\/auth\/google\/(login|callback)\/?$/i.test(req.originalUrl.split('?')[0])&&['GET','HEAD'].includes(req.method)) { res.redirect(302,googleFailureUrl('GOOGLE_SIGN_IN_FAILED',googleTargetOrigin)); return; }
    const status=error instanceof DomainError?error.status:error instanceof HttpError&&error.statusCode===403?403:400;
    // Preserve the public admission reason without exposing arbitrary framework errors.
    const message=error instanceof DomainError?error.code:error instanceof HttpError&&error.statusCode===403&&error.message==='INVITATION_REQUIRED'?'INVITATION_REQUIRED':'INVALID_AUTH_REQUEST';
    res.status(status).json({message});
  }
};
export const middlewareConfig:MiddlewareConfigFn=(config)=>{
  // Framework dev logging includes full URLs, which may contain sensitive links.
  config.delete('logger');
  // Replace Wasp's development wildcard and production single origin in-place.
  // Non-browser requests retain their normal authorization boundaries.
  config.set('cors',clientCorsMiddleware());
  const seedImportJson=express.json({limit:'30mb'}),defaultJson=express.json();
  config.set('express.json',(req,res,next)=>{
    const route=req.originalUrl.split('?')[0].replace(/\/+$/,'').toLowerCase();
    return (route==='/operations/seed-command'?seedImportJson:defaultJson)(req,res,next);
  });
  config.set('growth.context',growthContextMiddleware);
  config.set('saas.protection',protection);
  return config;
};
