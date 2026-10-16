import { Link } from 'react-router';
import { ArrowRight, Check, Plus } from 'lucide-react';
import { getPublicPricing, useQuery } from 'wasp/client/operations';
import { Empty, Loading, moneyLabel, PageHeader } from './App';
import type { PublicPricingView } from '../server/public-pricing';
import { rememberPricingIntent } from './pricing-intent';
import { AnalyticsPreferences } from './site-analytics/SiteAnalytics';

export { LandingPage } from './landing/LandingPage';
export function PricingPage() {
  const query = useQuery(getPublicPricing, {});
  const data = query.data as PublicPricingView | undefined;
  return <main className="site-document wide"><PageHeader eyebrow="套餐与额度" title="按团队使用，按需要选择。" description="订阅由组织统一购买，工作区按品牌或客户划分。" />
    {query.isLoading ? <Loading label="正在读取套餐…" /> : query.error || !data ? <Empty title="暂时无法读取套餐" action={<button className="button secondary" onClick={() => void query.refetch()}>重新读取</button>}>请稍后重试，购买前会重新核对价格与权益。</Empty> : data.status !== 'PUBLISHED' || !data.plans.length ? <Empty title="正式价格及套餐待公布" action={<Link className="button secondary" to="/app/settings#billing">查看已开通权益</Link>}>{data.message}</Empty> : <div className="pricing-columns">{data.plans.map(plan => <article className="pricing-option" key={plan.id}><h2>{plan.name}</h2><p>组织统一订阅</p><strong>{moneyLabel(plan.priceMinor, plan.currency)}<small> / 月</small></strong><ul>{[`${plan.workspaceLimit.toLocaleString('zh-CN')} 个工作区`, `${plan.memberLimit.toLocaleString('zh-CN')} 个成员席位`, `${plan.savedAdLimit.toLocaleString('zh-CN')} 条收藏`, `${plan.monthlyAnalysisLimit.toLocaleString('zh-CN')} 次分析 / 月`].map(feature => <li key={feature}><Check size={15} />{feature}</li>)}</ul><Link className="button secondary" to={`/app/settings?plan=${encodeURIComponent(plan.id)}#billing`} onClick={() => rememberPricingIntent(plan.id)}>选择此套餐</Link><p className="small-note">登录后选择组织，由组织所有者确认购买。</p></article>)}</div>}
    <section className="prose"><h2>试用与订阅说明</h2><p>公开试用时长与额度待确认，以工作区显示的实际权益为准。</p><p>普通搜索不按次扣费，分析按套餐额度管理；具体额度在购买页面确认。</p><p>到期取消后，权益保留至已付周期末。套餐变更预约到下个周期；降级不会自动删除已有资料，超出额度时限制新增。</p><p>正式收款未启用时不会展示可购买价格。沙盒支付仅用于测试，不能代表正式付费服务已经上线。</p><p><Link to="/help">了解更多使用说明 →</Link></p></section></main>;
}
export function HelpPage() {
  const questions = [
    ['怎样开始使用？', '注册并完成邮箱验证后创建团队与工作区。搜索广告、查看来源，再收藏到当前工作区；有分析额度时可以发起内容分析。现已开放注册，无需邀请码。'],
    ['这里的数据代表真实广告效果吗？', '资料库展示来源可获得的广告内容与观测记录。首次发现不等于首次投放，观测跨度不等于连续投放时长。页面点击和视频播放是本产品的使用行为，不是竞品广告曝光或点击。'],
    ['查询国家与投放国家有什么区别？', '查询国家是采集时使用的来源查询条件，不能单独证明广告真实投放到了该国家。来源未明确返回的字段不会推断补齐。'],
    ['为什么图片或视频打不开？', '来源媒体可能过期、不可下载或尚未缓存。可以刷新详情重新获取可用链接，或者打开原始来源；广告原文和来源证据仍然保留。'],
    ['分析会读取什么？', '分析基于当前可获得的文案和已处理媒体证据。推断与来源事实分开展示；没有转录时不会假装读过视频台词。分析失败会释放预占额度。'],
    ['同一个组织内的工作区是否都互通？', '组织所有者和管理员可管理组织工作区；普通成员仅能访问已授权的工作区。收藏、笔记、分析和私有文件按归属校验。'],
    ['怎样取消或变更套餐？', '由组织所有者在团队与设置页面操作。取消在已付周期结束时生效，变更套餐预约到下个周期；账单与收据不等同于本地税务发票。'],
    ['怎样反馈问题或申请删除数据？', '登录后打开团队与设置，提交问题反馈或数据删除申请。请勿在反馈里填写密码、密钥或其他账号凭证。'],
  ];
  return <main className="site-document"><PageHeader eyebrow="帮助中心" title="把第一条研究流程走通。" description="从注册、团队协作到资料来源，这里说明工作台的使用边界。" /><div className="help-steps"><span>创建工作区</span><ArrowRight size={16} /><span>搜索与查看</span><ArrowRight size={16} /><span>收藏与分析</span></div><div className="faq-list">{questions.map(([title, body], index) => <details key={title} open={index === 0}><summary>{title}<Plus size={16} /></summary><p>{body}</p></details>)}</div><div className="document-action"><Link className="button primary" to="/app/settings#feedback">提交反馈</Link><Link to="/app">进入工作台 →</Link></div></main>;
}
export function TermsPage() {
  return <LegalPage title="服务条款" intro="测试阶段说明。运营主体、正式收费条款与争议处理信息将在正式开放前补齐并提示确认。" sections={[
    ['服务用途', '本产品用于研究来源公开展示的广告资料及保存团队研究内容。资料覆盖、更新频率与可用性受来源限制，不保证完整收录或媒体永久可用。'],
    ['账号与团队', '请提供可验证的邮箱，并妥善保管登录凭据。团队管理者负责授权成员与工作区；不得尝试访问其他组织的私有数据。'],
    ['来源与内容权利', '广告素材与文案的权利归各自权利人。公开可见不代表可以自由复制、再分发或商用；使用者需自行核实相关权利与适用条件。'],
    ['分析与判断', '内容分析包含模型推断和测试建议，可能不完整或有误。请结合原始证据判断，不把分析当作真实收益、点击率或投放结果承诺。'],
    ['付费与取消', '正式价格及可用权益以购买时显示的套餐版本为准。取消在已付周期末生效；套餐变更预约下一周期。退款规则将在真实收费开放前明确。'],
    ['停止使用与数据处理', '可以在设置中提交账号或团队数据删除申请。必要的安全审计、交易记录或依法需保留的信息将按适用要求处理，结果通过可用联系渠道反馈。'],
    ['联系与更新', '测试期间通过工作台“团队与设置 → 问题反馈”联系支持。重要条款变化会在应用内提示；当前版本不能代替正式商业上线前的完整服务协议。'],
  ]} />;
}
export function PrivacyPage() {
  return <LegalPage title="隐私说明" intro="说明测试阶段的数据用途与访问边界。运营主体信息及完整保存期限将在正式开放前公布。" preferences sections={[
    ['账号与协作数据', '处理注册邮箱、成员关系、工作区设置以及你主动提交的收藏、笔记、分析请求和反馈，以完成认证、协作与服务支持。'],
    ['Google 登录', '选择 Google 登录时，我们接收 Google 提供的账号标识、邮箱及姓名，用于身份验证和账号显示。此授权不允许我们读取 Gmail 邮件或广告账户。'],
    ['公开广告与团队私有内容', '公开广告资料可以由平台统一采集；团队的收藏、笔记、分析、成员和账单按组织及工作区隔离。平台支持人员访问私有内容需明确授权并留有审计。'],
    ['分析与服务提供商', '内容分析需要把任务所需的输入交给已配置的服务端模型提供商处理。不要上传无权处理的个人信息、商业秘密或账号凭证。'],
    ['必要的使用记录', '记录登录、安全审计、任务状态、额度及本产品中的查看、来源跳转、媒体播放等事件，用于服务运作与排错；这些事件不会被包装成广告平台真实效果指标。'],
    ['可选网站统计', '只有在你明确允许后，我们才加载 Google Analytics 和 Microsoft Clarity。Google Analytics 用于了解公开页面访问量、访问地区及渠道来源；Clarity 用于公开页面的热力图和使用回放。供应商可能通过 Cookie、设备与网络信息区分访问；这不等于识别每位访客的真实身份。'],
    ['可选渠道与转化统计', '允许统计后，我们在自己的服务器保存本浏览器的首次来源网站、推广标签、公开落地页与匿名随机标识，并在同一浏览器中关联真实新建账号、验证成功和首次成功收藏广告，用于分析渠道效果。来源 Cookie 最长有效 30 天，不读取私有素材内容，也不将注册邮箱、账号标识或收藏内容发送给 Google Analytics 或 Clarity。更换设备、拒绝统计或来源失效的访问可能无法关联。'],
    ['统计范围与选择', '第三方统计脚本限于首页、套餐、帮助、条款和隐私页，不在登录、验证、密码重置及工作区加载。发送到 Google Analytics 的页面地址不含查询参数或片段，仅单独保留格式受限的推广渠道标签及来源网站地址，不发送邮箱、密码、工作区或认证链接。你可以拒绝或随时在下方撤回；选择保存在当前浏览器，拒绝不影响必要功能。撤回立即停止本浏览器的后续统计并通知服务器；网络中断时会提示重试，已发送记录不会因此自动删除。'],
    ['文件与访问链接', '私有文件通过服务端权限检查后提供短期有效链接。分享链接可能在有效期内被持有人访问，请仅分享给获准接收的人。'],
    ['导出与删除申请', '可在设置中提交数据相关请求。处理前可能需要确认身份和团队权限；必要的交易、安全或法定记录按适用要求保留。'],
    ['安全与联系方式', '密码和会话交由认证系统处理，凭证不进入前端页面。测试期间通过工作台反馈入口提出隐私问题；正式联系渠道与保存期限仍待发布。'],
  ]} />;
}
function LegalPage({ title, intro, sections, preferences = false }: { title: string; intro: string; sections: string[][]; preferences?: boolean }) {
  return <main className="site-document prose"><PageHeader eyebrow="服务说明 · 2026 年 10 月" title={title} description={intro} />{sections.map(([heading, body], index) => <section key={heading}><h2>{index + 1}. {heading}</h2><p>{body}</p></section>)}{preferences && <AnalyticsPreferences />}<p><Link to="/help">返回帮助中心 →</Link></p></main>;
}
export function NotFoundPage() { return <main className="site-document"><Empty title="这个页面不存在" action={<Link className="button primary" to="/">返回首页</Link>}>链接可能已经改变，也可以从工作台重新开始。</Empty></main>; }
