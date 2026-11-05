import { extractText, getDocumentProxy } from "unpdf";
import { limits } from "../constants";

export class PdfRejectedError extends Error {}

export function looksLikePdf(bytes: Uint8Array): boolean {
  // "%PDF-" magic within the first 1 KiB (spec allows leading junk).
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ExtractedPdf = { pageCount: number; pages: string[] };

/** Extract text per page (1-indexed by array position + 1). Rejects scanned/empty PDFs. */
export async function extractPdfPages(bytes: Uint8Array): Promise<ExtractedPdf> {
  if (bytes.byteLength > limits.maxPdfBytes) throw new PdfRejectedError("PDF exceeds the 20 MB limit");
  if (!looksLikePdf(bytes)) throw new PdfRejectedError("File is not a PDF");

  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/password/i.test(msg)) throw new PdfRejectedError("Encrypted/password-protected PDFs are not supported");
    throw new PdfRejectedError("PDF could not be parsed");
  }
  if (pdf.numPages > limits.maxPages) {
    throw new PdfRejectedError(`PDF has ${pdf.numPages} pages; the limit is ${limits.maxPages}`);
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map(cleanPageText);
  const chars = pages.reduce((n, p) => n + p.length, 0);
  if (chars < 200 || chars / Math.max(totalPages, 1) < 40) {
    throw new PdfRejectedError(
      "No extractable text found. This looks like a scanned/image-only PDF; OCR is not supported in this version.",
    );
  }
  return { pageCount: totalPages, pages };
}

export function cleanPageText(s: string): string {
  return s
    .replace(/\u0000/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
