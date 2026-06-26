/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter',
          'sans-serif',
        ],
      },
      colors: {
        bioclaw: {
          accent: '#059669', // matches BioClaw web UI accent
        },
      },
    },
  },
  plugins: [],
};
