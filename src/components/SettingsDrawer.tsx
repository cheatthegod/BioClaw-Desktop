/**
 * Right-hand drawer for app settings. Account + Logout for now; future
 * phases will add: Python env extras toggle, sidecar diagnostics, MCP
 * server list, and a "Repair env" button.
 *
 * History: this used to expose a "运行模式" mode switch (云端 vs 本地)
 * plus remote/local URL inputs. Both went away with the iframe drop in
 * preview13 — the desktop now only has one mode (local-via-bundled
 * sidecar) and one upstream (chat.bioclaw.tech, baked in).
 */
import { useAppStore } from '../lib/store';
import { useAuthStore } from '../lib/auth-state';

export function SettingsDrawer() {
  const toggleSettings = useAppStore((s) => s.toggleSettings);

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-80 flex-col border-l border-line/40 bg-surface shadow-xl">
      <div className="flex items-center justify-between border-b border-line/40 px-4 py-3">
        <h2 className="text-[13px] font-semibold text-ink">设置</h2>
        <button
          type="button"
          onClick={toggleSettings}
          className="text-[12px] text-muted hover:text-ink"
        >
          关闭
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Section title="账户">
          <AccountRow />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      {children}
    </section>
  );
}

function AccountRow() {
  const email = useAuthStore((s) => s.email);
  const logout = useAuthStore((s) => s.logout);
  const busy = useAuthStore((s) => s.busy);
  if (!email) {
    return <div className="text-[12px] text-muted">未登录</div>;
  }
  return (
    <div className="space-y-2">
      <div className="rounded border border-line/40 bg-bg px-2.5 py-2 text-[12px] text-ink">
        <div className="text-[10px] uppercase tracking-wider text-muted">已登录</div>
        <div className="mt-0.5 truncate font-mono">{email}</div>
      </div>
      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        className="w-full rounded border border-line/60 bg-surface px-2.5 py-1.5 text-[12px] text-ink-soft hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? '处理中…' : '登出'}
      </button>
    </div>
  );
}
