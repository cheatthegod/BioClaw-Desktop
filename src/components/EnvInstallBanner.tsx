/**
 * Inline banner shown at the top of the chat when the sidecar is in
 * the middle of unpacking the bundled Python env on first launch.
 *
 * Visual: thin sage bar with a spinner + the latest phase label.
 * Replaces the old modal SetupWizard for the "default" flow — the
 * user sees one line of feedback ("Unpacking local Python kernel…")
 * for ~30-60 s on the first launch after install, then it vanishes
 * and chat is fully usable. No clicks, no choices, no PyPI mirror
 * selection. Matches the OmicOS feel.
 *
 * The full SetupWizard component still exists for opt-in scenarios
 * (add `scientific` / `single-cell` extras, or repair a broken env).
 * Those code paths invoke it from Settings, not from App.tsx auto-mount.
 */
import { useEnvStore } from '../lib/env-state';

export function EnvInstallBanner() {
  const state = useEnvStore((s) => s.state);
  if (!state || state.status !== 'installing') return null;
  const phase = state.installPhase ?? 'Preparing local Python kernel';
  return (
    <div className="flex items-center gap-3 border-b border-line/40 bg-accent-soft px-4 py-2 text-[12px] text-ink-soft">
      <Spinner />
      <span className="font-medium text-ink">{phase}</span>
      <span className="text-muted">(one-time setup, ~30-60 s)</span>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin text-accent"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
