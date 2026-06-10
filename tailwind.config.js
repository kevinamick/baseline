/** @type {import('tailwindcss').Config} */
module.exports = {
  // Theme is attribute-driven ([data-theme="dark"] on <html>, stamped before
  // paint). Point Tailwind's `dark:` variant at that attribute so the handful of
  // existing dark: utilities track the toggle instead of the OS media query.
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Every palette color points at a CSS variable (defined in globals.css),
        // so a single [data-theme] flip on <html> re-themes every utility — no
        // `dark:` variants. See the dark overrides in globals.css.

        // Warm porcelain page surfaces
        paper: {
          DEFAULT: 'var(--paper)',
          warm: 'var(--paper-warm)',
          soft: 'var(--paper-soft)',
        },
        // Soft charcoal — text, primary buttons, the hero/focus card.
        // `ink` inverts to a warm near-white in dark (it's also the high-emphasis
        // fill), so text sitting ON an ink fill must use `fg-on-ink`, not `white`.
        // DEFAULT uses channel form so opacity modifiers work (e.g. ring-ink/40).
        ink: {
          DEFAULT: 'rgb(var(--ink-rgb) / <alpha-value>)',
          soft: 'var(--ink-soft)',
          // Hover shade for the ink button — tracks the ink fill (which inverts to
          // near-white in dark), unlike `soft` which is the elevated dark surface.
          hover: 'var(--ink-hover)',
        },
        // Modal / dialog scrim (dark in both themes — do NOT use ink/45).
        overlay: 'var(--overlay)',
        // Card surfaces
        card: {
          DEFAULT: 'var(--bg-card)',
          warm: 'var(--bg-card-warm)',
        },
        // Inset row backgrounds
        row: {
          DEFAULT: 'var(--bg-row)',
          hover: 'var(--bg-row-hover)',
          selected: 'var(--bg-row-selected)',
        },
        // Foreground text hierarchy — use these instead of raw zinc utilities.
        fg: {
          1: 'var(--fg-1)',
          2: 'var(--fg-2)',
          3: 'var(--fg-3)',
          4: 'var(--fg-4)',
          'on-ink': 'var(--fg-on-ink)', // text on the ink fill (inverts)
          'on-ink-muted': 'var(--fg-on-ink-muted)', // muted text on the dark ink-soft hero
          'on-accent': 'var(--ink-on-accent)', // text on the accent fill (white in light, dark in dark)
        },
        // Cobalt accent — the personality of the brand (lifted in dark).
        // DEFAULT + ink use channel form so opacity modifiers work
        // (bg-accent/15, ring-accent/40, text-accent-ink/60).
        accent: {
          DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',
          hover: 'var(--accent-hover)',
          press: 'var(--accent-press)',
          soft: 'var(--accent-soft)',
          ink: 'rgb(var(--accent-ink-rgb) / <alpha-value>)',
        },
        // Warm-greige hairlines that match the porcelain paper
        hairline: {
          DEFAULT: 'var(--border-card)',
          cool: 'var(--border-card-cool)',
          field: 'var(--border-input)',
          strong: 'var(--border-strong)',
        },
        // Semantic — each has a fill (DEFAULT), a pill background, and pill text.
        success: {
          DEFAULT: 'var(--success)',
          bg: 'var(--success-bg)',
          fg: 'var(--success-fg)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          bg: 'var(--warning-bg)',
          fg: 'var(--warning-fg)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          hover: 'var(--danger-hover)',
          bg: 'var(--danger-bg)',
          fg: 'var(--danger-fg)',
        },
        info: {
          DEFAULT: 'var(--info)',
          bg: 'var(--info-bg)',
          fg: 'var(--info-fg)',
        },
        // Eval score thresholds (charts + score text)
        score: {
          high: 'var(--score-high)',
          mid: 'var(--score-mid)',
          low: 'var(--score-low)',
          'high-ink': 'var(--score-high-ink)', // text-on-surface (theme-aware, AA)
          'mid-ink': 'var(--score-mid-ink)',
          'low-ink': 'var(--score-low-ink)',
        },
        // Loading shimmer base
        skeleton: 'var(--bg-skeleton)',
      },
      fontFamily: {
        sans: [
          'var(--font-geist-sans)',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'var(--font-geist-mono)',
          'ui-monospace',
          'SF Mono',
          'JetBrains Mono',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      // Deep, soft rounding is part of the brand (overrides Tailwind defaults).
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '14px',
        xl: '20px',
        '2xl': '28px',
        '3xl': '36px',
        full: '9999px',
      },
      // Shadows are theme-aware (warm/sepia in light, black-based in dark) via
      // CSS vars defined in globals.css.
      boxShadow: {
        sm: 'var(--shadow-sm)',
        card: 'var(--shadow-card)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
      },
      letterSpacing: {
        hero: '-0.025em',
      },
      backgroundImage: {
        // Porcelain paper gradient — a soft cobalt glow at top-center (cobalt-navy
        // in dark) over the page surface. Theme-aware via CSS var.
        'paper-gradient': 'var(--paper-gradient)',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
      animation: {
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
      transitionTimingFunction: {
        'soft-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
}
