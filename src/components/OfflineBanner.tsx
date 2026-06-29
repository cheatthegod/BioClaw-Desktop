/**
 * Non-blocking banner shown when the sidecar can't reach the BioClaw SaaS
 * (goal M3.2). Local-first features — chat, skills, the bundled Python env —
 * keep working; only the cloud panels (GPU jobs, 工作台) are unavailable.
 */
import { useSaasReachable } from '../hooks/useSaasReachable';

export function OfflineBanner({ port }: { port: number | null }) {
  const reach = useSaasReachable(port);
  if (reach !== 'offline') return null;
  return (
    <div className="flex items-center gap-2 border-b border-amber-300/40 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-800">
      <span aria-hidden>⚠️</span>
      <span>离线 — 云端功能（GPU 工具、工作台）暂不可用。本地聊天、技能与 Python 环境仍可使用。</span>
    </div>
  );
}
