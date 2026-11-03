"""Rebuild the code-drawn app icon with Pillow, then use macOS iconutil."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math, subprocess
root = Path(__file__).resolve().parents[1]
size = 1024
im = Image.new('RGBA', (size,size), (0,0,0,0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((44,44,980,980), radius=215, fill='#2c594b')
d.rounded_rectangle((170,215,854,835), radius=150, outline='#b8c8a3', width=11)
font = ImageFont.truetype(str(root/'assets/fonts/NotoSans-Regular.ttf'), 610)
d.text((512,455), 'w', font=font, fill='#f6f6ee', anchor='mm', stroke_width=2)
points=[]
for i in range(8):
    angle=-math.pi/2+i*math.pi/4
    radius=110 if i%2==0 else 30
    points.append((800+math.cos(angle)*radius,240+math.sin(angle)*radius))
d.ellipse((665,110,930,375), fill='#2c594b')
d.polygon(points, fill='#e9d9aa')
im.save(root/'assets/icon.png')
iconset=root/'tmp/WatchAndWonder.iconset';iconset.mkdir(parents=True,exist_ok=True)
for n in (16,32,128,256,512):
    for scale in (1,2):
        im.resize((n*scale,n*scale),Image.Resampling.LANCZOS).save(iconset/f'icon_{n}x{n}{"@2x" if scale==2 else ""}.png')
subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(root/'assets/WatchAndWonder.icns')],check=True)
