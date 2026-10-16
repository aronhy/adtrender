import Stripe from 'stripe';
import type { Prisma,PrismaClient } from '@prisma/client';
import { DomainError } from '../team/access';
import { createStripeBilling,type SubscriptionNotice } from './stripe';
import { createHash } from 'node:crypto';
import { queueEmail } from '../server/email';
import { publicPricingEnabled } from '../server/public-pricing';

export function subscriptionNoticeEmail(key: string) {
  return async (tx: Prisma.TransactionClient, notice: SubscriptionNotice): Promise<void> => {
    const organization=await tx.organization.findUniqueOrThrow({where:{id:notice.organizationId},select:{name:true}});
    const owners=await tx.organizationMember.findMany({where:{organizationId:notice.organizationId,role:'OWNER',user:{disabledAt:null,email:{not:null}}},include:{user:{select:{id:true,email:true,notificationPreference:true}}}});
    const descriptions:Record<SubscriptionNotice['type'],string>={
      PAYMENT_ATTENTION:'订阅存在待处理付款。请登录工作台查看账单与订阅状态；有效期不会因未完成的付款自动延长。',
      STATUS_CHANGED:'订阅状态已更新。请登录工作台查看当前权益与账单。',
      CANCELLATION_SCHEDULED:'已安排在当前周期结束时取消订阅，当前已核对的权益按有效期保留。',
      CANCELLATION_REVOKED:'周期结束取消标记已撤销。后续权益仍以供应商对账结果为准。',
      PERIOD_UPDATED:'已根据供应商账单核对并更新订阅周期。请登录工作台查看当前权益。',
    };
    const statusLabels:Record<string,string>={ACTIVE:'正常',TRIALING:'试用中',PAST_DUE:'待处理付款',UNPAID:'未付款',INCOMPLETE:'尚未完成',INCOMPLETE_EXPIRED:'未完成且已过期',CANCELED:'已取消',PAUSED:'已暂停',REFUNDED:'已按退款规则调整权益'};
    const text=`组织：${organization.name}\n${descriptions[notice.type]}\n当前状态：${statusLabels[notice.status]??notice.status}\n${notice.periodEnd?`已核对的权益截止时间（UTC）：${notice.periodEnd.toISOString()}`:'当前未取得可确认的已付周期，请以工作台权益和账单为准。'}\n此通知不作为付款收据。`;
    for (const {user} of owners) {
      const preference=user.notificationPreference;
      if (preference&&typeof preference==='object'&&!Array.isArray(preference)&&preference.email===false) continue;
      const dedupeKey=createHash('sha256').update(JSON.stringify(['subscription-notice',notice.subscriptionId,notice.eventId,notice.type,user.id])).digest('hex');
      await queueEmail(tx,{to:user.email!,subject:notice.type==='PAYMENT_ATTENTION'?'订阅付款待处理':'订阅状态通知',text},{key,dedupeKey,templateKey:`SUBSCRIPTION_${notice.type}`,organizationId:notice.organizationId,userId:user.id});
    }
  };
}

export function billingFromEnvironment(db: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  if (env.BILLING_ENABLED !== 'true' || !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) throw new DomainError(503, 'BILLING_NOT_CONFIGURED');
  const refundPolicy = env.STRIPE_REFUND_POLICY;
  if (refundPolicy !== 'RETAIN_PAID_PERIOD' && refundPolicy !== 'REVOKE_FULL_CURRENT_PERIOD') throw new DomainError(503, 'REFUND_POLICY_NOT_CONFIGURED');
  return createStripeBilling(db, new Stripe(env.STRIPE_SECRET_KEY, { timeout: 5000, maxNetworkRetries: 1 }), {
    publicAppUrl: env.WASP_WEB_CLIENT_URL ?? 'http://localhost:3000', webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    mode: env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test', livePaymentsEnabled: env.LIVE_BILLING_ENABLED === 'true', refundPolicy,
    publicPricingEnabled:publicPricingEnabled(env),
    onSubscriptionNotice:subscriptionNoticeEmail(env.OUTBOX_ENCRYPTION_KEY??''),
  });
}
