import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { appSurface, surfaceDestination } from './app-surface';

function ExternalRedirect({ to }: { to: string }) {
  useEffect(() => { window.location.replace(to); }, [to]);
  return null;
}

/** Evaluate before mounting workspace queries, admin modules or public pages. */
export function SurfaceBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const destination = surfaceDestination(location.pathname, location.search, appSurface(), location.hash);
  if (destination?.type === 'external') return <ExternalRedirect to={destination.to} />;
  if (destination?.type === 'internal') return <Navigate to={destination.to} replace />;
  return children;
}
