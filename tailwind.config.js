/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        foreground: "rgb(var(--color-foreground) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        "surface-raised": "rgb(var(--color-surface-raised) / <alpha-value>)",
        default: "rgb(var(--color-border-default) / <alpha-value>)",
        ink: "#1d232f",
        panel: "#f7f8fb",
        accent: "#2563eb",
      },
    },
  },
  plugins: [],
};
