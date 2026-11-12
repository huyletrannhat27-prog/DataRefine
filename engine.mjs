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

export function createTrainingRecordKey(headers) {
  const ordered = [...headers].sort();
  const table = { headers };
  return row => JSON.stringify(ordered.map(col => valueAt(table,row,col)));
}

const DAY = 86400000;
const dateNumber = value => {
  const date = normalDate(value);
  return date ? Date.parse(date + 'T00:00:00Z') / DAY : NaN;
};
const targetType = profile => profile.model?.targetType ?? 'number';
const getTarget = (value, type) => type === 'category' ? (blank(value) ? null : value.normalize('NFC'))
  : type === 'date' ? dateNumber(value) : number(value);
const validTarget = value => value !== null && (typeof value === 'string' || Number.isFinite(value));

function examples(table, target, features, type) {
  const key = createTrainingRecordKey(table.headers);
  const targetIndex = table.headers.indexOf(target);
  return table.rows.map((row, index) => ({
    x:features.map(col => valueAt(table,row,col)),
    y:getTarget(row[targetIndex]?.trim() ?? '',type),
    record:table.keys?.[index] ?? key(row)
  })).filter(row => validTarget(row.y) && row.x.every(v => !blank(v)));
}

function encode(features, x) {
  return x.map((value,i) => features[i].date ? dateNumber(value)
    : features[i].numeric ? number(value) : category(value));
}

function majority(weighted) {
  const votes = new Map();
  for (const { value, weight } of weighted) votes.set(value,(votes.get(value) ?? 0) + weight);
  let best, highest = -Infinity;
  for (const [value, score] of votes) {
    if (score > highest || (score === highest && value < best)) {
      highest = score;
      best = value;
    }
  }
  return best;
}

function infer(model, input) {
  const x = encode(model.features,input);
  if (input.some(blank) || x.some(v => typeof v === 'number' && !Number.isFinite(v))) return null;
  if (model.features.some((f,i) => !f.numeric && !f.values.includes(x[i]))) return null;
  const best = [];
  for (const sample of model.samples) {
    let distance = 0;
    for (let i=0; i<x.length; i++) {
      const f = model.features[i];
      distance += f.numeric ? Math.abs(x[i] - sample.x[i]) / f.span : Number(x[i] !== sample.x[i]);
    }
    if (best.length === 3 && distance >= best[2].distance) continue;
    best.push({ distance, y:sample.y });
    best.sort((a,b) => a.distance - b.distance);
    if (best.length > 3) best.pop();
  }
  const min = best[0].distance;
  if (min > 0.65) return null;
  const selected = min === 0 ? best.filter(n => n.distance === 0) : best;
  const weighted = selected.map(n => ({ value:n.y, weight:1 / (n.distance + 0.01) }));
  if (model.targetType === 'category') return majority(weighted);
  const sum = weighted.reduce((v,n) => v + n.value * n.weight,0);
  const weight = weighted.reduce((v,n) => v + n.weight,0);
  return round(sum / weight, model.integer ? 0 : 2);
}

function inferTargetType(table, column, requested) {
  if (['number','category','date'].includes(requested)) return requested;
  if (requested != null && requested !== 'auto') throw Error('Loại cột mục tiêu không hợp lệ.');
  const i = table.headers.indexOf(column);
  const values = table.rows.map(row => row[i]?.trim() ?? '').filter(v => !blank(v));
  const looksLike = parse => values.length > 0 &&
    values.filter(value => Number.isFinite(parse(value))).length >= Math.ceil(values.length * 0.9);
  if (looksLike(dateNumber)) return 'date';
  if (looksLike(number)) return 'number';
  return 'category';
}

function baselineValue(model) {
  return model.targetType === 'category' ? model.mode : model.median;
}

function evaluate(model, rows) {
  let error = 0, baseline = 0, predicted = 0;
  const fallback = baselineValue(model);
  for (const row of rows) {
    const value = infer(model,row.x);
    if (value !== null) predicted++;
    if (model.targetType === 'category') {
      error += Number(category(value ?? fallback) !== category(row.y));
      baseline += Number(category(fallback) !== category(row.y));
    } else {
      error += Math.abs((value ?? fallback) - row.y);
      baseline += Math.abs(fallback - row.y);
    }
  }
  const scale = model.targetType === 'category' ? 100 : 1;
  return { error:scale * error / rows.length, baseline:scale * baseline / rows.length, coverage:predicted / rows.length };
}

function metricFields(model, error) {
  return model.targetType === 'category' ? { errorRate:round(error,3) } : { mae:round(error,3) };
}

export function fitRulesProfile({ label, headers, current }) {
  return {
    label, headers, key:schemaKey(headers), target:null, method:'rules', model:null,
    version:(current?.version ?? 0) + 1, metrics:{ eligible:true }
  };
}

export function fitProfile({ label, target, featureNames, train, validate, current, requestedType }) {
  if (schemaKey(train.headers) !== schemaKey(validate.headers)) throw Error('Tập validation cần có cùng các cột với tập train.');
  if (!train.headers.includes(target)) throw Error('Chọn cột mục tiêu cần điền.');
  const type = inferTargetType(train,target,requestedType);
  const cols = featureNames.length ? [...new Set(featureNames)] : train.headers.filter(c => c !== target);
  if (!cols.length || cols.includes(target) || cols.some(c => !train.headers.includes(c))) throw Error('Chọn cột đầu vào khác cột mục tiêu.');
  const all = [...new Map(examples(train,target,cols,type).map(s => [s.record,s])).values()];
  const check = [...new Map(examples(validate,target,cols,type).map(s => [s.record,s])).values()];
  if (all.length < 12 || check.length < 5) throw Error('Cần ít nhất 12 dòng train và 5 dòng validation khác nhau có đủ giá trị. Hãy đổi cột hoặc chọn Làm sạch theo quy tắc.');
  const trainRecords = new Set(all.map(s => s.record));
  if (check.some(s => trainRecords.has(s.record))) throw Error('Phát hiện bản ghi trùng giữa tập train và validation.');
  const features = cols.map((name,i) => {
    const values = all.map(s => s.x[i]);
    const dates = values.map(dateNumber);
    const nums = values.map(number);
    if (dates.every(Number.isFinite)) return { name, date:true, numeric:true, span:Math.max(1,Math.max(...dates)-Math.min(...dates)) };
    if (nums.every(Number.isFinite) && !/(^|_)ma_|(^|_)id$/.test(name))
      return { name, numeric:true, span:Math.max(1,Math.max(...nums)-Math.min(...nums)) };
    return { name, numeric:false, values:[...new Set(values.map(category))] };
  });
  const model = { targetType:type, features, samples:all.map(s => ({ x:encode(features,s.x), y:s.y })) };
  if (type === 'category') {
    const representatives = new Map();
    const normalized = all.map(s => {
      const value = category(s.y);
      if (!representatives.has(value)) representatives.set(value,s.y);
      return { value, weight:1 };
    });
    model.mode = representatives.get(majority(normalized));
    for (const sample of model.samples) sample.y = representatives.get(category(sample.y));
  } else {
    const ys = all.map(s => s.y).sort((a,b) => a-b);
    model.median = (ys[Math.floor(ys.length/2)] + ys[Math.floor((ys.length-1)/2)]) / 2;
    model.integer = type === 'date' || ys.every(Number.isInteger);
    model.nonnegative = type === 'number' && ys[0] >= 0;
  }
  const score = evaluate(model,check);
  let previous = null;
  if (current?.model && current.target === target && targetType(current) === type) {
    const byRecord = new Map(examples(validate,target,current.model.features.map(f => f.name),type).map(s => [s.record,s]));
    // An empty feature vector with missing values makes the existing model use its evaluation baseline.
    const previousRows = check.map(row => byRecord.get(row.record) ??
      { y:row.y, x:current.model.features.map(() => '') });
    previous = evaluate(current.model,previousRows).error;
  }
  const eligible = score.coverage >= 0.6 && score.error <= score.baseline + 1e-9 &&
    (previous === null || score.error <= previous + 1e-9);
  return {
    label, headers:train.headers, key:schemaKey(train.headers), target, method:'knn', model,
    version:(current?.version ?? 0) + 1,
    metrics:{ ...metricFields(model,score.error), baseline:round(score.baseline,3),
      previous:previous === null ? null : round(previous,3),
      coverage:round(score.coverage * 100,1), train:all.length, test:check.length, eligible }
  };
}

export function evaluateHoldout(profile, table) {
  const { target, model } = profile;
  const rows = [...new Map(examples(table,target,model.features.map(f => f.name),targetType(profile))
    .map(row => [row.record,row])).values()];
  if (rows.length < 5) throw Error('Tập test cần ít nhất 5 dòng hợp lệ khác nhau. Hãy đổi cột hoặc dùng quy tắc.');
  const score = evaluate(model,rows);
  return { rows:rows.length, ...metricFields(model,score.error), coverage:round(score.coverage * 100,1) };
}

export function createRowProcessor(headers, profile, isDuplicate) {
  const stats = { rows: 0, missing: 0, filled: 0, unresolved: 0, duplicates: 0 };
  const table = { headers };
  const type = targetType(profile ?? {});
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
      if (profile && (dayColumn.test(column) || (column === profile.target && type === 'date'))) {
        const date = normalDate(value);
        if (!date) pending.push({ column, i, kind: 'Ngày không hợp lệ' });
        else if (value !== date) {
          row[i] = date;
          report(column, 'Định dạng ngày', 'Đã chuẩn hóa', date, value);
        }
      }
      if (profile?.model && column === profile.target && type === 'number' && (!Number.isFinite(number(value)) || (profile.model.nonnegative && number(value) < 0))) {
        pending.push({ column, i, kind: 'Giá trị số không hợp lệ' });
      }
    });
    const duplicate = profile && isDuplicate(row);
    for (const item of pending) {
      if (duplicate) {
        report(item.column, item.kind, 'Dòng trùng đã loại');
        continue;
      }
      const canFill = profile?.model && item.column === profile.target && item.kind === 'Ô trống';
      const guess = canFill ? infer(profile.model, profile.model.features.map(f => valueAt(table, row, f.name))) : null;
      if (guess === null) {
        stats.unresolved++;
        report(item.column, item.kind, profile ? 'Cần kiểm tra' : 'Chờ hỗ trợ', '', row[item.i]);
      } else {
        stats.filled++;
        const value = type === 'date' ? new Date(guess * DAY).toISOString().slice(0,10) : String(guess);
        row[item.i] = value;
        report(item.column, item.kind, 'Đã ước lượng', type === 'number' ? guess : value);
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
