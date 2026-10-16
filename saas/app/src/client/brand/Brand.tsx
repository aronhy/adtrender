import { Link } from 'react-router';
import './brand.css';

/** AdThrender's A/lightning mark, redrawn as a scalable vector. */
export function Brand({ className = '', label = 'AdThrender', domain = false, to = '/' }: { className?: string; label?: string; domain?: boolean; to?: string }) {
  return <Link to={to} className={`at-brand ${className}`} aria-label={label}>
    <svg className="at-mark" viewBox="0 0 104 96" fill="none" aria-hidden="true"><path fill="#ff6b32" d="M8 88 52 8H75L96 88H71L64 61 73 52H56L65 30 31 62H47L34 88Z" /></svg>
    <span className="at-wordmark">AdThrender{domain && <small>adtrender.com</small>}</span>
  </Link>;
}
