// Builds a small, valid, deterministic multi-page PDF entirely in-process,
// so the spec needs no committed binary. Object layout: 1=catalog, 2=pages,
// then (page,content) pairs per page, then one shared Helvetica font. Byte
// offsets are computed while concatenating, so the xref table is correct by
// construction (ASCII-only content, 1 char = 1 byte).
export function makePdf(pageCount: number): Buffer {
  const fontObjNum = 3 + pageCount * 2;
  const kids = Array.from(
    { length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i++) {
    const stream = `BT /F1 48 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> ` +
      `/Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
