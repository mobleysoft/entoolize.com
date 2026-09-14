/**
 * entoolize.com - Vendor Invoice to QuickBooks Bill Draft (MVP)
 *
 * Two real input paths, both running the same extraction logic:
 *  1. Paste invoice text (fully client-side, no backend call).
 *  2. Upload an actual PDF (POST /api/invoices/extract) - this Worker sends
 *     the raw PDF bytes to weyland-ocr-worker (this account's existing,
 *     already-deployed PDFium+Tesseract-WASM OCR service, already used by
 *     weylandai.com/accountdrac.com/lawyik.com) via a real Cloudflare
 *     Service Binding, then runs the identical field-extraction logic on
 *     the returned OCR text. Neither path calls the QuickBooks API - that
 *     needs real OAuth credentials this environment doesn't have. The
 *     extraction/field logic (extractInvoiceFields and its helpers) is
 *     defined once below and serialized into the client bundle via
 *     Function.toString() so the two paths can never drift out of sync.
 */

/*
 * Vendor invoice -> QuickBooks bill-draft field extractor.
 *
 * Honest scope note: this parses TEXT (pasted directly, or OCR'd from a
 * real PDF via weyland-ocr-worker) and applies real regex/heuristic field
 * extraction -- vendor, invoice #, dates, line items, totals -- emitting a
 * QuickBooks-bill-draft-shaped JSON object for human review before posting.
 * It does NOT call the QuickBooks API (needs real OAuth credentials this
 * environment doesn't have) -- the output JSON is shaped to match
 * QuickBooks' Bill object fields (VendorRef, TxnDate, DueDate, Line[]) so
 * wiring the real API call is the only remaining step, not a redesign.
 */
function extractInvoiceFields(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('No invoice text provided');
  }

  const vendor = matchFirst(text, [
    /(?:from|vendor|bill\s*from|sold\s*by)\s*[:\-]\s*(.+)/i,
  ]) || firstNonEmptyLine(text);

  const invoiceNumber = matchFirst(text, [
    /invoice\s*(?:#|no\.?|number)\s*[:\-]?\s*([A-Za-z0-9\-]+)/i,
  ]);

  const invoiceDate = matchFirst(text, [
    /(?:invoice\s*date|date)\s*[:\-]\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i,
  ]);

  const dueDate = matchFirst(text, [
    /(?:due\s*date|payment\s*due)\s*[:\-]\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i,
  ]);

  // Bare "total" must not match inside "subtotal" -- try the specific,
  // unambiguous phrasings first, and only fall back to a bare "total"
  // line that has been filtered to exclude subtotal lines.
  const totalLineText = text.split(/\r?\n/)
    .filter(l => !/sub\s*-?\s*total/i.test(l))
    .join('\n');
  const total = matchFirst(totalLineText, [
    /(?:total\s*due|amount\s*due|grand\s*total)\s*[:\-]?\s*\$?\s*([0-9,]+\.[0-9]{2})/i,
    /\btotal\s*[:\-]?\s*\$?\s*([0-9,]+\.[0-9]{2})/i,
  ]);

  const subtotal = matchFirst(text, [
    /sub\s*-?\s*total\s*[:\-]?\s*\$?\s*([0-9,]+\.[0-9]{2})/i,
  ]);

  const tax = matchFirst(text, [
    /(?:tax|vat|gst)\s*[:\-]?\s*\$?\s*([0-9,]+\.[0-9]{2})/i,
  ]);

  // Line items: lines that look like "<description>  <qty>  <unit price>  <amount>"
  // or "<description> ... $<amount>" as a fallback.
  const lineItems = [];
  const lines = text.split(/\r?\n/);
  const lineItemRe = /^(.+?)\s+(\d+(?:\.\d+)?)\s+\$?([0-9,]+\.\d{2})\s+\$?([0-9,]+\.\d{2})\s*$/;
  const simpleAmountRe = /^(.+?)\s+\$?([0-9,]+\.\d{2})\s*$/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(sub-?total|total|tax|vat|gst|amount due|invoice|date|vendor|from|bill to)/i.test(trimmed)) continue;
    let m = trimmed.match(lineItemRe);
    if (m) {
      lineItems.push({
        description: m[1].trim(),
        qty: parseFloat(m[2]),
        unitPrice: parseNum(m[3]),
        amount: parseNum(m[4])
      });
      continue;
    }
    m = trimmed.match(simpleAmountRe);
    if (m && !/^\d+$/.test(m[1].trim())) {
      lineItems.push({
        description: m[1].trim(),
        qty: 1,
        unitPrice: parseNum(m[2]),
        amount: parseNum(m[2])
      });
    }
  }

  const confidence = scoreConfidence({ vendor, invoiceNumber, invoiceDate, total, lineItems });

  // QuickBooks Bill-object-shaped draft.
  const qbBillDraft = {
    VendorRef: { name: vendor || null },
    TxnDate: normalizeDate(invoiceDate),
    DueDate: normalizeDate(dueDate),
    DocNumber: invoiceNumber || null,
    Line: lineItems.map(li => ({
      Amount: li.amount,
      DetailType: 'AccountBasedExpenseLineDetail',
      Description: li.description,
      Qty: li.qty,
      UnitPrice: li.unitPrice
    })),
    TotalAmt: total ? parseNum(total) : (subtotal && tax ? parseNum(subtotal) + parseNum(tax) : null)
  };

  return {
    extracted: {
      vendor: vendor || null,
      invoiceNumber: invoiceNumber || null,
      invoiceDate: invoiceDate || null,
      dueDate: dueDate || null,
      subtotal: subtotal ? parseNum(subtotal) : null,
      tax: tax ? parseNum(tax) : null,
      total: total ? parseNum(total) : null
    },
    lineItems,
    confidence,
    qbBillDraft
  };
}

function matchFirst(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function firstNonEmptyLine(text) {
  const line = text.split(/\r?\n/).find(l => l.trim().length > 0);
  return line ? line.trim() : null;
}

function parseNum(s) {
  return parseFloat(String(s).replace(/,/g, ''));
}

function normalizeDate(d) {
  if (!d) return null;
  const m = d.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return d;
  let [, a, b, y] = m;
  if (y.length === 2) y = '20' + y;
  return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
}

function scoreConfidence({ vendor, invoiceNumber, invoiceDate, total, lineItems }) {
  let score = 0;
  if (vendor) score += 0.25;
  if (invoiceNumber) score += 0.2;
  if (invoiceDate) score += 0.15;
  if (total) score += 0.2;
  if (lineItems.length > 0) score += 0.2;
  return Math.round(score * 100) / 100;
}

// Client bundle: the exact same functions above, serialized via
// Function.toString() so the browser-side "paste text" path and the
// server-side "upload PDF" path can never silently diverge.
const EXTRACT_JS = [matchFirst, firstNonEmptyLine, parseNum, normalizeDate, scoreConfidence, extractInvoiceFields]
  .map(fn => fn.toString())
  .join('\n\n') + '\n';

const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Entoolize — Invoice to QuickBooks Bill Draft (MVP)</title>\n<style>\n  body { font-family: -apple-system, Helvetica, Arial, sans-serif; background:#0c0f14; color:#eee; margin:0; padding:2rem; }\n  h1 { font-size:1.4rem; }\n  .note { color:#8ec9ff; font-size:0.85rem; max-width:680px; line-height:1.4; }\n  textarea { width:100%; max-width:680px; height:200px; background:#111820; color:#eee; border:1px solid #2a3a4a; border-radius:6px; padding:0.6rem; font-family:monospace; }\n  button { margin-top:0.6rem; padding:0.6rem 1.2rem; background:#2f6fa8; color:#fff; border:none; border-radius:4px; cursor:pointer; }\n  input[type=file] { margin-top:0.6rem; color:#eee; }\n  pre { background:#111820; padding:1rem; border-radius:6px; max-width:680px; overflow:auto; }\n  .conf { font-weight:bold; }\n  hr { max-width:680px; margin:2rem 0; border-color:#2a3a4a; }\n</style>\n</head>\n<body>\n<h1>Entoolize — Vendor Invoice to QuickBooks Bill Draft</h1>\n<p class=\"note\">MVP scope, honest version: paste the invoice's text (from a PDF's text layer,\nemail body, or any text source) below, or upload an actual PDF (OCR'd server-side via this\naccount's own weyland-ocr-worker, no external OCR API). Either path runs the same real\nregex/heuristic field extraction -- vendor, invoice #, dates, line items, totals -- and\nproduces a QuickBooks Bill-object-shaped draft for your review, matching QuickBooks' actual\nfield names (VendorRef, TxnDate, Line[], etc). Neither path calls the QuickBooks API itself\n(needs real OAuth credentials this environment doesn't have).</p>\n\n<h3>Upload a PDF</h3>\n<input type=\"file\" id=\"pdfInput\" accept=\"application/pdf\">\n<br>\n<button id=\"runPdf\">Extract from PDF</button>\n\n<hr>\n\n<h3>Or paste invoice text</h3>\n<textarea id=\"input\" placeholder=\"Paste invoice text here...\">Acme Fabrication Co.\nInvoice Number: INV-2049\nInvoice Date: 03/14/2026\nDue Date: 04/13/2026\nSteel brackets  10  25.00  250.00\nShipping  1  40.00  40.00\nSubtotal: 290.00\nTax: 23.20\nTotal Due: $313.20</textarea>\n<br>\n<button id=\"run\">Extract fields</button>\n\n<h3>Extraction confidence</h3>\n<p id=\"conf\" class=\"conf\"></p>\n<h3>QuickBooks Bill draft (review before posting)</h3>\n<pre id=\"out\"></pre>\n\n<script src=\"invoice-extract.js\"></script>\n<script>\nfunction render(r, extra) {\n  const out = document.getElementById('out');\n  const conf = document.getElementById('conf');\n  conf.textContent = `${Math.round(r.confidence * 100)}% of expected fields found` +\n    (extra || '') +\n    (r.confidence < 0.6 ? ' -- low confidence, review carefully before posting.' : '');\n  out.textContent = JSON.stringify(r.qbBillDraft, null, 2) +\n    '\\n\\n-- raw extracted fields --\\n' + JSON.stringify(r.extracted, null, 2) +\n    '\\n\\n-- line items --\\n' + JSON.stringify(r.lineItems, null, 2);\n}\nfunction run() {\n  const text = document.getElementById('input').value;\n  try {\n    render(extractInvoiceFields(text));\n  } catch (e) {\n    document.getElementById('conf').textContent = 'Error: ' + e.message;\n    document.getElementById('out').textContent = '';\n  }\n}\nasync function runPdf() {\n  const fileInput = document.getElementById('pdfInput');\n  const file = fileInput.files[0];\n  const conf = document.getElementById('conf');\n  const out = document.getElementById('out');\n  if (!file) { conf.textContent = 'Choose a PDF file first.'; out.textContent = ''; return; }\n  conf.textContent = 'Running OCR (weyland-ocr-worker)...';\n  out.textContent = '';\n  try {\n    const resp = await fetch('/api/invoices/extract', { method: 'POST', body: file });\n    const data = await resp.json();\n    if (!resp.ok) { conf.textContent = 'Error: ' + (data.error || resp.statusText); return; }\n    render(data, ` (OCR, ${data.pages_processed} page(s) processed)`);\n    out.textContent += '\\n\\n-- OCR text preview --\\n' + data.ocr_text_preview;\n  } catch (e) {\n    conf.textContent = 'Error: ' + e.message;\n  }\n}\ndocument.getElementById('run').addEventListener('click', run);\ndocument.getElementById('runPdf').addEventListener('click', runPdf);\nrun();\n</script>\n</body>\n</html>\n";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(INDEX_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/invoice-extract.js') {
      return new Response(EXTRACT_JS, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
    }

    if (url.pathname === '/api/invoices/extract' && request.method === 'POST') {
      if (!env.OCR_SERVICE) {
        return json({ error: 'OCR service not configured on this Worker' }, 500);
      }
      let pdfBuffer;
      try {
        pdfBuffer = await request.arrayBuffer();
      } catch (e) {
        return json({ error: 'Could not read request body: ' + e.message }, 400);
      }
      if (!pdfBuffer || pdfBuffer.byteLength === 0) {
        return json({ error: 'Empty request body -- POST raw PDF bytes' }, 400);
      }

      // Real bug found + fixed 2026-09-14 (depth audit): this used to send a
      // hardcoded 'X-Total-Pages': '3', which silently truncated OCR to the
      // PDF's first 3 pages regardless of its real length -- live-verified
      // against a real 8-page PDF, which came back with pages_processed: 3
      // and no indication the other 5 pages were ever dropped. Vendor
      // invoices routinely run longer than 3 pages once itemized line items
      // or attached statements are included, so this was real, silent data
      // loss on the extraction this venture's whole MVP is built around.
      // weyland-ocr-worker's own pageRange() (page-range.js) already caps
      // 'X-Total-Pages' at the document's real page count via
      // Math.min(documentPages, ...), so requesting a generous upper bound
      // is safe -- it never over-processes a short document. 60 pages is a
      // realistic ceiling for a vendor invoice/statement while still
      // bounding worst-case OCR cost; ocrResult.hasMore/documentPageCount
      // (already returned by the OCR worker, previously ignored here) are
      // now surfaced honestly instead of assumed away.
      let ocrResp;
      try {
        ocrResp = await env.OCR_SERVICE.fetch('https://internal/extract-text', {
          method: 'POST',
          headers: { 'X-Total-Pages': '60' },
          body: pdfBuffer,
        });
      } catch (e) {
        return json({ error: 'OCR service unreachable: ' + e.message }, 502);
      }
      if (!ocrResp.ok) {
        const errText = await ocrResp.text();
        return json({ error: `OCR service error: ${errText}` }, 502);
      }

      const ocrResult = await ocrResp.json();
      const fullText = (ocrResult.pages || []).map(p => p.text).join('\n');
      if (!fullText.trim()) {
        return json({ error: 'OCR returned no text for this PDF -- it may be blank or unreadable' }, 422);
      }

      let extraction;
      try {
        extraction = extractInvoiceFields(fullText);
      } catch (e) {
        return json({ error: e.message }, 422);
      }

      const truncated = !!ocrResult.hasMore;
      const truncationWarning = truncated
        ? ` WARNING: this PDF has ${ocrResult.documentPageCount} pages but only the first ${ocrResult.pageCount} were processed -- extraction may be missing fields from later pages.`
        : '';

      return json({
        ...extraction,
        ocr_text_preview: fullText.slice(0, 500),
        pages_processed: ocrResult.pageCount,
        document_page_count: ocrResult.documentPageCount,
        truncated,
        note: 'Fields extracted from real OCR text via weyland-ocr-worker (PDFium + Tesseract-WASM, self-hosted, no external OCR API). Does not call the QuickBooks API -- no OAuth credentials are provisioned on this account. Review this draft before posting manually.' + truncationWarning,
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
