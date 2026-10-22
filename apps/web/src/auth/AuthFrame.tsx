import { useEffect, useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Brand } from '../client/brand/Brand';
import { getStudioPublicOverview, useQuery } from 'wasp/client/operations';
import { SiteFooter } from '../client/studio/StudioPublic';
import { AuthLanguagePicker, useAuthLocale } from './locale';
import './auth.css';
import './studio-auth.css';
import { appSurface, customerAppOrigin } from '../client/app-surface';

function PublicLink({ path, className, children }: { path: string; className?: string; children: ReactNode }) {
  return appSurface() === 'admin' ? <a className={className} href={customerAppOrigin() + path}>{children}</a> : <Link className={className} to={path}>{children}</Link>;
}

function AuthCreative(){
  const query=useQuery(getStudioPublicOverview,{}, {refetchOnWindowFocus:false});
  const data=query.data as {ads?:Array<{id:string;advertiserName:string|null;mediaUrl:string|null}>}|undefined;
  const ad=data?.ads?.find(row=>row.mediaUrl);
  return <figure className="auth-studio-creative">{ad?.mediaUrl?<img src={ad.mediaUrl} alt={ad.advertiserName?`${ad.advertiserName} 广告素材`:'公开广告素材'} />:<div><img src="/ui/assets/brand.svg" alt=""/><span>广告素材 · 文案 · 落地页</span></div>}{ad&&<figcaption><span>广告资料库</span><strong>{ad.advertiserName||'来源广告素材'}</strong></figcaption>}</figure>;
}
/** Shared, localized layout for the complete account lifecycle. */
export function AuthFrame({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { t, href } = useAuthLocale();
  const admin = appSurface() === 'admin';
  const headingId = useId();

  useEffect(() => {
    const originalTitle = document.title;
    document.title = `${title} · AdTrender`;
    return () => { document.title = originalTitle; };
  }, [title]);

  return <><div className={`auth-shell ${admin?'auth-admin':'studio-auth'}`}>
    <aside className="auth-brand-panel">
      <Brand className="auth-brand" to={href(admin ? '/app/admin' : '/')} />
      <div className="auth-brand-content">
        <div className="auth-brand-copy">
          {admin ? <><h2>{t('admin.brand')}</h2><p>{t('admin.description')}</p></> : <><h2>{t('brand.heading')}<br /><span>{t('brand.accent')}</span></h2><p>{t('brand.body')}</p></>}
        </div>
        {!admin && <AuthCreative/>}
      </div>
    </aside>
    <div className="auth-main-panel">
      <header className="auth-topbar">
        <PublicLink className="auth-home" path={href('/')}><ArrowLeft size={16} aria-hidden="true" /><span>{t(admin ? 'admin.customerSite' : 'nav.home')}</span></PublicLink>
        <Brand className="auth-mobile-brand" to={href(admin ? '/app/admin' : '/')} />
        <AuthLanguagePicker />
      </header>
      <main className="auth-main" aria-labelledby={headingId}>
        <div className="auth-content">
          <div className="auth-heading">
            <h1 id={headingId}>{title}</h1>
            {description && <p>{description}</p>}
          </div>
          {children}
        </div>
      </main>
      <footer className="auth-footer">
        <nav><PublicLink path={href('/terms')}>{t('nav.terms')}</PublicLink><PublicLink path={href('/privacy')}>{t('nav.privacy')}</PublicLink></nav>
        <PublicLink path={href('/help')}>{t('nav.help')}</PublicLink>
      </footer>
    </div>
  </div>{!admin&&<SiteFooter/>}</>;
}
