/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Bonsai palette — deep bark + leaf green accents on near-black.
        bark: {
          950: '#0b0e0c',
          900: '#11150f',
          850: '#161b13',
          800: '#1c2318',
          700: '#28311f',
          600: '#3a4630',
        },
        leaf: {
          400: '#7cc47a',
          500: '#5aa85c',
          600: '#468a49',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
