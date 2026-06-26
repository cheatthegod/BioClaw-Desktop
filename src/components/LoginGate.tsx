/**
 * First-run login screen. Two steps:
 *   1. Enter email -> click "Send code"
 *   2. Enter 6-digit code from email -> click "Sign in"
 *
 * On success the auth store transitions to loginStep='done' and the
 * parent (App.tsx) swaps over to the main app shell.
 *
 * Visual style mirrors the rest of the desktop UI: zinc-tinted neutral
 * background, teal primary action, subtle border on the card. We
 * deliberately keep the chrome minimal — this is the first thing the
 * user sees on every fresh install.
 */
import { useEffect, useState } from 'react';
import { useAuthStore } from '../lib/auth-state';

export function LoginGate() {
  const step = useAuthStore((s) => s.loginStep);
  if (step === 'done') return null;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-gradient-to-br from-zinc-50 to-teal-50/30 p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-xl">
        <Header />
        {step === 'enter-email' ? <EmailStep /> : <CodeStep />}
        <Footer />
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="mb-6 text-center">
      <h1 className="text-2xl font-semibold text-zinc-900">BioClaw Desktop</h1>
      <p className="mt-1 text-sm text-zinc-500">Sign in with your BioClaw email to get started.</p>
    </div>
  );
}

function Footer() {
  return (
    <p className="mt-6 text-center text-xs text-zinc-400">
      We don't store passwords — you'll get a one-time code by email.
    </p>
  );
}

function EmailStep() {
  const pendingEmail = useAuthStore((s) => s.pendingEmail);
  const setEmail = useAuthStore((s) => s.setEmail);
  const submitEmail = useAuthStore((s) => s.submitEmail);
  const busy = useAuthStore((s) => s.busy);
  const errorText = useAuthStore((s) => s.errorText);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submitEmail();
      }}
      className="space-y-4"
    >
      <div>
        <label htmlFor="email" className="block text-xs font-medium uppercase tracking-wide text-zinc-600">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          value={pendingEmail}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
          placeholder="you@university.edu"
          disabled={busy}
        />
      </div>
      {errorText ? <ErrorBanner message={errorText} /> : null}
      <button
        type="submit"
        disabled={busy || pendingEmail.length === 0}
        className="w-full rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
      >
        {busy ? 'Sending…' : 'Send code'}
      </button>
    </form>
  );
}

function CodeStep() {
  const pendingEmail = useAuthStore((s) => s.pendingEmail);
  const submitCode = useAuthStore((s) => s.submitCode);
  const goBack = useAuthStore((s) => s.goBack);
  const busy = useAuthStore((s) => s.busy);
  const errorText = useAuthStore((s) => s.errorText);
  const [code, setCode] = useState('');

  // Strip non-digits + cap at 8 chars (SaaS uses 6, but tolerate longer).
  const onCodeChange = (raw: string) => setCode(raw.replace(/\D+/g, '').slice(0, 8));

  // Auto-focus on mount so the user just types.
  useEffect(() => {
    const el = document.getElementById('otp-code') as HTMLInputElement | null;
    el?.focus();
  }, []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submitCode(code);
      }}
      className="space-y-4"
    >
      <p className="text-sm text-zinc-600">
        We sent a 6-digit code to <span className="font-medium text-zinc-900">{pendingEmail}</span>.
      </p>
      <div>
        <label htmlFor="otp-code" className="block text-xs font-medium uppercase tracking-wide text-zinc-600">
          Code
        </label>
        <input
          id="otp-code"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={8}
          required
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-center font-mono text-xl tracking-[0.4em] text-zinc-900 placeholder:text-zinc-300 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
          placeholder="••••••"
          disabled={busy}
        />
      </div>
      {errorText ? <ErrorBanner message={errorText} /> : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={goBack}
          disabled={busy}
          className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={busy || code.length < 4}
          className="flex-1 rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          {busy ? 'Verifying…' : 'Sign in'}
        </button>
      </div>
    </form>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </div>
  );
}
