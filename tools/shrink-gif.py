#!/usr/bin/env python
"""把 GIF 压到指定字节上限，保留为 GIF（可动图）。

用法：python shrink-gif.py <input> <output> <max_bytes>
成功时把最终字节数写到 stdout 并以 0 退出；失败退出码 1。
只用 Pillow，不联网、不加别的依赖。
"""
import io
import sys

try:
    from PIL import Image, ImageSequence
except Exception as exc:  # pragma: no cover - 环境缺 Pillow 时明确失败
    sys.stderr.write(f"Pillow 不可用：{exc}\n")
    sys.exit(2)


def load_frames(path):
    image = Image.open(path)
    frames = []
    durations = []
    for frame in ImageSequence.Iterator(image):
        frames.append(frame.convert("RGBA").copy())
        durations.append(int(frame.info.get("duration", image.info.get("duration", 80)) or 80))
    return frames, durations


def encode(frames, durations, scale=1.0, step=1):
    out_frames = []
    out_durations = []
    for index, frame in enumerate(frames):
        if index % step:
            continue
        width = max(8, int(frame.width * scale))
        height = max(8, int(frame.height * scale))
        resized = frame.resize((width, height), Image.LANCZOS)
        out_frames.append(resized.convert("P", palette=Image.ADAPTIVE))
        out_durations.append(durations[index])
    buffer = io.BytesIO()
    out_frames[0].save(
        buffer,
        format="GIF",
        save_all=True,
        append_images=out_frames[1:],
        duration=out_durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    return buffer.getvalue()


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("用法：shrink-gif.py <input> <output> <max_bytes>\n")
        return 1
    source, target, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
    try:
        frames, durations = load_frames(source)
    except Exception as exc:
        sys.stderr.write(f"读取 GIF 失败：{exc}\n")
        return 1
    if not frames:
        sys.stderr.write("GIF 没有可用帧\n")
        return 1
    plan = [(1.0, 1), (0.8, 1), (0.65, 1), (0.5, 1), (0.5, 2), (0.4, 2), (0.35, 3), (0.25, 3), (0.2, 4)]
    best = None
    for scale, step in plan:
        try:
            data = encode(frames, durations, scale=scale, step=step)
        except Exception:
            continue
        if best is None or len(data) < len(best):
            best = data
        if len(data) <= limit:
            with open(target, "wb") as handle:
                handle.write(data)
            print(len(data))
            return 0
    sys.stderr.write(f"压到 {len(best) if best else 0} 字节仍超过上限 {limit}\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
