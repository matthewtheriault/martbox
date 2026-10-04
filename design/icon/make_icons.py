"""Draws the MartBox icon (a neutral grey cube with a play mark) at every
size the apps need. Neutral so it suits whichever accent a person picks.

    python3 design/icon/make_icons.py <out-dir>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

TOP = (237, 237, 240)
RIGHT = (184, 184, 191)
LEFT = (139, 139, 147)
INK = (11, 11, 13)
SLIT = (90, 90, 98)
LED_ON = (245, 245, 247)
LED_OFF = (110, 110, 118)
BG_CENTER = (38, 38, 43)
BG_EDGE = (8, 8, 10)
SS = 4  # supersampling


def radial(w, h, center, edge, cx=None, cy=None, radius=None):
    cx = w / 2 if cx is None else cx
    cy = h * 0.42 if cy is None else cy
    radius = radius or max(w, h) * 0.75
    small = Image.new('RGB', (w // 8 or 1, h // 8 or 1))
    px = small.load()
    for y in range(small.height):
        for x in range(small.width):
            d = min(1.0, (((x * 8 - cx) ** 2 + (y * 8 - cy) ** 2) ** 0.5) / radius)
            t = d ** 1.4
            px[x, y] = tuple(round(center[i] * (1 - t) + edge[i] * t) for i in range(3))
    return small.resize((w, h), Image.BICUBIC)


def cube_layer(w, h, cx, cy, scale, shadow=True):
    """The cube alone on a transparent layer, centred at (cx, cy)."""
    W, H = w * SS, h * SS
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    k = scale * SS
    P = lambda x, y: (cx * SS + x * k, cy * SS + y * k)
    if shadow:
        sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(sh).ellipse([*P(-200, 170), *P(200, 260)], fill=(0, 0, 0, 170))
        layer = Image.alpha_composite(layer, sh.filter(ImageFilter.GaussianBlur(40 * k)))
    d = ImageDraw.Draw(layer)
    d.polygon([P(0, -220), P(221, -104), P(0, 6), P(-220, -104)], fill=TOP)
    d.polygon([P(-220, -104), P(0, 6), P(0, 220), P(-220, 104)], fill=LEFT)
    d.polygon([P(0, 6), P(221, -104), P(221, 104), P(0, 220)], fill=RIGHT)
    d.polygon([P(-42, -151), P(-42, -56), P(44, -104)], fill=INK)
    d.line([P(-180, -52), P(-180, 66)], fill=SLIT, width=max(1, round(8 * k)))
    d.line([P(-140, -30), P(-140, 90)], fill=SLIT, width=max(1, round(8 * k)))
    for (x, y), c in (((161, 29), LED_ON), ((161, 67), LED_OFF)):
        r = 12
        d.ellipse([*P(x - r, y - r), *P(x + r, y + r)], fill=c)
    return layer.resize((w, h), Image.LANCZOS)


def background(w, h):
    return radial(w, h, BG_CENTER, BG_EDGE).convert('RGBA')


def square_icon(size, rounded):
    img = background(size, size)
    img = Image.alpha_composite(img, cube_layer(size, size, size / 2, size * 0.504, size / 1024))
    if not rounded:
        return img.convert('RGB')
    mask = Image.new('L', (size * SS, size * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * SS - 1, size * SS - 1], radius=round(size * SS * 0.225), fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask.resize((size, size), Image.LANCZOS))
    return out


def tv_layers(w, h):
    """Apple TV parallax icon: background and cube as separate layers."""
    back = background(w, h).convert('RGB')
    front = cube_layer(w, h, w / 2, h / 2, h / 768 * 0.95)
    return back, front


def wide(w, h):
    img = background(w, h)
    img = Image.alpha_composite(img, cube_layer(w, h, w / 2, h / 2, h / 720 * 0.82))
    return img.convert('RGB')


if __name__ == '__main__':
    out = Path(sys.argv[1] if len(sys.argv) > 1 else 'icons')
    out.mkdir(parents=True, exist_ok=True)
    rounded = square_icon(1024, rounded=True)
    rounded.save(out / 'icon-rounded-1024.png')
    rounded.save(out / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    square_icon(1024, rounded=False).save(out / 'icon-square-1024.png')
    for w, h in ((400, 240), (800, 480), (1280, 768)):
        back, front = tv_layers(w, h)
        back.save(out / f'back-{w}x{h}.png')
        front.save(out / f'front-{w}x{h}.png')
    for w, h in ((1920, 720), (3840, 1440), (2320, 720), (4640, 1440)):
        wide(w, h).save(out / f'shelf-{w}x{h}.png')
    print('wrote', len(list(out.iterdir())), 'files to', out)
