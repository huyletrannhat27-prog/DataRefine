
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

const CHUNK = 1024 * 1024;
const READ_BATCH = 2;

export function openPostgres(connectionString, max = 4) {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis:10000 });
  pool.on('error', error => console.error('PostgreSQL connection:', error.code ?? error.name));
  return pool;
}

export async function createPostgresState(pool, seed) {
  const { rows:[settings] } = await pool.query('SHOW server_encoding');
  if (settings.server_encoding !== 'UTF8') throw Error('DataRefine requires a UTF-8 PostgreSQL database.');
  const sql = await readFile(new URL('./sql/001-postgres.sql',import.meta.url),'utf8');
  await pool.query(sql);
  await pool.query('INSERT INTO datarefine_state (id, body) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING',
    [JSON.stringify(seed)]);
  return {
    async read() {
      const { rows:[row] } = await pool.query('SELECT body, revision FROM datarefine_state WHERE id = 1');
      return { state:row.body, revision:row.revision };
    },
    async write(serialized, revision) {
      const { rowCount } = await pool.query(
        'UPDATE datarefine_state SET body = $1::jsonb, revision = revision + 1 WHERE id = 1 AND revision = $2',
        [serialized,revision]);
      return rowCount === 1;
    }
  };
}

function fileError(status,message) {
  return Object.assign(new Error(message),{status});
}

export function createPostgresFiles(pool) {
  async function put(id, kind, source, { limit = Infinity, length, required = false } = {}) {
    if (length > limit) throw fileError(413,'File vượt giới hạn cho phép.');
    if (required && !source) throw fileError(400,'File không có dữ liệu.');
    const client = await pool.connect();
    let bytes = 0, position = 0, pending = Buffer.allocUnsafe(CHUNK), used = 0;
    async function write(chunk) {
      await client.query('INSERT INTO datarefine_file_chunks (id,kind,position,data) VALUES ($1,$2,$3,$4)',
        [id,kind,position++,chunk]);
    }
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM datarefine_files WHERE id = $1 AND kind = $2',[id,kind]);
      await client.query('INSERT INTO datarefine_files (id,kind,size_bytes) VALUES ($1,$2,0)',[id,kind]);
      for await (const piece of source) {
        const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        bytes += chunk.length;
        if (bytes > limit) throw fileError(413,'File vượt giới hạn 10 GiB.');
        for (let offset = 0; offset < chunk.length;) {
          const count = Math.min(CHUNK-used,chunk.length-offset);
          chunk.copy(pending,used,offset,offset+count);
          used += count;
          offset += count;
          if (used === CHUNK) { await write(pending); used = 0; }
        }
      }
      if ((required && !bytes) || (length !== undefined && bytes !== length))
        throw fileError(400,'File rỗng hoặc quá trình tải lên bị gián đoạn.');
      if (used) await write(pending.subarray(0,used));
      await client.query('UPDATE datarefine_files SET size_bytes = $3 WHERE id = $1 AND kind = $2',[id,kind,bytes]);
      await client.query('COMMIT');
      return bytes;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '53100') throw fileError(507,'PostgreSQL đã hết dung lượng lưu file.');
      throw error;
    } finally { client.release(); }
  }

  async function download(id,kind) {
    const client = await pool.connect();
    let closed = false;
    async function close() {
      if (closed) return;
      closed = true;
      try { await client.query('ROLLBACK'); client.release(); }
      catch (error) { client.release(error); }
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows:[file] } = await client.query('SELECT size_bytes FROM datarefine_files WHERE id = $1 AND kind = $2',[id,kind]);
      if (!file) throw fileError(404,'Không tìm thấy file đã lưu.');
      const size = Number(file.size_bytes);
      async function* chunks() {
        let position = 0, read = 0;
        try {
          while (read < size) {
            const { rows } = await client.query(
              'SELECT position, data FROM datarefine_file_chunks WHERE id = $1 AND kind = $2 AND position >= $3 ORDER BY position LIMIT $4',
              [id,kind,position,READ_BATCH]);
            if (!rows.length) throw Error('Thiếu khối dữ liệu trong PostgreSQL.');
            for (const row of rows) {
              if (row.position !== position++ || read + row.data.length > size) throw Error('Khối dữ liệu không hợp lệ.');
              read += row.data.length;
              yield row.data;
            }
          }
        } finally { await close(); }
      }
      const stream = Readable.from(chunks(),{ objectMode:false });
      stream.once('close',() => { void close(); });
      return { size, body:Readable.toWeb(stream,{ strategy:{ highWaterMark:2 * CHUNK, size:chunk => chunk.byteLength } }) };
    } catch (error) {
      await close();
      throw error;
    }
  }

  return {
    put, download,
    async discard(id) { await pool.query('DELETE FROM datarefine_files WHERE id = $1',[id]); },
    async sample(id) {
      const { rows:[row] } = await pool.query(
        "SELECT substring(data from 1 for 131072) AS data FROM datarefine_file_chunks WHERE id = $1 AND kind = 'original' AND position = 0",[id]);
      return row?.data ?? Buffer.alloc(0);
    },
    async json(id,kind) {
      const { body } = await download(id,kind);
      return new Response(body).json();
    }
  };
}
