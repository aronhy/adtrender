import { validateRuntimeConfig } from './config';
import { prisma } from 'wasp/server';
import { emailSender } from 'wasp/server/email';
import { createHash } from 'node:crypto';
import { issueAuthLink } from '../auth/links';
import { queueEmail,type Message } from './email';
import type { PrismaClient } from '@prisma/client';

export function createQueuedEmailSender(db: PrismaClient, key: string) {
  return async (message: Message) => {
    try {
      return await db.$transaction(async (tx) => {
        const links = new Map<string, 'RESET'|'VERIFY'>();
        for (const match of (message.text+'\n'+(message.html??'')).matchAll(/https?:\/\/[^\s<>"'。]+/g)) {
          const link = new URL(match[0]);
          if (!['/email-verification','/password-reset'].includes(link.pathname)||!link.searchParams.has('token')) continue;
          const native = link.searchParams.get('token')!;
          const purpose = link.pathname==='/password-reset'?'RESET':'VERIFY';
          if (!native || (links.has(native)&&links.get(native)!==purpose)) throw new Error('INVALID_AUTH_EMAIL');
          links.set(native,purpose);
        }
        // Expire queued authentication messages before their opaque links expire.
        const expiresAt = new Date(Date.now()+(links.size?28*60000:3600000));
        let text=message.text,html=message.html;
        let templateKey='NOTIFICATION';
        for (const [native,purpose] of links) {
          const opaque=await issueAuthLink(tx,{email:message.to,purpose,frameworkToken:native,key});
          text=text.replaceAll(native,opaque).replaceAll(encodeURIComponent(native),opaque);
          html=html?.replaceAll(native,opaque).replaceAll(encodeURIComponent(native),opaque);
          templateKey=purpose;
        }
        await queueEmail(tx,{...message,text,html},{key,dedupeKey:createHash('sha256').update(message.to+text).digest('hex'),templateKey,expiresAt});
        return {queued:true};
      });
    } catch { throw new Error('EMAIL_QUEUE_FAILED'); }
  };
}

export const serverSetup = async() => {
  validateRuntimeConfig(process.env);
  const [zone]=await prisma.$queryRaw<Array<{timezone:string}>>`SELECT current_setting('TimeZone') AS timezone`;
  if(zone.timezone!=='UTC')throw new Error('Database timezone must be UTC; run migrations.');
  if(!/^[a-f\d]{64}$/i.test(process.env.OUTBOX_ENCRYPTION_KEY??''))throw new Error('OUTBOX_ENCRYPTION_KEY is required for auth email delivery.');
  emailSender.send=createQueuedEmailSender(prisma,process.env.OUTBOX_ENCRYPTION_KEY!);
};
