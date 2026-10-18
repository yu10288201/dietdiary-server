/* =========================================================================
 * theme.js - theme presets.
 *
 * Every accent ships a light scheme and a dark scheme so contrast holds in
 * both modes: `ink` is the text/icon color placed on top of `brand`.
 * ========================================================================= */
(function (root) {
  'use strict';

  root.ACCENTS = [
    {
      id: 'forest', name: '森野绿', tag: '默认 · 专注健康',
      light: { brand: '#5C8D5A', soft: '#E8F1E7', ink: '#FFFFFF' },
      dark:  { brand: '#7BB077', soft: '#1E2A1E', ink: '#0E150E' }
    },
    {
      id: 'ocean', name: '海盐蓝', tag: '清爽 · 数据感',
      light: { brand: '#3B82F6', soft: '#E7F0FE', ink: '#FFFFFF' },
      dark:  { brand: '#63A0FA', soft: '#16233A', ink: '#0A1220' }
    },
    {
      id: 'tangerine', name: '暖橙', tag: '食欲 · 活力',
      light: { brand: '#F0763B', soft: '#FDEDE3', ink: '#FFFFFF' },
      dark:  { brand: '#FF9257', soft: '#33210F', ink: '#20130A' }
    },
    {
      id: 'berry', name: '莓果粉', tag: '柔和 · 女性向',
      light: { brand: '#E0559B', soft: '#FCE8F2', ink: '#FFFFFF' },
      dark:  { brand: '#F477B4', soft: '#331529', ink: '#20101A' }
    },
    {
      id: 'violet', name: '雾紫', tag: '克制 · 高级感',
      light: { brand: '#7C6BF2', soft: '#EEECFE', ink: '#FFFFFF' },
      dark:  { brand: '#9B8DFF', soft: '#221F3A', ink: '#120F22' }
    },
    {
      id: 'graphite', name: '石墨灰', tag: '极简 · 无色彩',
      light: { brand: '#3A4149', soft: '#EDEFF2', ink: '#FFFFFF' },
      dark:  { brand: '#AEB8C4', soft: '#242C34', ink: '#12171C' }
    }
  ];

  root.themeById = function (id) {
    for (var i = 0; i < root.ACCENTS.length; i++) {
      if (root.ACCENTS[i].id === id) return root.ACCENTS[i];
    }
    return root.ACCENTS[0];
  };

  function hexToRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }
  /* mix a hex color toward #fff (t>0) or #000 (t<0); replaces CSS color-mix(),
   * which Android 7/8 WebViews do not understand. */
  function mix(hex, t) {
    var c = hexToRgb(hex);
    var target = t >= 0 ? 255 : 0;
    var k = Math.abs(t);
    var r = Math.round(c.r + (target - c.r) * k);
    var g = Math.round(c.g + (target - c.g) * k);
    var b = Math.round(c.b + (target - c.b) * k);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  root.applyTheme = function (accentId, mode) {
    var a = root.themeById(accentId);
    var s = (mode === 'dark') ? a.dark : a.light;
    var r = document.documentElement.style;
    r.setProperty('--brand', s.brand);
    r.setProperty('--brand-soft', s.soft);
    r.setProperty('--brand-ink', s.ink);
    // derived tokens that used to be computed with color-mix() in the CSS
    r.setProperty('--brand-2', mix(s.brand, mode === 'dark' ? -0.4 : 0.42));
    r.setProperty('--brand-glow', rgba(s.brand, 0.42));
    r.setProperty('--tabbar-bg', rgba(mode === 'dark' ? '#161B21' : '#FFFFFF', 0.92));
    document.body.classList.toggle('dark', mode === 'dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'dark' ? '#101418' : '#F6F7F9');
  };
})(window);
