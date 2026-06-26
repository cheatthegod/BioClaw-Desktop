/**
 * Zustand store for the desktop auth/session state. Three responsibilities:
 *
 *   1. Hold the current user identity (email + token) so any component
 *      can render a `Signed in as foo@bar` chip without prop drilling.
 *   2. Drive the LoginGate state machine (email -> code -> ready).
 *   3. Expose `logout()` so the Settings drawer can wipe state +
 *      keychain in one call.
 *
 * Token storage policy:
 *   - In-memory: yes (so chat-state can read it on every send without
 *     a keychain hop).
 *   - Disk: yes, via OS keychain through credentials.save (see auth.ts).
 *   - localStorage / sessionStorage / Zustand persist: NEVER.
 */
import { create } from 'zustand';
import { requestOtp, verifyOtp, persistSession, clearStoredSession, type AuthError } from './auth';

export type LoginStep = 'enter-email' | 'enter-code' | 'done';

interface AuthState {
  email: string | null;
  token: string | null;
  loginStep: LoginStep;
  /** The email being entered / verified, decoupled from the persisted email until verify succeeds. */
  pendingEmail: string;
  /** True while a fetch is in flight. */
  busy: boolean;
  errorText: string | null;

  setEmail: (email: string) => void;
  /** Step 1 — POST send-otp. Advances to enter-code on 2xx. */
  submitEmail: () => Promise<void>;
  /** Step 2 — POST verify-otp. Stores token + transitions to done. */
  submitCode: (code: string) => Promise<void>;
  /** Drop in the existing token after init.ts loads it from keychain. */
  hydrate: (email: string, token: string) => void;
  /** Wipe in-memory + keychain. Returns to enter-email. */
  logout: () => Promise<void>;
  /** Move back from enter-code to enter-email (e.g. user typo'd email). */
  goBack: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  email: null,
  token: null,
  loginStep: 'enter-email',
  pendingEmail: '',
  busy: false,
  errorText: null,

  setEmail: (email) => set({ pendingEmail: email, errorText: null }),

  submitEmail: async () => {
    const email = get().pendingEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      set({ errorText: 'Please enter a valid email address.' });
      return;
    }
    set({ busy: true, errorText: null });
    try {
      await requestOtp(email);
      set({ busy: false, loginStep: 'enter-code', pendingEmail: email });
    } catch (err) {
      const e = err as AuthError;
      set({ busy: false, errorText: e.message ?? 'Failed to send code.' });
    }
  },

  submitCode: async (code) => {
    const email = get().pendingEmail;
    const trimmed = code.trim();
    if (!email) {
      set({ errorText: 'Email is missing — go back and re-enter it.' });
      return;
    }
    if (!/^\d{4,8}$/.test(trimmed)) {
      set({ errorText: 'Code should be the 6-digit number we emailed you.' });
      return;
    }
    set({ busy: true, errorText: null });
    try {
      const { token } = await verifyOtp(email, trimmed);
      await persistSession(email, token);
      set({ busy: false, email, token, loginStep: 'done', errorText: null });
    } catch (err) {
      const e = err as AuthError;
      set({ busy: false, errorText: e.message ?? 'Invalid code.' });
    }
  },

  hydrate: (email, token) => {
    set({ email, token, loginStep: 'done', pendingEmail: email, errorText: null });
  },

  logout: async () => {
    set({ busy: true });
    try {
      await clearStoredSession();
    } catch {
      /* if the keychain hiccups we still want to clear in-memory state */
    }
    set({
      email: null,
      token: null,
      pendingEmail: '',
      loginStep: 'enter-email',
      busy: false,
      errorText: null,
    });
  },

  goBack: () => set({ loginStep: 'enter-email', errorText: null }),
}));
