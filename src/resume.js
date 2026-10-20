// Extracts plain text from a resume/job-description file (PDF, DOCX, TXT, or MD) so it can be
// dropped into the existing Settings textareas. No OCR — text layer only.
const fs = require('fs');
const path = require('path');

async function parseDocumentFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  if (ext === '.txt' || ext === '.md') {
    return buf.toString('utf8').trim();
  }
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const res = await pdfParse(buf);
    return (res.text || '').trim();
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const res = await mammoth.extractRawText({ buffer: buf });
    return (res.value || '').trim();
  }
  throw new Error('Unsupported file type: ' + (ext || '(none)') + '. Use a PDF, DOCX, or TXT file.');
}

module.exports = { parseDocumentFile };
