"""Generate extension icons using the standard library; no installed packages."""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'extension' / 'icons'
ROOT.mkdir(exist_ok=True)

def icon(size):
    scale = 4
    high = size * scale
    rows = bytearray()
    # A selection bracket, a small arrow and three translated text strokes.
    strokes = [(22, 28, 22, 98, 6), (22, 28, 37, 28, 6), (22, 98, 37, 98, 6),
               (43, 63, 78, 63, 5), (66, 51, 78, 63, 5), (66, 75, 78, 63, 5),
               (91, 28, 106, 28, 6), (106, 28, 106, 98, 6), (91, 98, 106, 98, 6)]
    def distance(x, y, x1, y1, x2, y2):
        dx, dy = x2-x1, y2-y1
        t = max(0, min(1, ((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy)))
        return math.hypot(x-x1-t*dx, y-y1-t*dy)
    def pixel(x, y):
        cx, cy = max(22-x, 0, x-106), max(22-y, 0, y-106)
        if math.hypot(cx, cy) > 22:
            return (0, 0, 0, 0)
        if any(distance(x, y, *stroke[:4]) < stroke[4]/2 for stroke in strokes):
            return (40, 97, 131, 255)
        return (196, 232, 251, 255)
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [pixel((x*scale+sx+.5)*128/high, (y*scale+sy+.5)*128/high) for sy in range(scale) for sx in range(scale)]
            rows.extend(round(sum(sample[channel] for sample in samples)/len(samples)) for channel in range(4))
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind+data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')

for size in (16, 32, 48, 128):
    (ROOT / f'{size}.png').write_bytes(icon(size))
print('Generated 4 icons in extension/icons (standard library only).')
