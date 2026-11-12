
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';

export const MAX_DATASET_BYTES = 10 * 1024 ** 3;
export const MAX_COLUMNS = 128;
const MAX_RECORD = 1024 ** 2;

const formats = new Map([
  ['.csv', 'CSV'], ['.tsv', 'TSV'], ['.txt', 'TXT'], ['.jsonl', 'JSONL'], ['.ndjson', 'JSONL']
]);
export const datasetFormat = name => formats.get(extname(name).toLowerCase());

const normalize = name => name.normalize('NFC').trim().toLowerCase().replace(/\s+/g, '_');
export function normalizeHeaders(row) {
  const headers = row.map(normalize);
  if (headers.length < 2 || headers.length > MAX_COLUMNS ||
      headers.some(name => !name || name.length > 80) || new Set(headers).size !== headers.length)
    throw Error('Cần từ 2 đến 128 cột có tên khác nhau và không quá 80 ký tự.');
  return headers;
}

async function* textChunks(stream, onRead) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    onRead(bytes);
    let text;
    try { text = decoder.decode(chunk, { stream: true }); }
    catch { throw Error('Tệp không dùng mã hóa UTF-8 hợp lệ.'); }
    if (text.includes('\0')) throw Error('Tệp văn bản có ký tự NUL không hợp lệ.');
    if (text) yield text;
  }
  try {
    const tail = decoder.decode();
    if (tail) yield tail;
  } catch { throw Error('Tệp không dùng mã hóa UTF-8 hợp lệ.'); }
}

async function localSample(path) {
  const file = await open(path);
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0,bytesRead);
  } finally { await file.close(); }
}

function chooseDelimiter(buffer) {
  const sample = buffer.toString('utf8').trimStart();
  const counts = new Map([[',', 0], ['\t', 0], [';', 0], ['|', 0]]);
  let quoted = false;
  for (const c of sample) {
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === '\r' || c === '\n') break;
    if (counts.has(c)) counts.set(c, counts.get(c) + 1);
  }
  const candidates = [...counts].sort((a, b) => b[1] - a[1]);
  if (!candidates[0][1] || candidates[0][1] === candidates[1][1])
    throw Error('Không xác định được dấu phân cách trong tiêu đề. Hãy dùng CSV, TSV hoặc TXT có dấu phân cách rõ ràng.');
  return candidates[0][0];
}

async function* delimitedRows(chunks, delimiter) {
  const tokens = new RegExp('["\\r\\n' + (delimiter === '\t' ? '\\t' : delimiter) + ']', 'g');
  let row = [], cell = '', mode = 'plain', recordSize = 0, skipLf = false;
  const append = part => {
    if (recordSize + part.length > MAX_RECORD) throw Error('Một bản ghi vượt giới hạn 1 Mi ký tự.');
    recordSize += part.length;
    cell += part;
  };
  function field() {
    if (row.length >= MAX_COLUMNS) throw Error('Một bản ghi có quá 128 cột.');
    row.push(cell);
    cell = '';
    mode = 'plain';
  }
  function finishRow() {
    field();
    const result = row;
    row = [];
    recordSize = 0;
    return result.length > 1 || result[0].trim() ? result : null;
  }
  for await (const text of chunks) {
    let i = 0;
    while (i < text.length) {
      if (skipLf) {
        skipLf = false;
        if (text[i] === '\n') { i++; continue; }
      }
      if (mode === 'quoted') {
        const end = text.indexOf('"', i);
        if (end < 0) { append(text.slice(i)); break; }
        append(text.slice(i, end));
        mode = 'closed';
        i = end + 1;
        continue;
      }
      if (mode === 'closed' && text[i] === '"') {
        append('"');
        mode = 'quoted';
        i++;
        continue;
      }
      tokens.lastIndex = i;
      const next = tokens.exec(text);
      const end = next?.index ?? text.length;
      if (end > i) {
        if (mode === 'closed') throw Error('Có ký tự sau dấu ngoặc kép đóng của một ô.');
        append(text.slice(i, end));
      }
      if (!next) break;
      const c = next[0];
      i = end + 1;
      if (c === delimiter) field();
      else if (c === '"') {
        if (cell) throw Error('Dấu ngoặc kép xuất hiện giữa một ô chưa được bao bằng ngoặc.');
        mode = 'quoted';
      } else {
        skipLf = c === '\r';
        const result = finishRow();
        if (result) yield result;
      }
    }
  }
  if (mode === 'quoted') throw Error('Một ô có dấu ngoặc kép chưa được đóng.');
  if (row.length || cell || mode === 'closed') {
    const result = finishRow();
    if (result) yield result;
  }
}

async function* lines(chunks) {
  let pending = '';
  for await (const text of chunks) {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      if (pending.length + end - start > MAX_RECORD) throw Error('Một dòng JSONL vượt giới hạn 1 Mi ký tự.');
      pending += text.slice(start, end);
      if (newline < 0) break;
      if (pending.trim()) yield pending;
      pending = '';
      start = end + 1;
    }
  }
  if (pending.trim()) yield pending;
}

async function* jsonRows(chunks) {
  let headers, allowed, rowNumber = 0;
  for await (const line of lines(chunks)) {
    rowNumber++;
    let object;
    try {
      // Keep the exact source of numbers, including integer IDs above MAX_SAFE_INTEGER.
      object = JSON.parse(line, (_key, value, context) => typeof value === 'number' ? context.source : value);
    } catch { throw Error('Bản ghi JSONL ' + rowNumber + ' không phải JSON hợp lệ.'); }
    if (!object || typeof object !== 'object' || Array.isArray(object))
      throw Error('Mỗi bản ghi JSONL phải là một object phẳng (bản ghi ' + rowNumber + ').');
    const keys = Object.keys(object);
    if (!headers) {
      headers = normalizeHeaders(keys);
      allowed = new Set(headers);
      yield headers;
    }
    const values = new Map();
    for (const key of keys) {
      const name = normalize(key);
      const value = object[key];
      if (!allowed.has(name) || values.has(name))
        throw Error('Bản ghi JSONL ' + rowNumber + ' có cột mới hoặc trùng; khai báo đủ cột ở bản ghi đầu.');
      if (value !== null && typeof value === 'object')
        throw Error('Bản ghi JSONL ' + rowNumber + ' có dữ liệu lồng nhau.');
      values.set(name, value == null ? '' : String(value));
    }
    yield headers.map(name => values.get(name) ?? '');
  }
}

export async function* readDataset(input, format, onRead = () => {}) {
  const source = typeof input === 'string'
    ? { sample:() => localSample(input), stream:() => createReadStream(input,{ highWaterMark:256 * 1024 }) }
    : input;
  const delimiter = format === 'TXT' || format === 'CSV' ? chooseDelimiter(await source.sample()) : '\t';
  const chunks = textChunks(await source.stream(), onRead);
  const records = format === 'JSONL' ? jsonRows(chunks) : delimitedRows(chunks, delimiter);
  let headers, count = 0;
  for await (const row of records) {
    if (!headers) {
      headers = format === 'JSONL' ? row : normalizeHeaders(row);
      yield headers;
      continue;
    }
    count++;
    if (row.length !== headers.length) throw Error('Bản ghi ' + count + ' không khớp số cột của tiêu đề.');
    yield row;
  }
  if (!count) throw Error('Tệp phải có tiêu đề và ít nhất một bản ghi.');
}
