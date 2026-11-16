# Pixel sticker library generator (deterministic, Pillow).
# 人设优先：绝不改色（不做 hue-shift）、绝不加挂饰/配件。
# 1) 基础 whale-pixel-*.png 去白底变透明（仅从边框 flood-fill，保留白裙等内部白色）。
# 2) 变体只做「保持人设」的变换：水平翻转 + 全身/头部胸像裁剪。全部原色、透明。
# 3) 扩充库：bases/index.json 登记的新基础 sprite（同一角色同一配色），每张同样只做
#    翻转×裁剪。新基础图先过配色护栏（发蓝/裙藏青必须仍在），改色图直接拒绝，绝不入库。
# Run: conda run -n base python tools/gen-pixel-stickers.py
# Guard check single base: conda run -n base python tools/gen-pixel-stickers.py --check-base <png>
import os, sys, json
from collections import deque
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'web', 'assets')
OUT = os.path.join(ASSETS, 'pixel-stickers')
BASES_DIR = os.path.join(OUT, 'bases')
BASES = {
    'whale-pixel-excited.png': 'excited',
    'whale-pixel-wave.png': 'happy',
    'whale-pixel-idle.png': 'idle',
    'whale-pixel-sit.png': 'tired',
    'whale-pixel-pout.png': 'pout',
}
NEAR_WHITE = 235
TARGET_SIZE = 256
# 参考 sprite 实测配色：发蓝 ~(48-64,96-112,160-192)，裙藏青 ~(32-48,48-64,96-112)。
HAIR_MIN_PIXELS = 200
NAVY_MIN_PIXELS = 100

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

def palette_guard(im):
    """on-model 护栏：发蓝与裙藏青像素必须仍在（改色/换配色会在这里被拒）。"""
    hair = navy = 0
    for r, g, b, a in im.getdata():
        if a < 200:
            continue
        if r < 120 and b > 120 and b - r >= 60 and g > r:
            hair += 1
        elif r < 80 and g < 90 and 60 <= b <= 140 and b - r >= 30:
            navy += 1
    if hair < HAIR_MIN_PIXELS or navy < NAVY_MIN_PIXELS:
        raise ValueError(f'off-model palette: hair={hair} navy={navy} (need >={HAIR_MIN_PIXELS}/{NAVY_MIN_PIXELS})')
    return hair, navy

def head_crop(im):
    bbox = im.getbbox() or (0, 0, im.size[0], im.size[1])
    l, t, r, b = bbox
    h = b - t
    return im.crop((l, t, r, t + max(8, int(h * 0.55))))

def load_new_bases():
    index = os.path.join(BASES_DIR, 'index.json')
    if not os.path.isfile(index):
        return []
    with open(index, encoding='utf-8') as f:
        entries = json.load(f)
    seen = set()
    for e in entries:
        for k in ('file', 'slug', 'mood', 'scene'):
            if not e.get(k):
                raise ValueError(f'bases/index.json 条目缺字段 {k}: {e}')
        if e['slug'] in seen or e['slug'] in BASES.values():
            raise ValueError(f"slug 重复: {e['slug']}")
        seen.add(e['slug'])
        if e.get('hue') not in (None, 0) or e.get('accessory') not in (None, 'none'):
            raise ValueError(f" bases/index.json 不允许改色/挂饰: {e['file']}")
    return entries

def emit_variants(base, slug, mood, scene, base_ref, manifest):
    for flip in (False, True):
        for crop in ('full', 'head'):
            v = base.transpose(Image.FLIP_LEFT_RIGHT) if flip else base.copy()
            if crop == 'head':
                v = head_crop(v)
            name = f"{slug}-{'f' if flip else 'n'}-{crop}.png"
            v.save(os.path.join(OUT, name))
            manifest.append({'file': name, 'mood': mood, 'scene': scene, 'base': base_ref,
                             'flip': flip, 'crop': crop})

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
        emit_variants(base, mood, mood, 'none', fname, manifest)
    for e in load_new_bases():
        raw = Image.open(os.path.join(BASES_DIR, e['file']))
        base = make_transparent(raw)
        if base.size != (TARGET_SIZE, TARGET_SIZE):
            base = base.resize((TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)
        palette_guard(base)
        emit_variants(base, e['slug'], e['mood'], e['scene'], f"bases/{e['file']}", manifest)
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump({'version': 3, 'count': len(manifest), 'stickers': manifest}, f, ensure_ascii=False, indent=1)
    print('transparent bases:', len(BASES), '| new bases:', len(load_new_bases()), '| on-model variants:', len(manifest))

def check_base(path):
    im = make_transparent(Image.open(path))
    if im.size != (TARGET_SIZE, TARGET_SIZE):
        im = im.resize((TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)
    hair, navy = palette_guard(im)
    print(f'on-model OK: hair={hair} navy={navy}')

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--check-base':
        check_base(sys.argv[2])
    else:
        main()