#!/usr/bin/env python3
"""中文字体子集化 —— 把 923KB 的 Fusion Pixel 压到实际用字规模。

原理：
    从**源码**里扫描所有用到的字符（分片 JS + HTML + CSS + 台词库），
    加上常用标点/数字/ASCII 兜底，生成子集字体。

为什么要兜底字符集：
    角色台词可以由用户自定义（CharEditor 的自由输入），AI 返回的台词
    也是运行时才有的文本。只按源码扫会漏掉这些 —— 用户一旦输入未收录的
    汉字就会看到豆腐块。所以基础上再并入 GB2312 一级字库（3755 字），
    覆盖日常中文的 99% 以上。

体积预期：923KB → 约 200~260KB（取决于是否含 GB2312 全集）。

用法：
    python src/subset_font.py            # 生成子集
    python src/subset_font.py --check    # 只报告，不写文件
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

# 简体优先，繁体兜底。
# 其余语言变体（ja/ko/latin/zh_hk/zh_tw）已删除——本项目只出简体中文文案。
# 早先这里还有第三个候选 assets/fonts/fusion-pixel-12px-zh.woff2，
# 它与上面第一个文件逐字节相同（MD5 一致），属于分发目录里的重复副本，已删除。
CANDIDATES = [
    SRC / "fonts" / "fusion" / "fusion-pixel-12px-proportional-zh_hans.ttf.woff2",
    SRC / "fonts" / "fusion" / "fusion-pixel-12px-proportional-zh_hant.ttf.woff2",
]
OUT = ROOT / "assets" / "fonts" / "fusion-pixel-subset.woff2"


def source_font() -> pathlib.Path:
    for c in CANDIDATES:
        if c.exists():
            return c
    raise SystemExit("找不到源字体")


def scan_chars(include_comments: bool = True) -> set:
    """扫描项目源码里出现的所有非 ASCII 字符。

    分两种口径：
      include_comments=True  —— 含注释，用于**生成子集**（宁可多留几个字，
                                 也不要在用户输入或 AI 台词里出现豆腐块）
      include_comments=False —— 剔除注释，用于**校验**（注释不渲染，
                                 Fusion Pixel 本身也没有 ≤ ≥ − ≈ ≫ 这些数学符号，
                                 拿它们报「缺字」是假警报）
    """
    chars = set()
    patterns = [
        (SRC / "parts", "*.js"),
        (SRC / "parts", "*.html"),
        (ROOT / "css", "*.css"),
    ]
    line_comment = re.compile(r"//[^\n]*")
    block_comment = re.compile(r"/\*.*?\*/", re.S)
    html_comment = re.compile(r"<!--.*?-->", re.S)
    for base, pat in patterns:
        if not base.exists():
            continue
        for p in base.glob(pat):
            try:
                text = p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            if not include_comments:
                text = block_comment.sub(" ", text)
                text = line_comment.sub(" ", text)
                text = html_comment.sub(" ", text)
            for ch in text:
                if ord(ch) > 0x7F:
                    chars.add(ch)
    # 兜底：ASCII 可见字符 + 常用中文标点
    chars.update(chr(c) for c in range(0x20, 0x7F))
    chars.update("　、。〈〉《》「」『』【】〔〕・ー…‥“”‘’～￥％＋－×÷＝")
    return chars


def gb2312_level1() -> set:
    """GB2312 一级汉字（3755 字，覆盖日常用字）。

    不引入外部词表：GB2312 的区位码规律是
      一级汉字：区 16~55，位 1~94，按拼音排序
    用编码器反查即可枚举，无需联网。
    """
    chars = set()
    for qu in range(16, 56):
        for wei in range(1, 95):
            try:
                b = bytes([qu + 0xA0, wei + 0xA0])
                ch = b.decode("gb2312")
                if len(ch) == 1:
                    chars.add(ch)
            except (UnicodeDecodeError, IndexError):
                continue
    return chars


def main():
    try:
        from fontTools import subset
    except ImportError:
        print("需要 fonttools：python -m pip install fonttools brotli", file=sys.stderr)
        raise SystemExit(1)

    src = source_font()
    used = scan_chars()
    base = gb2312_level1()
    all_chars = used | base
    print(f"源字体      {src.relative_to(ROOT)}  {src.stat().st_size/1024:.0f} KB")
    print(f"源码用字    {len(used)} 个")
    print(f"GB2312 一级 {len(base)} 个")
    print(f"合计        {len(all_chars)} 个")

    if "--check" in sys.argv:
        # 校验只看「会渲染的字符」：注释里出现 ≤ ≥ − ≈ ≫ 不算问题，
        # 那些符号源字体本来就没有，也从不出现在界面上。
        ui_chars = scan_chars(include_comments=False)
        if not OUT.exists():
            print("子集字体尚不存在 —— 跑 python src/subset_font.py 生成")
        else:
            from fontTools.ttLib import TTFont
            f = TTFont(OUT)
            cmap = set()
            for table in f["cmap"].tables:
                cmap.update(table.cmap.keys())
            missing = [c for c in ui_chars if ord(c) not in cmap]
            print(f"现有子集 {OUT.stat().st_size/1024:.0f} KB，渲染用字 {len(ui_chars)} 个，缺字 {len(missing)} 个")
            if missing:
                print("  缺失码位：" + " ".join(f"U+{ord(c):04X}" for c in missing[:30]))
                try:
                    print("  缺失示例：" + "".join(missing[:30]))
                except UnicodeEncodeError:
                    print("  缺失示例：（含当前控制台无法显示的字符）")
                raise SystemExit(1)
            print("覆盖完整")
        return

    text = "".join(sorted(all_chars))
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.desubroutinize = True
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True

    font = subset.load_font(str(src), opts)
    sub = subset.Subsetter(options=opts)
    sub.populate(text=text)
    sub.subset(font)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    subset.save_font(font, str(OUT), opts)

    before = src.stat().st_size
    after = OUT.stat().st_size
    print(f"输出        {OUT.relative_to(ROOT)}  {after/1024:.0f} KB"
          f"  （省 {(1-after/before)*100:.0f}%）")


if __name__ == "__main__":
    main()
