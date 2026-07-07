/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx}', './components/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0F1115',
        surface: '#171A21',
        'surface-alt': '#1E222B',
        elevated: '#262B36',
        border: '#2A2F3A',
        accent: '#FFD60A',
        'accent-muted': '#C9AC00',
        success: '#22C55E',
        danger: '#EF4444',
        warning: '#F59E0B',
      },
    },
  },
  plugins: [],
};
