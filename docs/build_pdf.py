"""Render docs/GUIDE.md to docs/GUIDE.pdf via markdown + weasyprint."""
from __future__ import annotations

import sys
from pathlib import Path

import markdown
from weasyprint import HTML, CSS
from weasyprint.text.fonts import FontConfiguration


ROOT = Path(__file__).resolve().parent
MD_PATH = ROOT / "GUIDE.md"
PDF_PATH = ROOT / "GUIDE.pdf"


CSS_STR = r"""
@page {
  size: A4;
  margin: 20mm 18mm 18mm 18mm;
  @top-left {
    content: "Qwen3-TTS Studio — Guide";
    font-family: Inter, system-ui, sans-serif;
    font-size: 9pt; color: #888;
  }
  @top-right {
    content: "v0.1.0";
    font-family: Inter, system-ui, sans-serif;
    font-size: 9pt; color: #888;
  }
  @bottom-center {
    content: counter(page) " / " counter(pages);
    font-family: Inter, system-ui, sans-serif;
    font-size: 9pt; color: #888;
  }
}
@page :first {
  @top-left { content: ""; }
  @top-right { content: ""; }
}

html, body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
  font-size: 10.2pt;
  line-height: 1.5;
  color: #1c2030;
}
body { max-width: 190mm; margin: 0 auto; }

h1 {
  font-size: 24pt; letter-spacing: -0.02em;
  color: #0f1117; margin-top: 0;
  border-bottom: 3px solid #7c9eff; padding-bottom: 6px;
}
h1:first-of-type {
  margin-top: 0; padding-top: 40mm; border: none;
  font-size: 32pt;
}
h1:first-of-type + p {
  font-size: 13pt; color: #52607a;
  border-bottom: 1px solid #ddd; padding-bottom: 14pt;
}
h2 {
  font-size: 15pt; color: #243056;
  margin-top: 22pt; page-break-after: avoid;
  border-bottom: 1px solid #d0d8e8; padding-bottom: 3pt;
}
h3 {
  font-size: 12.5pt; color: #324171; margin-top: 14pt;
  page-break-after: avoid;
}
h4 { font-size: 11pt; color: #45547c; margin-top: 10pt; }

p, li { margin: 4pt 0; }

code {
  font-family: "JetBrains Mono", Consolas, Menlo, monospace;
  font-size: 9pt;
  background: #f1f4fa;
  color: #2f3c5e;
  padding: 0.5pt 3pt;
  border-radius: 3px;
}
pre {
  background: #111625;
  color: #e6e8ee;
  padding: 10pt 12pt;
  border-radius: 6px;
  font-size: 8.6pt;
  line-height: 1.45;
  overflow-x: auto;
  margin: 8pt 0;
  page-break-inside: avoid;
}
pre code { background: none; color: inherit; padding: 0; font-size: inherit; }

table {
  border-collapse: collapse;
  width: 100%;
  margin: 8pt 0;
  page-break-inside: avoid;
  font-size: 9.2pt;
}
th, td {
  border: 1px solid #d4dbe8;
  padding: 5pt 7pt;
  text-align: left;
  vertical-align: top;
}
th {
  background: #eef2fa;
  color: #223060;
  font-weight: 600;
}
tr:nth-child(even) td { background: #fafbfe; }

blockquote {
  border-left: 3px solid #7c9eff;
  padding: 4pt 10pt;
  margin: 8pt 0;
  background: #f5f8ff;
  color: #3b466a;
}

hr {
  border: none;
  border-top: 1px solid #d0d8e8;
  margin: 14pt 0;
}

ul, ol { padding-left: 18pt; }

.toc {
  page-break-after: always;
  margin-top: 20mm;
}
.toc h2 { border: none; font-size: 18pt; }
.toc ul { list-style: none; padding-left: 0; }
.toc li { margin: 3pt 0; font-size: 10.5pt; }
.toc a { text-decoration: none; color: #243056; }

em { color: #52607a; }
strong { color: #0f1117; }

/* avoid widow/orphan lines */
p, li { orphans: 3; widows: 3; }
h2, h3, h4 { page-break-after: avoid; }
table, pre { page-break-inside: avoid; }
"""


def build_toc(html: str) -> str:
    """Build a simple TOC by scanning <h2> elements."""
    import re
    toc_items = []
    for m in re.finditer(r'<h2[^>]*>(.*?)</h2>', html, flags=re.DOTALL):
        label = re.sub(r'<[^>]+>', '', m.group(1)).strip()
        if not label:
            continue
        toc_items.append(label)
    if not toc_items:
        return ""
    toc_html = '<nav class="toc"><h2>Contents</h2><ul>'
    for i, label in enumerate(toc_items, 1):
        toc_html += f'<li>{label}</li>'
    toc_html += '</ul></nav>'
    return toc_html


def main() -> int:
    if not MD_PATH.exists():
        print(f"missing: {MD_PATH}", file=sys.stderr)
        return 1
    src = MD_PATH.read_text(encoding="utf-8")
    html_body = markdown.markdown(
        src,
        extensions=["tables", "fenced_code", "codehilite", "sane_lists", "attr_list"],
        extension_configs={"codehilite": {"noclasses": False, "pygments_style": "monokai"}},
    )

    toc = build_toc(html_body)
    html_full = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Qwen3-TTS Studio — Guide</title>
</head>
<body>
{toc}
{html_body}
</body>
</html>"""

    font_config = FontConfiguration()
    css = CSS(string=CSS_STR, font_config=font_config)
    HTML(string=html_full, base_url=str(ROOT)).write_pdf(
        str(PDF_PATH), stylesheets=[css], font_config=font_config,
    )
    print(f"wrote {PDF_PATH} ({PDF_PATH.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
