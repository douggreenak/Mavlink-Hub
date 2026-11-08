#!/usr/bin/env python3
"""Writes the README download buttons to docs/buttons/ as self-contained SVG (no external images or fonts), in the
Material 3 Expressive style: big rounded shapes, bold tonal colour, large type, a large icon tile.
Icons are Google's Material Icons (Apache License 2.0).   python3 tools/make-buttons.py"""
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'buttons')
FONT = "'Google Sans','Google Sans Text',Roboto,'Segoe UI','Helvetica Neue',Arial,sans-serif"
ICON = {  # Material Icons, 24 x 24
    'desktop_windows': 'M20 3H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h6v2H8v2h8v-2h-2v-2h6c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2',
    'laptop_mac': 'M20 18c1.1 0 1.99-.9 1.99-2L22 5c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2H0c0 1.1.9 2 2 2h20c1.1 0 2-.9 2-2h-4zM4 5h16v11H4V5zm8 14c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z',
    'download': 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
}
# Material 3 tonal palettes
BUTTONS = {
    'download-windows': dict(label='Windows', icon='desktop_windows', primary='#0B57D0', container='#D3E3FD', on='#041E49', outline='#A8C7FA', sub='#0B3A8F'),
    'download-mac': dict(label='Mac', icon='laptop_mac', primary='#6750A4', container='#EADDFF', on='#21005D', outline='#CFBCFF', sub='#4F378B'),
}

def svg(b):
    w, h = 380, 104
    # container: fully round on the left, a softer corner on the right (the expressive "mixed shape" look)
    l, r, x0 = 50, 30, 54            # left end: an exact semicircle (radius = half the height) centred on the icon circle
    path = f'M{x0} 2 H{w-2-r} A{r} {r} 0 0 1 {w-2} {2+r} V{h-2-r} A{r} {r} 0 0 1 {w-2-r} {h-2} H{x0} A{l} {l} 0 0 1 {x0} 2 Z'
    ic, dl = ICON[b['icon']], ICON['download']
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="t">
  <title id="t">Download for {b['label']}</title>
  <path d="{path}" fill="{b['container']}" stroke="{b['outline']}" stroke-width="2"/>
  <circle cx="54" cy="52" r="38" fill="{b['primary']}"/>
  <path d="{ic}" fill="#FFFFFF" transform="translate(32.4 30.4) scale(1.8)"/>
  <text x="110" y="42" font-family="{FONT}" font-size="14" font-weight="600" letter-spacing=".4" fill="{b['sub']}">Download for</text>
  <text x="108" y="77" font-family="{FONT}" font-size="34" font-weight="800" letter-spacing="-.5" fill="{b['on']}">{b['label']}</text>
  <circle cx="326" cy="52" r="30" fill="{b['primary']}"/>
  <path d="{dl}" fill="#FFFFFF" transform="translate(307 33) scale(1.58)"/>
</svg>
'''

os.makedirs(OUT, exist_ok=True)
for name, b in BUTTONS.items():
    open(os.path.join(OUT, name + '.svg'), 'w').write(svg(b))
print('wrote', sorted(os.listdir(OUT)))
