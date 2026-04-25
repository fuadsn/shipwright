/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        command: {
          bg: "#101317",
          panel: "#171c22",
          rail: "#1f252d",
          line: "#313944",
          text: "#eef3f8",
          muted: "#9ca9b7",
          amber: "#f0b84b",
          blue: "#68a7ff",
          green: "#65d68b",
          red: "#ff6b6b"
        }
      }
    }
  },
  plugins: []
};
