const OpenAI = require('openai');
const config = require('../config');

const client = new OpenAI({ apiKey: config.openaiApiKey });

const TEXT_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/csv',
]);

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

const MAX_CHARS_PER_FILE = 12000;
const MAX_TOTAL_CHARS = 30000;

function truncate(text, max = MAX_CHARS_PER_FILE) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[truncated]`;
}

function isPdf(file) {
  return (
    file.mimetype === 'application/pdf' ||
    String(file.originalname || '')
      .toLowerCase()
      .endsWith('.pdf')
  );
}

function isTextLike(file) {
  const name = String(file.originalname || '').toLowerCase();
  return (
    TEXT_TYPES.has(file.mimetype) ||
    /\.(txt|md|csv|json|log)$/.test(name)
  );
}

function isImage(file) {
  return IMAGE_TYPES.has(file.mimetype) || /\.(png|jpe?g|webp|gif)$/i.test(file.originalname || '');
}

async function extractPdfText(buffer) {
  const pdfParse = require('pdf-parse');
  const parsed = await pdfParse(buffer);
  return truncate(parsed.text || '');
}

async function extractImageDetails(file) {
  const b64 = file.buffer.toString('base64');
  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content:
          'Extract all useful factual details from this document/image for a phone call assistant (names, dates, policy numbers, vehicle info, addresses, amounts, requirements). Return plain text notes only.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Filename: ${file.originalname}. Extract details the caller may need to discuss.`,
          },
          {
            type: 'image_url',
            image_url: { url: `data:${file.mimetype};base64,${b64}` },
          },
        ],
      },
    ],
  });
  return truncate(completion.choices[0]?.message?.content || '');
}

/**
 * Normalize uploaded multer files into attachment records with extracted text.
 */
async function processUploads(files = []) {
  const attachments = [];
  let total = 0;

  for (const file of files) {
    if (total >= MAX_TOTAL_CHARS) break;

    let extractedText = '';
    let status = 'ok';
    let error = null;

    try {
      if (isTextLike(file)) {
        extractedText = truncate(file.buffer.toString('utf8'));
      } else if (isPdf(file)) {
        extractedText = await extractPdfText(file.buffer);
      } else if (isImage(file)) {
        extractedText = await extractImageDetails(file);
      } else {
        status = 'unsupported';
        error = `Unsupported type: ${file.mimetype || 'unknown'}. Use txt, csv, json, md, pdf, or images.`;
      }
    } catch (err) {
      status = 'failed';
      error = err.message || 'Failed to read file';
    }

    const remaining = MAX_TOTAL_CHARS - total;
    if (extractedText.length > remaining) {
      extractedText = truncate(extractedText, remaining);
    }
    total += extractedText.length;

    attachments.push({
      id: `${Date.now()}-${attachments.length}`,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      status,
      error,
      extractedText,
    });
  }

  return attachments;
}

function formatAttachmentsForPrompt(attachments = []) {
  if (!attachments.length) return '';
  return attachments
    .filter((a) => a.extractedText)
    .map(
      (a) =>
        `--- File: ${a.filename} (${a.mimeType}) ---\n${a.extractedText}`
    )
    .join('\n\n');
}

module.exports = {
  processUploads,
  formatAttachmentsForPrompt,
};