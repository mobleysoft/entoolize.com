/*
 * Vendor invoice -> QuickBooks bill-draft field extractor.
 *
 * Honest scope note: this parses the TEXT LAYER of an invoice (pasted
 * text, or extracted upstream from a PDF's text layer -- no PDF binary
 * parser is bundled here, since a real one is a substantial library, not
 * something to fake). Given real invoice text, it applies real regex/
 * heuristic field extraction -- vendor, invoice #, dates, line items,
 * totals -- and emits a QuickBooks-bill-draft-shaped JSON object for
 * human review before posting. It does NOT call the QuickBooks API
 * (needs real OAuth credentials this environment doesn't have) -- the
 * output JSON is shaped to match QuickBooks' Bill object fields
 * (VendorRef, TxnDate, DueDate, Line[]) so wiring the real API call is
 * the only remaining step, not a redesign.
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

if (typeof module !== 'undefined') {
  module.exports = { extractInvoiceFields };
}
