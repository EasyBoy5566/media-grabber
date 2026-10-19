"""產生擴充功能圖示：圓角漸層方塊 + 白色「圖片 + 下載箭頭」。

用法：python tools/make_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "media-grabber" / "icons"
S = 1024  # 先畫大圖再縮小，邊緣比較平滑


def draw() -> Image.Image:
    # 對角漸層 #6d6df2 → #4a3fc4
    grad = Image.new("RGBA", (S, S))
    top, bottom = (109, 109, 242), (74, 63, 196)
    px = grad.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            px[x, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=S * 0.22, fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    w = int(S * 0.06)
    white = (255, 255, 255, 255)
    # 圖片框
    d.rounded_rectangle((S * .2, S * .18, S * .8, S * .62), radius=S * .06, outline=white, width=w)
    # 山與太陽
    d.line([(S * .26, S * .56), (S * .42, S * .40), (S * .52, S * .50), (S * .60, S * .43), (S * .74, S * .56)],
           fill=white, width=w, joint="curve")
    d.ellipse((S * .60, S * .25, S * .70, S * .35), fill=white)
    # 下載箭頭
    d.line([(S * .5, S * .66), (S * .5, S * .84)], fill=white, width=w)
    d.line([(S * .40, S * .76), (S * .5, S * .86), (S * .60, S * .76)], fill=white, width=w, joint="curve")
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    big = draw()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png")
    print("saved to", OUT)


if __name__ == "__main__":
    main()
