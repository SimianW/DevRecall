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
        accent: "rgb(var(--color-accent) / <alpha-value>)",
      },
      fontFamily: {
        serif: ["Georgia", "ui-serif", "Cambria", "Times New Roman", "serif"],
      },
    },
  },
  plugins: [],
};
