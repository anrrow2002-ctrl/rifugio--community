// rgb(from var(...)) 相对颜色语法是为了让 text-gold/70 这类透明度修饰符真正生效
// （老 Play CDN 时代这些 class 根本编译不出来，属于一直静默失效）。iOS 16.4+/Chrome 119+。
const path = require('path');
const alpha = (v) => `rgb(from ${v} r g b / <alpha-value>)`;
module.exports = {
  content: [path.resolve(__dirname, '../../index.html'), path.resolve(__dirname, '../../js/**/*.js')],
  theme: {
    extend: {
      colors: {
        paper: alpha('var(--paper)'), ink: alpha('var(--ink)'), gold: alpha('var(--gold)'), abyss: alpha('var(--abyss)'),
        warmInk: alpha('var(--warm-ink)'), warmGold: alpha('var(--warm-gold)'),
        cardBg: alpha('var(--card-bg)'), altBg: alpha('var(--alt-bg)')
      },
      fontFamily: {
        serif: ['"Noto Serif SC"', 'serif'],
        ital: ['"Cormorant Garamond"', 'serif'],
        script: ['"Pinyon Script"', 'cursive'],
      }
    }
  }
}
