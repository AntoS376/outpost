// QR codes made in the browser, offline (bundled into public/vendor/qr.js).
import qrcode from 'qrcode-generator';

/** An SVG QR code for `text`, with medium error correction so a slightly smudged screen still scans. */
export function qrSvg(text, { cellSize = 4, margin = 2 } = {}) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize, margin, scalable: true, alt: `QR code for ${text}` });
}
