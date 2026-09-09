"""Use the existing app icon for Android launcher assets."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
resources = ROOT / 'mobile/android/app/src/main/res'
icon = Image.open(ROOT / 'public/icon-512.png').convert('RGBA')
for density, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
    folder = resources / ('mipmap-' + density)
    folder.mkdir(exist_ok=True)
    for name in ['ic_launcher.png', 'ic_launcher_round.png']:
        icon.resize((size, size), Image.Resampling.LANCZOS).save(folder / name)
    canvas_size = round(size * 108 / 48)
    foreground = Image.new('RGBA', (canvas_size, canvas_size))
    art = icon.resize((round(canvas_size * .64),) * 2, Image.Resampling.LANCZOS)
    foreground.alpha_composite(art, ((canvas_size - art.width) // 2,) * 2)
    foreground.save(folder / 'ic_launcher_foreground.png')
(resources / 'values/ic_launcher_background.xml').write_text('<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">#2b5cd9</color></resources>\n', encoding='utf-8')
print('Android app icons updated.')
