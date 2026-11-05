// Minimal valid PDF writer (Helvetica, one text block per page) for tests.
export function makePdf(pages: string[][]): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => (objs.push(s), objs.length);
  const catalog = add(""); // placeholder 1
  const pagesObj = add(""); // placeholder 2
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const lines of pages) {
    const body = ["BT", "/F1 11 Tf", "14 TL", "50 780 Td", ...lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`), "ET"].join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
