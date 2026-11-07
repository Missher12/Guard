import base64
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/office/vendor/pypdf-6.18.1-py3-none-any.whl"))
from openpyxl import Workbook
from openpyxl.styles import Font
from docx import Document
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfWriter
from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject

root = Path(sys.argv[1])
for index in [1, 2]:
    book = Workbook()
    sheet = book.active
    sheet.title = "数据"
    sheet.append(["id", "value", "double"])
    sheet.append([index, index * 3, "=B2*2"])
    sheet["B2"].font = Font(bold=True)
    book.save(root / f"book{index}.xlsx")
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 12 Tf 10 30 Td (Page {index}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(root / f"page{index}.pdf")
doc = Document()
p = doc.add_paragraph()
p.add_run("Hello ").bold = True
p.add_run("{{na").italic = True
p.add_run("me}}!")
doc.add_table(rows=1, cols=2).cell(0, 0).text = "old"
doc.save(root / "letter.docx")
image = root / "pixel.png"
image.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9V0AAAAASUVORK5CYII="))
presentation = Presentation()
slide = presentation.slides.add_slide(presentation.slide_layouts[6])
shape = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
shape.text_frame.paragraphs[0].add_run().text = "Hello {{name}}"
slide.shapes.add_picture(str(image), Inches(1), Inches(3), Inches(1), Inches(1))
presentation.save(root / "slides.pptx")
