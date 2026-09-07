"""
Ditherra — autotile generation.

Pure pixel arithmetic: takes the base tile the agent painted and derives the
16 bitmask variants (lighting, outline, bevel, rounded corners) that a tilemap
needs. No FastAPI, no database, no storage — give it an image, get images back.
That is why it lives here and not in server.py.

Bitmask: TOP=1, RIGHT=2, BOTTOM=4, LEFT=8.
Mask 15 = fully surrounded (the base tile from the AI). Mask 0 = isolated.
"""

from PIL import Image

def _darken_px(r, g, b, amount):
    return (max(0, int(r * (1 - amount))), max(0, int(g * (1 - amount))), max(0, int(b * (1 - amount))))

def generate_autotile_variant(base_img: Image.Image, mask: int) -> Image.Image:
    """Apply directional lighting, outline, inner bevel and rounded corners for a bitmask variant.

    Light comes from the top-left, so exposed top/left edges get a highlight band and
    exposed bottom/right edges get a shadow band, both with a smooth linear falloff.
    A 1px dark outline plus a dimmer inner bevel line make the block read as 3D.
    Fully-surrounded tiles (mask 15, no exposed edges) fall through every pass untouched,
    so tiled interiors stay seamless.
    # ponytail: 4-bit blob (16 tiles), not 47-tile Wang; corners are convex-only (two exposed edges).
    """
    size = base_img.width
    img = base_img.copy()
    pixels = img.load()

    top_exposed = (mask & 1) == 0
    right_exposed = (mask & 2) == 0
    bottom_exposed = (mask & 4) == 0
    left_exposed = (mask & 8) == 0

    def _blend(r, g, b, f):
        # f>0 lightens toward white-ish, f<0 darkens; clamped.
        r = max(0, min(255, int(r + f * 255)))
        g = max(0, min(255, int(g + f * 255)))
        b = max(0, min(255, int(b + f * 255)))
        return r, g, b

    # Note: y=0 is TOP in PIL. Light source is top-left.
    band = max(2, size // 4)          # shading falloff depth
    hi = 0.32                          # top/left highlight strength
    sh = 0.30                          # bottom/right shadow strength
    top_pop = 0.16                     # extra highlight on the very top exposed row(s)
    pop_rows = max(1, size // 16)

    # Pass 1: directional edge shading with smooth falloff.
    for y in range(size):
        for x in range(size):
            r, g, b, a = pixels[x, y]
            if a < 25:
                continue
            f = 0.0
            if top_exposed and y < band:
                f += hi * (1 - y / band)
            if left_exposed and x < band:
                f += hi * 0.6 * (1 - x / band)
            if bottom_exposed:
                d = size - 1 - y
                if d < band:
                    f -= sh * (1 - d / band)
            if right_exposed:
                d = size - 1 - x
                if d < band:
                    f -= sh * 0.6 * (1 - d / band)
            # grass-like top: give the very top exposed rows an extra lift
            if top_exposed and y < pop_rows:
                f += top_pop
            if f != 0.0:
                r, g, b = _blend(r, g, b, f)
                pixels[x, y] = (r, g, b, a)

    # Pass 2: inner bevel — one dimmer line just inside where the outline will sit.
    outline_w = max(1, size // 16)
    bevel = outline_w                  # bevel line lives immediately inside the outline
    for y in range(size):
        for x in range(size):
            r, g, b, a = pixels[x, y]
            if a < 25:
                continue
            f = 0.0
            if top_exposed and outline_w <= y < outline_w + bevel:
                f += 0.22               # bright bevel under the top outline
            if left_exposed and outline_w <= x < outline_w + bevel:
                f += 0.14
            if bottom_exposed and size - outline_w - bevel <= y < size - outline_w:
                f -= 0.22               # dark bevel above the bottom outline
            if right_exposed and size - outline_w - bevel <= x < size - outline_w:
                f -= 0.14
            if f != 0.0:
                r, g, b = _blend(r, g, b, f)
                pixels[x, y] = (r, g, b, a)

    # Pass 3: crisp dark outline on exposed edges.
    for y in range(size):
        for x in range(size):
            r, g, b, a = pixels[x, y]
            if a < 25:
                continue
            hit = (
                (top_exposed and y < outline_w)
                or (bottom_exposed and y >= size - outline_w)
                or (left_exposed and x < outline_w)
                or (right_exposed and x >= size - outline_w)
            )
            if hit:
                dr, dg, db = _darken_px(r, g, b, 0.55)
                pixels[x, y] = (dr, dg, db, a)

    # Pass 4: rounded corners — clear the outermost convex corner where two edges are exposed.
    radius = max(1, size // 10)
    for y in range(size):
        for x in range(size):
            clear = (
                (top_exposed and left_exposed and x + y < radius)
                or (top_exposed and right_exposed and (size - 1 - x) + y < radius)
                or (bottom_exposed and left_exposed and x + (size - 1 - y) < radius)
                or (bottom_exposed and right_exposed and (size - 1 - x) + (size - 1 - y) < radius)
            )
            if clear:
                pixels[x, y] = (0, 0, 0, 0)

    return img

def generate_tileset(base_img: Image.Image) -> dict[int, Image.Image]:
    """Generate all 16 autotile variants from a base tile (mask 15)."""
    variants = {}
    for mask in range(16):
        variants[mask] = generate_autotile_variant(base_img, mask)
    return variants
