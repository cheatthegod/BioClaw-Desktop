/** @type {import('tailwindcss').Config} */
//
// BioClaw Desktop design tokens. Mirrors the SaaS frontend's "Biomni
// Editorial" sage palette (see BioClaw-SaaS/src/channels/local-web/
// frontend/src/styles.css). The web side uses Tailwind 4 `@theme` so the
// tokens are CSS variables; desktop is on Tailwind 3 still, so we wire
// them in through `theme.extend.colors` referencing CSS vars defined in
// styles/globals.css. That way both files agree on the palette and a
// future theme switch (default / ocean / sakura) just swaps the vars,
// no Tailwind rebuild required.
//
// Naming convention — single tokens (NOT shade scales) so we never
// accidentally mix `bg-zinc-100` with `bg-accent`. Match SaaS names
// 1:1 so a designer can copy a class between repos and have it work.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'Inter var',
          '-apple-system',
          'Segoe UI',
          'Helvetica Neue',
          'ui-sans-serif',
          'system-ui',
          'Noto Sans SC',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
        serif: [
          'Instrument Serif',
          'ui-serif',
          'Georgia',
          'Songti SC',
          'SimSun',
          'serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Consolas',
          'monospace',
        ],
      },
      colors: {
        // === Surfaces ============================================
        // ONE flat tone for the entire page; structure comes from
        // borders, not surface contrast. So `bg`, `surface`,
        // `surface-2`, `surface-raised` all resolve to the same var
        // by default — they're separately named only so a future
        // theme could differentiate them without touching consumers.
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--color-surface-2) / <alpha-value>)',
        'surface-raised': 'rgb(var(--color-surface-raised) / <alpha-value>)',
        // === Text ================================================
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        'ink-soft': 'rgb(var(--color-ink-soft) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        'muted-2': 'rgb(var(--color-muted-2) / <alpha-value>)',
        // === Hairlines ===========================================
        // The editorial look uses borders, NOT shadows, for structure.
        // `line` is the universal card / section / row line;
        // `line-strong` is active-tab / focus-ring / accents.
        line: 'rgb(var(--color-border) / <alpha-value>)',
        'line-strong': 'rgb(var(--color-border-strong) / <alpha-value>)',
        // === Accent (forest sage) ================================
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        'accent-ink': 'rgb(var(--color-accent-ink) / <alpha-value>)',
        'accent-bg': 'rgb(var(--color-accent-rgb) / 0.07)',
        'accent-soft': 'rgb(var(--color-accent-rgb) / 0.13)',
        // === Semantics ===========================================
        success: 'rgb(var(--color-success) / <alpha-value>)',
        warning: 'rgb(var(--color-warning) / <alpha-value>)',
        danger: 'rgb(var(--color-error) / <alpha-value>)',
      },
      borderRadius: {
        // Match the SaaS scale 6 / 8 / 12 / 16 / 22 (the existing
        // tailwind `sm`/`md`/`lg`/`xl`/`2xl` are 4/6/8/12/16 — close
        // but not aligned). We override the named tokens so existing
        // utility classes snap to BioClaw's scale.
        sm: '8px',
        DEFAULT: '12px',
        md: '12px',
        lg: '16px',
        xl: '22px',
      },
      boxShadow: {
        // Editorial: NO shadow at xs/sm — the strong border carries it.
        // md/lg keep a soft drop for popovers, modals, tooltips where
        // elevation has actual meaning.
        xs: '0 0 #0000',
        sm: '0 0 #0000',
        md: '0 4px 12px rgba(15, 15, 22, 0.08), 0 1px 3px rgba(15, 15, 22, 0.05)',
        lg: '0 12px 32px rgba(15, 15, 22, 0.14), 0 4px 8px rgba(15, 15, 22, 0.06)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.22, 1, 0.36, 1)',
        'in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },
  },
  plugins: [],
};
