import type { Prisma } from '@prisma/client';
import { growthEnabled } from './contract';
import { currentGrowthToken } from './context';
import { lockActiveVisit } from './service';

type ConversionName = 'ACCOUNT_CREATED'|'REGISTRATION_VERIFIED'|'FIRST_AD_SAVED';
/** Internal business hooks only. The caller establishes the true business
 * transition. A savepoint keeps optional statistics failure out of auth/save
 * transactions, including PostgreSQL's aborted-transaction error state. */
export async function safelyRecordConversion(tx: Prisma.TransactionClient, userId: string, name: ConversionName) {
  const token = currentGrowthToken();
  if (!growthEnabled() || !token) return;
  await tx.$executeRawUnsafe('SAVEPOINT growth_conversion');
  let previousLockTimeout: string | undefined;
  try {
    const [setting] = await tx.$queryRaw<Array<{ value: string }>>`SELECT current_setting('lock_timeout') AS value`;
    previousLockTimeout = setting.value;
    // Allow normal short page/click writes to finish, but bound optional
    // statistics lock waits independently from the business transaction.
    await tx.$queryRaw`SELECT set_config('lock_timeout', '250ms', true)`;
    const visit = await lockActiveVisit(tx, token);
    if (visit) {
      const first = name === 'ACCOUNT_CREATED' ? null : await tx.conversionEvent.findUnique({ where: { userId_name: { userId, name: 'ACCOUNT_CREATED' } } });
      // A residual Google identity can first be admitted later. Only the visit
      // that preceded that account's creation may claim it as acquisition.
      const newAccount = name === 'ACCOUNT_CREATED' ? await tx.user.findUnique({ where: { id: userId }, select: { createdAt: true } }) : null;
      if ((newAccount && newAccount.createdAt >= visit.createdAt) || first?.visitId === visit.id) await tx.conversionEvent.createMany({ data: [{ userId, visitId: visit.id, name }], skipDuplicates: true });
    }
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${previousLockTimeout}, true)`;
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT growth_conversion');
  } catch {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT growth_conversion');
    if (previousLockTimeout !== undefined) await tx.$queryRaw`SELECT set_config('lock_timeout', ${previousLockTimeout}, true)`;
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT growth_conversion');
    // Do not include database errors: they can contain row content or credentials.
    console.warn('GROWTH_CONVERSION_NOT_RECORDED');
  }
}
