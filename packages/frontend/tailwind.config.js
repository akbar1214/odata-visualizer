/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#DFF4F3',
          100: '#DFF4F3',
          200: '#B8DEDA',
          300: '#6CB4AD',
          400: '#3B9B91',
          500: '#0A8276',
          600: '#08665C',
          700: '#06534B',
          800: '#06534B',
          900: '#06534B',
        },
        engineering: {
          100: '#F7F7F7',
          200: '#EEEDED',
          300: '#BFBBBB',
          400: '#8D8786',
          500: '#575352',
          600: '#3C3A39',
        },
        ocean: {
          100: '#DFF4F3',
          200: '#B8DEDA',
          300: '#6CB4AD',
          400: '#3B9B91',
          500: '#0A8276',
          600: '#08665C',
          700: '#06534B',
        },
        infineon: {
          red: '#CD002F',
          'red-dark': '#A2001E',
          'red-darker': '#900021',
          orange: '#E16B25',
          green: '#4CA460',
          lawn: '#9BBA43',
          'lawn-dark': '#3C6C0F',
          berry: '#9C216E',
          sun: '#F97414',
          sand: '#FCD442',
        },
        black: '#1D1D1D',
      },
      boxShadow: {
        'ifx': '0 0 12px 0 #1D1D1D1F, 0 0 1px 0 #1D1D1D1F',
        'ifx-small': '0 4px 8px 0 #1D1D1D1F, 0 0 1px 0 #1D1D1D1F',
        'ifx-large': '0 4px 16px 0 #1D1D1D1F, 0 0 1px 0 #1D1D1D1F',
      },
      borderRadius: {
        'ifx': '1px',
        'ifx-25': '2px',
        'ifx-50': '4px',
        'ifx-100': '8px',
        'ifx-200': '16px',
      },
      fontFamily: {
        sans: ['"Source Sans 3"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
