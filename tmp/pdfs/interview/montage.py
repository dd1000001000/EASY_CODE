from pathlib import Path
from PIL import Image, ImageDraw
from pypdf import PdfReader
import json

root = Path(__file__).parent
pages = sorted(root.glob('page-*.png'))
for start in range(0, len(pages), 9):
    group = pages[start:start+9]
    sheet = Image.new('RGB', (1260, 1812), '#dce5e8')
    d = ImageDraw.Draw(sheet)
    for i, file in enumerate(group):
        im = Image.open(file).convert('RGB')
        im.thumbnail((400, 568))
        x, y = 10 + (i % 3)*420, 28 + (i // 3)*604
        sheet.paste(im, (x, y))
        d.text((x, y-19), file.stem, fill='#142b3a')
    sheet.save(root / f'montage-{start//9+1}.png')
pdf = Path('F:/coding agent/面试/EASY_CODE_技术面试准备手册.pdf')
r = PdfReader(str(pdf))
assert len(pages) == len(r.pages) == 31
assert len(r.pages[1].get('/Annots', [])) == 24
assert len(r.outline) == 31
fonts = set()
for page in r.pages:
    for _, ref in page['/Resources']['/Font'].items():
        font = ref.get_object()
        if '/FontDescriptor' in font:
            desc = font['/FontDescriptor'].get_object()
            assert '/FontFile2' in desc or '/FontFile3' in desc
            fonts.add(str(font['/BaseFont']))
print(json.dumps({'pages_rendered': len(pages), 'bookmarks': len(r.outline),
    'toc_links': len(r.pages[1]['/Annots']), 'embedded_fonts': sorted(fonts), 'bytes': pdf.stat().st_size}))
