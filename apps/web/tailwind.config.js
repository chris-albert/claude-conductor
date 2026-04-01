/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "monospace"],
      },
      colors: {
        c: {
          bg: "var(--c-bg)",
          "bg-raised": "var(--c-bg-raised)",
          surface: "var(--c-surface)",
          "surface-hover": "var(--c-surface-hover)",
          "surface-active": "var(--c-surface-active)",
          border: "#2a2a3a",
          "border-subtle": "#1f1f2e",
          text: "#e8e8ed",
          "text-secondary": "#a0a0b0",
          muted: "#6b6b80",
          accent: "#7c6cf0",
          "accent-hover": "#8e7ff7",
          "accent-subtle": "rgba(124, 108, 240, 0.12)",
          success: "#3dd68c",
          warning: "#f5a623",
          error: "#f06c6c",
          "error-subtle": "rgba(240, 108, 108, 0.12)",
          user: "#2a3a5c",
          "user-border": "#354870",
        },
      },
      fontSize: {
        "2xs": ["0.65rem", { lineHeight: "0.875rem" }],
      },
      animation: {
        "pulse-subtle": "pulse-subtle 2s ease-in-out infinite",
        "fade-in": "fade-in 0.2s ease-out",
        "slide-up": "slide-up 0.2s ease-out",
      },
      keyframes: {
        "pulse-subtle": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
