import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // VeriRelease Fintech Color System
        obsidian: "#090B0A",
        charcoal: "#111512",
        graphite: "#171C19",
        surface: {
          1: "#1D241F",
          2: "#242C26",
        },
        ivory: "#F1F0E8",
        sage: "#B9C5B5",
        "muted-grey": "#858F87",
        lime: {
          DEFAULT: "#C6F36A",
          hover: "#B5E358",
          muted: "rgba(198, 243, 106, 0.12)",
        },
        mint: "#8FE0A5",
        amber: "#E9B85D",
        coral: "#E77D70",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          '"SF Mono"',
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
