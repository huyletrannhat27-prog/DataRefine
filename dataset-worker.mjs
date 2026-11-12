
import { open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { readDataset } from './tabular.mjs';
import { createRowProcessor, schemaKey, toCsv } from './engine.mjs';

const { dir, format, bytes, profiles } = workerData;
const path = name => join(dir, name);
const reportHeaders = ['ban_ghi','cot','loai','xu_ly','gia_tri_goc','gia_tri_moi'];
const excerpt = value => typeof value === 'string' && value.length > 180 ? value.slice(0, 179) + '…' : value;

async function sink(name, header) {
  const file = await open(path(name), 'w');
  let pending = '\uFEFF' + toCsv([header], true);
  async function flush() {
    if (!pending) return;
    const block = pending;
    pending = '';
    await file.writeFile(block, 'utf8');
  }
  return {
    row(values) {
      pending += toCsv([values], true);
      if (pending.length >= 128 * 1024) return flush();
    },
    async finish() { await flush(); },
    close() { return file.close(); }
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

async function processDataset() {
  let checkedAt = 0, headers, profile, processor, result, report, index;
  const issues = [], preview = [];
  let issueCount = 0;
  try {
    for await (const row of readDataset(path('original'), format, read => {
      const now = Date.now();
      if (now - checkedAt >= 1000) {
        checkedAt = now;
        parentPort.postMessage({ type:'progress', percent:Math.min(99, Math.floor(read * 100 / bytes)) });
      }
    })) {
      if (!headers) {
        headers = row;
        profile = profiles.find(p => p.key === schemaKey(headers));
        report = await sink('report.csv', reportHeaders);
        if (profile) {
          await rm(path('dedup.sqlite'), { force:true });
          index = deduplicate();
          result = await sink('result.csv', headers);
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
    await writeFile(path('details.json'), JSON.stringify({ issues, issueCount, preview }), 'utf8');
    return { headers, stats:processor.stats, profile:profile?.label ?? null, version:profile?.version ?? null };
  } finally {
    await Promise.all([report?.close(), result?.close()]);
    index?.close();
    await rm(path('dedup.sqlite'), { force:true });
  }
}

try {
  parentPort.postMessage({ type:'result', data:await processDataset() });
} catch (error) {
  await Promise.all(['result.csv', 'report.csv', 'details.json'].map(name => rm(path(name), { force:true }).catch(() => {})));
  const message = error.code === 'ENOSPC' || /disk is full|database or disk is full/i.test(error.message)
    ? 'Ổ đĩa đã hết chỗ khi xử lý file.' : error.message;
  parentPort.postMessage({ type:'error', error:message });
}
