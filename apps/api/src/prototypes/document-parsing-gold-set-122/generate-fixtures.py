"""Generate the anonymous, synthetic document set for Collector Issue #122.

PROTOTYPE ONLY. The generated files are evidence for a product decision and are
not production parser fixtures. Content is synthetic; no user data or network
access is used.
"""

from __future__ import annotations

import io
import json
import os
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parent
PDF_DIR = ROOT / "output" / "pdf"
DOCX_DIR = ROOT / "output" / "documents"
GOLD_DIR = ROOT / "gold"
FIXED_ZIP_TIME = (2026, 1, 1, 0, 0, 0)
MAX_IMPORT_BYTES = 20 * 1024 * 1024


def font_path(*names: str) -> str:
    font_root = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    for name in names:
        candidate = font_root / name
        if candidate.exists():
            return str(candidate)
    raise FileNotFoundError(f"Missing required fixture font: {names}")


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("FixtureSC", font_path("NotoSansSC-VF.ttf", "simhei.ttf")))
    pdfmetrics.registerFont(TTFont("FixtureSCBold", font_path("NotoSansSC-VF.ttf", "msyhbd.ttc", "simhei.ttf")))


def new_canvas(path: Path, size: tuple[float, float]) -> canvas.Canvas:
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=size, pageCompression=1, invariant=1)
    pdf.setAuthor("Collector Prototype #122")
    pdf.setCreator("Collector deterministic synthetic fixture generator")
    pdf.setSubject("Anonymous research-document parsing benchmark")
    return pdf


def draw_wrapped(pdf: canvas.Canvas, text: str, x: float, y: float, width: float, *,
                 font: str = "FixtureSC", size: float = 10.5, leading: float = 16,
                 color=black) -> float:
    pdf.setFont(font, size)
    pdf.setFillColor(color)
    line = ""
    for char in text:
        trial = line + char
        if pdfmetrics.stringWidth(trial, font, size) > width and line:
            pdf.drawString(x, y, line)
            y -= leading
            line = char
        else:
            line = trial
    if line:
        pdf.drawString(x, y, line)
        y -= leading
    return y


def chart_png() -> bytes:
    image = Image.new("RGB", (900, 420), "white")
    draw = ImageDraw.Draw(image)
    draw.line((90, 340, 840, 340), fill="#344054", width=4)
    draw.line((90, 45, 90, 340), fill="#344054", width=4)
    bars = [(170, 210, "A"), (330, 150, "B"), (490, 95, "C"), (650, 185, "D")]
    font = ImageFont.truetype(font_path("arial.ttf"), 28)
    for x, top, label in bars:
        draw.rectangle((x, top, x + 90, 340), fill="#4F86C6", outline="#1F4D78", width=2)
        draw.text((x + 34, 350), label, fill="#1D2939", font=font)
    draw.text((110, 12), "Study-time allocation (synthetic)", fill="#1D2939", font=font)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    return buffer.getvalue()


def make_zh_textbook(path: Path) -> None:
    width, height = A4
    pdf = new_canvas(path, A4)
    margin = 62
    pdf.setFillColor(HexColor("#17324D"))
    pdf.rect(0, height - 112, width, 112, fill=1, stroke=0)
    pdf.setFillColor(white)
    pdf.setFont("FixtureSCBold", 22)
    pdf.drawString(margin, height - 60, "学习系统中的证据链")
    pdf.setFont("FixtureSC", 10)
    pdf.drawString(margin, height - 84, "匿名合成教材节选 · 单栏 · 可复制文本")
    pdf.setFillColor(black)
    pdf.setFont("FixtureSCBold", 15)
    pdf.drawString(margin, height - 150, "第一章  从阅读到可追溯理解")
    y = height - 182
    y = draw_wrapped(pdf, "研究型阅读不只要求保留句子，还要求保留句子在原文中的位置。读者必须能够从摘要回到页码、段落和图表区域，核对上下文是否支持结论。", margin, y, width - 2 * margin)
    y -= 8
    y = draw_wrapped(pdf, "一个可靠的解析结果应区分正文、标题、注释与参考文献。若系统无法识别某个对象，它应明确降级，而不是把页眉、脚注或图片文字拼成看似流畅的新段落。", margin, y, width - 2 * margin)
    pdf.setFont("FixtureSCBold", 13)
    pdf.drawString(margin, y - 16, "1.1 可验证引用")
    y -= 46
    y = draw_wrapped(pdf, "本节的关键断言是：引用价值同时依赖文字完整性和稳定定位。只有导出 Markdown 而没有页码与区域，无法支持严谨复核。", margin, y, width - 2 * margin)
    pdf.setStrokeColor(HexColor("#AAB7C4"))
    pdf.line(margin, 72, width - margin, 72)
    pdf.setFont("FixtureSC", 8)
    pdf.drawString(margin, 55, "注 1：本页全部内容为 #122 生成的匿名合成文本。")
    pdf.drawRightString(width - margin, 38, "1")
    pdf.showPage()

    pdf.setFont("FixtureSCBold", 15)
    pdf.drawString(margin, height - 70, "第二章  结构对象不能退化为纯文本")
    pdf.setFont("FixtureSC", 10)
    pdf.drawString(margin, height - 102, "表 1  三类解析结果对研究任务的影响")
    x0, y0 = margin, height - 145
    col_widths = [115, 150, 205]
    row_h = 36
    rows = [
        ["对象", "最低保留要求", "错误降级的后果"],
        ["表格", "单元格与行列关系", "数字脱离指标，比较失真"],
        ["公式", "可读表达与所在区域", "变量关系丢失，推导不可复核"],
        ["图片", "资源、说明文字与页码", "图证据消失或被误写成正文"],
    ]
    current_y = y0
    for row_index, row in enumerate(rows):
        current_x = x0
        for col_index, value in enumerate(row):
            fill = HexColor("#DCEAF7") if row_index == 0 else white
            pdf.setFillColor(fill)
            pdf.setStrokeColor(HexColor("#65758B"))
            pdf.rect(current_x, current_y - row_h, col_widths[col_index], row_h, fill=1, stroke=1)
            pdf.setFillColor(black)
            pdf.setFont("FixtureSCBold" if row_index == 0 else "FixtureSC", 8.5)
            pdf.drawString(current_x + 6, current_y - 22, value)
            current_x += col_widths[col_index]
        current_y -= row_h
    pdf.setFont("FixtureSCBold", 12)
    pdf.drawString(margin, current_y - 48, "公式 1  区域加权证据分数")
    pdf.setFont("Helvetica", 15)
    pdf.drawString(margin + 30, current_y - 82, "S = 0.5T + 0.3L + 0.2V")
    pdf.setFont("FixtureSC", 9.5)
    pdf.drawString(margin + 30, current_y - 105, "其中 T 为文字完整性，L 为定位质量，V 为视觉对象保留度。")
    pdf.setStrokeColor(HexColor("#AAB7C4"))
    pdf.line(margin, 72, width - margin, 72)
    pdf.setFont("FixtureSC", 8)
    pdf.drawString(margin, 55, "脚注：公式仅用于展示结构评分，不代表正式产品权重。")
    pdf.drawRightString(width - margin, 38, "2")
    pdf.showPage()

    pdf.setFont("FixtureSCBold", 15)
    pdf.drawString(margin, height - 70, "第三章  图像证据与参考文献")
    chart = chart_png()
    pdf.drawImage(ImageReader(io.BytesIO(chart)), margin, height - 430, width=470, height=219, preserveAspectRatio=True)
    pdf.setFont("FixtureSC", 9)
    pdf.drawCentredString(width / 2, height - 447, "图 1  四类学习活动的时间分配（合成数据）")
    pdf.setFont("FixtureSCBold", 12)
    pdf.drawString(margin, height - 500, "参考文献")
    references = [
        "[1] Lin, Q. Evidence-aware reading systems. Synthetic Press, 2025.",
        "[2] Zhao, M. Stable locators for research notes. Example Journal, 8(2), 44-58.",
        "[3] Collector Project. Anonymous benchmark protocol #122, 2026.",
    ]
    y = height - 528
    pdf.setFont("Helvetica", 9)
    for reference in references:
        pdf.drawString(margin, y, reference)
        y -= 20
    pdf.setFont("FixtureSC", 8)
    pdf.drawRightString(width - margin, 38, "3")
    pdf.save()


def draw_english_lines(pdf: canvas.Canvas, lines: list[str], x: float, y: float, width: float) -> float:
    pdf.setFont("Times-Roman", 9.2)
    for line in lines:
        words = line.split()
        current = ""
        for word in words:
            trial = f"{current} {word}".strip()
            if pdfmetrics.stringWidth(trial, "Times-Roman", 9.2) > width and current:
                pdf.drawString(x, y, current)
                y -= 12.5
                current = word
            else:
                current = trial
        if current:
            pdf.drawString(x, y, current)
            y -= 12.5
        y -= 4
    return y


def make_en_paper(path: Path) -> None:
    width, height = letter
    pdf = new_canvas(path, letter)
    margin, gap = 46, 24
    column_width = (width - 2 * margin - gap) / 2
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawCentredString(width / 2, height - 52, "Recoverable Reading Order in Local Research Tools")
    pdf.setFont("Helvetica", 9)
    pdf.drawCentredString(width / 2, height - 71, "A. Example · B. Sample · Anonymous synthetic manuscript")
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(margin, height - 102, "Abstract")
    pdf.setFont("Times-Roman", 9)
    pdf.drawString(margin, height - 117, "We test whether document parsers preserve reading order, structure, and citation-ready locations.")

    left = [
        "1 Introduction",
        "Research readers move repeatedly between a claim and its source. A useful parser therefore preserves both readable prose and the place where the prose appeared.",
        "Two-column papers are a representative stress case because the visual order can differ from the order of drawing commands in the PDF stream.",
        "The benchmark treats a fluent but interleaved paragraph as a structural failure, not as a cosmetic defect.",
    ]
    right = [
        "2 Evaluation protocol",
        "Each candidate returns ordered blocks, headings, page regions, tables, formulas, figures, and an explicit outcome classification.",
        "Human reviewers compare those objects with a small gold set. They may mark a checkpoint as pass, partial, or fail, but cannot average away fabricated content.",
        "A candidate that cannot process a page should report the limitation without inventing text.",
    ]
    # Deliberately draw the right column before the left column. Visual reading order
    # remains left then right; extraction that trusts content-stream order will fail.
    draw_english_lines(pdf, right, margin + column_width + gap, height - 150, column_width)
    draw_english_lines(pdf, left, margin, height - 150, column_width)
    pdf.setStrokeColor(HexColor("#B8C0CC"))
    pdf.line(margin, 55, width - margin, 55)
    pdf.setFont("Times-Roman", 7.5)
    pdf.drawString(margin, 42, "1 Footnote: all names, measurements, and citations in this paper are synthetic.")
    pdf.drawRightString(width - margin, 30, "1")
    pdf.showPage()

    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(margin, height - 55, "3 Results")
    pdf.setFont("Helvetica", 9)
    pdf.drawString(margin, height - 78, "Table 1. Candidate outcomes on representative structures")
    rows = [
        ["Candidate", "Order", "Table", "Locator"],
        ["Text-only", "Partial", "Fail", "Page only"],
        ["Layout-aware", "Pass", "Pass", "Region"],
        ["OCR-first", "Partial", "Partial", "Region"],
    ]
    widths = [150, 95, 95, 125]
    x0, y0, row_h = margin, height - 100, 28
    for row_index, row in enumerate(rows):
        x = x0
        for col_index, value in enumerate(row):
            pdf.setFillColor(HexColor("#E7EEF7") if row_index == 0 else white)
            pdf.setStrokeColor(HexColor("#667085"))
            pdf.rect(x, y0 - row_h, widths[col_index], row_h, fill=1, stroke=1)
            pdf.setFillColor(black)
            pdf.setFont("Helvetica-Bold" if row_index == 0 else "Helvetica", 8)
            pdf.drawString(x + 5, y0 - 18, value)
            x += widths[col_index]
        y0 -= row_h
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(margin, y0 - 40, "Equation 1. Weighted structural score")
    pdf.setFont("Times-Italic", 15)
    pdf.drawString(margin + 32, y0 - 72, "Q = 0.4R + 0.35C + 0.25D")
    figure = chart_png()
    pdf.drawImage(ImageReader(io.BytesIO(figure)), margin + 245, y0 - 195, width=250, height=117, preserveAspectRatio=True)
    pdf.setFont("Helvetica", 8)
    pdf.drawCentredString(margin + 370, y0 - 207, "Figure 1. Synthetic quality profile")
    pdf.drawRightString(width - margin, 30, "2")
    pdf.showPage()

    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(margin, height - 55, "References")
    refs = [
        "[1] Example, A. (2024). Reading order as evidence. Synthetic Review 4(1), 1-12.",
        "[2] Sample, B. (2025). Region-level citation locators. Fictional Computing 9(3), 22-39.",
        "[3] Collector Project. (2026). Issue 122 anonymous gold-set protocol.",
    ]
    y = height - 85
    pdf.setFont("Times-Roman", 10)
    for ref in refs:
        pdf.drawString(margin, y, ref)
        y -= 24
    pdf.drawRightString(width - margin, 30, "3")
    pdf.save()


def scanned_page(page_number: int) -> Image.Image:
    image = Image.new("RGB", (1240, 1754), "#F7F3E8")
    draw = ImageDraw.Draw(image)
    title_font = ImageFont.truetype(font_path("arialbd.ttf"), 42)
    body_font = ImageFont.truetype(font_path("arial.ttf"), 28)
    mono_font = ImageFont.truetype(font_path("consola.ttf", "arial.ttf"), 28)
    draw.text((105, 90), f"Scanned laboratory note - page {page_number}", fill="#182230", font=title_font)
    lines = (
        [
            "Experiment: citation recovery from image-only pages",
            "Observation A: the page has no selectable text layer.",
            "Observation B: OCR should keep line order and page identity.",
            "Measured value: 12.4 +/- 0.3 units.",
        ] if page_number == 1 else [
            "Conclusion: honest degradation is preferable to invented text.",
            "The phrase BLUE ANCHOR appears only on this second page.",
            "Reference region: lower-left handwritten-style note.",
            "Reviewer initials: EX-122",
        ]
    )
    y = 230
    for line in lines:
        draw.text((120, y), line, fill="#1F2937", font=body_font)
        y += 78
    draw.rectangle((110, 700, 1120, 1200), outline="#5D6B7A", width=4)
    draw.text((150, 750), "Image-only measurement grid", fill="#344054", font=title_font)
    for row in range(4):
        draw.line((150, 850 + row * 75, 1060, 850 + row * 75), fill="#98A2B3", width=3)
    for col in range(5):
        draw.line((150 + col * 227, 850, 150 + col * 227, 1075), fill="#98A2B3", width=3)
    draw.text((130, 1510), f"SCAN-{page_number:02d} / anonymous synthetic source", fill="#475467", font=mono_font)
    return image


def make_scanned_pdf(path: Path) -> None:
    width, height = A4
    pdf = new_canvas(path, A4)
    for page_number in (1, 2):
        image = scanned_page(page_number)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=False)
        pdf.drawImage(ImageReader(io.BytesIO(buffer.getvalue())), 0, 0, width=width, height=height)
        pdf.showPage()
    pdf.save()


def set_cell_margins(cell, top=80, start=120, bottom=80, end=120) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_geometry(table, widths_dxa: list[int], indent_dxa=120) -> None:
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.autofit = False
    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.first_child_found_in("w:tblW")
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(sum(widths_dxa)))
    tbl_w.set(qn("w:type"), "dxa")
    tbl_ind = tbl_pr.first_child_found_in("w:tblInd")
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), str(indent_dxa))
    tbl_ind.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths_dxa:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)
    for row in table.rows:
        for index, cell in enumerate(row.cells):
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.first_child_found_in("w:tcW")
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:w"), str(widths_dxa[index]))
            tc_w.set(qn("w:type"), "dxa")
            cell.width = Inches(widths_dxa[index] / 1440)
            set_cell_margins(cell)


def set_style_font(style, name: str, size: float, color: str, before: float, after: float, line: float) -> None:
    style.font.name = name
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor.from_string(color)
    style._element.rPr.rFonts.set(qn("w:ascii"), name)
    style._element.rPr.rFonts.set(qn("w:hAnsi"), name)
    style.paragraph_format.space_before = Pt(before)
    style.paragraph_format.space_after = Pt(after)
    style.paragraph_format.line_spacing = line


def make_docx(path: Path) -> None:
    document = Document()
    document.core_properties.title = "Anonymous office research report"
    document.core_properties.subject = "Collector Issue #122 synthetic DOCX regression sample"
    document.core_properties.author = "Collector Prototype #122"
    document.core_properties.last_modified_by = "Collector Prototype #122"
    document.core_properties.created = document.core_properties.modified
    section = document.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = section.right_margin = section.bottom_margin = section.left_margin = Inches(1)
    section.header_distance = section.footer_distance = Inches(0.492)

    set_style_font(document.styles["Normal"], "Calibri", 11, "000000", 0, 6, 1.10)
    set_style_font(document.styles["Heading 1"], "Calibri", 16, "2E74B5", 16, 8, 1.0)
    set_style_font(document.styles["Heading 2"], "Calibri", 13, "2E74B5", 12, 6, 1.0)
    set_style_font(document.styles["Heading 3"], "Calibri", 12, "1F4D78", 8, 4, 1.0)

    header = section.header.paragraphs[0]
    header.text = "TECHNICAL NOTE  |  ANONYMOUS SYNTHETIC SAMPLE"
    header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    header.runs[0].font.name = "Calibri"
    header.runs[0].font.size = Pt(8.5)
    header.runs[0].font.color.rgb = RGBColor(102, 112, 133)

    title = document.add_paragraph()
    title.paragraph_format.space_before = Pt(16)
    title.paragraph_format.space_after = Pt(4)
    run = title.add_run("OFFICE RESEARCH REPORT")
    run.bold = True
    run.font.name = "Calibri"
    run.font.size = Pt(23)
    run.font.color.rgb = RGBColor(0, 0, 0)
    subtitle = document.add_paragraph()
    subtitle.paragraph_format.space_after = Pt(14)
    subrun = subtitle.add_run("Document parsing regression sample for Collector Issue #122")
    subrun.font.name = "Calibri"
    subrun.font.size = Pt(13)
    subrun.font.color.rgb = RGBColor(68, 68, 68)

    for label, value in (
        ("Audience", "Research-tool evaluators"),
        ("Status", "Synthetic and public-safe"),
        ("Purpose", "Office-document regression only; not the core research benchmark"),
    ):
        paragraph = document.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(2)
        label_run = paragraph.add_run(f"{label}: ")
        label_run.bold = True
        paragraph.add_run(value)

    document.add_heading("1. Executive summary", level=1)
    document.add_paragraph(
        "This synthetic report checks whether a DOCX parser preserves headings, paragraphs, a real table, and an embedded image while keeping a stable paragraph-level location. It is intentionally ordinary: office documents are a regression group, not the benchmark's main research-material claim."
    )
    document.add_heading("1.1 Decision criteria", level=2)
    document.add_paragraph(
        "A candidate passes this sample when the reading order is intact, the heading ladder remains visible, table cells remain associated with their row and column, and the figure is reported as an image resource rather than fabricated prose."
    )

    document.add_heading("2. Observed results", level=1)
    table = document.add_table(rows=4, cols=3)
    values = [
        ["Parser mode", "Reading value", "Citation value"],
        ["Plain text", "Partial", "Low"],
        ["Structure aware", "High", "High"],
        ["Silent fallback", "Misleading", "Unacceptable"],
    ]
    for r_index, row in enumerate(table.rows):
        for c_index, cell in enumerate(row.cells):
            cell.text = values[r_index][c_index]
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_after = Pt(0)
                for item in paragraph.runs:
                    item.font.name = "Calibri"
                    item.font.size = Pt(10)
                    item.bold = r_index == 0
            if r_index == 0:
                shade = OxmlElement("w:shd")
                shade.set(qn("w:fill"), "F2F4F7")
                cell._tc.get_or_add_tcPr().append(shade)
    header_properties = table.rows[0]._tr.get_or_add_trPr()
    header_marker = OxmlElement("w:tblHeader")
    header_marker.set(qn("w:val"), "true")
    header_properties.append(header_marker)
    set_table_geometry(table, [2400, 3480, 3480])

    document.add_paragraph("Source: anonymous synthetic measurements for #122.")
    figure_path = ROOT / "office-figure.tmp.png"
    figure_path.write_bytes(chart_png())
    picture = document.add_picture(str(figure_path), width=Inches(5.7))
    picture._inline.docPr.set("descr", "Bar chart showing four synthetic parser quality profiles labeled A through D")
    picture._inline.docPr.set("title", "Synthetic quality profile")
    picture_paragraph = picture._inline.getparent().getparent()
    picture_paragraph.getparent()
    document.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    caption = document.add_paragraph("Figure 1. Synthetic quality profile used only to test image extraction.")
    caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    caption.runs[0].italic = True
    caption.runs[0].font.size = Pt(9)

    document.add_page_break()
    document.add_heading("3. Reproducibility notes", level=1)
    document.add_paragraph(
        "The sample is generated from source code and contains no personal names, private files, external URLs, or copied publication text. A parser may legitimately omit visual styling, but it must not change the meaning of the table or invent a description for the figure."
    )
    document.add_heading("3.1 References", level=2)
    for text in (
        "Example Standards Group. Structured office documents. Synthetic edition, 2025.",
        "Collector Project. Anonymous document parsing protocol #122, 2026.",
    ):
        paragraph = document.add_paragraph(style="List Number")
        paragraph.add_run(text)

    footer = section.footer.paragraphs[0]
    footer.text = "Collector #122 · Anonymous synthetic DOCX regression sample"
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer.runs[0].font.name = "Calibri"
    footer.runs[0].font.size = Pt(8)
    footer.runs[0].font.color.rgb = RGBColor(102, 112, 133)

    path.parent.mkdir(parents=True, exist_ok=True)
    document.save(path)
    figure_path.unlink(missing_ok=True)
    normalize_docx_zip(path)


def normalize_docx_zip(path: Path) -> None:
    source = path.read_bytes()
    rewritten = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(source), "r") as archive, zipfile.ZipFile(
        rewritten, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as output:
        for name in sorted(archive.namelist()):
            info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            output.writestr(info, archive.read(name))
    path.write_bytes(rewritten.getvalue())


def make_negative_pdfs() -> None:
    corrupted = PDF_DIR / "negative-corrupted.pdf"
    corrupted.write_bytes(b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\nBROKEN-XREF-AND-TRUNCATED")

    source = PDF_DIR / "negative-encrypted-source.tmp.pdf"
    pdf = new_canvas(source, letter)
    pdf.setFont("Helvetica", 12)
    pdf.drawString(72, 720, "Password-protected anonymous synthetic document")
    pdf.drawString(72, 696, "Visible after opening with password: collector-122")
    pdf.save()
    reader = PdfReader(source)
    writer = PdfWriter()
    writer.append_pages_from_reader(reader)
    writer.add_metadata({
        "/Title": "Encrypted synthetic negative sample",
        "/Author": "Collector Prototype #122",
    })
    writer.encrypt("collector-122", algorithm="AES-256-R5")
    with (PDF_DIR / "negative-encrypted.pdf").open("wb") as stream:
        writer.write(stream)
    source.unlink(missing_ok=True)

    oversized = PDF_DIR / "negative-oversized.pdf"
    base = io.BytesIO()
    pdf = canvas.Canvas(base, pagesize=letter, pageCompression=1, invariant=1)
    pdf.drawString(72, 720, "Valid PDF prefix followed by deterministic padding")
    pdf.save()
    content = base.getvalue()
    target = MAX_IMPORT_BYTES + 1
    if len(content) > target:
        raise RuntimeError("Unexpected oversized seed")
    oversized.write_bytes(content + b"\x00" * (target - len(content)))


def gold_set() -> dict:
    return {
        "schemaVersion": 1,
        "prototype": True,
        "issue": 122,
        "question": "Which minimal anonymous gold set lets a user compare real reading and citation value instead of only Markdown export?",
        "decisionStatus": "awaiting-user-review",
        "classification": {
            "success": "Overall score >= 85, every core research sample >= 75, and no critical violation.",
            "partial": "Overall score 50-84, or a non-critical research structure is missing while the degradation is explicit.",
            "failure": "Overall score < 50, any fabricated content, an unusable citation locator claimed as precise, or a negative sample reported as a clean success.",
        },
        "criticalViolations": [
            "fabricated_text",
            "false_precise_locator",
            "negative_reported_success",
            "silent_content_loss",
        ],
        "dimensions": [
            {"id": "body", "label": "可读正文", "weight": 25},
            {"id": "order", "label": "阅读顺序与标题层级", "weight": 20},
            {"id": "locator", "label": "页码与区域定位", "weight": 20},
            {"id": "structure", "label": "表格与公式结构", "weight": 15},
            {"id": "image", "label": "图片资源与图注", "weight": 10},
            {"id": "degradation", "label": "失败分类与诚实降级", "weight": 10},
        ],
        "samples": [
            {
                "id": "zh-single-column-textbook",
                "group": "core-research",
                "file": "output/pdf/zh-single-column-textbook.pdf",
                "format": "pdf",
                "language": "zh-CN",
                "layout": "single-column selectable text",
                "coverage": ["headings", "page-region", "table", "formula", "footnote", "figure", "references"],
                "expectedOutcome": "success",
                "checkpoints": [
                    {"id": "zh-body", "dimension": "body", "label": "三页中文正文可复制，关键断言完整，无页眉脚注混入"},
                    {"id": "zh-headings", "dimension": "order", "label": "三章与 1.1 小节层级正确，正文顺序不跳页"},
                    {"id": "zh-locators", "dimension": "locator", "label": "关键断言定位到第 1 页中部；表 1 和公式 1 定位到第 2 页；图 1 定位到第 3 页"},
                    {"id": "zh-table-formula", "dimension": "structure", "label": "表 1 保留 4x3 单元格；公式 S = 0.5T + 0.3L + 0.2V 可读"},
                    {"id": "zh-figure", "dimension": "image", "label": "图 1 作为独立图片资源并关联图注与第 3 页"},
                    {"id": "zh-degrade", "dimension": "degradation", "label": "若公式或图片不可结构化，明确标记缺失，不把图像内容伪造成正文"},
                ],
                "gold": {
                    "readingOrder": ["第一章", "1.1 可验证引用", "第二章", "表 1", "公式 1", "第三章", "图 1", "参考文献"],
                    "regions": [
                        {"page": 1, "region": "middle", "contains": "引用价值同时依赖文字完整性和稳定定位"},
                        {"page": 2, "region": "upper-middle", "object": "table-1"},
                        {"page": 2, "region": "lower-middle", "object": "formula-1"},
                        {"page": 3, "region": "upper-middle", "object": "figure-1"},
                    ],
                    "table": [["对象", "最低保留要求", "错误降级的后果"], ["表格", "单元格与行列关系", "数字脱离指标，比较失真"], ["公式", "可读表达与所在区域", "变量关系丢失，推导不可复核"], ["图片", "资源、说明文字与页码", "图证据消失或被误写成正文"]],
                    "formula": "S = 0.5T + 0.3L + 0.2V",
                    "imageCaption": "图 1  四类学习活动的时间分配（合成数据）",
                },
            },
            {
                "id": "en-two-column-paper",
                "group": "core-research",
                "file": "output/pdf/en-two-column-paper.pdf",
                "format": "pdf",
                "language": "en",
                "layout": "two-column selectable text; content stream intentionally draws right column first",
                "coverage": ["two-column-order", "table", "formula", "footnote", "figure", "references"],
                "expectedOutcome": "success",
                "checkpoints": [
                    {"id": "en-body", "dimension": "body", "label": "正文与参考文献完整，无跨栏句子拼接"},
                    {"id": "en-order", "dimension": "order", "label": "第 1 页视觉顺序为标题/摘要 → 左栏 Introduction → 右栏 Evaluation protocol"},
                    {"id": "en-locators", "dimension": "locator", "label": "Introduction 与 Evaluation protocol 均保留第 1 页及左右栏区域"},
                    {"id": "en-structures", "dimension": "structure", "label": "第 2 页表格 4x4、Equation 1 与变量表达保持可读"},
                    {"id": "en-figure", "dimension": "image", "label": "Figure 1 资源、图注和第 2 页位置可回读"},
                    {"id": "en-degrade", "dimension": "degradation", "label": "无法恢复跨栏顺序时明确声明布局受限，不将交错文本称为成功"},
                ],
                "gold": {
                    "readingOrder": ["Title", "Abstract", "1 Introduction", "2 Evaluation protocol", "3 Results", "Table 1", "Equation 1", "Figure 1", "References"],
                    "regions": [{"page": 1, "region": "left-column", "heading": "1 Introduction"}, {"page": 1, "region": "right-column", "heading": "2 Evaluation protocol"}],
                    "formula": "Q = 0.4R + 0.35C + 0.25D",
                },
            },
            {
                "id": "scanned-lab-note",
                "group": "core-research",
                "file": "output/pdf/scanned-lab-note.pdf",
                "format": "pdf",
                "language": "en",
                "layout": "two image-only scanned pages; intentionally no text layer",
                "coverage": ["scan", "ocr", "page-region", "image-only-table"],
                "expectedOutcome": "success-or-explicit-partial",
                "checkpoints": [
                    {"id": "scan-body", "dimension": "body", "label": "OCR 读取主要正文；第 2 页保留短语 BLUE ANCHOR"},
                    {"id": "scan-order", "dimension": "order", "label": "两页顺序和每页行序稳定"},
                    {"id": "scan-locator", "dimension": "locator", "label": "BLUE ANCHOR 可定位到第 2 页上半部"},
                    {"id": "scan-grid", "dimension": "structure", "label": "图像内测量网格被识别为图片/表格候选，不伪造单元格数值"},
                    {"id": "scan-image", "dimension": "image", "label": "每页保留原始页面图像资源"},
                    {"id": "scan-degrade", "dimension": "degradation", "label": "无 OCR 时返回部分成功并明确无文本层；不得返回空白成功"},
                ],
                "gold": {"pageCount": 2, "textLayer": False, "anchor": {"page": 2, "region": "upper-half", "contains": "BLUE ANCHOR"}},
            },
            {
                "id": "office-docx-regression",
                "group": "office-regression",
                "file": "output/documents/office-regression.docx",
                "format": "docx",
                "language": "en",
                "layout": "two-page business brief",
                "coverage": ["headings", "paragraphs", "table", "image", "page-break", "references"],
                "expectedOutcome": "success",
                "checkpoints": [
                    {"id": "docx-body", "dimension": "body", "label": "两页段落完整且按文档顺序"},
                    {"id": "docx-order", "dimension": "order", "label": "Heading 1/2 层级和分页前后顺序正确"},
                    {"id": "docx-locator", "dimension": "locator", "label": "至少保留段落或块级稳定定位；不要求复原 Word 像素版式"},
                    {"id": "docx-table", "dimension": "structure", "label": "4x3 表格的行列关系保留"},
                    {"id": "docx-image", "dimension": "image", "label": "Figure 1 图片资源与图注可关联"},
                    {"id": "docx-degrade", "dimension": "degradation", "label": "若图片不支持，正文仍成功且明确图片缺失"},
                ],
                "gold": {"headingOrder": ["1. Executive summary", "1.1 Decision criteria", "2. Observed results", "3. Reproducibility notes", "3.1 References"], "tableSize": [4, 3], "imageCaption": "Figure 1. Synthetic quality profile used only to test image extraction."},
            },
            {
                "id": "negative-corrupted",
                "group": "negative",
                "file": "output/pdf/negative-corrupted.pdf",
                "format": "pdf",
                "language": "none",
                "layout": "truncated malformed PDF",
                "coverage": ["corrupt"],
                "expectedOutcome": "failure",
                "checkpoints": [
                    {"id": "corrupt-body", "dimension": "body", "label": "不产生任何伪造正文"},
                    {"id": "corrupt-order", "dimension": "order", "label": "不伪造结构"},
                    {"id": "corrupt-locator", "dimension": "locator", "label": "不伪造页码或区域"},
                    {"id": "corrupt-structure", "dimension": "structure", "label": "不伪造表格/公式"},
                    {"id": "corrupt-image", "dimension": "image", "label": "不伪造图片资源"},
                    {"id": "corrupt-degrade", "dimension": "degradation", "label": "稳定分类为 damaged/corrupt，失败可解释且不可伪装成成功"},
                ],
                "gold": {"classification": "failure", "acceptedCodes": ["damaged_file", "corrupt_pdf", "parse_failed"]},
            },
            {
                "id": "negative-encrypted",
                "group": "negative",
                "file": "output/pdf/negative-encrypted.pdf",
                "format": "pdf",
                "language": "en",
                "layout": "AES-256 password-protected PDF",
                "coverage": ["encrypted"],
                "expectedOutcome": "failure",
                "checkpoints": [
                    {"id": "encrypted-body", "dimension": "body", "label": "未提供密码时不返回正文"},
                    {"id": "encrypted-order", "dimension": "order", "label": "不猜测标题或结构"},
                    {"id": "encrypted-locator", "dimension": "locator", "label": "不伪造页码区域"},
                    {"id": "encrypted-structure", "dimension": "structure", "label": "不伪造结构对象"},
                    {"id": "encrypted-image", "dimension": "image", "label": "不伪造图片资源"},
                    {"id": "encrypted-degrade", "dimension": "degradation", "label": "稳定分类为 password_required/encrypted；密码 collector-122 只供人工验证"},
                ],
                "gold": {"classification": "failure", "acceptedCodes": ["password_required", "encrypted_pdf", "parse_failed"], "reviewPassword": "collector-122"},
            },
            {
                "id": "negative-oversized",
                "group": "negative",
                "file": "output/pdf/negative-oversized.pdf",
                "format": "pdf",
                "language": "en",
                "layout": "valid PDF prefix padded to 20 MiB + 1 byte",
                "coverage": ["size-limit"],
                "expectedOutcome": "failure-before-parse",
                "checkpoints": [
                    {"id": "oversized-body", "dimension": "body", "label": "大小校验失败后不进入解析，不产生正文"},
                    {"id": "oversized-order", "dimension": "order", "label": "不产生结构"},
                    {"id": "oversized-locator", "dimension": "locator", "label": "不产生定位"},
                    {"id": "oversized-structure", "dimension": "structure", "label": "不产生结构对象"},
                    {"id": "oversized-image", "dimension": "image", "label": "不产生图片资源"},
                    {"id": "oversized-degrade", "dimension": "degradation", "label": "在解析前稳定分类 file_too_large，报告实际大小与 20 MiB 限制"},
                ],
                "gold": {"classification": "failure-before-parse", "byteLength": MAX_IMPORT_BYTES + 1, "acceptedCodes": ["file_too_large"]},
            },
        ],
    }


def validate_outputs(data: dict) -> None:
    required = {sample["file"] for sample in data["samples"]}
    missing = [relative for relative in sorted(required) if not (ROOT / relative).exists()]
    if missing:
        raise RuntimeError(f"Missing generated samples: {missing}")
    if (PDF_DIR / "negative-oversized.pdf").stat().st_size != MAX_IMPORT_BYTES + 1:
        raise RuntimeError("Oversized negative is not exactly 20 MiB + 1 byte")
    encrypted = PdfReader(PDF_DIR / "negative-encrypted.pdf")
    if not encrypted.is_encrypted or encrypted.decrypt("collector-122") == 0:
        raise RuntimeError("Encrypted negative cannot be decrypted with the review password")
    scanned = PdfReader(PDF_DIR / "scanned-lab-note.pdf")
    if len(scanned.pages) != 2 or any((page.extract_text() or "").strip() for page in scanned.pages):
        raise RuntimeError("Scanned sample must have two image-only pages and no text layer")
    if len(PdfReader(PDF_DIR / "zh-single-column-textbook.pdf").pages) != 3:
        raise RuntimeError("Chinese textbook must have three pages")
    if len(PdfReader(PDF_DIR / "en-two-column-paper.pdf").pages) != 3:
        raise RuntimeError("English paper must have three pages")


def main() -> None:
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    DOCX_DIR.mkdir(parents=True, exist_ok=True)
    GOLD_DIR.mkdir(parents=True, exist_ok=True)
    register_fonts()
    make_zh_textbook(PDF_DIR / "zh-single-column-textbook.pdf")
    make_en_paper(PDF_DIR / "en-two-column-paper.pdf")
    make_scanned_pdf(PDF_DIR / "scanned-lab-note.pdf")
    make_docx(DOCX_DIR / "office-regression.docx")
    make_negative_pdfs()
    data = gold_set()
    validate_outputs(data)
    (GOLD_DIR / "gold-set.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Generated {len(data['samples'])} synthetic samples and gold/gold-set.json")


if __name__ == "__main__":
    main()
