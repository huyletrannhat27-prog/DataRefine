import { MAX_COLUMNS, normalizeHeaders } from './tabular.mjs';

export const FILE_LIMIT = 200_000;
const MAX_ROWS = 1200;
const dayColumn = /^(ngay|date|ngay_ban|ngay_nhap)$/;

export function parseCsv(input) {
  const src = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  function pushCell() {
    if (row.length >= MAX_COLUMNS || cell.length > 2000) throw Error('CSV quá nhiều cột hoặc có ô vượt 2.000 ký tự.');
    row.push(cell);
    cell = '';
    closed = false;
  }
  function pushRow() {
    pushCell();
    if (row.length > 1 || row[0].trim()) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1) throw Error('Bản thử nghiệm hỗ trợ tối đa 1.200 bản ghi.');
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (src[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
      continue;
    }
    if (c === ',') pushCell();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      pushRow();
    } else if (closed || (c === '"' && cell)) throw Error('CSV có dấu ngoặc kép sai định dạng.');
    else if (c === '"') quoted = true;
    else cell += c;
  }
  if (quoted) throw Error('CSV có ô chưa đóng dấu ngoặc kép.');
  if (row.length || cell || closed) pushRow();
  if (rows.length < 2) throw Error('Cần một hàng tiêu đề và ít nhất một bản ghi.');
  const headers = normalizeHeaders(rows.shift());
  if (rows.some(x => x.length !== headers.length)) throw Error('Có bản ghi không khớp số cột ở hàng tiêu đề.');
  return { headers, rows };
}

export function toCsv(rows, protect = false) {
  return rows.map(row => row.map(value => {
    let s = String(value ?? '');
    if (protect && /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(s) && !Number.isFinite(number(s))) s = "'" + s;
    return /[,"\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  }).join(',')).join('\r\n') + '\r\n';
}
export const schemaKey = headers => JSON.stringify([...headers].sort());
export const blank = v => v == null || String(v).trim() === '';
const number = v => /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(String(v).trim()) ? Number(v) : NaN;
const category = v => String(v).trim().toLowerCase().normalize('NFC');
const round = (n, places = 2) => Number(n.toFixed(places));

function normalDate(value) {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!iso && !vn) return null;
  const [y, m, d] = iso ? iso.slice(1) : [vn[3], vn[2], vn[1]];
  const formatted = [y, m.padStart(2, '0'), d.padStart(2, '0')].join('-');
  const parsed = new Date(formatted + 'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === formatted ? formatted : null;
}

function valueAt(table, row, column) {
  const value = row[table.headers.indexOf(column)]?.trim() ?? '';
  return dayColumn.test(column) ? normalDate(value) ?? '' : value;
}

function examples(table, target, features) {
  return table.rows.map(row => ({
    x: features.map(col => valueAt(table, row, col)),
    y: number(valueAt(table, row, target)),
    record: JSON.stringify(table.headers.slice().sort().map(col => valueAt(table, row, col)))
  })).filter(s => Number.isFinite(s.y) && s.x.every(v => !blank(v)));
}

function encode(features, x) {
  return x.map((value, i) => features[i].numeric ? number(value) : category(value));
}

function infer(model, input, allowFallback = false) {
  const x = encode(model.features, input);
  if (input.some(blank) || x.some(v => typeof v === 'number' && !Number.isFinite(v)))
    return allowFallback ? model.median : null;
  if (model.features.some((f, i) => !f.numeric && !f.values.includes(x[i])))
    return allowFallback ? model.median : null;
  let min = Infinity;
  const best = [];
  for (const sample of model.samples) {
    let distance = 0;
    for (let i = 0; i < x.length; i++) {
      const f = model.features[i];
      distance += f.numeric ? Math.abs(x[i] - sample.x[i]) / f.span : Number(x[i] !== sample.x[i]);
    }
    min = Math.min(min, distance);
    if (best.length === 3 && distance >= best[2].distance) continue;
    best.push({ distance, y: sample.y });
    best.sort((a, b) => a.distance - b.distance);
    if (best.length > 3) best.pop();
  }
  if (min > 0.65) return allowFallback ? model.median : null;
  const selected = min === 0 ? best.filter(n => n.distance === 0) : best;
  const sum = selected.reduce((v, n) => v + n.y / (n.distance + 0.01), 0);
  const weight = selected.reduce((v, n) => v + 1 / (n.distance + 0.01), 0);
  return round(sum / weight, model.integer ? 0 : 2);
}

export function fitProfile({ label, target, featureNames, train, validate, current }) {
  if (schemaKey(train.headers) !== schemaKey(validate.headers)) throw Error('File kiểm thử cần có cùng các cột với file huấn luyện.');
  if (!train.headers.includes(target) || dayColumn.test(target)) throw Error('Chọn cột số cần điền.');
  const cols = featureNames.length ? [...new Set(featureNames)] : train.headers.filter(c => c !== target);
  if (cols.includes(target) || cols.some(c => !train.headers.includes(c))) throw Error('Cột đầu vào không hợp lệ.');
  const all = [...new Map(examples(train, target, cols).map(s => [s.record, s])).values()];
  const check = [...new Map(examples(validate, target, cols).map(s => [s.record, s])).values()];
  if (all.length < 12 || check.length < 5) throw Error('Cần tối thiểu 12 bản ghi huấn luyện và 5 bản ghi kiểm thử khác nhau, đầy đủ cột mục tiêu và cột đầu vào.');
  const trainRecords = new Set(all.map(s => s.record));
  if (check.some(s => trainRecords.has(s.record))) throw Error('Phát hiện bản ghi trùng giữa tập huấn luyện và tập kiểm thử.');
  const features = cols.map((name, i) => {
    const values = all.map(s => s.x[i]);
    const nums = values.map(number);
    return nums.every(Number.isFinite) && !/(^|_)ma_|(^|_)id$/.test(name)
      ? { name, numeric: true, span: Math.max(1, Math.max(...nums) - Math.min(...nums)) }
      : { name, numeric: false, values: [...new Set(values.map(category))] };
  });
  const ys = all.map(s => s.y).sort((a, b) => a - b);
  const median = (ys[Math.floor(ys.length / 2)] + ys[Math.floor((ys.length - 1) / 2)]) / 2;
  const model = {
    features, median, integer: ys.every(Number.isInteger), nonnegative: ys[0] >= 0,
    samples: all.map(s => ({ x: encode(features, s.x), y: s.y }))
  };
  const predictions = check.map(s => infer(model, s.x));
  const mae = predictions.reduce((v, n, i) => v + Math.abs((n ?? median) - check[i].y), 0) / check.length;
  const baseline = check.reduce((v, s) => v + Math.abs(s.y - median), 0) / check.length;
  let previous = null;
  if (current) {
    if (current.target !== target) throw Error('Bản cập nhật phải giữ nguyên cột mục tiêu của dạng dữ liệu.');
    const test = examples(validate, target, current.model.features.map(f => f.name));
    const byRecord = new Map(test.map(s => [s.record, s]));
    previous = check.reduce((v, s) => {
      const record = byRecord.get(s.record);
      const prediction = record ? infer(current.model, record.x, true) : current.model.median;
      return v + Math.abs(s.y - prediction);
    }, 0) / check.length;
  }
  const coverage = predictions.filter(x => x !== null).length / check.length;
  const eligible = coverage >= 0.6 && mae <= baseline + 1e-9 && (previous === null || mae <= previous + 1e-9);
  return {
    label, headers: train.headers, key: schemaKey(train.headers), target,
    version: (current?.version ?? 0) + 1, model,
    metrics: { mae: round(mae, 3), baseline: round(baseline, 3), previous: previous === null ? null : round(previous, 3),
      coverage: round(coverage * 100, 1), train: all.length, test: check.length, eligible }
  };
}

export function createRowProcessor(headers, profile, isDuplicate) {
  const stats = { rows: 0, missing: 0, filled: 0, unresolved: 0, duplicates: 0 };
  const table = { headers };
  function processRow(original) {
    stats.rows++;
    const issues = [];
    const row = original.map(x => x.trim());
    const pending = [];
    function report(column, kind, action, value = '', before = '') {
      issues.push({ row: stats.rows, column, kind, action, value, before });
    }
    table.headers.forEach((column, i) => {
      const value = row[i];
      if (blank(value)) {
        stats.missing++;
        pending.push({ column, i, kind: 'Ô trống' });
        return;
      }
      if (original[i] !== value && profile) report(column, 'Khoảng trắng', 'Đã chuẩn hóa', value, original[i]);
      if (dayColumn.test(column) && profile) {
        const date = normalDate(value);
        if (!date) pending.push({ column, i, kind: 'Ngày không hợp lệ' });
        else if (value !== date) {
          row[i] = date;
          report(column, 'Định dạng ngày', 'Đã chuẩn hóa', date, value);
        }
      }
      if (column === profile?.target && (!Number.isFinite(number(value)) || (profile.model.nonnegative && number(value) < 0))) {
        pending.push({ column, i, kind: 'Giá trị số không hợp lệ' });
      }
    });
    const duplicate = profile && isDuplicate(row);
    for (const item of pending) {
      if (duplicate) {
        report(item.column, item.kind, 'Dòng trùng đã loại');
        continue;
      }
      const canFill = item.column === profile?.target && item.kind === 'Ô trống';
      const guess = canFill ? infer(profile.model, profile.model.features.map(f => valueAt(table, row, f.name))) : null;
      if (guess === null) {
        stats.unresolved++;
        report(item.column, item.kind, profile ? 'Cần kiểm tra' : 'Chờ hỗ trợ', '', row[item.i]);
      } else {
        stats.filled++;
        row[item.i] = String(guess);
        report(item.column, item.kind, 'Đã ước lượng', guess);
      }
    }
    if (duplicate) {
      stats.duplicates++;
      report('—', 'Dòng trùng', 'Đã loại');
    }
    return { row: duplicate ? null : row, issues };
  }
  return { stats, processRow };
}

export function processTable(table, profile) {
  const issues = [], cleaned = [], seen = new Set();
  const processor = createRowProcessor(table.headers, profile, row => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  for (const original of table.rows) {
    const result = processor.processRow(original);
    if (result.row) cleaned.push(result.row);
    issues.push(...result.issues);
  }
  return {
    stats: processor.stats, issues,
    output: profile ? toCsv([table.headers, ...cleaned], true) : null
  };
}

export const demoFiles = (() => {
  const sales = [['ngay','ma_san_pham','cua_hang','khuyen_mai','so_luong_ban']];
  const stock = [['ma_hang','kho','khu_vuc','luong_nhap','ton_kho']];
  function make(headers, start, count, stockMode) {
    return toCsv([...headers, ...Array.from({length: count}, (_, i) => {
      const n = start + i;
      const item = n % 3, location = Math.floor(n / 3) % 2, promo = Math.floor(n / 6) % 2;
      if (stockMode) {
        const incoming = 20 + n % 13 * 3;
        return ['H-' + (item + 1), 'K' + (location + 1), promo ? 'Nam' : 'Bac', incoming,
          incoming + item * 38 + location * 20 + promo * 12];
      }
      const day = new Date(Date.UTC(2025, 0, n + 1)).toISOString().slice(0, 10);
      return [day, 'SP-' + (item + 1), 'CN' + (location + 1), promo, 12 + item * 32 + location * 12 + promo * 19 + n % 3];
    })]);
  }
  return {
    'ban-hang.csv': toCsv([...sales, ['12/03/2025','SP-1','CN1',0,''], ['2025-03-13','SP-2','CN2',1,''],
      ['2025-03-14','SP-9','CN1',0,''], ['2025-03-15','SP-3','CN1',1,96], ['2025-03-15','SP-3','CN1',1,96],
      ['2025-03-16','SP-2','',1,79]]),
    'kho-moi.csv': toCsv([...stock, ['H-1','K1','Bac',26,''], ['H-2','K2','Nam',38,''], ['H-3','K1','Bac',29,105]]),
    'kho-huan-luyen.csv': make(stock, 0, 72, true),
    'kho-kiem-thu.csv': make(stock, 72, 12, true),
    'ban-hang-huan-luyen.csv': make(sales, 0, 48, false),
    'ban-hang-kiem-thu.csv': make(sales, 48, 12, false)
  };
})();

export function seedState() {
  const profile = fitProfile({
    label: 'Bán hàng', target: 'so_luong_ban', featureNames: ['ma_san_pham','cua_hang','khuyen_mai'],
    train: parseCsv(demoFiles['ban-hang-huan-luyen.csv']), validate: parseCsv(demoFiles['ban-hang-kiem-thu.csv'])
  });
  return { profiles: [profile], drafts: [], jobs: [], notices: [] };
}
