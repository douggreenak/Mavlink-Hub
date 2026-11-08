#!/usr/bin/env python3
"""Draws the MAVLink Hub icon (a plane on its dashed predicted path) and writes
assets/icon.png, assets/hub.ico and, on a Mac, assets/hub.icns.
Pure Python plus the macOS tools sips and iconutil; no extra packages.   python3 tools/make-icons.py"""
import math, os, struct, subprocess, sys, tempfile, zlib

N, SS = 1024, 2                      # final size, supersampling
W = N * SS
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')

def mask():
    return [bytearray(W) for _ in range(W)]

def fill_spans(m, y, spans):
    if 0 <= y < W:
        row = m[y]
        for a, b in spans:
            a, b = max(0, int(math.ceil(a))), min(W, int(math.floor(b)) + 1)
            if b > a:
                row[a:b] = b'\x01' * (b - a)

def rounded_square(radius):
    m = mask(); r = radius * SS
    for y in range(W):
        if y < r: dy = r - y
        elif y > W - 1 - r: dy = y - (W - 1 - r)
        else: dy = 0
        inset = r - math.sqrt(max(0, r * r - dy * dy)) if dy else 0
        fill_spans(m, y, [(inset, W - 1 - inset)])
    return m

def polygon(points):
    m = mask(); n = len(points)
    ys = [p[1] for p in points]
    for y in range(max(0, int(min(ys))), min(W, int(max(ys)) + 1)):
        xs = []
        yc = y + 0.5
        for i in range(n):
            (x1, y1), (x2, y2) = points[i], points[(i + 1) % n]
            if (y1 <= yc < y2) or (y2 <= yc < y1):
                xs.append(x1 + (yc - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        fill_spans(m, y, [(xs[k], xs[k + 1]) for k in range(0, len(xs) - 1, 2)])
    return m

def dashed_arc(cx, cy, R, a0, a1, thick, dash, gap):
    m = mask(); r_in, r_out = R - thick / 2, R + thick / 2
    for y in range(int(cy - r_out), int(cy + r_out) + 1):
        dy = y + 0.5 - cy
        if abs(dy) > r_out: continue
        xo = math.sqrt(r_out ** 2 - dy ** 2)
        xi = math.sqrt(r_in ** 2 - dy ** 2) if abs(dy) < r_in else 0
        for lo, hi in ((cx - xo, cx - xi), (cx + xi, cx + xo)):
            for x in range(int(lo), int(hi) + 1):
                if not (0 <= x < W): continue
                ang = math.degrees(math.atan2(y + 0.5 - cy, x + 0.5 - cx)) % 360
                if a0 <= ang <= a1 and ((ang - a0) % (dash + gap)) < dash:
                    m[y][x] = 1
    return m

def shifted(m, dx, dy):
    out = mask()
    for y in range(W):
        sy = y - dy
        if 0 <= sy < W:
            row = m[sy]
            if dx >= 0: out[y][dx:] = row[:W - dx]
            else: out[y][:W + dx] = row[-dx:]
    return out

def down(m):
    """SSxSS box filter -> N x N coverage 0..1"""
    out = []
    for y in range(N):
        rows = [m[y * SS + k] for k in range(SS)]
        out.append([sum(sum(r[x * SS:(x + 1) * SS]) for r in rows) / (SS * SS) for x in range(N)])
    return out

def png(path, pixels, size):
    raw = b''.join(b'\x00' + bytes(v for px in row for v in px) for row in pixels)
    def chunk(t, d): c = struct.pack('>I', len(d)) + t + d; return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def main():
    os.makedirs(ROOT, exist_ok=True)
    bg = down(rounded_square(224))
    # the plane (24 x 24 grid, same silhouette the dashboard uses), turned to follow the arc
    pts = [(12, 2), (15, 11), (22, 14), (22, 16), (15, 15), (14, 20), (16, 22), (16, 23), (12, 22), (8, 23), (8, 22), (10, 20), (9, 15), (2, 16), (2, 14), (9, 11)]
    theta, k, pcx, pcy = math.radians(70), 25.0 * SS, 640 * SS, 400 * SS
    def place(p):
        x, y = (p[0] - 12) * k, (p[1] - 12.5) * k
        return (pcx + x * math.cos(theta) - y * math.sin(theta), pcy + x * math.sin(theta) + y * math.cos(theta))
    plane_pts = [place(p) for p in pts]
    plane = down(polygon(plane_pts))
    shadow = down(shifted(polygon(plane_pts), 10 * SS, 14 * SS))
    arc = down(dashed_arc(770 * SS, 790 * SS, 390 * SS, 168, 250, 34 * SS, 7, 5))
    out = []
    for y in range(N):
        t = y / (N - 1)
        base = (int(34 + (13 - 34) * t), int(57 + (20 - 57) * t), int(95 + (34 - 95) * t))
        row = []
        for x in range(N):
            a = bg[y][x]
            if a == 0: row.append((0, 0, 0, 0)); continue
            r, g, b = base
            s = shadow[y][x] * 0.40; r, g, b = r * (1 - s), g * (1 - s), b * (1 - s)
            c = arc[y][x] * 0.95; r, g, b = r + (127 - r) * c, g + (178 - g) * c, b + (255 - b) * c
            c = plane[y][x]; r, g, b = r + (246 - r) * c, g + (195 - g) * c, b + (67 - b) * c
            row.append((int(r), int(g), int(b), int(255 * a)))
        out.append(row)
    big = os.path.join(tempfile.mkdtemp(), 'icon1024.png'); png(big, out, N)
    sizes = {}
    for s in (16, 32, 48, 64, 128, 256, 512):
        p = os.path.join(os.path.dirname(big), f'{s}.png'); subprocess.run(['sips', '-z', str(s), str(s), big, '--out', p], capture_output=True, check=True); sizes[s] = p
    open(os.path.join(ROOT, 'icon.png'), 'wb').write(open(sizes[512], 'rb').read())
    # Windows .ico with PNG-compressed images
    imgs = [(s, open(sizes[s], 'rb').read()) for s in (16, 32, 48, 64, 128, 256)]
    head = struct.pack('<HHH', 0, 1, len(imgs)); off = 6 + 16 * len(imgs); body = b''; entries = b''
    for s, data in imgs:
        entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), off + len(body)); body += data
    open(os.path.join(ROOT, 'hub.ico'), 'wb').write(head + entries + body)
    # macOS .icns through an iconset
    if sys.platform == 'darwin':
        iset = os.path.join(os.path.dirname(big), 'hub.iconset'); os.makedirs(iset)
        for name, s in (('16x16', 16), ('16x16@2x', 32), ('32x32', 32), ('32x32@2x', 64), ('128x128', 128), ('128x128@2x', 256), ('256x256', 256), ('256x256@2x', 512), ('512x512', 512)):
            open(os.path.join(iset, f'icon_{name}.png'), 'wb').write(open(sizes[s], 'rb').read())
        subprocess.run(['sips', '-z', '1024', '1024', big, '--out', os.path.join(iset, 'icon_512x512@2x.png')], capture_output=True, check=True)
        subprocess.run(['iconutil', '-c', 'icns', iset, '-o', os.path.join(ROOT, 'hub.icns')], check=True)
    print('wrote', sorted(os.listdir(ROOT)))

main()
