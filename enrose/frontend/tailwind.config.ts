import type { Config } from "tailwindcss";

// A restrained, warm palette chosen to match Enrose's own positioning: premium and
// calm rather than loud. Deep ink ground, muted rose accent, generous whitespace.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0c0a09",
          900: "#14100f",
          850: "#1b1614",
          800: "#241d1a",
          700: "#332a26",
          600: "#4a3e38",
        },
        rose: {
          DEFAULT: "#c88a86",
          soft: "#e2b8b4",
          deep: "#a9645f",
        },
        sand: "#f5efe9",
        muted: "#a1938c",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Inter", "sans-serif"],
        display: ["ui-serif", "Georgia", "Cambria", "serif"],
      },
      borderRadius: { xl2: "1.25rem" },
    },
  },
  plugins: [],
};

export default config;
