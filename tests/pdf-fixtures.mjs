import { deflateSync } from 'node:zlib';

function documentBuilder() {
  const objects = [null];
  const add = value => { objects.push(value); return objects.length - 1; };
  const stream = (data, attributes = '') => { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary'); return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${attributes} >>\nstream\n`), bytes, Buffer.from('\nendstream')]); };
  const finish = (root, extra = '') => {
    const chunks = [Buffer.from('%PDF-1.7\n%\xff\xff\xff\xff\n', 'binary')], offsets = [0];
    let length = chunks[0].length;
    for (let id = 1; id < objects.length; id++) {
      offsets.push(length);
      const chunk = Buffer.concat([Buffer.from(`${id} 0 obj\n`), Buffer.isBuffer(objects[id]) ? objects[id] : Buffer.from(objects[id], 'binary'), Buffer.from('\nendobj\n')]);
      chunks.push(chunk); length += chunk.length;
    }
    const xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root ${root} 0 R ${extra} >>\nstartxref\n${length}\n%%EOF\n`;
    chunks.push(Buffer.from(xref)); return Buffer.concat(chunks);
  };
  return { objects, add, stream, finish };
}
const escapePDF = value => value.replace(/[\\()]/g, match => `\\${match}`);
export function textPDF({ pages = 3, chinese = false, encrypted = false, scripted = false } = {}) {
  const pdf = documentBuilder(), root = pdf.add(''), pageTree = pdf.add('');
  let font;
  const lines = chinese ? ['对世界保持好奇。', '阅读让我们接触新的想法。'] : ['Stay curious about the world.', 'Reading connects us with new ideas.'];
  let encode;
  if (chinese) {
    const characters = [...new Set(lines.join(''))], cmap = characters.map((char, index) => `<${(index + 1).toString(16).padStart(4, '0')}> <${char.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n');
    const unicode = pdf.add(pdf.stream(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${characters.length} beginbfchar\n${cmap}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`));
    const descriptor = pdf.add('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 800 /StemV 80 >>');
    const descendant = pdf.add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`);
    font = pdf.add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`);
    encode = text => `<${Array.from(text, char => (characters.indexOf(char) + 1).toString(16).padStart(4, '0')).join('')}>`;
  } else {
    font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    encode = text => `(${escapePDF(text)})`;
  }
  const kids = [];
  for (let index = 0; index < pages; index++) {
    const content = pdf.add(pdf.stream(`BT /F1 18 Tf 60 720 Td ${encode(lines[0])} Tj 0 -32 Td ${encode(lines[1])} Tj ET`));
    kids.push(pdf.add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  const openAction = scripted ? `/OpenAction << /S /JavaScript /JS (${escapePDF("app.alert('PDF_SCRIPT_MUST_NOT_RUN');this.submitForm('https://blocked.invalid/never');")}) >>` : '';
  pdf.objects[root] = `<< /Type /Catalog /Pages ${pageTree} 0 R ${openAction} >>`;
  pdf.objects[pageTree] = `<< /Type /Pages /Count ${pages} /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] >>`;
  let extra = '';
  if (encrypted) {
    const encryption = pdf.add(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'11'.repeat(32)}> /P -4 >>`);
    extra = `/Encrypt ${encryption} 0 R /ID [<${'12'.repeat(16)}> <${'12'.repeat(16)}>]`;
  }
  return pdf.finish(root, extra);
}
export function imagePDF() {
  const pdf = documentBuilder(), root = pdf.add(''), tree = pdf.add('');
  const pixels = Buffer.alloc(32 * 32 * 3, 185);
  const image = pdf.add(pdf.stream(deflateSync(pixels), '/Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'));
  const content = pdf.add(pdf.stream('q 492 0 0 650 60 70 cm /Im1 Do Q'));
  const page = pdf.add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
  pdf.objects[root] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  pdf.objects[tree] = `<< /Type /Pages /Count 1 /Kids [${page} 0 R] >>`;
  return pdf.finish(root);
}
