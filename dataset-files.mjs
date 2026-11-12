
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { MAX_DATASET_BYTES } from './tabular.mjs';

const fileNames = { original: 'original', csv: 'result.csv', report: 'report.csv', details: 'details.json' };
function error(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createDatasetFiles(stateDir) {
  const root = resolve(stateDir, 'datasets');
  function folder(id) {
    const resolved = resolve(root, id);
    if (!/^[0-9a-f-]{36}$/.test(id) || dirname(resolved) !== root) throw Error('Invalid dataset ID');
    return resolved;
  }
  const pathFor = (id, kind) => join(folder(id), fileNames[kind]);
  const progress = new Map();
  async function save(id, body, length) {
    if (!body || length === 0) throw error(400, 'File không có dữ liệu.');
    if (length > MAX_DATASET_BYTES) throw error(413, 'File vượt giới hạn 10 GiB.');
    const dir = folder(id);
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, 'upload.part');
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _, callback) {
        bytes += chunk.length;
        if (bytes > MAX_DATASET_BYTES) callback(error(413, 'File vượt giới hạn 10 GiB.'));
        else callback(null, chunk);
      }
    });
    try {
      if (length !== undefined) {
        const info = await statfs(dir, { bigint: true });
        if (info.bavail * info.bsize < BigInt(length))
          throw error(507, 'Ổ đĩa không còn đủ chỗ để lưu file gốc.');
      }
      await pipeline(Readable.fromWeb(body), limiter, createWriteStream(temporary, { flags: 'wx' }));
      if (!bytes || (length !== undefined && bytes !== length)) throw error(400, 'File rỗng hoặc quá trình tải lên bị gián đoạn.');
      await rename(temporary, pathFor(id, 'original'));
      return bytes;
    } catch (cause) {
      await rm(dir, { recursive: true, force: true }).catch(console.error);
      if (cause.code === 'ENOSPC') throw error(507, 'Ổ đĩa đã hết chỗ khi nhận file.');
      throw cause;
    }
  }
  function run(job, profiles) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./dataset-worker.mjs', import.meta.url), {
        workerData: { dir: folder(job.id), format: job.format, bytes: job.bytes, profiles }
      });
      let result;
      worker.on('message', message => {
        if (message.type === 'progress') progress.set(job.id, message.percent);
        else result = message;
      });
      worker.once('error', reject);
      worker.once('exit', code => {
        if (code || !result) reject(Error('Tiến trình xử lý file đã dừng.'));
        else if (result.type === 'error') reject(Error(result.error));
        else resolve(result.data);
      });
    }).finally(() => progress.delete(job.id));
  }
  return {
    save, run,
    progress: id => progress.get(id),
    discard: id => rm(folder(id), { recursive: true, force: true }),
    async details(id) { return JSON.parse(await readFile(pathFor(id, 'details'), 'utf8')); },
    async download(id, kind) {
      const path = pathFor(id, kind);
      const { size } = await stat(path);
      return { size, body: Readable.toWeb(createReadStream(path)) };
    }
  };
}
