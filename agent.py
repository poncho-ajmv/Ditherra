"""
Ditherra Agent — LangGraph-based pixel art agent with canvas tools.

The agent gets a canvas, a palette, and tools to draw on it.
It thinks between each action, building up the sprite incrementally.
Supports continuation — send follow-up messages to the same agent thread.
"""

import json
import base64
import io
from typing import Any

from PIL import Image
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.memory import MemorySaver

import os
from pathlib import Path

import providers


# ── Checkpointer ──
#
# Single local process: LangGraph message history lives in memory. Canvas pixel
# state is owned by the caller (passed via `existing_pixels`), so a restart
# loses the conversation but never the sprite itself.

# ponytail: in-memory history, dies on restart. Swap for SqliteSaver if you want
# chat continuation to survive a server restart.
_checkpointer = MemorySaver()



def _thread_id_for(gen_id) -> str:
    """Deterministic thread ID per generation."""
    return f"job_{gen_id}"

# ── Canvas State ──

def palette_char(v: int) -> str:
    """Palette index as one character: 0-9, then A-Z, then a-z, '.' transparent.

    62 distinct symbols so palettes up to 62 colours stay readable to the agent.
    The single source for this mapping — the canvas grid, the view_canvas legend
    and the system prompt's palette listing all read it from here.
    """
    if v < 0:
        return "."
    if v < 10:
        return str(v)
    if v < 36:
        return chr(ord("A") + v - 10)
    if v < 62:
        return chr(ord("a") + v - 36)
    return "#"


class Canvas:
    def __init__(self, size: int, palette: list[str], pixels: list[list[int]] | None = None):
        self.size = size
        self.palette = palette
        self.pixels = pixels if pixels else [[-1] * size for _ in range(size)]

    def set_pixel(self, x: int, y: int, color: int) -> str:
        if not (0 <= x < self.size and 0 <= y < self.size):
            return f"Error: ({x},{y}) out of bounds (0-{self.size-1})"
        if color < -1 or color >= len(self.palette):
            return f"Error: color index {color} invalid (use -1 to {len(self.palette)-1})"
        self.pixels[y][x] = color
        return f"Set ({x},{y}) to {color}"

    def get_pixel(self, x: int, y: int) -> int:
        if 0 <= x < self.size and 0 <= y < self.size:
            return self.pixels[y][x]
        return -1

    def fill_rect(self, x1: int, y1: int, x2: int, y2: int, color: int) -> str:
        if color < -1 or color >= len(self.palette):
            return f"Error: color index {color} invalid"
        count = 0
        for y in range(max(0, y1), min(self.size, y2 + 1)):
            for x in range(max(0, x1), min(self.size, x2 + 1)):
                self.pixels[y][x] = color
                count += 1
        return f"Filled rect ({x1},{y1})-({x2},{y2}) with {color}, {count} pixels"

    def draw_line(self, x1: int, y1: int, x2: int, y2: int, color: int) -> str:
        if color < -1 or color >= len(self.palette):
            return f"Error: color index {color} invalid"
        dx, dy = abs(x2 - x1), abs(y2 - y1)
        sx = 1 if x1 < x2 else -1
        sy = 1 if y1 < y2 else -1
        err = dx - dy
        count = 0
        cx, cy = x1, y1
        while True:
            if 0 <= cx < self.size and 0 <= cy < self.size:
                self.pixels[cy][cx] = color
                count += 1
            if cx == x2 and cy == y2:
                break
            e2 = 2 * err
            if e2 > -dy:
                err -= dy
                cx += sx
            if e2 < dx:
                err += dx
                cy += sy
        return f"Drew line, {count} pixels"

    def fill_row(self, y: int, x_start: int, x_end: int, color: int) -> str:
        if color < -1 or color >= len(self.palette):
            return f"Error: color index {color} invalid"
        count = 0
        for x in range(max(0, x_start), min(self.size, x_end + 1)):
            if 0 <= y < self.size:
                self.pixels[y][x] = color
                count += 1
        return f"Filled row y={y}, {count} pixels"

    def fill_column(self, x: int, y_start: int, y_end: int, color: int) -> str:
        if color < -1 or color >= len(self.palette):
            return f"Error: color index {color} invalid"
        count = 0
        for y in range(max(0, y_start), min(self.size, y_end + 1)):
            if 0 <= x < self.size:
                self.pixels[y][x] = color
                count += 1
        return f"Filled column x={x}, {count} pixels"

    def draw_rotated_rect(self, cx: int, cy: int, w: int, h: int, angle_deg: float, color: int) -> int:
        """Draw a filled rotated rectangle. cx,cy = center, w,h = full width/height, angle_deg = rotation."""
        import math
        rad = math.radians(angle_deg)
        cos_a, sin_a = math.cos(rad), math.sin(rad)
        hw, hh = w / 2, h / 2
        # Check bounding box
        max_r = math.ceil(math.sqrt(hw * hw + hh * hh)) + 1
        count = 0
        for py in range(max(0, cy - max_r), min(self.size, cy + max_r + 1)):
            for px in range(max(0, cx - max_r), min(self.size, cx + max_r + 1)):
                # Rotate point into rect's local space
                dx = px - cx
                dy = py - cy
                lx = dx * cos_a + dy * sin_a
                ly = -dx * sin_a + dy * cos_a
                if abs(lx) <= hw and abs(ly) <= hh:
                    self.pixels[py][px] = color
                    count += 1
        return count

    def to_image(self) -> Image.Image:
        img = Image.new("RGBA", (self.size, self.size), (0, 0, 0, 0))
        for y, row in enumerate(self.pixels):
            for x, idx in enumerate(row):
                if 0 <= idx < len(self.palette):
                    h = self.palette[idx]
                    r, g, b = int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)
                    img.putpixel((x, y), (r, g, b, 255))
        return img

    def to_visual_grid(self) -> str:
        """Compact visual grid using single-char symbols. Much easier for small LLMs to parse."""
        # Column ruler
        if self.size <= 16:
            ruler = "   " + "".join(f"{x:X}" for x in range(self.size))
        else:
            # Two-line ruler for 32+
            tens = "   " + "".join(str(x // 10) if x >= 10 else " " for x in range(self.size))
            ones = "   " + "".join(f"{x % 10}" for x in range(self.size))
            ruler = tens + "\n" + ones

        rows = []
        for y, row in enumerate(self.pixels):
            label = f"{y:>2} " if self.size <= 16 else f"{y:>3}"
            rows.append(label + "".join(palette_char(v) for v in row))

        return ruler + "\n" + "\n".join(rows)

    def region_summary(self, y1: int, x1: int, y2: int, x2: int) -> str:
        """Describe what's in a rectangular region — helps the model understand spatial layout."""
        counts: dict[int, int] = {}
        for y in range(max(0, y1), min(self.size, y2 + 1)):
            for x in range(max(0, x1), min(self.size, x2 + 1)):
                v = self.pixels[y][x]
                counts[v] = counts.get(v, 0) + 1
        total = sum(counts.values())
        if total == 0:
            return "empty"
        parts = []
        for idx, c in sorted(counts.items(), key=lambda x: -x[1]):
            pct = c * 100 // total
            if pct < 5:
                continue
            if idx < 0:
                parts.append(f"empty:{pct}%")
            else:
                parts.append(f"{idx}:{pct}%")
        return " ".join(parts)

    # ── Shape drawing ──

    def draw_circle(self, cx: int, cy: int, radius: int, color: int, fill: bool = True) -> int:
        count = 0
        for y in range(max(0, cy - radius), min(self.size, cy + radius + 1)):
            for x in range(max(0, cx - radius), min(self.size, cx + radius + 1)):
                dx, dy = x - cx, y - cy
                dist_sq = dx * dx + dy * dy
                r_sq = radius * radius
                if fill:
                    if dist_sq <= r_sq:
                        self.pixels[y][x] = color
                        count += 1
                else:
                    # Outline only — within 1px of the edge
                    if abs(dist_sq - r_sq) <= radius * 2:
                        self.pixels[y][x] = color
                        count += 1
        return count

    def draw_ellipse(self, cx: int, cy: int, rx: int, ry: int, color: int, fill: bool = True) -> int:
        count = 0
        for y in range(max(0, cy - ry), min(self.size, cy + ry + 1)):
            for x in range(max(0, cx - rx), min(self.size, cx + rx + 1)):
                dx, dy = (x - cx) / max(rx, 1), (y - cy) / max(ry, 1)
                dist = dx * dx + dy * dy
                if fill:
                    if dist <= 1.0:
                        self.pixels[y][x] = color
                        count += 1
                else:
                    if abs(dist - 1.0) <= 0.3:
                        self.pixels[y][x] = color
                        count += 1
        return count

    def draw_triangle(self, x1: int, y1: int, x2: int, y2: int, x3: int, y3: int, color: int, fill: bool = True) -> int:
        def sign(px, py, ax, ay, bx, by):
            return (px - bx) * (ay - by) - (ax - bx) * (py - by)

        min_x = max(0, min(x1, x2, x3))
        max_x = min(self.size - 1, max(x1, x2, x3))
        min_y = max(0, min(y1, y2, y3))
        max_y = min(self.size - 1, max(y1, y2, y3))

        count = 0
        for y in range(min_y, max_y + 1):
            for x in range(min_x, max_x + 1):
                d1 = sign(x, y, x1, y1, x2, y2)
                d2 = sign(x, y, x2, y2, x3, y3)
                d3 = sign(x, y, x3, y3, x1, y1)
                has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
                has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
                if not (has_neg and has_pos):
                    self.pixels[y][x] = color
                    count += 1
        return count

    # ── Noise filling ──

    @staticmethod
    def _hash_noise(x: int, y: int, seed: int) -> float:
        n = x * 374761393 + y * 668265263 + seed * 1274126177
        n = ((n ^ (n >> 13)) * 1274126177) & 0x7fffffff
        n = n ^ (n >> 16)
        return (n & 0x7fffffff) / 0x7fffffff

    def fill_noise(self, x1: int, y1: int, x2: int, y2: int,
                   colors: list[int], seed: int = 42, scale: float = 1.0) -> int:
        """Simple value noise — distributes colors randomly based on noise."""
        count = 0
        n_colors = len(colors)
        if n_colors == 0:
            return 0
        for y in range(max(0, y1), min(self.size, y2 + 1)):
            for x in range(max(0, x1), min(self.size, x2 + 1)):
                n = self._hash_noise(int(x * scale), int(y * scale), seed)
                idx = int(n * n_colors) % n_colors
                self.pixels[y][x] = colors[idx]
                count += 1
        return count

    def fill_voronoi(self, x1: int, y1: int, x2: int, y2: int,
                     colors: list[int], num_points: int = 8, seed: int = 42) -> int:
        """Voronoi noise — creates cell-like patterns with given colors."""
        w = x2 - x1 + 1
        h = y2 - y1 + 1
        # Generate random seed points
        points = []
        for i in range(num_points):
            px = x1 + int(self._hash_noise(i, 0, seed) * w)
            py = y1 + int(self._hash_noise(0, i, seed + 99) * h)
            points.append((px, py, colors[i % len(colors)]))

        count = 0
        for y in range(max(0, y1), min(self.size, y2 + 1)):
            for x in range(max(0, x1), min(self.size, x2 + 1)):
                best_dist = float('inf')
                best_color = colors[0]
                for px, py, pc in points:
                    d = (x - px) ** 2 + (y - py) ** 2
                    if d < best_dist:
                        best_dist = d
                        best_color = pc
                self.pixels[y][x] = best_color
                count += 1
        return count

    def fill_noise_circle(self, cx: int, cy: int, radius: int,
                          colors: list[int], seed: int = 42) -> int:
        """Fill a circular area with noise-distributed colors."""
        count = 0
        n_colors = len(colors)
        if n_colors == 0:
            return 0
        for y in range(max(0, cy - radius), min(self.size, cy + radius + 1)):
            for x in range(max(0, cx - radius), min(self.size, cx + radius + 1)):
                if (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2:
                    n = self._hash_noise(x, y, seed)
                    self.pixels[y][x] = colors[int(n * n_colors) % n_colors]
                    count += 1
        return count

    def to_image_b64(self, scale: int = 512) -> str:
        img = self.to_image().resize((scale, scale), Image.NEAREST)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()


# ── Tool factory ──

def make_tools(canvas: Canvas, vision: bool = True, full_toolset: bool = True,
               require_review: bool = False):
    """Create agent tools. vision=False omits base64 previews. full_toolset=False
    drops advanced shape/noise tools. require_review makes finish() refuse to end
    a run whose last action was a drawing tool — see the finish tool below."""

    # Snapshot of the canvas as of the last view_canvas. finish() compares it to
    # the canvas now: if they differ, the agent drew something and then quit
    # without ever looking at the result. Comparing pixels rather than counting
    # tool calls means every drawing tool is covered, including any added later,
    # without a flag to remember to set in each one.
    last_viewed: list = [None]

    def _snapshot():
        return tuple(tuple(row) for row in canvas.pixels)

    @tool
    def draw_pixel(x: int, y: int, color: int) -> str:
        """Set a single pixel at (x, y) to a palette color index. Use -1 for transparent."""
        return canvas.set_pixel(x, y, color)

    @tool
    def draw_pixels(pixels: list[dict]) -> str:
        """Set multiple pixels at once. Each dict has keys: x, y, color. Use this for efficiency when setting many pixels."""
        errors = []
        drawn = 0
        for p in pixels:
            try:
                x = int(p.get("x", p.get("X", 0)))
                y = int(p.get("y", p.get("Y", 0)))
                c = int(p.get("color", p.get("c", p.get("colour", -1))))
                r = canvas.set_pixel(x, y, c)
                if r.startswith("Error"):
                    errors.append(r)
                else:
                    drawn += 1
            except (KeyError, TypeError, ValueError) as e:
                errors.append(f"Bad pixel data: {p} ({e})")
        return f"Drew {drawn} pixels. {len(errors)} errors: {errors[:3]}" if errors else f"Drew {drawn} pixels."

    @tool
    def fill_rect(x1: int, y1: int, x2: int, y2: int, color: int) -> str:
        """Fill a rectangle from (x1,y1) to (x2,y2) inclusive with a palette color index."""
        return canvas.fill_rect(x1, y1, x2, y2, color)

    @tool
    def fill_row(y: int, x_start: int, x_end: int, color: int) -> str:
        """Fill a horizontal row at y from x_start to x_end inclusive."""
        return canvas.fill_row(y, x_start, x_end, color)

    @tool
    def fill_column(x: int, y_start: int, y_end: int, color: int) -> str:
        """Fill a vertical column at x from y_start to y_end inclusive."""
        return canvas.fill_column(x, y_start, y_end, color)

    @tool
    def draw_line(x1: int, y1: int, x2: int, y2: int, color: int) -> str:
        """Draw a 1-pixel-wide line from (x1,y1) to (x2,y2)."""
        return canvas.draw_line(x1, y1, x2, y2, color)

    @tool
    def draw_circle(cx: int, cy: int, radius: int, color: int, fill: bool = True) -> str:
        """Draw a circle. cx,cy = center, radius = size. fill=True for solid, fill=False for outline only."""
        count = canvas.draw_circle(cx, cy, radius, color, fill)
        return f"Drew {'filled' if fill else 'outline'} circle at ({cx},{cy}) r={radius}, {count}px"

    @tool
    def view_canvas() -> str:
        """View the current canvas. Returns a visual grid where each character is a palette index (0-9, A-Z) and '.' is transparent. Use this to check your work."""
        last_viewed[0] = _snapshot()
        grid = canvas.to_visual_grid()

        # Usage counts. The palette itself is already in the system prompt, so
        # repeating "2 = 2(#8B5E3C)" on every look was pure duplication — the
        # counts are the only new information here.
        color_counts: dict[int, int] = {}
        for row in canvas.pixels:
            for v in row:
                color_counts[v] = color_counts.get(v, 0) + 1
        used = " ".join(f"{palette_char(i)}:{n}" for i, n in
                        sorted(color_counts.items(), key=lambda x: -x[1])[:12])
        total = sum(c for i, c in color_counts.items() if i >= 0)

        # Spatial summary: describe each quadrant
        half = canvas.size // 2
        spatial = f"TOP-LEFT: {canvas.region_summary(0, 0, half-1, half-1)} | TOP-RIGHT: {canvas.region_summary(0, half, half-1, canvas.size-1)} | BOTTOM-LEFT: {canvas.region_summary(half, 0, canvas.size-1, half-1)} | BOTTOM-RIGHT: {canvas.region_summary(half, half, canvas.size-1, canvas.size-1)}"

        result = f"{grid}\n\nUSED: {used}\nFilled: {total}/{canvas.size*canvas.size}px\nLAYOUT: {spatial}"

        # Only include base64 preview for vision-capable models
        if vision:
            img_b64 = canvas.to_image_b64(64)
            result += f"\n\n[PREVIEW base64 PNG 64x64]\n{img_b64}"

        return result

    @tool
    def get_pixel(x: int, y: int) -> str:
        """Get the palette index at position (x, y)."""
        v = canvas.get_pixel(x, y)
        name = canvas.palette[v] if 0 <= v < len(canvas.palette) else "transparent"
        return f"({x},{y}) = {v} ({name})"

    @tool
    def finish() -> str:
        """Call this when the sprite is complete and you're satisfied with the result."""
        # Finishing straight after a drawing tool means the last thing the agent
        # did was change the canvas and then declare it good without looking.
        # The refusal is worded as the next step, not as an error, so the model
        # acts on it instead of retrying finish. Must not contain the literal
        # FINISHED — that string is what the run loop watches for.
        if require_review and last_viewed[0] != _snapshot():
            return ("Not done yet: the canvas changed since your last view_canvas, "
                    "so you have not seen what you just drew. Call view_canvas, "
                    "name every defect you find using the review checklist, and fix "
                    "them. Only call finish after a review pass that found nothing "
                    "worth changing.")
        return "FINISHED"

    @tool
    def noise_fill_rect(x1: int, y1: int, x2: int, y2: int, colors: list[int], seed: int = 42, scale: float = 1.0) -> str:
        """Fill a rectangle with noise-distributed colors. Randomly picks from the color list per pixel based on noise. Use different seeds for variation. Scale controls granularity (higher = finer)."""
        count = canvas.fill_noise(x1, y1, x2, y2, colors, seed, scale)
        return f"Noise-filled rect ({x1},{y1})-({x2},{y2}) with {len(colors)} colors, {count}px"

    # Core tools — always included (8 tools)
    core = [
        draw_pixel, draw_pixels, fill_rect, fill_row, fill_column, draw_line,
        draw_circle, noise_fill_rect,
        view_canvas, get_pixel, finish,
    ]

    if not full_toolset:
        return core

    # Advanced tools — only for capable models

    @tool
    def draw_ellipse(cx: int, cy: int, rx: int, ry: int, color: int, fill: bool = True) -> str:
        """Draw an ellipse. cx,cy = center, rx/ry = horizontal/vertical radius. fill=True for solid."""
        count = canvas.draw_ellipse(cx, cy, rx, ry, color, fill)
        return f"Drew {'filled' if fill else 'outline'} ellipse at ({cx},{cy}) rx={rx} ry={ry}, {count}px"

    @tool
    def draw_triangle(x1: int, y1: int, x2: int, y2: int, x3: int, y3: int, color: int) -> str:
        """Draw a filled triangle with 3 corner points."""
        count = canvas.draw_triangle(x1, y1, x2, y2, x3, y3, color)
        return f"Drew triangle ({x1},{y1})-({x2},{y2})-({x3},{y3}), {count}px"

    @tool
    def draw_rotated_rect(cx: int, cy: int, width: int, height: int, angle: float, color: int) -> str:
        """Draw a filled rotated rectangle. cx,cy = center position. width,height = full dimensions. angle = rotation in degrees (0=horizontal, 45=diagonal, etc)."""
        count = canvas.draw_rotated_rect(cx, cy, width, height, angle, color)
        return f"Drew rotated rect at ({cx},{cy}) {width}x{height} angle={angle}deg, {count}px"

    @tool
    def noise_fill_circle(cx: int, cy: int, radius: int, colors: list[int], seed: int = 42) -> str:
        """Fill a circular area with noise-distributed colors. Good for organic patches, spots, texture within a round area."""
        count = canvas.fill_noise_circle(cx, cy, radius, colors, seed)
        return f"Noise-filled circle at ({cx},{cy}) r={radius} with {len(colors)} colors, {count}px"

    @tool
    def voronoi_fill(x1: int, y1: int, x2: int, y2: int, colors: list[int], num_cells: int = 8, seed: int = 42) -> str:
        """Fill a rectangle with Voronoi cell pattern. Creates organic stone-like, cobblestone, or cellular textures. Each cell gets a color from the list. num_cells controls how many cells (more = smaller cells)."""
        count = canvas.fill_voronoi(x1, y1, x2, y2, colors, num_cells, seed)
        return f"Voronoi-filled rect ({x1},{y1})-({x2},{y2}) with {num_cells} cells, {count}px"

    return core + [draw_ellipse, draw_triangle, draw_rotated_rect, noise_fill_circle, voronoi_fill]


# ── LLM factory ──
#
# One lookup, no branching on model names. providers.json says where each model
# lives and which env var holds its key; almost everything speaks the OpenAI
# protocol, so almost everything lands in the same ChatOpenAI call.

# A call that never returns used to hang the whole generation forever: the SSE
# keepalive kept the UI saying "painting", the worker thread stayed alive, and
# the only way out was restarting the server. Generous on purpose — a 4B model
# on a laptop can legitimately take minutes on one call — but finite.
LLM_TIMEOUT = float(os.getenv("DITHERRA_LLM_TIMEOUT", "600"))
LLM_RETRIES = 1


def _get_llm(model_id: str, temperature: float = 0.7):
    name, p, model = providers.resolve(model_id)
    kind = p.get("kind", "openai")

    if kind == "antigravity":
        # Map antigravity model alias
        if model == "antigravity-pro":
            target_model = "gemini-2.5-pro"
        elif model == "antigravity-preview":
            target_model = "gemini-3-flash-preview"
        elif model == "antigravity-flash":
            target_model = "gemini-2.5-flash"
        elif "pro" in model:
            target_model = "gemini-2.5-pro"
        elif "flash" in model:
            target_model = "gemini-2.5-flash"
        else:
            target_model = model

        saved = providers._saved_keys()
        gkey = (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
                or saved.get("GEMINI_API_KEY") or saved.get("GOOGLE_API_KEY"))
        if gkey:
            from langchain_google_genai import ChatGoogleGenerativeAI
            return ChatGoogleGenerativeAI(model=target_model, temperature=temperature, google_api_key=gkey,
                                          timeout=LLM_TIMEOUT, max_retries=LLM_RETRIES)

        creds_path = Path(os.path.expanduser("~/.gemini/oauth_creds.json"))
        if creds_path.exists():
            try:
                import json
                from google.oauth2.credentials import Credentials
                from langchain_google_genai import ChatGoogleGenerativeAI
                data = json.loads(creds_path.read_text())
                creds = Credentials(
                    token=data.get("access_token"),
                    refresh_token=data.get("refresh_token"),
                    token_uri="https://oauth2.googleapis.com/token",
                    client_id=data.get("client_id"),
                    client_secret=data.get("client_secret")
                )
                return ChatGoogleGenerativeAI(
                    model=target_model,
                    temperature=temperature,
                    timeout=LLM_TIMEOUT,
                    max_retries=LLM_RETRIES,
                    credentials=creds,
                    vertexai=True,
                    project=os.getenv("ANTIGRAVITY_PROJECT_ID", "default-cli-project")
                )
            except Exception as e:
                print(f"[Antigravity Provider] OAuth error: {e}")

        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(model=target_model, temperature=temperature,
                                      timeout=LLM_TIMEOUT, max_retries=LLM_RETRIES)

    if kind == "gemini":
        # An AI Studio API key (from the env OR the key the settings panel saved
        # to secrets.json) means the simple ChatGoogleGenerativeAI path. Only fall
        # back to Vertex AI when there's genuinely no key — a saved key was being
        # ignored, so Gemini demanded a GCP project that a key user never has.
        saved = providers._saved_keys()
        gkey = (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
                or saved.get("GEMINI_API_KEY") or saved.get("GOOGLE_API_KEY"))
        if gkey:
            from langchain_google_genai import ChatGoogleGenerativeAI
            return ChatGoogleGenerativeAI(model=model, temperature=temperature, google_api_key=gkey,
                                          timeout=LLM_TIMEOUT, max_retries=LLM_RETRIES)
        from langchain_google_vertexai import ChatVertexAI
        return ChatVertexAI(
            model_name=model,
            temperature=temperature,
            project=providers.google_service_account(),
            location=os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
            timeout=LLM_TIMEOUT,
            max_retries=LLM_RETRIES,
        )

    from langchain_openai import ChatOpenAI
    # OPENAI_BASE_URL points the openai provider at a compatible server (vLLM,
    # LiteLLM, a proxy). Documented in .env.example; only applies to plain openai.
    base_url = os.getenv("OPENAI_BASE_URL") if name == "openai" else None

    # Thinking models (qwen3 and friends) reason before answering, and Ollama
    # turns that on by default. A 4B model on a small context can spend its
    # entire budget thinking and never emit a single tool call — the run logs
    # "start" and then nothing, forever. Ollama's OpenAI-compatible endpoint
    # accepts reasoning_effort, so this costs one field instead of a new client.
    # extra_body, not model_kwargs: langchain may already own the named param.
    extra = {"reasoning_effort": "none"} if p.get("kind") != "gemini" and providers.is_local(p) else None

    return ChatOpenAI(
        model=model,
        temperature=temperature,
        base_url=base_url or p["base_url"],
        # Local servers ignore the key but the client still demands a string.
        api_key=providers.api_key(p) or "not-needed",
        timeout=LLM_TIMEOUT,
        max_retries=LLM_RETRIES,
        **({"extra_body": extra} if extra else {}),
    )


# ── Sessions ──
#
# LangGraph owns the message history (in the checkpointer, keyed by gen_id).
# Canvas pixel state is owned by the caller — passed in via `existing_pixels`
# for continuations.

def thread_exists(gen_id) -> bool:
    """Return True if a LangGraph thread already exists for this gen_id."""
    cp = _checkpointer
    config = {"configurable": {"thread_id": _thread_id_for(gen_id)}}
    try:
        return cp.get(config) is not None
    except Exception:
        return False


# ── System prompt ──

from sprite_types import SPRITE_TYPES


def agent_hint(sprite_type: str) -> str:
    """Painting instructions for a sprite type, falling back to a plain block."""
    entry = SPRITE_TYPES.get(sprite_type) or SPRITE_TYPES["block"]
    return entry["agent_hint"]

def describe_tools(tools) -> str:
    """The prompt's tool list, generated from the tools the agent actually has.

    This used to be two hand-written lists. Adding a tool meant four edits, and
    forgetting one meant the model was told about a tool that didn't exist — or
    never heard about a new one. Neither failure raises anything; you just get
    worse sprites. Generated, the two can't disagree.
    """
    lines = []
    for t in tools:
        args = ",".join(t.args.keys())
        summary = (t.description or "").strip().split("\n")[0]
        lines.append(f"- {t.name}({args}) — {summary}")
    return "\n".join(lines)


WORKFLOW_ONE_PASS = """WORKFLOW:
1. Plan what to draw — think about the shape, then the colors
2. Fill large areas first with fill_rect
3. Call view_canvas to see your progress
4. Add details with draw_pixel or draw_pixels
5. Call view_canvas again to check
6. Use noise_fill_rect to add texture variation if needed
7. Final view_canvas to verify everything looks right
8. Call finish when done

IMPORTANT: Call view_canvas after every few drawing steps. It shows you exactly what the canvas looks like so you can correct mistakes early."""


# The one-pass workflow above is a recipe: do these eight things, then stop. A
# cooperative model follows it literally and calls finish around step 12, no
# matter how large a step budget it was given — which is why raising the budget
# alone never raised quality. This version has no step 8. It loops on a review
# with named defects, and the only way out is a pass that finds nothing.
WORKFLOW_REFINE = """WORKFLOW — you block in, then you refine. There is no step
where you are done just because you drew something once.

BLOCK IN
1. Decide the silhouette before any color: what shape reads as this subject at
   this size? At small sizes the silhouette IS the sprite.
2. Fill the large masses with fill_rect. Do not start with details.
3. Call view_canvas.

REFINE — repeat this loop until a full pass finds nothing to fix
4. Look at the canvas and name, out loud, every defect you can see. Check for:
   - SILHOUETTE: would you recognise the subject from the outline alone?
   - LIGHT: is there one consistent light direction? Highlights on the lit side,
     shadow on the other, mid-tone between. Flat single-color shapes look unfinished.
   - STRAY PIXELS: isolated pixels that belong to nothing, ragged edges, holes
     inside a mass that should be solid.
   - PALETTE: are you using the range you were given, or only two or three of
     them? Unused colors are usually a missed shade or highlight.
   - READABILITY: at this size, does any detail turn to mush? If a detail costs
     more than 2-3 pixels of clarity elsewhere, cut it.
   - EDGES: intentional contrast at the boundary, no accidental blur.
5. Fix what you named. One defect at a time — a big fill can undo good work.
6. Call view_canvas again and look at what your fix actually did. A fix that
   introduced a new problem is not a fix.
7. If that pass found nothing worth changing, and only then, call finish.

RULES
- Never call finish right after a drawing tool. Always view_canvas first and
  judge what you see — finish will reject you otherwise.
- "It looks fine" is not a review. Name what you checked.
- Being slow is fine. The user asked for the best sprite you can make, not the
  fastest one. They can stop you at any time if they've seen enough.
- If two passes in a row change nothing meaningful, you are done — say so and
  call finish. Do not churn."""


def build_system_prompt(user_prompt: str, palette: list[str], size: int,
                        style_prompt: str, tools, sprite_type: str = "block",
                        has_reference: bool = False, review: bool = False) -> str:
    palette_desc = "\n".join(
        f"  {i} (char {palette_char(i)}): {c}" if i >= 10 else f"  {i}: {c}"
        for i, c in enumerate(palette)
    )

    tools_text = describe_tools(tools)

    grid_explanation = """When you call view_canvas, you see a grid like this:
   0123456789ABCDEF    ← column numbers (hex for 10-15)
 0 ................    ← row 0 (all transparent)
 1 ..0000000000....    ← row 1 (color 0 in columns 2-11)
Each character is a palette index: 0-9 = colors 0-9, A-Z = colors 10-35, a-z = colors 36-61, . = transparent
Read it like a picture: rows go top to bottom (y), columns go left to right (x).""" if size <= 16 else """When you call view_canvas, you see a grid. Each character = one pixel.
0-9 = palette colors 0-9, A-Z = colors 10-35, a-z = colors 36-61, . = transparent.
Rows = y (top to bottom), columns = x (left to right)."""

    return f"""{style_prompt}

You are a pixel artist. You draw on a {size}x{size} canvas using color indices from a palette.

SUBJECT: {user_prompt}

PALETTE:
{palette_desc}
Use -1 for transparent.

{agent_hint(sprite_type)}

{"A reference image is attached. Match its shapes and colors in pixel art." if has_reference else ""}

COORDINATE SYSTEM:
- (0,0) = top-left corner
- ({size-1},{size-1}) = bottom-right corner
- x goes RIGHT (columns), y goes DOWN (rows)

{grid_explanation}

TOOLS:
{tools_text}

{WORKFLOW_REFINE if review else WORKFLOW_ONE_PASS}"""


# How hard the agent works. More steps means more passes of "look, fix, look",
# which is where quality actually comes from — and the preview image is the most
# expensive single thing sent, so draft skips it.
QUALITY = {
    "draft":  {"max_steps": 25,  "preview": False, "review": False},  # quick + cheap, paints blind
    "normal": {"max_steps": 80,  "preview": True,  "review": False},  # = the original repo baseline
    "high":   {"max_steps": 120, "preview": True,  "review": False},  # more passes, same recipe
    # Quality above everything. The step budget stops being the dial: what this
    # changes is the *instructions* — a review loop the agent only leaves when a
    # full pass finds nothing to fix — and a finish tool it has to earn.
    # max_steps None means the only stops are the agent's own finish and the
    # user's STOP button; a ceiling can still be imposed per request.
    "max":    {"max_steps": None, "preview": True, "review": True},
}

# Imposed only when the user says cost matters (Settings). High enough that a
# real sprite never reaches it — it exists to end a model stuck in a loop, not
# to end a sprite that's still improving.
RUNAWAY_CEILING = 500


def step_budget(quality: str, step_ceiling: int | None = None) -> int | None:
    """How many steps a run gets, or None for uncapped.

    Uncapped means the agent's own `finish` and the user's STOP button are the
    only things that end the run. A ceiling only ever cuts a budget down — it
    can't hand a tier more steps than the tier asked for.
    """
    base = QUALITY.get(quality, QUALITY["normal"])["max_steps"]
    if step_ceiling is None:
        return base
    return step_ceiling if base is None else min(base, step_ceiling)


def _drop_stale_canvas_views(state):
    """Keep only the most recent canvas view in what the model is sent.

    Every `view_canvas` result stayed in the conversation forever, and the whole
    conversation is re-sent on every call — so after 30 looks the model receives
    30 pictures of the canvas, 29 of which show a canvas that no longer exists.
    That is 17x the tokens AND worse painting: contradictory snapshots of the
    same thing are noise, not context. The older ones become a one-line stub.
    """
    kept = False
    trimmed = []
    for m in reversed(state["messages"]):
        if getattr(m, "name", None) == "view_canvas" and isinstance(getattr(m, "content", None), str):
            if kept:
                m = m.model_copy(update={"content": "[earlier canvas view — superseded]"})
            kept = True
        trimmed.append(m)
    return {"llm_input_messages": _sanitize_tool_pairing(list(reversed(trimmed)))}


def _sanitize_tool_pairing(messages):
    """Guarantee every AIMessage.tool_calls has a matching ToolMessage, and vice
    versa, in the list we hand to the model.

    OpenAI-compatible APIs (deepseek-chat especially) return 400
    "An assistant message with 'tool_calls' must be followed by tool messages
    responding to each 'tool_call_id'" if that pairing is broken. deepseek
    occasionally emits a tool_call that never gets a paired ToolMessage (duplicate
    or malformed ids on parallel calls), which poisons the whole thread since the
    full history is re-sent on every step. Every model call flows through the
    pre_model_hook, so this is the one choke point that fixes it for good.

    Only drops dangling tool_calls / orphan tool responses — never reorders, never
    rewrites content, never fabricates tool output. Idempotent.
    """
    responded = {
        m.tool_call_id
        for m in messages
        if isinstance(m, ToolMessage) and getattr(m, "tool_call_id", None)
    }
    called: set = set()
    out = []
    for m in messages:
        tcs = getattr(m, "tool_calls", None)
        if isinstance(m, AIMessage) and tcs:
            kept_tcs = [tc for tc in tcs if tc.get("id") in responded]
            if len(kept_tcs) != len(tcs):
                m = m.model_copy(update={"tool_calls": kept_tcs})
            called.update(tc.get("id") for tc in kept_tcs)
        out.append(m)
    # Drop tool responses whose call we just dropped or never saw.
    return [
        m for m in out
        if not (isinstance(m, ToolMessage) and m.tool_call_id not in called)
    ]


# ── Run agent (initial or continuation) ──

def run_agent_stream(
    gen_id,
    message: str,
    palette: list[str],
    size: int,
    model_name: str,
    style_prompt: str = "",
    sprite_type: str = "block",
    reference_b64: str | None = None,
    on_step: Any = None,
    quality: str = "normal",
    existing_pixels: list[list[int]] | None = None,
    cancel_check: Any = None,
    step_ceiling: int | None = None,
):
    """
    Run the agent or continue an existing session.

    First call (no thread for `gen_id`) creates the session and seeds it with the
    full system prompt. Subsequent calls (thread already exists in checkpointer)
    continue the conversation as a chat edit.
    """
    # Build the canvas from the caller-provided pixel state. Canvas pixel state
    # lives outside the LangGraph thread (it's owned by the job system, not
    # the conversation). LangGraph just owns the message history.
    q = QUALITY.get(quality, QUALITY["normal"])
    # None = the agent's own finish and the user's STOP are the only stops.
    # A caller-supplied ceiling (Settings: "cost matters") caps it either way.
    max_steps = step_budget(quality, step_ceiling)
    review = q["review"]

    canvas = Canvas(size, palette, existing_pixels)
    _, provider, bare_model = providers.resolve(model_name)
    is_codex = provider.get("kind") == "codex"
    if is_codex:
        import codex_app_server
        is_new = not codex_app_server.has_thread(gen_id)
    else:
        is_new = not thread_exists(gen_id)
    thread_id = _thread_id_for(gen_id)

    can_see = providers.has_vision(model_name)
    vision = can_see and q["preview"]      # draft skips the image to save tokens
    tools = make_tools(canvas, vision=vision, full_toolset=can_see, require_review=review)

    show_reference = False
    if is_new:
        # A reference only reaches a model that can see. Sending an image_url to a
        # text-only model is either an API error or a silent drop — and a silent
        # drop is worse: you confirm concept art and the agent never looks at it.
        show_reference = reference_b64 is not None and can_see
        sys_prompt = build_system_prompt(message, palette, size, style_prompt, tools, sprite_type,
                                         has_reference=show_reference, review=review)
        prompt_text = sys_prompt
        user_parts = [{"type": "text", "text": sys_prompt}]
        if show_reference:
            user_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{reference_b64}"},
            })
        elif reference_b64 and on_step:
            on_step(canvas, "warning", f"{model_name} can't see images — painting from the prompt only")
        input_message = HumanMessage(content=user_parts)
    else:
        # Follow-up: include current canvas state so the agent knows what it's editing
        grid = canvas.to_visual_grid()
        follow_up = f"""The user wants you to make changes to the current sprite.

CURRENT CANVAS STATE:
{grid}

USER REQUEST: {message}

Use the canvas tools to make the requested changes. Call finish when done."""
        prompt_text = follow_up
        input_message = HumanMessage(content=follow_up)

    if is_codex:
        codex_app_server.run_pixel_turn(
            gen_id=gen_id,
            model=bare_model,
            text=prompt_text,
            tools=tools,
            canvas=canvas,
            reference_b64=reference_b64 if show_reference else None,
            on_step=on_step,
            max_steps=max_steps if max_steps is not None else RUNAWAY_CEILING,
            cancel_check=cancel_check,
        )
        return canvas

    llm = _get_llm(model_name)
    checkpointer = _checkpointer
    try:
        agent = create_react_agent(llm, tools, checkpointer=checkpointer,
                                   pre_model_hook=_drop_stale_canvas_views)
    except TypeError:
        # ponytail: older LangGraph has no pre_model_hook. Run without trimming
        # rather than refuse to start — it costs tokens, it doesn't break.
        agent = create_react_agent(llm, tools, checkpointer=checkpointer)

    # LangGraph's own ceiling defaults to 25 super-steps, which lands *below* every
    # QUALITY tier — draft/normal/high all stopped at the same ~12 tool calls, and
    # hitting it raises GraphRecursionError instead of finishing. One round trip is
    # two nodes (agent + tools), so give it room for max_steps of them plus slack.
    # LangGraph's default ceiling is 25 super-steps, below every tier — hitting it
    # raises GraphRecursionError instead of finishing. One round trip is two nodes.
    # Uncapped still needs a number here, so use the runaway guard.
    budget = max_steps if max_steps is not None else RUNAWAY_CEILING
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": budget * 2 + 10}

    step_count = 0
    finished = False

    # Normally consume the full stream — don't break early to avoid GeneratorExit
    # in LangSmith. The one exception is cancel: draining still pulls the next chunk,
    # which runs the next node = another model call, so draining wouldn't stop token
    # spend. To actually stop, break and close() the generator explicitly (clean,
    # no uncaught GeneratorExit). Cancel is cooperative *between* steps: an in-flight
    # call can't be interrupted, but the next one never happens.
    stream = agent.stream(
        {"messages": [input_message]},
        config=config,
        stream_mode="updates",
    )
    for chunk in stream:
        if cancel_check and cancel_check():
            if on_step:
                on_step(canvas, "canceled", "Generation canceled")
            stream.close()
            break

        if finished:
            continue  # drain remaining chunks without processing

        for node_name, node_data in chunk.items():
            messages = node_data.get("messages", [])
            for msg in messages:
                # Real token usage, only when the provider actually reports it.
                # AIMessage.usage_metadata is a dict (input/output/total_tokens)
                # or None for providers that don't return counts — never guessed.
                um = getattr(msg, "usage_metadata", None)
                if um and on_step:
                    on_step(canvas, "usage", um)

                step_count += 1

                if hasattr(msg, "tool_calls") and msg.tool_calls:
                    # Agent decided to call a tool — log it but DON'T snapshot pixels yet
                    # (the tool hasn't executed, canvas hasn't changed)
                    for tc in msg.tool_calls:
                        info = f"Tool: {tc['name']}({json.dumps(tc['args'], separators=(',', ':'))})"
                        if on_step:
                            on_step(canvas, "tool_call", info)

                elif hasattr(msg, "content") and isinstance(msg.content, str):
                    content = msg.content.strip()
                    if "FINISHED" in (msg.content or ""):
                        finished = True
                    # Tool results come from the "tools" node — canvas has been updated
                    if node_name == "tools" and on_step:
                        on_step(canvas, "tool_result", content[:200])
                    elif content and on_step:
                        on_step(canvas, "thought", content[:200])

                if max_steps is not None and step_count >= max_steps:
                    finished = True

    return canvas


# ── Self-check ──

def _check_sanitize():
    """Assert the trimming/sanitizer keeps tool_call ↔ tool response pairing intact."""

    def ids(msgs):
        called, responded = set(), set()
        for m in msgs:
            if isinstance(m, AIMessage) and m.tool_calls:
                called.update(tc["id"] for tc in m.tool_calls)
            if isinstance(m, ToolMessage):
                responded.add(m.tool_call_id)
        return called, responded

    def paired(msgs):
        called, responded = ids(msgs)
        return called == responded

    # 1. Healthy history is left valid and complete.
    good = [
        HumanMessage(content="draw a cat"),
        AIMessage(content="", tool_calls=[
            {"name": "fill_row", "args": {}, "id": "a", "type": "tool_call"},
            {"name": "fill_row", "args": {}, "id": "b", "type": "tool_call"},
        ]),
        ToolMessage(content="ok", tool_call_id="a", name="fill_row"),
        ToolMessage(content="ok", tool_call_id="b", name="fill_row"),
    ]
    assert paired(_sanitize_tool_pairing(good)), "healthy pairing was broken"
    assert len(_sanitize_tool_pairing(good)) == 4, "healthy history lost messages"

    # 2. deepseek-style dangling tool_call (id 'b' never answered) gets dropped,
    #    leaving a valid history instead of a 400.
    bad = [
        HumanMessage(content="draw a cat"),
        AIMessage(content="", tool_calls=[
            {"name": "fill_row", "args": {}, "id": "a", "type": "tool_call"},
            {"name": "fill_row", "args": {}, "id": "b", "type": "tool_call"},
        ]),
        ToolMessage(content="ok", tool_call_id="a", name="fill_row"),
    ]
    fixed = _sanitize_tool_pairing(bad)
    assert paired(fixed), "dangling tool_call not repaired"
    ai = [m for m in fixed if isinstance(m, AIMessage)][0]
    assert [tc["id"] for tc in ai.tool_calls] == ["a"], "wrong tool_call kept"

    # 3. Orphan tool response (no matching call) is dropped.
    orphan = [
        HumanMessage(content="hi"),
        ToolMessage(content="stray", tool_call_id="zzz", name="fill_row"),
    ]
    assert paired(_sanitize_tool_pairing(orphan)), "orphan tool message not dropped"

    # 4. Idempotent.
    once = _sanitize_tool_pairing(bad)
    assert _sanitize_tool_pairing(once) == once, "sanitizer not idempotent"

    print("agent._check_sanitize: OK")


if __name__ == "__main__":
    _check_sanitize()
