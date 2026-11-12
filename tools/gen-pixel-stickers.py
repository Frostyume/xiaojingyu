# Pixel sticker library generator (deterministic, Pillow).
# 人设优先：绝不改色（不做 hue-shift）、绝不加挂饰/配件。
# 1) 基础 whale-pixel-*.png 去白底变透明（仅从边框 flood-fill，保留白裙等内部白色）。
# 2) 变体只做「保持人设」的变换：水平翻转 + 全身/头部胸像裁剪。全部原色、透明。
# Run: conda run -n base python tools/gen-pixel-stickers.py
import os, json
from collections import deque
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'web', 'assets')
OUT = os.path.join(ASSETS, 'pixel-stickers')
BASES = {
    'whale-pixel-excited.png': 'excited',
    'whale-pixel-wave.png': 'happy',
    'whale-pixel-idle.png': 'idle',
    'whale-pixel-sit.png': 'tired',
    'whale-pixel-pout.png': 'pout',
}
NEAR_WHITE = 235

def make_transparent(im):
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    seen = [[False] * w for _ in range(h)]
    dq = deque()
    def seed(x, y):
        r, g, b, a = px[x, y]
        if a > 0 and r >= NEAR_WHITE and g >= NEAR_WHITE and b >= NEAR_WHITE and not seen[y][x]:
            seen[y][x] = True
            dq.append((x, y))
    for x in range(w):
        seed(x, 0); seed(x, h - 1)
    for y in range(h):
        seed(0, y); seed(w - 1, y)
    while dq:
        x, y = dq.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx]:
                r, g, b, a = px[nx, ny]
                if a > 0 and r >= NEAR_WHITE and g >= NEAR_WHITE and b >= NEAR_WHITE:
                    seen[ny][nx] = True
                    dq.append((nx, ny))
    return im

def head_crop(im):
    bbox = im.getbbox() or (0, 0, im.size[0], im.size[1])
    l, t, r, b = bbox
    h = b - t
    return im.crop((l, t, r, t + max(8, int(h * 0.55))))

def main():
    # 清掉旧库（含改色/挂饰的废弃变体），重新生成保持人设的库。
    if os.path.isdir(OUT):
        for f in os.listdir(OUT):
            if f.endswith('.png') or f == 'manifest.json':
                os.remove(os.path.join(OUT, f))
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    for fname, mood in BASES.items():
        base = make_transparent(Image.open(os.path.join(ASSETS, fname)))
        base.save(os.path.join(ASSETS, fname))  # 透明底，实时页同步
        for flip in (False, True):
            for crop in ('full', 'head'):
                v = base.transpose(Image.FLIP_LEFT_RIGHT) if flip else base.copy()
                if crop == 'head':
                    v = head_crop(v)
                name = f"{mood}-{'f' if flip else 'n'}-{crop}.png"
                v.save(os.path.join(OUT, name))
                manifest.append({'file': name, 'mood': mood, 'base': fname, 'flip': flip, 'crop': crop})
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump({'version': 2, 'count': len(manifest), 'stickers': manifest}, f, ensure_ascii=False, indent=1)
    print('transparent bases:', len(BASES), '| on-model variants:', len(manifest))

if __name__ == '__main__':
    main()