import type { Readable } from 'node:stream';
import { extractText, getDocumentProxy } from 'unpdf';
import { HttpError } from '../util.js';

const MB = 1024 * 1024;
const mb = (bytes: number) => `${Math.round((bytes / MB) * 100) / 100} MB`;

/** Reads a request body into memory, refusing it as soon as it passes `limit` bytes (`tooBigText` says why). */
export async function readLimited(
  req: Readable & { headers: Record<string, unknown> },
  limit: number,
  tooBigText = (size: number) => `This PDF is ${mb(size)}; the limit is ${mb(limit)}. Split it, or raise OUTPOST_PDF_MAX_MB in ~/.config/outpost/env.`,
): Promise<Uint8Array> {
  const tooBig = (size: number) => new HttpError(413, tooBigText(size));
  const declared = Number(req.headers['content-length']);
  if (declared > limit) {
    req.resume(); // drain so the connection can answer
    throw tooBig(declared);
  }
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      req.resume();
      throw tooBig(size);
    }
    parts.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** Extracts the text layer of a PDF, page by page. Runs locally (Mozilla's PDF.js); nothing leaves the Mac. */
export async function pdfToText(data: Uint8Array): Promise<{ text: string; pages: number }> {
  if (Buffer.from(data.subarray(0, 1024)).indexOf('%PDF-') < 0) {
    throw new HttpError(400, "This file isn't a readable PDF. Check that it opens in Preview, then try again.");
  }
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(data, { verbosity: 0 });
  } catch (e) {
    if ((e as Error)?.name === 'PasswordException') {
      throw new HttpError(422, 'This PDF is password-protected. Open it in Preview, export a copy without a password, and add that.');
    }
    throw new HttpError(400, "This file isn't a readable PDF. Check that it opens in Preview, then try again.");
  }
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const joined = text.map((t) => t.trim()).filter(Boolean).join('\n\n');
    // Scans are pictures of pages: there is no text layer to read.
    if (joined.replace(/\s/g, '').length < 20) {
      throw new HttpError(422, 'No text found. This looks like a scanned PDF. Add a version with selectable text instead, for example one your scanner app has run text recognition (OCR) on.');
    }
    return { text: joined, pages: totalPages };
  } finally {
    await pdf.loadingTask.destroy(); // frees the PDF.js worker for this document
  }
}
