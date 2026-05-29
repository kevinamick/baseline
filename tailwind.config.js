/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Warm butter-cream page surfaces
        paper: {
          DEFAULT: '#FAF5E4',
          warm: '#F4ECCF',
          soft: '#FDF9EE',
        },
        // Soft charcoal — text, primary buttons, the dark focus card
        ink: {
          DEFAULT: '#0E0E10',
          soft: '#1C1C1F',
        },
        // Card surfaces
        card: {
          DEFAULT: '#FFFFFF',
          warm: '#FBF6E6',
        },
        // Butter-yellow accent — the personality of the brand
        accent: {
          DEFAULT: '#FFE066',
          hover: '#F4D03F',
          press: '#E5BE2E',
          soft: '#FFF1A8',
          ink: '#5A4400',
        },
        // Warm hairlines that match the cream paper
        hairline: {
          DEFAULT: '#EDE6CB',
          cool: '#E8E5DA',
          field: '#E0D9BD',
          strong: '#C9C0A0',
        },
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
      // Soft, sepia-tinted shadows so they belong on cream, never cool/gray.
      boxShadow: {
        sm: '0 1px 2px 0 rgba(80, 60, 0, 0.04)',
        card: '0 2px 4px -1px rgba(80, 60, 0, 0.04), 0 8px 24px -8px rgba(80, 60, 0, 0.06)',
        lg: '0 16px 32px -8px rgba(80, 60, 0, 0.10), 0 4px 8px -4px rgba(80, 60, 0, 0.05)',
        xl: '0 28px 56px -12px rgba(60, 45, 0, 0.16), 0 8px 16px -6px rgba(60, 45, 0, 0.08)',
      },
      letterSpacing: {
        hero: '-0.025em',
      },
      backgroundImage: {
        // Cream paper gradient — lifts the top-center for hero/marketing zones.
        'paper-gradient':
          'radial-gradient(ellipse 90% 80% at 50% 0%, #F4E9B6 0%, #FAF5E4 45%, #FDF9EE 100%)',
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
