/** @type {import('tailwindcss').Config} */
const extractClasses = (content) => {
  const tokens = [];
  const classRegex = /(?:class|className)\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
  let match;

  while ((match = classRegex.exec(content)) !== null) {
    const raw = match[1] || match[2] || match[3] || '';
    raw
      .split(/\s+/)
      .map(item => item.trim())
      .filter(Boolean)
      .forEach(item => tokens.push(item));
  }

  return tokens;
};

export default {
  content: {
    files: [
      "./index.html",
      "./components/**/*.{js,jsx,ts,tsx}",
      "./App.{js,jsx,ts,tsx}",
      "./main.{js,jsx,ts,tsx}",
    ],
    extract: {
      js: extractClasses,
      jsx: extractClasses,
      ts: extractClasses,
      tsx: extractClasses,
    },
  },
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      colors: {
        slate: {
          850: '#1e293b',
          950: '#020617',
        }
      },
      animation: {
        'in': 'fadeIn 0.5s ease-in',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
