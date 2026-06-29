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
import { useI18nStore, useT, type Locale } from '../lib/i18n';

export function SettingsDrawer() {
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const t = useT();

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-80 flex-col border-l border-line/40 bg-surface shadow-xl">
      <div className="flex items-center justify-between border-b border-line/40 px-4 py-3">
        <h2 className="text-[13px] font-semibold text-ink">设置 · Settings</h2>
        <button
          type="button"
          onClick={toggleSettings}
          className="text-[12px] text-muted hover:text-ink"
        >
          {t('common.close')}
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Section title={t('settings.account')}>
          <AccountRow />
        </Section>
        <Section title={t('settings.language')}>
          <LanguageRow />
        </Section>
      </div>
    </div>
  );
}

function LanguageRow() {
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);
  const opts: { id: Locale; label: string }[] = [
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
  ];
  return (
    <div className="flex gap-2">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => setLocale(o.id)}
          className={`rounded px-3 py-1 text-[12px] ${
            locale === o.id
              ? 'bg-accent text-white'
              : 'border border-line/50 text-ink-soft hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
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
  const t = useT();
  const email = useAuthStore((s) => s.email);
  const logout = useAuthStore((s) => s.logout);
  const busy = useAuthStore((s) => s.busy);
  if (!email) {
    return <div className="text-[12px] text-muted">{t('account.notSignedIn')}</div>;
  }
  return (
    <div className="space-y-2">
      <div className="rounded border border-line/40 bg-bg px-2.5 py-2 text-[12px] text-ink">
        <div className="text-[10px] uppercase tracking-wider text-muted">
          {t('account.signedIn')}
        </div>
        <div className="mt-0.5 truncate font-mono">{email}</div>
      </div>
      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        className="w-full rounded border border-line/60 bg-surface px-2.5 py-1.5 text-[12px] text-ink-soft hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? t('account.processing') : t('account.logout')}
      </button>
    </div>
  );
}
