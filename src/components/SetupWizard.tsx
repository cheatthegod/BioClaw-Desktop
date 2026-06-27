/**
 * First-run setup wizard. Shows once the user has signed in (login
 * step done) but the sidecar reports `env.status === 'needs-setup'`.
 *
 * Three screens in a state machine:
 *   1. Welcome — explains what's about to happen (download CPython +
 *      pip wheels), lets the user pick PyPI mirror + optional extras.
 *   2. Progress — live console-style log of `uv python install` +
 *      `uv sync`, with the current "phase" surfaced as a headline.
 *      Bound to env-state.ts; tolerates the wizard being closed and
 *      reopened mid-install.
 *   3. Done — quick confirmation + "Continue to chat" button.
 *
 * Style: matches the LoginGate exactly — editorial sage card on the
 * sage page, serif H1, JetBrains Mono for the log lines.
 *
 * Mirror selection mirrors OmicOS's auto / pypi / aliyun / tuna —
 * China users get a fast wheel-fetch out of the box. We ship a
 * fourth "auto-probe" mode that defers to the sidecar; the sidecar's
 * env/setup endpoint will pick the first mirror to respond < 800 ms.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEnvStore, startSetup, type EnvState } from '../lib/env-state';

type Mirror = 'auto' | 'pypi' | 'aliyun' | 'tuna' | 'custom';

interface SetupWizardProps {
  port: number;
  /** Called once env transitions to 'ready'. Parent dismisses. */
  onDone: () => void;
}

const MIRROR_PRESETS: Record<Exclude<Mirror, 'auto' | 'custom'>, string> = {
  pypi: 'https://pypi.org/simple',
  aliyun: 'https://mirrors.aliyun.com/pypi/simple',
  tuna: 'https://pypi.tuna.tsinghua.edu.cn/simple',
};

const EXTRA_OPTIONS: Array<{ key: string; title: string; subtitle: string }> = [
  {
    key: 'scientific',
    title: 'Scientific stack',
    subtitle: 'numpy / pandas / scipy / matplotlib — adds ≈300 MB',
  },
  {
    key: 'single-cell',
    title: 'Single-cell',
    subtitle: 'scanpy + anndata — only needed for sc.* skills',
  },
  {
    key: 'phylo',
    title: 'Phylogenetics',
    subtitle: 'phykit + dendropy — tree / MSA quality metrics',
  },
];

export function SetupWizard({ port, onDone }: SetupWizardProps) {
  const envState = useEnvStore((s) => s.state);
  const installing = useEnvStore((s) => s.installing);
  const refresh = useEnvStore((s) => s.refresh);

  const [view, setView] = useState<'welcome' | 'progress' | 'done'>('welcome');
  const [mirror, setMirror] = useState<Mirror>('auto');
  const [customMirror, setCustomMirror] = useState('');
  const [extras, setExtras] = useState<string[]>([]);

  // Refresh state on mount; if the env is already 'ready' when the
  // wizard renders (e.g. user installed via CLI, opened the GUI later)
  // skip straight to done.
  useEffect(() => {
    void refresh(port);
  }, [port, refresh]);

  useEffect(() => {
    if (envState?.status === 'ready' && !installing) setView('done');
  }, [envState, installing]);

  const abortRef = useRef<AbortController | null>(null);

  const indexUrl = useMemo(() => {
    if (mirror === 'auto') return undefined;
    if (mirror === 'custom') return customMirror.trim() || undefined;
    return MIRROR_PRESETS[mirror];
  }, [mirror, customMirror]);

  const onStart = async () => {
    setView('progress');
    abortRef.current = new AbortController();
    try {
      await startSetup(
        port,
        {
          ...(extras.length > 0 ? { extras } : {}),
          ...(indexUrl ? { indexUrl } : {}),
        },
        abortRef.current.signal,
      );
      await refresh(port);
      setView('done');
    } catch {
      // env-state.ts already stored the error message; the progress
      // view renders it as a sticky banner.
    }
  };

  const onCancel = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg p-6">
      <div className="w-full max-w-2xl rounded-xl border border-line/40 bg-surface p-8">
        {view === 'welcome' ? (
          <WelcomeView
            envState={envState}
            mirror={mirror}
            setMirror={setMirror}
            customMirror={customMirror}
            setCustomMirror={setCustomMirror}
            extras={extras}
            setExtras={setExtras}
            onStart={() => void onStart()}
          />
        ) : view === 'progress' ? (
          <ProgressView onCancel={onCancel} />
        ) : (
          <DoneView projectDir={envState?.projectDir ?? ''} onContinue={onDone} />
        )}
      </div>
    </div>
  );
}

function WelcomeView(props: {
  envState: EnvState | null;
  mirror: Mirror;
  setMirror: (m: Mirror) => void;
  customMirror: string;
  setCustomMirror: (s: string) => void;
  extras: string[];
  setExtras: (e: string[]) => void;
  onStart: () => void;
}) {
  const toggleExtra = (key: string) =>
    props.setExtras(
      props.extras.includes(key) ? props.extras.filter((x) => x !== key) : [...props.extras, key],
    );

  return (
    <div>
      <h1 className="font-serif text-[32px] leading-tight text-ink">Set up the local kernel</h1>
      <p className="mt-2 text-sm text-muted">
        BioClaw ships a managed Python that runs the bio-skill scripts locally. We'll download CPython 3.11
        and pin the dependency lockfile. About 230 MB of wheels for the base set; nothing leaves your
        machine after install.
      </p>

      <Section title="PyPI mirror" subtitle="Where to fetch the wheels from. Auto probes each option and picks the fastest.">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MirrorChip active={props.mirror === 'auto'} onClick={() => props.setMirror('auto')} label="Auto" hint="Probe + pick" />
          <MirrorChip active={props.mirror === 'pypi'} onClick={() => props.setMirror('pypi')} label="PyPI" hint="pypi.org" />
          <MirrorChip active={props.mirror === 'aliyun'} onClick={() => props.setMirror('aliyun')} label="Aliyun" hint="mirrors.aliyun.com" />
          <MirrorChip active={props.mirror === 'tuna'} onClick={() => props.setMirror('tuna')} label="TUNA" hint="清华源" />
        </div>
        <button
          type="button"
          onClick={() => props.setMirror('custom')}
          className={
            'mt-2 text-[11px] underline-offset-2 hover:underline ' +
            (props.mirror === 'custom' ? 'text-accent' : 'text-muted')
          }
        >
          Use a custom URL…
        </button>
        {props.mirror === 'custom' ? (
          <input
            value={props.customMirror}
            onChange={(e) => props.setCustomMirror(e.target.value)}
            placeholder="https://mirrors.example.com/pypi/simple"
            className="mt-2 block w-full rounded-md border border-line/60 bg-bg px-3 py-2 font-mono text-xs text-ink placeholder:text-muted-2 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          />
        ) : null}
      </Section>

      <Section title="Optional add-ons" subtitle="Adds extras to the base env. You can install or remove these later via Settings.">
        <div className="space-y-2">
          {EXTRA_OPTIONS.map((opt) => {
            const checked = props.extras.includes(opt.key);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => toggleExtra(opt.key)}
                className={
                  'flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition ' +
                  (checked
                    ? 'border-accent bg-accent-soft'
                    : 'border-line/60 bg-bg hover:border-line')
                }
              >
                <Checkbox checked={checked} />
                <div>
                  <div className="text-[13px] font-semibold text-ink">{opt.title}</div>
                  <div className="text-[11px] text-muted">{opt.subtitle}</div>
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="mt-6 flex items-center justify-between">
        <p className="text-[11px] text-muted">
          Installs to <span className="font-mono">{props.envState?.projectDir ?? '~/.bioclaw/env'}</span>
        </p>
        <button
          type="button"
          onClick={props.onStart}
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent/90"
        >
          Install
        </button>
      </div>
    </div>
  );
}

function ProgressView({ onCancel }: { onCancel: () => void }) {
  const phase = useEnvStore((s) => s.installPhase);
  const log = useEnvStore((s) => s.installLog);
  const err = useEnvStore((s) => s.installError);
  const installing = useEnvStore((s) => s.installing);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <div>
      <h1 className="font-serif text-[28px] leading-tight text-ink">
        {err ? 'Setup interrupted' : installing ? 'Installing…' : 'Setting up'}
      </h1>
      <p className="mt-1 text-sm text-muted">{phase ?? 'Initialising…'}</p>

      <div
        ref={scrollRef}
        className="mt-4 h-64 overflow-y-auto rounded-md border border-line/60 bg-bg p-3 font-mono text-[11px] leading-relaxed text-ink-soft"
      >
        {log.length === 0 ? (
          <div className="text-muted-2">Waiting for uv to start…</div>
        ) : (
          log.map((entry, i) => (
            <div key={i} className={entry.stream === 'stderr' ? 'text-warning' : ''}>
              {entry.line}
            </div>
          ))
        )}
      </div>

      {err ? (
        <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          {err}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end">
        {installing ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line/60 bg-surface px-4 py-2 text-sm font-medium text-ink-soft hover:bg-bg"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DoneView({ projectDir, onContinue }: { projectDir: string; onContinue: () => void }) {
  return (
    <div className="text-center">
      <h1 className="font-serif text-[32px] leading-tight text-ink">All set</h1>
      <p className="mt-2 text-sm text-muted">
        Python kernel ready at <span className="font-mono text-ink-soft">{projectDir}</span>. You can re-run setup
        from Settings → Account → Repair env at any time.
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="mt-6 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent/90"
      >
        Continue to chat
      </button>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">{title}</h3>
      <p className="mt-0.5 text-[11px] text-muted-2">{subtitle}</p>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function MirrorChip({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md border px-3 py-2 text-left transition ' +
        (active ? 'border-accent bg-accent-soft' : 'border-line/60 bg-bg hover:border-line')
      }
    >
      <div className="text-[12px] font-semibold text-ink">{label}</div>
      <div className="mt-0.5 truncate text-[10px] text-muted">{hint}</div>
    </button>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <div
      className={
        'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ' +
        (checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface')
      }
    >
      {checked ? (
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 fill-current" aria-hidden>
          <path d="M10.5 3.5L4.75 9.25 1.5 6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </div>
  );
}
