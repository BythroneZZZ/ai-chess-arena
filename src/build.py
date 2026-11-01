#!/usr/bin/env python3
"""
AI CHESS ARENA · 多文件组装 / 校验（v2.0 拆分架构）

架构（2B）：
    index.html          外壳（head + body + script 标签）
    css/main.css        样式（字体走 ../assets/fonts）
    js/*.js             13 个逻辑分片，按顺序 <script src> 加载
    assets/vendor/      chess.js、stockfish.js
    assets/fonts/       像素字体

因为 es 模块的 import 在 file:// 下同样受限，且本项目需要「顺序即依赖」的
全局对象图，所以采用经典 <script> 标签而非 ES Module —— 这是有意的选择。

用法：
    python src/build.py            # 校验 + 同步 js/ 与 index.html
    python src/build.py --check    # 只校验，不写文件
    python src/build.py --serve    # 校验后起本地服务器（8765）
"""
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

# 顺序即依赖：后者可以引用前者的全局对象
JS_PARTS = [
    "03_core.js",
    "03a_api.js",
    "04_render.js",
    "05_run.js",
    "05_board.js",
    "06_engine.js",
    "06b_analysis.js",
    "06c_boardkeys.js",
    "06a_endpoint.js",
    "06_game.js",
    "07a_settings.js",
    "07b_clock.js",
    "07_ui.js",
    "08_wire.js",
    "08a_undo.js",
    "08b_openings.js",
    "08c_review.js",
]

REQUIRED_FILES = [
    "css/main.css",
    "assets/fonts/ps2p.woff2",
    "assets/fonts/fusion-pixel-subset.woff2",
    "assets/vendor/chess.js",
    "assets/vendor/stockfish.js",
    "data/openings.json",
]


def _find_node():
    """解析 node 可执行文件路径。

    优先级：PATH → NODE_BIN / DSH_NODE 环境变量 → 常见安装位置。
    早先只硬编码了一个本机绝对路径，换机器就退化成「跳过语法检查」，
    等于把最容易发现的一类错误放过去了。
    """
    import os
    node = shutil.which("node")
    if node:
        return node
    for env in ("NODE_BIN", "DSH_NODE", "NODE_EXE"):
        v = os.environ.get(env)
        if v and pathlib.Path(v).exists():
            return v
    candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    la = os.environ.get("LOCALAPPDATA")
    if la:
        candidates.append(str(pathlib.Path(la) / "Programs" / "nodejs" / "node.exe"))
    for cand in candidates:
        if pathlib.Path(cand).exists():
            return cand
    return None


def node_syntax_check(js: str) -> list:
    import tempfile, os
    node = _find_node()
    if not node:
        # 没有 node 时明确说明「跳过了」，避免误以为检查通过
        return ["Node 语法检查未执行：找不到 node（设 NODE_BIN 或加入 PATH）"]
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
        fh.write(js)
        tmp = fh.name
    try:
        r = subprocess.run([node, "--check", tmp], capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            return []
        return ["Node syntax: " + line for line in (r.stderr or "").strip().splitlines()[:6]]
    except Exception as e:
        return ["Node 语法检查未执行: " + str(e)]
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def check() -> list:
    errs = []

    for rel in REQUIRED_FILES:
        if not (ROOT / rel).exists():
            errs.append(f"缺少资源: {rel}")

    chunks = []
    for name in JS_PARTS:
        path = HERE / "parts" / name
        if not path.exists():
            errs.append(f"缺少分片: {name}")
            continue
        src = path.read_text(encoding="utf-8")
        if "</script" in src.lower():
            errs.append(f"{name}: 含 </script")
        chunks.append(src)

    js = "\n".join(chunks)
    errs.extend(node_syntax_check(js))

    # 顶层重复声明
    seen = {}
    for m in re.finditer(r"^(?:const|let|class)\s+([A-Za-z_$][\w$]*)", js, re.M):
        n = m.group(1)
        if n in seen:
            errs.append(f"重复声明: {n}")
        else:
            seen[n] = m.start()

    # 契约与安全要素（防止回归时被删）
    for needle, label in [
        ("MAX_TOKENS_UI: 256", "ApiContract.MAX_TOKENS_UI"),
        ("MAX_TOKENS_REQ: 200", "ApiContract.MAX_TOKENS_REQ"),
        ("Run.kill()", "代次作废"),
        ("Run.isLive(token)", "代次校验"),
        ("runSleep(", "可取消等待"),
        ("drain(", "引擎 job 结算"),
        ("abortJob(", "引擎超时收尾"),
        ("onFatal(", "引擎故障处理"),
        ("EndpointGuard", "端点准入"),
        ("engineBudgetFor", "难度×余时预算"),
    ]:
        if needle not in js:
            errs.append(f"缺少要素: {label} ({needle})")

    # 字体路径必须相对 css/（文件缺失时先跳过，避免 read_text 抛 traceback）
    css_path = ROOT / "css" / "main.css"
    if not css_path.exists():
        errs.append("缺少 css/main.css")
    else:
        css = css_path.read_text(encoding="utf-8")
        if "url(../assets/fonts/" not in css:
            errs.append("css/main.css 的字体路径应为 ../assets/fonts/")
        if "data:font" in css:
            errs.append("css/main.css 仍含 base64 字体，应改为外链")

    # index.html 必须引用所有分片（同样要防文件缺失）
    idx_path = ROOT / "index.html"
    if not idx_path.exists():
        errs.append("缺少 index.html")
    else:
        idx = idx_path.read_text(encoding="utf-8")
        for name in JS_PARTS:
            if f'./js/{name}' not in idx:
                errs.append(f"index.html 未引用 js/{name}")
        if "./css/main.css" not in idx:
            errs.append("index.html 未引用 css/main.css")

    # file:// 双击即玩版：同一套分片 + 两个内联数据脚本
    off = ROOT / "offline.html"
    if not off.exists():
        errs.append("缺少 offline.html（file:// 双击即玩版）")
    else:
        o = off.read_text(encoding="utf-8")
        for name in JS_PARTS:
            if f'./js/{name}' not in o:
                errs.append(f"offline.html 未引用 js/{name}")
        for needle, label in [
            ('./assets/vendor/stockfish.inline.js', 'offline 内联引擎'),
            ('./data/openings.inline.js', 'offline 内联开局库'),
        ]:
            if needle not in o:
                errs.append(f"offline.html 缺少 {label}")
        # 内联脚本必须排在逻辑分片之前（engineSource 在初始化时读全局量）
        first_js = o.find('./js/03_core.js')
        if first_js >= 0:
            for needle, label in [('./assets/vendor/stockfish.inline.js', '引擎'),
                                  ('./data/openings.inline.js', '开局库')]:
                pos = o.find(needle)
                if pos >= 0 and pos > first_js:
                    errs.append(f"offline.html 的{label}内联脚本必须排在 js/ 分片之前")
    for rel in ["assets/vendor/stockfish.inline.js", "data/openings.inline.js"]:
        if not (ROOT / rel).exists():
            errs.append(f"缺少内联产物: {rel}（跑 npm run build 生成）")

    # js/ 与 src/parts/ 是否同步
    # 漏跑 build 会让浏览器加载旧副本，构建期却一切正常 —— 这类「改了没生效」
    # 排查起来极费时间，必须在 check 里直接拦住。
    for name in JS_PARTS:
        src_p = HERE / "parts" / name
        out_p = ROOT / "js" / name
        if not out_p.exists():
            errs.append(f"js/{name} 不存在（跑 npm run build）")
            continue
        if not src_p.exists():
            continue
        try:
            if src_p.read_bytes() != out_p.read_bytes():
                errs.append(f"js/{name} 与 src/parts/{name} 不同步（跑 npm run build）")
        except OSError as e:
            errs.append(f"读取 {name} 失败: {e}")

    # offline.html 存在时也要同步检查：它由 build 生成，改了分片忘重建就会过期
    off_path = ROOT / "offline.html"
    if off_path.exists():
        try:
            if off_path.stat().st_mtime < (HERE / "parts" / "02_body.html").stat().st_mtime:
                errs.append("offline.html 比源分片旧（跑 npm run build）")
        except OSError:
            pass

    # 字体子集覆盖：改了 UI 文案后忘了重跑 subset_font.py，界面会出现豆腐块
    subset = ROOT / "assets" / "fonts" / "fusion-pixel-subset.woff2"
    if subset.exists():
        try:
            sys.path.insert(0, str(HERE))
            import subset_font
            ui_chars = subset_font.scan_chars(include_comments=False)
            from fontTools.ttLib import TTFont
            f = TTFont(str(subset))
            cmap = set()
            for table in f["cmap"].tables:
                cmap.update(table.cmap.keys())
            missing = [c for c in ui_chars if ord(c) not in cmap]
            if missing:
                errs.append(
                    "字体子集缺 %d 个字（跑 npm run subset-font）: %s"
                    % (len(missing), " ".join(f"U+{ord(c):04X}" for c in missing[:8])))
        except ImportError:
            pass              # 没装 fonttools 就跳过，不阻断构建
        except Exception as e:
            errs.append("字体校验异常: " + str(e)[:80])

    return errs


def build_shell(offline: bool = False) -> str:
    """从 01_head.html + 02_body.html 组装 HTML。

    这是唯一的真源链：head/body 分片 -> shell -> index.html。
    早期版本用一份独立的 index.shell.html 模板，导致 body 改动不生效，已废弃。

    两种产物：
        index.html     HTTP 模式（引擎/开局库走 fetch，首屏轻）
        offline.html   file:// 双击即玩（引擎/开局库走内联常量）

    为什么不合并成一份：内联让 index.html 多背 1.9MB，
    HTTP 用户每次首屏都要解析它；而文件模式下 fetch 又必然失败。
    两份来自同一套分片，产物差异只有两个 <script> 标签。
    """
    head = (HERE / "parts" / "01_head.html").read_text(encoding="utf-8")
    body = (HERE / "parts" / "02_body.html").read_text(encoding="utf-8")
    tags = "\n".join(f'<script src="./js/{n}"></script>' for n in JS_PARTS)
    # file:// 模式下先挂内联数据，再加载逻辑分片（engineSource 会读全局量）
    inline_tags = (
        '<script src="./assets/vendor/stockfish.inline.js"></script>\n'
        '<script src="./data/openings.inline.js"></script>\n'
    ) if offline else ''

    # head 里声明字体占位符已不再使用（字体走 css 外链），若残留则替换成正式路径
    head = head.replace("url(__FONT_PS2P__) format('woff2')", "url(../assets/fonts/ps2p.woff2) format('woff2')")
    head = head.replace("url(__FONT_CJK__) format('woff2')", "url(../assets/fonts/fusion-pixel-subset.woff2) format('woff2')")
    # 样式外置：<style> 整段换成 link
    head = re.sub(r"<style>.*?</style>",
                  '<link rel="icon" href="data:image/svg+xml,'
                  '%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27%3E'
                  '%3Crect width=%2716%27 height=%2716%27 fill=%27%23100c1e%27/%3E'
                  '%3Crect x=%273%27 y=%276%27 width=%2710%27 height=%274%27 fill=%27%23ffcc4d%27/%3E'
                  '%3Crect x=%276%27 y=%272%27 width=%274%27 height=%274%27 fill=%27%23ece8ff%27/%3E'
                  '%3C/svg%3E">\n<link rel="stylesheet" href="./css/main.css">',
                  head, flags=re.S)

    return (
        head.rstrip()
        + "\n"
        + body
        + "\n<!-- 第三方：许可证见 THIRD_PARTY_NOTICES.md -->\n"
        + '<script src="./assets/vendor/chess.js"></script>\n'
        + inline_tags
        + tags
        + "\n</body>\n</html>\n"
    )


def build_inline_assets() -> None:
    """生成 file:// 双击即玩所需的内联数据脚本。

    为什么这样做（而不是把 1.5MB 塞进 index.html）：
      `file://` 下经典 <script src> 是**能加载**的（同目录相对路径也认），
      被拦的只有 fetch / ESM / new Worker(路径)。
      所以把引擎源码与开局库做成普通 JS 文件挂全局量即可：
        assets/vendor/stockfish.inline.js  -> window.__SF_SRC
        data/openings.inline.js            -> window.OPENINGS_BOOK
      index.html 保持几十 KB，HTTP 模式下引擎仍可独立缓存。

    ⚠️ 坑：Python 的 str.replace 里 `$&` / `\\g<0>` 不是模式，但**JS 的**
    String.replace 第二个参数里 `$&` 是替换模式，而 Stockfish 源码恰好含 `$&`。
    本项目在 Python 侧生成，用 json.dumps 转义，天然避开这个坑；
    如果哪天改用 Node 生成，必须写成 replace(needle, () => str)。
    """
    import json as _json
    out_dir_vendor = ROOT / "assets" / "vendor"
    out_dir_data = ROOT / "data"
    out_dir_vendor.mkdir(parents=True, exist_ok=True)
    out_dir_data.mkdir(parents=True, exist_ok=True)

    # 引擎源码：JSON 转义（含引号/换行/反斜杠全部安全）
    sf_path = ROOT / "assets" / "vendor" / "stockfish.js"
    sf_src = sf_path.read_text(encoding="utf-8", errors="replace")
    if "</script" in sf_src.lower():
        print("警告：引擎源码含 </script，内联会有风险", file=sys.stderr)
    (out_dir_vendor / "stockfish.inline.js").write_text(
        "/* 自动生成，勿手改。源：assets/vendor/stockfish.js */\n"
        "window.__SF_SRC = " + _json.dumps(sf_src) + ";\n",
        encoding="utf-8")

    # 开局库：紧凑 JSON
    book_path = ROOT / "data" / "openings.json"
    book = _json.loads(book_path.read_text(encoding="utf-8"))
    (out_dir_data / "openings.inline.js").write_text(
        "/* 自动生成，勿手改。源：data/openings.json */\n"
        "window.OPENINGS_BOOK = " + _json.dumps(book, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8")


def sync() -> None:
    # 分片 -> js/
    jsdir = ROOT / "js"
    jsdir.mkdir(exist_ok=True)
    for name in JS_PARTS:
        shutil.copyfile(HERE / "parts" / name, jsdir / name)

    # CSS：head 分片里的 <style> 抽出到 css/main.css
    head_src = (HERE / "parts" / "01_head.html").read_text(encoding="utf-8")
    m = re.search(r"<style>(.*?)</style>", head_src, re.S)
    if m:
        css = m.group(1).strip()
        css = css.replace("url(__FONT_PS2P__) format('woff2')", "url(../assets/fonts/ps2p.woff2) format('woff2')")
        css = css.replace("url(__FONT_CJK__) format('woff2')", "url(../assets/fonts/fusion-pixel-subset.woff2) format('woff2')")
        (ROOT / "css" / "main.css").write_text(css, encoding="utf-8")

    (ROOT / "index.html").write_text(build_shell(offline=False), encoding="utf-8")
    # file:// 双击即玩版：同一套分片，多挂两个内联数据脚本
    build_inline_assets()
    (ROOT / "offline.html").write_text(build_shell(offline=True), encoding="utf-8")


def main():
    if "--check" in sys.argv:
        errs = check()
        if errs:
            for e in errs:
                print("FAIL", e, file=sys.stderr)
            raise SystemExit(1)
        print(f"OK 校验通过（{len(JS_PARTS)} 个模块，多文件架构）")
        return

    sync()          # 先生成，再校验（否则新增模块会被误报）

    errs = check()
    if errs:
        print("校验失败：", file=sys.stderr)
        for e in errs:
            print("  -", e, file=sys.stderr)
        raise SystemExit(1)
    total = sum(f.stat().st_size for f in ROOT.rglob("*") if f.is_file() and "_build" not in str(f) and "node_modules" not in str(f))
    print(f"已同步 js/ 与 index.html")
    print(f"项目总计 {total/1048576:.2f} MB")

    if "--serve" in sys.argv:
        print("启动 http://localhost:8765 ...")
        subprocess.run([sys.executable, "-m", "http.server", "8765"], cwd=ROOT)


if __name__ == "__main__":
    main()
