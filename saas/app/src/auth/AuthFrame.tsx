import { useEffect, useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Brand } from '../client/brand/Brand';
import creativeAtlas from '../client/landing/creative-atlas.png';
import { AuthLanguagePicker, useAuthLocale } from './locale';
import './auth.css';
import { appSurface, customerAppOrigin } from '../client/app-surface';

function PublicLink({ path, className, children }: { path: string; className?: string; children: ReactNode }) {
  return appSurface() === 'admin' ? <a className={className} href={customerAppOrigin() + path}>{children}</a> : <Link className={className} to={path}>{children}</Link>;
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
    document.title = `${title} · AdThrender`;
    return () => { document.title = originalTitle; };
  }, [title]);

  return <div className="auth-shell">
    <aside className="auth-brand-panel">
      <Brand className="auth-brand" to={href(admin ? '/app/admin' : '/')} />
      <div className="auth-brand-content">
        <div className="auth-brand-copy">
          {admin ? <><h2>{t('admin.brand')}</h2><p>{t('admin.description')}</p></> : <><h2>{t('brand.heading')}<br /><span>{t('brand.accent')}</span></h2><p>{t('brand.body')}</p></>}
        </div>
        {!admin && <figure className="auth-creative">
          <div className="auth-creative-images" aria-hidden="true">
            <div className="auth-creative-image auth-creative-shoe" style={{ backgroundImage: `url(${creativeAtlas})` }} />
            <div className="auth-creative-image auth-creative-skin" style={{ backgroundImage: `url(${creativeAtlas})` }} />
          </div>
          <figcaption>{t('brand.sample')}</figcaption>
        </figure>}
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
  </div>;
}
