
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { readDataset } from './tabular.mjs';
import { createRowProcessor, createTrainingRecordKey, schemaKey, toCsv } from './engine.mjs';
import { fileNames } from './dataset-files.mjs';

const { id, dir, format, bytes, profiles, databaseUrl, task } = workerData;
let pool, blobs;
if (databaseUrl) {
  const { openPostgres, createPostgresFiles } = await import('./postgres.mjs');
  pool = openPostgres(databaseUrl);
  blobs = createPostgresFiles(pool);
}
const source = blobs ? {
  sample:() => blobs.sample(id),
  stream:async () => (await blobs.download(id,'original')).body
} : join(dir,'original');
const path = name => join(dir, name);
const reportHeaders = ['ban_ghi','cot','loai','xu_ly','gia_tri_goc','gia_tri_moi'];
const excerpt = value => typeof value === 'string' && value.length > 180 ? value.slice(0, 179) + '…' : value;

async function sink(kind, header) {
  let append, finish, close;
  if (blobs) {
    const stream = new PassThrough();
    const complete = blobs.put(id,kind,stream).catch(error => {
      stream.destroy(error);
      throw error;
    });
    // Writes and finish propagate failures to the worker; observe early failures too.
    stream.on('error',() => {});
    void complete.catch(() => {});
    append = block => new Promise((resolve,reject) => {
      stream.write(block,'utf8',error => error ? reject(error) : resolve());
    });
    finish = async () => { stream.end(); await complete; };
    close = async () => { stream.destroy(); await complete.catch(() => {}); };
  } else {
    const file = await open(path(fileNames[kind]),'w');
    append = block => file.writeFile(block,'utf8');
    finish = async () => {};
    close = () => file.close();
  }
  let pending = '\uFEFF' + toCsv([header],true);
  async function flush() {
    if (!pending) return;
    const block = pending;
    pending = '';
    await append(block);
  }
  return {
    row(values) {
      pending += toCsv([values],true);
      if (pending.length >= 128 * 1024) return flush();
    },
    async finish() { await flush(); await finish(); },
    close
  };
}

function deduplicate() {
  const db = new DatabaseSync(path('dedup.sqlite'));
  db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE seen (hash BLOB PRIMARY KEY) WITHOUT ROWID; BEGIN');
  const insert = db.prepare('INSERT OR IGNORE INTO seen (hash) VALUES (?)');
  const recent = new Set();
  let inserted = 0;
  return {
    seen(row) {
      const digest = createHash('sha256').update(JSON.stringify(row)).digest();
      const key = digest.toString('base64');
      if (recent.has(key)) return true;
      if (recent.size >= 8192) recent.clear();
      recent.add(key);
      const duplicate = insert.run(digest).changes === 0;
      if (!duplicate && ++inserted % 10000 === 0) db.exec('COMMIT; BEGIN');
      return duplicate;
    },
    close() { db.close(); }
  };
}

function inputRows() {
  let checkedAt = 0;
  return readDataset(source,format,read => {
    const now = Date.now();
    if (now - checkedAt < 1000) return;
    checkedAt = now;
    parentPort.postMessage({ type:'progress', percent:Math.min(99, Math.floor(read * 100 / bytes)) });
  });
}

async function saveDetails(value) {
  const details = JSON.stringify(value);
  if (blobs) await blobs.put(id,'details',[Buffer.from(details)]);
  else await writeFile(path('details.json'),details,'utf8');
}

async function splitDataset() {
  const partitions = {
    train:{ count:0, limit:2000, eligible:0, sample:[] },
    validation:{ count:0, limit:600, eligible:0, sample:[] },
    test:{ count:0, limit:600, eligible:0, sample:[] }
  };
  let headers, recordKey;
  try {
    for await (const row of inputRows()) {
      if (!headers) {
        headers = row;
        recordKey = createTrainingRecordKey(headers);
        for (const [name, part] of Object.entries(partitions)) part.sink = await sink(name,headers);
        continue;
      }
      const key = recordKey(row);
      const bucket = createHash('sha256').update(key).digest().readUInt32BE() % 100;
      const part = bucket < 70 ? partitions.train : bucket < 85 ? partitions.validation : partitions.test;
      part.count++;
      const writing = part.sink.row(row);
      if (writing) await writing;
      // Keep a bounded random sample for KNN. All rows still go to the exported split.
      if (Buffer.byteLength(JSON.stringify(row)) <= 768) {
        const position = Math.floor(Math.random() * ++part.eligible);
        if (part.sample.length < part.limit) part.sample.push(row);
        else if (position < part.limit) part.sample[position] = row;
      }
    }
    for (const part of Object.values(partitions)) await part.sink.finish();
    const counts = {}, sampled = {}, samples = {};
    for (const [name, part] of Object.entries(partitions)) {
      counts[name] = part.count;
      sampled[name] = part.sample.length;
      samples[name] = part.sample;
    }
    await saveDetails({ headers, samples });
    return { headers, counts, sampled };
  } finally {
    await Promise.all(Object.values(partitions).map(part => part.sink?.close()));
  }
}

async function processDataset() {
  let headers, profile, processor, result, report, index;
  const issues = [], preview = [];
  let issueCount = 0;
  try {
    for await (const row of inputRows()) {
      if (!headers) {
        headers = row;
        profile = profiles.find(p => p.key === schemaKey(headers));
        report = await sink('report', reportHeaders);
        if (profile) {
          await mkdir(dir,{recursive:true});
          await rm(path('dedup.sqlite'), { force:true });
          index = deduplicate();
          result = await sink('csv', headers);
        }
        processor = createRowProcessor(headers, profile, row => index.seen(row));
        continue;
      }
      const processed = processor.processRow(row);
      if (result && processed.row) {
        if (preview.length < 8) preview.push(processed.row.map(excerpt));
        const pending = result.row(processed.row);
        if (pending) await pending;
      }
      for (const issue of processed.issues) {
        issueCount++;
        if (issues.length < 120) issues.push({ ...issue, before:excerpt(issue.before), value:excerpt(issue.value) });
        const pending = report.row([issue.row, issue.column, issue.kind, issue.action, issue.before, issue.value]);
        if (pending) await pending;
      }
    }
    await report.finish();
    await result?.finish();
    await saveDetails({ issues, issueCount, preview });
    return { headers, stats:processor.stats, profile:profile?.label ?? null, version:profile?.version ?? null };
  } finally {
    await Promise.all([report?.close(), result?.close()]);
    index?.close();
    await rm(path('dedup.sqlite'), { force:true });
  }
}

try {
  parentPort.postMessage({ type:'result', data:await (task === 'split' ? splitDataset() : processDataset()) });
} catch (error) {
  await Promise.all(['result.csv', 'report.csv', 'details.json', 'train.csv', 'validation.csv', 'test.csv'].map(name => rm(path(name), { force:true }).catch(() => {})));
  const message = error.code === 'ENOSPC' || /disk is full|database or disk is full/i.test(error.message)
    ? 'Ổ đĩa đã hết chỗ khi xử lý file.' : error.message;
  parentPort.postMessage({ type:'error', error:message });
} finally { await pool?.end(); }
