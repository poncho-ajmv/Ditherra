"""
Ditherra — the sprite type catalogue.

One entry per type, and every consumer reads the same entry:

    label       the name shown in the UI dropdown
    ref_prompt  sent to the image model for the concept art
    agent_hint  prepended to the painting agent's system prompt
    has_tileset whether the autotile generator can run on it

These four used to be two dicts in two files — SPRITE_TYPES in server.py and
AGENT_TYPE_HINTS in agent.py — with the same eleven keys and nothing keeping
them in sync. Adding a type meant two edits, and forgetting one didn't break
anything: it just quietly produced worse art.
"""

SPRITE_TYPES = {
    "block": {
        "agent_hint": 'This is a BLOCK TILE. Fill EVERY pixel — no transparency (-1). The tile will be placed in a grid next to copies of itself. Cover the entire canvas with the material.',
        "label": "Block (Tile)",
        "ref_prompt": """Pixel art tile for a 2D side-scrolling sandbox platformer game (like Terraria/Growtopia).
IMPORTANT RULES:
- This is a SQUARE TILE that fills the ENTIRE canvas edge to edge. No empty space, no margins, no background visible.
- Viewed from the SIDE (2D side-scroller perspective), NOT top-down, NOT isometric, NOT 3D.
- The tile must be seamlessly tileable — it will be placed next to copies of itself in a grid.
- Flat front-facing view. No perspective, no depth, no 3D shading.
- Pixel art style with visible individual pixels. Crisp, no anti-aliasing, no smooth gradients.
- The entire square must be filled with the block material.""",
        "has_tileset": True,
    },
    "icon": {
        "agent_hint": 'This is an ITEM ICON. Draw the object shape and use -1 (transparent) for the background. Keep it compact, chunky, and recognizable. Leave some transparent padding around the edges.',
        "label": "Item Icon",
        "ref_prompt": """Pixel art item icon for a 2D game inventory.
IMPORTANT RULES:
- Single object centered on a TRANSPARENT background.
- Chunky, bold, readable at small sizes (16x16 to 32x32).
- Clear silhouette — the shape should be instantly recognizable.
- Viewed from the SIDE (2D side-scroller perspective).
- Pixel art style with visible individual pixels.
- The object should NOT fill the entire canvas — leave transparent padding around it.""",
        "has_tileset": False,
    },
    "character": {
        "agent_hint": 'This is a CHARACTER SPRITE. Draw a character on transparent background (-1). Make the silhouette clear and recognizable. Leave transparent padding around the edges.',
        "label": "Character",
        "ref_prompt": """Pixel art character sprite for a 2D game.
IMPORTANT RULES:
- Single character on a TRANSPARENT background.
- Front-facing or side-facing idle pose.
- Clear silhouette — the character should be instantly recognizable.
- Pixel art style with visible individual pixels. No anti-aliasing.
- Include basic details: eyes, clothing, distinguishing features.
- Readable at small sizes. Leave transparent padding around the character.""",
        "has_tileset": False,
    },
    "enemy": {
        "agent_hint": 'This is an ENEMY SPRITE. Draw a single creature on transparent background (-1). Give it a bold, threatening, instantly-readable silhouette. Leave transparent padding around the edges.',
        "label": "Enemy",
        "ref_prompt": """Pixel art enemy sprite for a 2D game.
IMPORTANT RULES:
- Single creature/enemy on a TRANSPARENT background.
- Side-facing or front-facing, readable threatening silhouette.
- Clear read at small sizes; bold shapes over fine detail.
- Pixel art style with visible individual pixels. No anti-aliasing.
- Leave transparent padding around the enemy.""",
        "has_tileset": False,
    },
    "platform": {
        "agent_hint": 'This is a PLATFORM piece. Fill the full WIDTH edge to edge so it tiles left-to-right; the TOP row(s) read as a walkable surface and below is solid material. Transparent (-1) only above the surface if the piece is thinner than the canvas.',
        "label": "Platform",
        "ref_prompt": """Pixel art platform piece for a 2D side-scrolling platformer.
IMPORTANT RULES:
- A horizontal ground/platform block, viewed from the SIDE (2D side-scroller).
- Fills the canvas WIDTH edge to edge so it tiles left-to-right seamlessly.
- Top surface reads as walkable ground; underside can be rock/dirt/structure.
- Flat front-facing view, no perspective, no 3D shading.
- Crisp pixel art, visible pixels, no anti-aliasing.""",
        "has_tileset": False,
    },
    "prop": {
        "agent_hint": 'This is a SCENERY PROP. Draw one decorative object resting on the ground, transparent background (-1). Clear chunky silhouette, transparent padding around it.',
        "label": "Prop / Decoration",
        "ref_prompt": """Pixel art scenery prop for a 2D game (barrel, crate, bush, sign, torch, rock).
IMPORTANT RULES:
- Single decorative object on a TRANSPARENT background.
- Sits on the ground — rendered as it would appear placed in a level.
- Viewed from the SIDE (2D side-scroller perspective).
- Clear silhouette, chunky pixel art, visible pixels, no anti-aliasing.
- Leave transparent padding around the prop.""",
        "has_tileset": False,
    },
    "projectile": {
        "agent_hint": 'This is a PROJECTILE. Draw one small compact shape pointing/moving RIGHT, on transparent background (-1). Bold and readable; leave transparent padding so it can rotate in-engine.',
        "label": "Projectile",
        "ref_prompt": """Pixel art projectile sprite for a 2D game (arrow, bullet, fireball, magic bolt).
IMPORTANT RULES:
- Single small projectile on a TRANSPARENT background.
- Points/moves to the RIGHT (0° facing), so it can be rotated in-engine.
- Compact and bold, readable in motion at small sizes.
- Crisp pixel art, visible pixels, no anti-aliasing.
- Leave transparent padding around it.""",
        "has_tileset": False,
    },
    "effect": {
        "agent_hint": 'This is an EFFECT/FX frame. Draw one energetic shape radiating from the CENTER on transparent background (-1). High contrast, punchy; transparent padding around it.',
        "label": "Effect / FX",
        "ref_prompt": """Pixel art visual effect frame for a 2D game (explosion, spark, smoke puff, impact, slash).
IMPORTANT RULES:
- A single effect shape centered on a TRANSPARENT background.
- Radiate from the center; energetic, punchy silhouette.
- Bright, high-contrast pixel art; visible pixels, no anti-aliasing.
- One frame (not a sheet). Leave transparent padding around it.""",
        "has_tileset": False,
    },
    "ui": {
        "agent_hint": 'This is a UI ELEMENT. Draw one clean interface control (button/frame/bar/cursor) on transparent background (-1). Flat, crisp edges, consistent border; small transparent padding.',
        "label": "UI Element",
        "ref_prompt": """Pixel art UI element for a 2D game interface (button, frame, panel, bar, cursor).
IMPORTANT RULES:
- A single interface element on a TRANSPARENT background.
- Front-facing, flat, clean edges; reads clearly as a UI control.
- Consistent border/inset so it looks intentional at small sizes.
- Crisp pixel art, visible pixels, no anti-aliasing.
- Leave a little transparent padding around it.""",
        "has_tileset": False,
    },
    "portrait": {
        "agent_hint": 'This is a PORTRAIT. Draw a head-and-shoulders bust of one character facing the viewer, filling most of the canvas. Expressive clear features; background transparent (-1) or simple.',
        "label": "Portrait",
        "ref_prompt": """Pixel art character portrait for 2D game dialogue / UI.
IMPORTANT RULES:
- Head-and-shoulders bust of one character, facing the viewer.
- Centered; can fill most of the canvas (it's a close-up, not a full body).
- Expressive face with clear features; background transparent or simple.
- Crisp pixel art, visible pixels, no anti-aliasing.""",
        "has_tileset": False,
    },
    "freeform": {
        "agent_hint": "This is a FREEFORM sprite. Use your best judgment for the composition. If the subject is a standalone object or character, use -1 (transparent) for the background. If it's a scene, pattern, or texture, fill the entire canvas.",
        "label": "Freeform",
        "ref_prompt": """Pixel art image.
Create whatever the user describes in pixel art style.
- Visible individual pixels, crisp edges, no anti-aliasing.
- Use the full canvas as you see fit based on the subject.
- If the subject is an object, center it on transparent background.
- If the subject is a scene or pattern, fill the canvas.""",
        "has_tileset": False,
    },
}
