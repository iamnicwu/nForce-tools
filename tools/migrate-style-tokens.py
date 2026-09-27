#!/usr/bin/env python3
"""
nForce-tools 样式收敛迁移脚本（一次性工具，跑完可删）

目标：
  1. 把散落的硬编码颜色收敛到 main.css :root 的语义令牌
  2. 把 27 种 font-size 收敛到 8 档字号刻度 + 5 档图标刻度
  3. 先 dry-run 逐条列出决策，人工过一遍再 --apply

硬性保护（都是踩过的坑）：
  * 绝不改 src/lib/js/** 与 antd.min.css（第三方）
  * :root 块整体保护：里面的自定义属性是令牌「定义」，
    替换会导致 --primary-color: var(--primary-color) 自引用。
    注意 :root 之外的 --xxx 定义（.theme-tools { --theme-color: #2f54eb }、
    内联 style="--row-accent:#8c8c8c"）替换成 var() 是正确且期望的。
  * 保留行尾风格：ui.js / logic.js / login_app.js / login.html 是 CRLF，
    用 newline="" 读写，否则产出"整个文件每一行都变了"的假 diff
  * 注释先抽成占位符，避免"注释里列出色值清单"被一起替换
  * JS 只改 CSS 上下文（style= / cssText / .style.xxx =）；
    ECharts 的 itemStyle.color（带引号的 '#52c41a'）是 canvas 颜色，
    var() 解析不了，必须原样保留
"""
import re
import os
import argparse
import collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# ---------------------------------------------------------------- 颜色映射表
COLOR_MAP = {
    # 文字四档
    "#333": "var(--text-primary)", "#333333": "var(--text-primary)",
    "#262626": "var(--text-primary)", "#1f2937": "var(--text-primary)",
    "#666": "var(--text-tertiary)", "#888": "var(--text-tertiary)",
    "#5c5c5c": "var(--text-tertiary)", "#6b7280": "var(--text-tertiary)",
    "#8c8c8c": "var(--text-secondary)", "#999": "var(--text-secondary)",
    "#999999": "var(--text-secondary)", "#9ca3af": "var(--text-secondary)",
    "#bfbfbf": "var(--text-light)",

    # 边框
    "#d9d9d9": "var(--border-color)", "#d1d5db": "var(--border-color)",
    "#f0f0f0": "var(--border-light)", "#e8e8e8": "var(--border-light)",
    "#eee": "var(--border-light)", "#ddd": "var(--border-light)",
    "#e5e7eb": "var(--border-light)", "#e9ecf2": "var(--border-light)",

    # 背景
    "#fafafa": "var(--bg-tertiary)", "#f9fafb": "var(--bg-tertiary)",
    "#f7f7f7": "var(--bg-tertiary)", "#f5f5f5": "var(--bg-tertiary)",
    "#f0f0f2": "var(--accent-gray-tint)", "#f2f5fa": "var(--bg-secondary)",

    # 主色
    "#1890ff": "var(--primary-color)", "#40a9ff": "var(--primary-hover)",
    "#e6f7ff": "var(--primary-bg)", "#91d5ff": "var(--primary-border)",
    "#e9f1ff": "var(--primary-bg)",

    # 语义色
    "#52c41a": "var(--success-color)", "#f6ffed": "var(--success-bg)",
    "#b7eb8f": "var(--success-border)",
    "#ff4d4f": "var(--error-color)", "#fff2f0": "var(--error-bg)",
    "#fff1f0": "var(--error-bg)", "#ffccc7": "var(--error-border)",
    "#ffa39e": "var(--error-border)", "#cf1322": "var(--error-strong)",
    "#e74c3c": "var(--error-color)",
    "#faad14": "var(--warning-color)", "#fffbe6": "var(--warning-bg)",
    "#ffe58f": "var(--warning-border)", "#fff1b8": "var(--warning-border)",
    "#f39c12": "var(--warning-color)",

    # 强调色（磁贴分组 / 功能主题 / 设置行图标）
    "#1677ff": "var(--accent-blue)", "#e6f1fb": "var(--accent-blue-tint)",
    "#f2f8ff": "var(--accent-blue-soft)",
    "#2f54eb": "var(--accent-indigo)", "#f0f5ff": "var(--accent-indigo-tint)",
    "#4c5bd4": "var(--accent-indigo)", "#2b4acb": "var(--accent-indigo)",
    "#3b48b8": "var(--accent-indigo-hover)", "#eef2ff": "var(--accent-indigo-soft)",
    "#722ed1": "var(--accent-purple)", "#f0eafc": "var(--accent-purple-tint)",
    "#f8f3ff": "var(--accent-purple-soft)",
    "#fa541c": "var(--accent-volcano)", "#fdeee4": "var(--accent-volcano-tint)",
    "#fff5ee": "var(--accent-volcano-soft)", "#d4380d": "var(--accent-volcano)",
    "#fff2e8": "var(--accent-volcano-bg)",
    "#eb2f96": "var(--accent-pink)", "#fce8f1": "var(--accent-pink-tint)",
    "#fff2f8": "var(--accent-pink-soft)",
    "#d48806": "var(--accent-amber)", "#fdf3dd": "var(--accent-amber-tint)",
    "#fffaf0": "var(--accent-amber-soft)",
    "#fa8c16": "var(--accent-orange)", "#fff7e6": "var(--accent-orange-tint)",

    # 品牌 / 代码块
    "#001529": "var(--brand-navy)", "#107c41": "var(--brand-excel)",
    "#1e1e1e": "var(--code-bg)", "#d4d4d4": "var(--code-fg)",

    # 收尾：补齐各「色族」缺失的底色档，以及零散但语义明确的取值
    "#d1fae5": "var(--success-bg)", "#065f46": "var(--success-color)",
    "#f9f0ff": "var(--accent-purple-tint)", "#fff0f6": "var(--accent-pink-soft)",
    "#ad6800": "var(--accent-amber-strong)",
    "#eef4ff": "var(--accent-indigo-soft)", "#f7f0ff": "var(--accent-purple-soft)",
    "#dbe6ff": "var(--accent-indigo-border-soft)", "#f7faff": "var(--accent-blue-soft)",
    "#91caff": "var(--primary-border)",
    "#f6f8fa": "var(--bg-tertiary)", "#fafbfd": "var(--bg-tertiary)",
    "#c3c8d6": "var(--text-light)",
}

# 白色只有一种，白就是白：不令牌化，只统一拼写
NORMALIZE_ONLY = {"#ffffff": "#fff"}

# ------------------------------------------------------------- 字号映射表
SIZE_MAP = {
    "12px": "var(--fs-xs)", "11px": "var(--fs-xs)", "12.5px": "var(--fs-sm)",
    "13px": "var(--fs-sm)", "14px": "var(--fs-base)",
    "15px": "var(--fs-lg)", "16px": "var(--fs-lg)",
    "18px": "var(--fs-xl)", "20px": "var(--fs-2xl)", "21px": "var(--fs-2xl)",
    "24px": "var(--fs-3xl)", "28px": "var(--fs-3xl)", "30px": "var(--fs-4xl)",
    "0.75rem": "var(--fs-xs)", "0.875rem": "var(--fs-base)",
    "0.9em": "var(--fs-sm)", "0.85em": "var(--fs-xs)",
    "1rem": "var(--fs-lg)", "1.1rem": "var(--fs-xl)", "1.125rem": "var(--fs-xl)",
    "1.25rem": "var(--fs-2xl)", "1.5rem": "var(--fs-3xl)", "1.875rem": "var(--fs-4xl)",
}

# 这几个值既可能是「字大」也可能是「图标大」，按选择器判定
AMBIGUOUS_ICON = {"32px": "var(--icon-xl)", "2rem": "var(--icon-xl)",
                  "48px": "var(--icon-2xl)", "3rem": "var(--icon-2xl)"}
AMBIGUOUS_TEXT = {"32px": "var(--fs-4xl)", "2rem": "var(--fs-4xl)",
                  "48px": "var(--icon-2xl)", "3rem": "var(--icon-2xl)"}

# 有意保持相对/语义化的取值，不动
SIZE_SKIP = {"inherit", "0", "1em", "85%", "100%", "80%", "75%", "90%",
             "7px", "9px", "10px"}

ICON_SELECTOR_RE = re.compile(
    r"(^|[\s,>+~])(i|\.svg-icon|\.icon|[\w-]*-icon|\.tile-icon|\.section-icon|\.module-icon)\b"
)

CSS_FILES = ["src/lib/css/main.css"]
HTML_FILES = ["src/index.html", "src/login.html", "src/popup.html"]
JS_FILES = [
    "src/app.js", "src/login_app.js",
    "src/biz/ui.js", "src/biz/ui_layout.js", "src/biz/logic.js",
    "src/biz/inspector_tools.js", "src/biz/ui_table.js",
    "src/common/utils.js", "src/common/excel_utils.js",
    "src/common/table_utils.js",
]
EXCLUDED_PATHS = {"src/icons/logo_generator.html", "src/lib/css/antd.min.css"}
EXCLUDED_PREFIX = ("src/lib/js/",)

stats = collections.Counter()
CHANGES = []


# ------------------------------------------------------------------ 基础工具
def read_preserve(path):
    """newline="" 不做换行翻译：CRLF 文件必须保持 CRLF，否则产生假 diff。"""
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def write_preserve(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


COMMENT_RE = re.compile(r"/\*.*?\*/|//[^\n]*", re.S)


def mask_comments(text):
    """注释抽成占位符，避免注释里列出的色值被一起替换。"""
    store = []

    def repl(m):
        store.append(m.group(0))
        return f"\x00C{len(store) - 1}\x00"

    return COMMENT_RE.sub(repl, text), store


def unmask_comments(text, store):
    for i, c in enumerate(store):
        text = text.replace(f"\x00C{i}\x00", c)
    return text


def protect_root(text):
    """:root 块整体保护（令牌定义不能被替换成 var()）。"""
    m = re.search(r":root\s*\{", text)
    if not m:
        return text, None
    depth, i = 0, m.end() - 1
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[:m.start()] + "\x00ROOT\x00" + text[i + 1:], text[m.start():i + 1]
        i += 1
    return text, None


def restore_root(text, block):
    return text if block is None else text.replace("\x00ROOT\x00", block)


# ------------------------------------------------------------------ 转换逻辑
def convert_colors(text, label, js_mode=False):
    out = []
    for line in text.split("\n"):
        for hexv, tok in NORMALIZE_ONLY.items():
            if hexv in line.lower():
                line = re.sub(hexv, tok, line, flags=re.I)
                stats["颜色拼写归一"] += 1
        style_assign = bool(re.search(r"\.style\.", line))
        for hexv, tok in COLOR_MAP.items():
            pat = re.compile(re.escape(hexv) + r"\b", re.I)
            if not pat.search(line):
                continue
            hits = [0]
            # 用当前行做引号判断（闭包变量在循环里会变，所以显式传参）
            def rep(m, _tok=tok, _hits=hits, _line=line):
                if js_mode and not style_assign and m.start() > 0 and _line[m.start() - 1] in "'\"":
                    return m.group(0)
                _hits[0] += 1
                return _tok

            line = pat.sub(rep, line)
            if hits[0]:
                stats["颜色→令牌"] += hits[0]
                CHANGES.append(("color", label, hexv, tok, hits[0]))
        out.append(line)
    return "\n".join(out)


def convert_sizes_css(text, label):
    lines = text.split("\n")
    out = []
    selector = ""
    for line in lines:
        stripped = line.strip()
        if stripped and stripped.endswith("{") and not stripped.startswith("@"):
            selector = stripped[:-1]
        elif stripped and not stripped.endswith(("{", "}", ";")) and ":" not in stripped:
            selector = stripped

        m = re.search(r"font-size\s*:\s*([^;}\"']+);", line)
        if not m:
            out.append(line)
            continue
        raw = m.group(1).strip()
        if raw in SIZE_SKIP:
            out.append(line)
            continue
        if raw in AMBIGUOUS_ICON:
            tok = AMBIGUOUS_ICON[raw] if ICON_SELECTOR_RE.search(selector or "") else AMBIGUOUS_TEXT[raw]
            stats["字号(需判定图标/文字)"] += 1
        else:
            tok = SIZE_MAP.get(raw)
        if not tok or tok == raw:
            out.append(line)
            continue
        out.append(line[:m.start(1)] + tok + line[m.end(1):])
        stats["字号→刻度"] += 1
        CHANGES.append(("size", label, raw, tok, 1))
    return "\n".join(out)


def convert_sizes_inline(text, label):
    def repl(m):
        raw = m.group(1).strip()
        if raw in SIZE_SKIP:
            return m.group(0)
        tok = SIZE_MAP.get(raw)
        if not tok:
            return m.group(0)
        stats["字号(内联)"] += 1
        CHANGES.append(("size", label, raw, tok, 1))
        return "font-size:" + tok + ";"
    return re.sub(r"font-size\s*:\s*([^;\"']+);", repl, text)


# ------------------------------------------------------------------ 文件处理
def process_css(path):
    orig = s = read_preserve(path)
    s, cstore = mask_comments(s)
    s, rblock = protect_root(s)
    s = convert_colors(s, path)
    s = convert_sizes_css(s, path)
    s = restore_root(s, rblock)
    return orig, unmask_comments(s, cstore)


def process_html(path):
    orig = s = read_preserve(path)
    s, cstore = mask_comments(s)
    s, rblock = protect_root(s)

    def style_block(m):
        inner = convert_colors(m.group(1), path)
        inner = convert_sizes_css(inner, path)
        return m.group(0).replace(m.group(1), inner)

    s = re.sub(r"<style>(.*?)</style>", style_block, s, flags=re.S)

    def attr(m):
        q, inner = m.group(1), m.group(2)
        inner = convert_colors(inner, path)
        inner = convert_sizes_inline(inner, path)
        return "style=" + q + inner + q

    s = re.sub(r"style=([\"'])(.*?)\1", attr, s, flags=re.S)
    s = restore_root(s, rblock)
    return orig, unmask_comments(s, cstore)


def process_js(path):
    orig = s = read_preserve(path)
    s, cstore = mask_comments(s)
    s, rblock = protect_root(s)
    out = []
    for i, line in enumerate(s.split("\n"), 1):
        if not re.search(r"#[0-9a-fA-F]{3,8}\b|font-size", line):
            out.append(line)
            continue
        # 整行都交给 convert_colors(js_mode=True)：
        # 它只跳过「被引号包住」的色值（ECharts/canvas 配置），
        # 所以多行模板字符串里的 CSS（style=" 开在上一行）也能覆盖到。
        new = convert_colors(line, f"{path}:{i}", js_mode=True)
        m = re.search(r"font-size\s*:\s*([^;}\"']+)(;|[\"'])", new)
        if m and m.group(1).strip() in SIZE_MAP:
            raw = m.group(1).strip()
            new = new[:m.start(1)] + SIZE_MAP[raw] + new[m.end(1):]
            stats["字号(JS内联)"] += 1
            CHANGES.append(("size", f"{path}:{i}", raw, SIZE_MAP[raw], 1))
        out.append(new)
    s = "\n".join(out)
    s = restore_root(s, rblock)
    return orig, unmask_comments(s, cstore)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只 dry-run）")
    args = ap.parse_args()

    total = 0
    for path in CSS_FILES + HTML_FILES + JS_FILES:
        if path in EXCLUDED_PATHS or path.startswith(EXCLUDED_PREFIX):
            print(f"  跳过（第三方/独立页）: {path}")
            continue
        if not os.path.exists(path):
            print(f"  跳过（不存在）: {path}")
            continue
        if path.endswith(".css"):
            orig, new = process_css(path)
        elif path.endswith(".html"):
            orig, new = process_html(path)
        else:
            orig, new = process_js(path)
        if orig != new:
            n = sum(1 for a, b in zip(orig.split("\n"), new.split("\n")) if a != b)
            total += n
            print(f"  {path:36s} 改动 {n:4d} 行")
            if args.apply:
                write_preserve(path, new)
        else:
            print(f"  {path:36s} 无改动")

    print("\n---- 分类统计 ----")
    for k, v in stats.most_common():
        print(f"  {k:20s} {v}")

    if not args.apply:
        print(f"\n总改动行数 {total}（dry-run，未写入。加 --apply 生效）")
        print("\n---- 明细（最多 90 条）----")
        agg = collections.Counter((c[0], c[2], c[3]) for c in CHANGES)
        for (kind, src, dst), n in agg.most_common(90):
            print(f"  [{kind:5s}] {src:22s} → {dst:30s} ×{n}")


if __name__ == "__main__":
    main()
