#!/usr/bin/env python3
"""Generate VidGrab icons as PNGs without external dependencies.

Draws an indigo rounded square with a white down-arrow-into-tray glyph
(download symbol) at 16/32/48/128 px.
"""
import struct
import zlib
import os

BG = (79, 70, 229)      # indigo
FG = (255, 255, 255)    # white


def png_chunk(tag, data):
    chunk = tag + data
    return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk))


def write_png(path, size, pixels):
    # pixels: list of rows, each row list of (r,g,b,a)
    raw = b''
    for row in pixels:
        raw += b'\x00' + b''.join(struct.pack('BBBB', *px) for px in row)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(png_chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)))
        f.write(png_chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(png_chunk(b'IEND', b''))


def make_icon(size):
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    radius = max(2, size // 5)

    def inside_rounded(x, y):
        # rounded-rect coverage test
        r = radius
        cx = min(max(x, r), size - 1 - r)
        cy = min(max(y, r), size - 1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r or (
            r <= x <= size - 1 - r or r <= y <= size - 1 - r
        ) and (0 <= x < size and 0 <= y < size) and (
            (r <= x <= size - 1 - r) or (r <= y <= size - 1 - r)
        )

    for y in range(size):
        for x in range(size):
            r = radius
            # rounded rect: within body strips or within corner circles
            in_h = r <= x < size - r
            in_v = r <= y < size - r
            if in_h or in_v:
                ok = True
            else:
                cx = r if x < r else size - 1 - r
                cy = r if y < r else size - 1 - r
                ok = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
            if ok:
                px[y][x] = (*BG, 255)

    # glyph: down arrow (shaft + triangle head) + tray bar
    shaft_w = max(2, size // 8)
    cx = size // 2
    top = size * 5 // 24
    head_top = size * 11 // 24
    head_bot = size * 16 // 24
    tray_y0 = size * 18 // 24
    tray_y1 = min(size - 1, tray_y0 + max(1, size // 12))
    tray_x0 = size * 5 // 24
    tray_x1 = size - tray_x0

    for y in range(top, head_top):
        for x in range(cx - shaft_w // 2, cx + (shaft_w + 1) // 2):
            if 0 <= x < size and px[y][x][3]:
                px[y][x] = (*FG, 255)

    head_half = max(2, size * 5 // 24)
    for y in range(head_top, head_bot):
        t = (y - head_top) / max(1, head_bot - head_top - 1)
        half = int(round(head_half * (1 - t)))
        for x in range(cx - half, cx + half + 1):
            if 0 <= x < size and px[y][x][3]:
                px[y][x] = (*FG, 255)

    for y in range(tray_y0, tray_y1 + 1):
        for x in range(tray_x0, tray_x1):
            if 0 <= x < size and 0 <= y < size and px[y][x][3]:
                px[y][x] = (*FG, 255)

    return px


def main():
    out_dir = os.path.join(os.path.dirname(__file__), '..', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(os.path.join(out_dir, f'icon{size}.png'), size, make_icon(size))
        print(f'icon{size}.png')


if __name__ == '__main__':
    main()
