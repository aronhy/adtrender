import type { GetPasswordResetEmailContentFn, GetVerificationEmailContentFn } from 'wasp/server/auth';
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const getVerificationEmailContent: GetVerificationEmailContentFn = ({verificationLink}) => ({subject:'验证您的邮箱', text:`请通过此链接验证邮箱：${verificationLink}。若非本人操作，请忽略。`, html:`<p>请验证您的邮箱后进入AdThrender。</p><a href="${escape(verificationLink)}">验证邮箱</a><p>若非本人操作，请忽略。</p>`});
export const getPasswordResetEmailContent: GetPasswordResetEmailContentFn = ({passwordResetLink}) => ({subject:'重置您的密码', text:`请通过此链接重置密码：${passwordResetLink}。若非本人操作，请忽略。`, html:`<p>您申请了密码重置。</p><a href="${escape(passwordResetLink)}">设置新密码</a><p>若非本人操作，请忽略，密码不会改变。</p>`});
