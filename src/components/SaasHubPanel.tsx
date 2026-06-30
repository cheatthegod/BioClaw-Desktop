/**
 * SaaS hub panel — native desktop access to the BioClaw website's
 * account-scoped features through the authenticated sidecar proxy (M1.1/M1.2).
 *
 * Tabs (read-mostly thin clients over /saas/*):
 *   • 账户   Account — /saas/profile + /saas/config
 *   • 配额   Quota   — /saas/quota/my-requests + request more
 *   • 知识库 KB      — /saas/kb/search?q=
 *   • 技能   Skills  — /saas/skills (the SaaS catalog; local skills live in chat)
 *
 * Covers goal M2.3 (skills, SaaS side), M2.4 (KB), M2.5 (quota), M2.8
 * (account/feedback). More website sections (projects, files, sharing, lab,
 * manage, admin) attach as further tabs.
 */
import { useState } from 'react';

import { useSaasQuery } from '../hooks/useSaasQuery';
import { saasPost, saasDelete } from '../lib/api/saas';
import { useT } from '../lib/i18n';

type TabId =
  | 'account'
  | 'quota'
  | 'kb'
  | 'skills'
  | 'projects'
  | 'papers'
  | 'lab'
  | 'shares'
  | 'contacts'
  | 'manage'
  | 'admin';

const TAB_IDS: TabId[] = [
  'account',
  'quota',
  'kb',
  'skills',
  'projects',
  'papers',
  'shares',
  'contacts',
  'lab',
  'manage',
  'admin',
];

export function SaasHubPanel({ port, onClose }: { port: number | null; onClose: () => void }) {
  const [tab, setTab] = useState<TabId>('account');
  const t = useT();
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg">
      <header className="flex items-center justify-between border-b border-line/40 px-4 py-3">
        <h2 className="text-[13px] font-semibold text-ink">{t('hub.title')}</h2>
        <button type="button" onClick={onClose} className="text-[12px] text-muted hover:text-ink">
          {t('common.close')}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-40 shrink-0 border-r border-line/40 px-2 py-3">
          {TAB_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`block w-full rounded px-3 py-1.5 text-left text-[12px] ${
                tab === id ? 'bg-accent/15 text-ink' : 'text-ink-soft hover:bg-line/20'
              }`}
            >
              {t(`hub.tab.${id}`)}
            </button>
          ))}
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === 'account' && <AccountTab port={port} />}
          {tab === 'quota' && <QuotaTab port={port} />}
          {tab === 'kb' && <KbTab port={port} />}
          {tab === 'skills' && <SkillsTab port={port} />}
          {tab === 'projects' && (
            <div className="max-w-2xl space-y-6">
              <ListSection port={port} title={t('hub.section.projects')} path="/projects" />
              <ListSection port={port} title={t('hub.section.datasets')} path="/datasets" />
            </div>
          )}
          {tab === 'papers' && (
            <ListSection port={port} title={t('hub.section.papers')} path="/paper-digest/list" />
          )}
          {tab === 'shares' && <SharesTab port={port} />}
          {tab === 'contacts' && (
            <ListSection port={port} title={t('hub.section.contacts')} path="/contacts" />
          )}
          {tab === 'lab' && (
            <ListSection port={port} title={t('hub.section.lab')} path="/lab/feed" />
          )}
          {tab === 'manage' && (
            <div className="max-w-2xl space-y-6">
              <ObjectSection
                port={port}
                title={t('hub.section.manageOverview')}
                path="/manage/overview"
              />
              <ObjectSection
                port={port}
                title={t('hub.section.manageStatus')}
                path="/manage/status"
              />
            </div>
          )}
          {tab === 'admin' && <AdminTab port={port} />}
        </section>
      </div>
    </div>
  );
}

function Loading({ q }: { q: { loading: boolean; needsAuth: boolean; error: Error | null } }) {
  const t = useT();
  if (q.needsAuth) return <p className="text-[12px] text-danger">{t('common.noAuth')}</p>;
  if (q.loading) return <p className="text-[12px] text-muted">{t('common.loading')}</p>;
  if (q.error)
    return (
      <p className="text-[12px] text-danger">{t('hub.loadFailed', { msg: q.error.message })}</p>
    );
  return null;
}

// ── Account ──────────────────────────────────────────────────────────

function AccountTab({ port }: { port: number | null }) {
  const t = useT();
  const profileQ = useSaasQuery<{ profile: Record<string, unknown> }>(port, '/profile');
  const configQ = useSaasQuery<Record<string, unknown>>(port, '/config');
  const [feedback, setFeedback] = useState('');
  const [sent, setSent] = useState(false);

  async function sendFeedback() {
    if (port == null || !feedback.trim()) return;
    try {
      await saasPost(port, '/feedback/message', { message: feedback.trim() });
      setSent(true);
      setFeedback('');
    } catch {
      /* surfaced inline below via sent flag staying false */
    }
  }

  const profile = profileQ.data?.profile ?? {};
  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">{t('hub.account')}</h3>
        <Loading q={profileQ} />
        {!profileQ.loading && (
          <dl className="mt-2 space-y-1 text-[12px]">
            {Object.entries(profile).length === 0 ? (
              <p className="text-[12px] text-muted">{t('hub.noProfile')}</p>
            ) : (
              Object.entries(profile).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-32 shrink-0 text-muted">{k}</dt>
                  <dd className="text-ink-soft">{renderValue(v)}</dd>
                </div>
              ))
            )}
          </dl>
        )}
      </div>

      <div>
        <h3 className="text-[14px] font-semibold text-ink">{t('hub.serverConfig')}</h3>
        <Loading q={configQ} />
        {configQ.data && (
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface-alt/60 p-2 font-mono text-[11px] text-ink-soft">
            {JSON.stringify(redactSecrets(configQ.data), null, 2)}
          </pre>
        )}
      </div>

      <div>
        <h3 className="text-[14px] font-semibold text-ink">{t('hub.feedback')}</h3>
        <textarea
          value={feedback}
          onChange={(e) => {
            setFeedback(e.target.value);
            setSent(false);
          }}
          rows={3}
          placeholder={t('hub.feedbackPlaceholder')}
          className="mt-2 w-full rounded border border-line/50 bg-surface px-2 py-1 text-[12px] text-ink"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            disabled={!feedback.trim() || port == null}
            onClick={() => void sendFeedback()}
            className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {t('common.send')}
          </button>
          {sent && <span className="text-[12px] text-success">{t('hub.feedbackSent')}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Quota ────────────────────────────────────────────────────────────

interface QuotaRequest {
  id?: string;
  status?: string;
  amount?: number;
  createdAt?: string;
  [k: string]: unknown;
}

function QuotaTab({ port }: { port: number | null }) {
  const t = useT();
  const q = useSaasQuery<{ requests: QuotaRequest[] }>(port, '/quota/my-requests');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);

  async function request() {
    if (port == null) return;
    try {
      await saasPost(port, '/quota/request', { reason: reason.trim() });
      setSubmitted(true);
      setReason('');
      q.refetch();
    } catch {
      /* ignore; list refetch will reflect server state */
    }
  }

  const requests = q.data?.requests ?? [];
  return (
    <div className="max-w-2xl space-y-4">
      <h3 className="text-[14px] font-semibold text-ink">{t('hub.quotaTitle')}</h3>
      <Loading q={q} />
      {!q.loading && (
        <ul className="space-y-1">
          {requests.length === 0 ? (
            <p className="text-[12px] text-muted">{t('hub.noQuota')}</p>
          ) : (
            requests.map((r, i) => (
              <li key={r.id ?? i} className="flex items-center gap-3 text-[12px]">
                <span className="rounded bg-line/30 px-2 py-0.5 text-[11px] text-muted">
                  {r.status ?? '—'}
                </span>
                <span className="text-ink-soft">{r.createdAt ?? ''}</span>
              </li>
            ))
          )}
        </ul>
      )}
      <div>
        <input
          type="text"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setSubmitted(false);
          }}
          placeholder={t('hub.quotaReasonPlaceholder')}
          className="w-full rounded border border-line/50 bg-surface px-2 py-1 text-[12px] text-ink"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            disabled={port == null}
            onClick={() => void request()}
            className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {t('hub.requestQuota')}
          </button>
          {submitted && <span className="text-[12px] text-success">{t('hub.submitted')}</span>}
        </div>
      </div>
    </div>
  );
}

// ── KB search ────────────────────────────────────────────────────────

interface KbHit {
  title?: string;
  text?: string;
  path?: string;
  score?: number;
  [k: string]: unknown;
}

function KbTab({ port }: { port: number | null }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('');
  const q = useSaasQuery<{ ok: boolean; hits: KbHit[] }>(
    port,
    `/kb/search?q=${encodeURIComponent(active)}`,
    { enabled: active.length > 0 },
  );
  const hits = q.data?.hits ?? [];
  return (
    <div className="max-w-2xl space-y-3">
      <h3 className="text-[14px] font-semibold text-ink">{t('hub.kbTitle')}</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setActive(query.trim());
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('hub.kbPlaceholder')}
          className="flex-1 rounded border border-line/50 bg-surface px-2 py-1 text-[12px] text-ink"
        />
        <button
          type="submit"
          className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white"
        >
          {t('common.search')}
        </button>
      </form>
      {active && <Loading q={q} />}
      {active && !q.loading && (
        <ul className="space-y-2">
          {hits.length === 0 ? (
            <p className="text-[12px] text-muted">{t('hub.noHits')}</p>
          ) : (
            hits.map((h, i) => (
              <li key={h.path ?? i} className="rounded border border-line/30 px-3 py-2">
                <div className="text-[12px] font-medium text-ink">
                  {h.title ?? h.path ?? t('hub.result')}
                </div>
                {h.text && <p className="mt-0.5 text-[11px] text-muted line-clamp-3">{h.text}</p>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ── Skills (SaaS catalog) ────────────────────────────────────────────

interface SaasSkill {
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  category?: string;
  [k: string]: unknown;
}

function SkillsTab({ port }: { port: number | null }) {
  const t = useT();
  const q = useSaasQuery<{ skills?: SaasSkill[] } | SaasSkill[]>(port, '/skills');
  const skills: SaasSkill[] = Array.isArray(q.data) ? q.data : (q.data?.skills ?? []);
  return (
    <div className="max-w-2xl space-y-3">
      <h3 className="text-[14px] font-semibold text-ink">{t('hub.skillsTitle')}</h3>
      <Loading q={q} />
      {!q.loading && (
        <ul className="space-y-1">
          {skills.length === 0 ? (
            <p className="text-[12px] text-muted">{t('hub.noCloudSkills')}</p>
          ) : (
            skills.map((s, i) => (
              <li key={s.id ?? i} className="rounded px-2 py-1 text-[12px] hover:bg-line/20">
                <span className="font-medium text-ink">{s.displayName ?? s.name ?? s.id}</span>
                {s.category && <span className="ml-2 text-[11px] text-muted">{s.category}</span>}
                {s.description && (
                  <p className="text-[11px] text-muted line-clamp-2">{s.description}</p>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ── generic sections (breadth features: projects, datasets, papers, lab, …) ──

function extractItems(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    for (const v of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

function itemTitle(it: Record<string, unknown>): string {
  for (const k of ['name', 'title', 'displayName', 'label', 'subject', 'id', 'email']) {
    const v = it[k];
    if (typeof v === 'string' && v) return v;
  }
  return JSON.stringify(it).slice(0, 80);
}

function itemSubtitle(it: Record<string, unknown>): string {
  for (const k of ['description', 'summary', 'text', 'status', 'createdAt', 'updatedAt']) {
    const v = it[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** Fetch a SaaS endpoint and render whatever array it returns as a card list. */
/**
 * Sharing tab (goal M2.7): list shares I've created (/share/my) PLUS the
 * primary actions — create a new share of the current chat (POST /share/chat,
 * default `unlisted` mode → a `/share/<id>` link) and revoke one (DELETE
 * /share/<id>). All ride the keystone /saas proxy.
 */
function SharesTab({ port }: { port: number | null }) {
  const t = useT();
  const q = useSaasQuery<unknown>(port, '/share/my');
  const items = extractItems(q.data);
  const [busy, setBusy] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (port == null) return;
    setBusy(true);
    setErr(null);
    setCreatedUrl(null);
    try {
      const r = await saasPost<{ ok?: boolean; url?: string; error?: string }>(
        port,
        '/share/chat',
        { mode: 'unlisted' },
      );
      if (r.url) setCreatedUrl(r.url);
      else setErr(r.error ?? t('hub.share.createFailed'));
      q.refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (port == null) return;
    setErr(null);
    try {
      await saasDelete(port, `/share/${encodeURIComponent(id)}`);
      q.refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-ink">{t('hub.section.shares')}</h3>
        <button
          type="button"
          disabled={busy || port == null}
          onClick={() => void create()}
          className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
        >
          {busy ? t('hub.share.creating') : t('hub.share.create')}
        </button>
      </div>
      {createdUrl && (
        <p className="mt-2 text-[12px] text-success">
          {t('hub.share.created', { url: createdUrl })}
        </p>
      )}
      {err && <p className="mt-2 text-[12px] text-danger">{err}</p>}
      <Loading q={q} />
      {!q.loading && !q.error && !q.needsAuth && (
        <ul className="mt-2 space-y-1">
          {items.length === 0 ? (
            <p className="text-[12px] text-muted">{t('hub.empty')}</p>
          ) : (
            items.slice(0, 100).map((it, i) => (
              <li
                key={(it.id as string) ?? i}
                className="flex items-start justify-between gap-3 rounded border border-line/30 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-[12px] font-medium text-ink">{itemTitle(it)}</div>
                  {itemSubtitle(it) && (
                    <p className="mt-0.5 text-[11px] text-muted line-clamp-2">{itemSubtitle(it)}</p>
                  )}
                </div>
                {typeof it.id === 'string' && (
                  <button
                    type="button"
                    onClick={() => void revoke(it.id as string)}
                    className="shrink-0 text-[11px] text-danger hover:underline"
                  >
                    {t('hub.share.revoke')}
                  </button>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function ListSection({ port, title, path }: { port: number | null; title: string; path: string }) {
  const t = useT();
  const q = useSaasQuery<unknown>(port, path);
  const items = extractItems(q.data);
  return (
    <div>
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      <Loading q={q} />
      {!q.loading && !q.error && !q.needsAuth && (
        <ul className="mt-2 space-y-1">
          {items.length === 0 ? (
            <p className="text-[12px] text-muted">{t('hub.empty')}</p>
          ) : (
            items.slice(0, 100).map((it, i) => (
              <li key={(it.id as string) ?? i} className="rounded border border-line/30 px-3 py-2">
                <div className="text-[12px] font-medium text-ink">{itemTitle(it)}</div>
                {itemSubtitle(it) && (
                  <p className="mt-0.5 text-[11px] text-muted line-clamp-2">{itemSubtitle(it)}</p>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** Fetch a SaaS endpoint and render the returned object as key/value rows. */
function ObjectSection({
  port,
  title,
  path,
}: {
  port: number | null;
  title: string;
  path: string;
}) {
  const q = useSaasQuery<Record<string, unknown>>(port, path);
  return (
    <div>
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      <Loading q={q} />
      {q.data && (
        <pre className="mt-2 max-h-56 overflow-auto rounded bg-surface-alt/60 p-2 font-mono text-[11px] text-ink-soft">
          {JSON.stringify(redactSecrets(q.data), null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Admin tab — only shows data if the session is an admin (else 403 → hidden). */
function AdminTab({ port }: { port: number | null }) {
  const t = useT();
  const overview = useSaasQuery<Record<string, unknown>>(port, '/admin/overview');
  // Admins get 200; everyone else gets 403/404 — treat any failure (or
  // missing auth) as "not an admin" and hide the surface.
  if (overview.needsAuth || overview.error != null) {
    return <p className="text-[12px] text-muted">{t('hub.noAdmin')}</p>;
  }
  if (overview.loading) return <p className="text-[12px] text-muted">{t('common.loading')}</p>;
  return (
    <div className="max-w-2xl space-y-6">
      <ObjectSection port={port} title={t('hub.section.adminOverview')} path="/admin/overview" />
      <ListSection port={port} title={t('hub.section.users')} path="/admin/users" />
    </div>
  );
}

function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Hide token/secret-ish fields from the rendered config blob. */
function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = /token|secret|password|key/i.test(k) ? '••••••' : v;
  }
  return out;
}
