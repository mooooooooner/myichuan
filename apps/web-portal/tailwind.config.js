/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0f19",
        panel: "#101826",
        neon: "#2dd4bf",
        glow: "#60a5fa"
      },
      boxShadow: {
        halo: "0 0 0 1px rgba(96,165,250,0.3), 0 16px 48px rgba(3,7,18,0.5)"
      }
    }
  },
  plugins: []
};
