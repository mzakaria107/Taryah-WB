/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        arabic: ['Tajawal', 'IBM Plex Arabic', 'sans-serif'],
      },
      colors: {
        brand: { DEFAULT: '#1f2937', light: '#374151', dark: '#111827' },
      },
    },
  },
  plugins: [],
};
