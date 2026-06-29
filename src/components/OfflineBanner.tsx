/**
 * Non-blocking banner shown when the sidecar can't reach the BioClaw SaaS
 * (goal M3.2). Local-first features — chat, skills, the bundled Python env —
 * keep working; only the cloud panels (GPU jobs, 工作台) are unavailable.
 */
import { useSaasReachable } from '../hooks/useSaasReachable';
import { useT } from '../lib/i18n';

export function OfflineBanner({ port }: { port: number | null }) {
  const reach = useSaasReachable(port);
  const t = useT();
  if (reach !== 'offline') return null;
  return (
    <div className="flex items-center gap-2 border-b border-amber-300/40 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-800">
      <span aria-hidden>⚠️</span>
      <span>{t('offline.banner')}</span>
    </div>
  );
}
