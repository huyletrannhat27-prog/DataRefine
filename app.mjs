import { FILE_LIMIT, demoFiles, fitProfile, parseCsv, processTable, schemaKey, toCsv } from './engine.mjs';
import { datasetFormat } from './tabular.mjs';

const now = () => new Date().toISOString();
const token = () => crypto.randomUUID();
const encoder = new TextEncoder();
const sessionAge = 60 * 60 * 24 * 30;
const downloadType = 'text/csv; charset=utf-8';

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new RequestError(status, message); }
function validate(action) {
  try { return action(); }
  catch (error) { return fail(400, error.message); }
}

async function parseBody(request) {
  const max = FILE_LIMIT * 3 + 8000;
  if (Number(request.headers.get('content-length')) > max) fail(413, 'Dung lượng tệp vượt giới hạn.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Yêu cầu thiếu dữ liệu.');
  let size = 0, value = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) { await reader.cancel(); fail(413, 'Dung lượng tệp vượt giới hạn.'); }
      value += decoder.decode(chunk.value, { stream: true });
    }
    value += decoder.decode();
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid object');
    return parsed;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    fail(400, 'Dữ liệu gửi lên phải là JSON mã hóa UTF-8.');
  }
}

function parseFile(value) {
  if (typeof value !== 'string' || !value.trim()) fail(400, 'Chọn một tệp CSV có dữ liệu.');
  if (value.includes('\uFFFD') || value.includes('\0')) fail(400, 'Hãy lưu tệp dưới dạng CSV UTF-8.');
  if (encoder.encode(value).byteLength > FILE_LIMIT) fail(413, 'Mỗi tệp CSV tối đa 200 KB.');
  return validate(() => parseCsv(value));
}

function safeName(name) {
  return String(name || 'dataset.csv').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 120);
}
function filename(name) {
  return "attachment; filename*=UTF-8''" + encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
}
function addNotice(state, job, audience, title, message, tone) {
  state.notices.unshift({ id: token(), jobId: job.id, audience, title, message, tone, time: now() });
  state.notices.length = Math.min(state.notices.length, 250);
}
function applyProfile(state, job, table, profile) {
  const result = processTable(table, profile);
  Object.assign(job, result, {
    profile: profile?.label ?? null, version: profile?.version ?? null, updated: now(),
    status: !profile ? 'waiting' : result.stats.unresolved ? 'review' : 'done'
  });
  announceResult(state, job);
}
function announceResult(state, job) {
  const { status, stats } = job;
  if (status === 'waiting') {
    addNotice(state, job, job.owner, 'Đang chờ hỗ trợ', job.name + ' có cấu trúc chưa được hỗ trợ.', 'warning');
    addNotice(state, job, 'admin', 'Có dạng dữ liệu mới', job.name + ' đang chờ cấu hình và mô hình.', 'warning');
  } else {
    addNotice(state, job, job.owner, 'File đã xử lý', job.name + ' có thể tải xuống.', 'success');
  }
  const { missing, unresolved, filled } = stats;
  if (missing || unresolved) {
    const message = job.name + ' có ' + missing + ' ô trống, đã điền ' + filled + ', còn ' + unresolved + ' vấn đề cần kiểm tra.';
    for (const audience of [job.owner, 'admin']) addNotice(state, job, audience, 'Báo cáo dữ liệu', message, unresolved ? 'warning' : 'success');
  }
}

const emptyStats = () => ({ rows:0, missing:0, filled:0, unresolved:0, duplicates:0 });

function jobSummary({ id, name, status, profile, version, created, updated, headers, stats, bytes, format, error }) {
  return { id, name, status, profile, version, created, updated, headers, stats, bytes, format, error };
}
function publicProfile({ key, label, target, headers, version, metrics, model }) {
  return { key, label, target, headers, version, metrics, features: model.features.map(f => f.name) };
}

async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
function equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function createApp(storage, assets, secret, files) {
  let expectedToken;
  const adminToken = () => expectedToken ??= hash('datarefine-admin:v1:' + secret);
  const read = async () => (await storage.read()).state;
  async function change(action) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { state, revision } = await storage.read();
      const output = action(state);
      const serialized = JSON.stringify(state);
      if (encoder.encode(serialized).byteLength > 6_000_000) fail(507, 'Kho dữ liệu của bản demo đã đầy.');
      if (await storage.write(serialized, revision)) return output;
    }
    fail(409, 'Có thay đổi đồng thời. Hãy thử lại.');
  }
  let running = false, requested = false;
  function kickQueue() {
    if (running) { requested = true; return; }
    running = true;
    requested = false;
    void drainQueue().catch(console.error).finally(() => {
      running = false;
      if (requested) kickQueue();
    });
  }
  async function drainQueue() {
    for (;;) {
      const state = await read();
      const job = state.jobs.findLast(job => job.format && job.status === 'processing');
      if (!job) return;
      let result, failure;
      try { result = await files.run(job, state.profiles); }
      catch (error) { failure = error.message; }
      await change(current => {
        const record = current.jobs.find(item => item.id === job.id);
        record.updated = now();
        if (failure) {
          record.status = 'failed';
          record.error = failure;
          addNotice(current, record, record.owner, 'Không xử lý được file', record.name + ': ' + failure, 'warning');
          return;
        }
        const key = schemaKey(result.headers);
        Object.assign(record, result, { key });
        if (!result.profile && current.profiles.some(profile => profile.key === key)) return;
        record.status = !result.profile ? 'waiting' : result.stats.unresolved ? 'review' : 'done';
        announceResult(current, record);
      });
    }
  }
  function summary(job) {
    return { ...jobSummary(job), progress:files.progress(job.id) };
  }
  // Jobs already written to disk can resume after the server restarts.
  queueMicrotask(kickQueue);
  return async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = new Headers({
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
    });
    const cookie = request.headers.get('cookie') ?? '';
    const getCookie = name => cookie.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1);
    function setCookie(name, value, age = sessionAge) {
      headers.append('Set-Cookie', name + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + age + (url.protocol === 'https:' ? '; Secure' : ''));
    }
    function send(body, type = 'application/json; charset=utf-8', status = 200) {
      headers.set('Content-Type', type);
      return new Response(type.startsWith('application/json') ? JSON.stringify(body) : body, { status, headers });
    }
    const method = request.method;
    const streamUpload = method === 'POST' && path === '/api/jobs/upload';
    function sendFile(contents, name) {
      headers.set('Content-Disposition', filename(name));
      return send('\uFEFF' + contents.replace(/^\uFEFF/, ''), downloadType);
    }

    try {
      if (method === 'GET' && Object.hasOwn(assets, path)) {
        const asset = assets[path];
        return send(asset.body, asset.type);
      }
      if (method === 'GET' && path.startsWith('/samples/')) {
        const name = path.slice(9);
        if (!Object.hasOwn(demoFiles, name)) fail(404, 'Không tìm thấy tệp mẫu.');
        return sendFile(demoFiles[name], name);
      }
      if (!path.startsWith('/api/')) fail(404, 'Không tìm thấy trang.');
      if (method === 'POST') {
        const origin = request.headers.get('origin');
        if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin))
          fail(403, 'Yêu cầu từ địa chỉ khác.');
        const contentType = request.headers.get('content-type') ?? '';
        if (streamUpload ? !/^application\/octet-stream(?:;|$)/i.test(contentType) : !/^application\/json(?:;|$)/i.test(contentType))
          fail(415, 'Định dạng yêu cầu không hợp lệ.');
      }
      let owner = getCookie('dr_user');
      if (!/^[0-9a-f-]{36}$/.test(owner ?? '')) { owner = token(); setCookie('dr_user', owner); }
      const adminCookie = getCookie('dr_admin');
      const isAdmin = Boolean(secret && adminCookie && equal(adminCookie, await adminToken()));
      if (method === 'POST' && path === '/api/admin/login') {
        if (!secret) fail(503, 'Chưa cấu hình mã quản trị trên máy chủ.');
        const body = await parseBody(request);
        if (typeof body.code !== 'string' || !equal(await hash('datarefine-admin:v1:' + body.code), await adminToken()))
          fail(401, 'Mã quản trị không đúng.');
        setCookie('dr_admin', await adminToken(), 8 * 60 * 60);
        return send({ admin: true });
      }
      if (method === 'POST' && path === '/api/admin/logout') {
        setCookie('dr_admin', '', 0);
        return send({ admin: false });
      }
      const adminView = url.searchParams.get('view') === 'admin' || path.startsWith('/api/admin/');
      if (adminView && !isAdmin) fail(401, 'Đăng nhập để mở trang quản trị.');
      if (method === 'GET' && path === '/api/state') {
        const state = await read();
        const audience = adminView ? 'admin' : owner;
        return send({
          admin: isAdmin, profiles: state.profiles.map(publicProfile),
          jobs: state.jobs.filter(job => adminView || job.owner === owner).map(summary),
          notices: state.notices.filter(item => item.audience === audience).slice(0, 80),
          drafts: adminView ? state.drafts.map(({ id, profile, created }) => ({ id, ...publicProfile(profile), created })) : []
        });
      }
      if (streamUpload) {
        const submitted = url.searchParams.get('name') ?? '';
        const format = datasetFormat(submitted);
        if (!format) fail(415, 'Chọn file CSV, TSV, TXT, JSONL hoặc NDJSON.');
        const id = token();
        const name = safeName(submitted);
        const contentLength = request.headers.get('content-length');
        const length = contentLength === null ? undefined : Number(contentLength);
        if (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
          fail(400, 'Dung lượng file không hợp lệ.');
        const bytes = await files.save(id, request.body, length);
        const job = { id, owner, name, format, bytes, created:now(), updated:now(), status:'processing',
          headers:[], stats:emptyStats() };
        try { await change(state => state.jobs.unshift(job)); }
        catch (error) { await files.discard(id).catch(console.error); throw error; }
        kickQueue();
        return send(summary(job), undefined, 202);
      }
      if (method === 'POST' && path === '/api/jobs') {
        const body = await parseBody(request);
        const table = parseFile(body.csv);
        const key = schemaKey(table.headers);
        return send(await change(state => {
          if (state.jobs.length >= 100) fail(507, 'Bản demo đã lưu tối đa 100 file.');
          const job = { id: token(), owner, name: safeName(body.name), raw: body.csv, key,
            headers: table.headers, created: now() };
          applyProfile(state, job, table, state.profiles.find(p => p.key === key));
          state.jobs.unshift(job);
          return jobSummary(job);
        }), undefined, 201);
      }
      const jobRoute = /^\/api\/jobs\/([a-f0-9-]{36})(?:\/(csv|report|original))?$/.exec(path);
      if (method === 'GET' && jobRoute) {
        const job = (await read()).jobs.find(j => j.id === jobRoute[1] && (adminView || j.owner === owner));
        if (!job) fail(404, 'Không tìm thấy file này.');
        const prefix = job.name.replace(/\.[^.]+$/, '');
        const kind = jobRoute[2];
        if (job.format) {
          const hasReport = ['done','review','waiting'].includes(job.status);
          const hasCsv = hasReport && job.status !== 'waiting';
          if (!kind) return send({ ...summary(job), ...(hasReport ? await files.details(job.id)
            : { issues:[], issueCount:0, preview:[] }) });
          if ((kind === 'csv' && !hasCsv) || (kind === 'report' && !hasReport)) fail(409, 'File kết quả chưa sẵn sàng.');
          const download = await files.download(job.id, kind);
          headers.set('Content-Length', String(download.size));
          const name = kind === 'original' ? job.name : prefix + (kind === 'csv' ? '-da-xu-ly.csv' : '-bao-cao.csv');
          headers.set('Content-Disposition', filename(name));
          return send(download.body, kind === 'original' ? 'application/octet-stream' : downloadType);
        }
        if (kind === 'csv') {
          if (!job.output) fail(409, 'File đang chờ xử lý.');
          return sendFile(job.output, prefix + '-da-xu-ly.csv');
        }
        if (kind === 'original') return sendFile(job.raw, job.name);
        if (kind === 'report') return sendFile(toCsv([
          ['ban_ghi','cot','loai','xu_ly','gia_tri_goc','gia_tri_moi'],
          ...job.issues.map(i => [i.row, i.column, i.kind, i.action, i.before, i.value])
        ], true), prefix + '-bao-cao.csv');
        const table = job.output ? parseCsv(job.output) : null;
        return send({ ...jobSummary(job), issues: job.issues.slice(0, 120), issueCount: job.issues.length, preview: table?.rows.slice(0, 8) ?? [] });
      }
      if (method === 'POST' && path === '/api/admin/headers') {
        const body = await parseBody(request);
        return send({ headers: parseFile(body.csv).headers });
      }
      if (method === 'POST' && path === '/api/admin/train') {
        const body = await parseBody(request);
        const label = String(body.label ?? '').trim().slice(0, 60);
        if (!label) fail(400, 'Nhập tên dạng dữ liệu.');
        const train = parseFile(body.training);
        const validateCsv = parseFile(body.validation);
        const featureNames = Array.isArray(body.features) ? body.features : [];
        const key = schemaKey(train.headers);
        return send(await change(state => {
          const profile = validate(() => fitProfile({ label, target: body.target, featureNames,
            train, validate: validateCsv, current: state.profiles.find(p => p.key === key) }));
          const draft = { id: token(), created: now(), profile };
          state.drafts = [draft, ...state.drafts.filter(d => d.profile.key !== key)].slice(0, 10);
          return { id: draft.id, ...publicProfile(profile) };
        }), undefined, 201);
      }
      if (method === 'POST' && path === '/api/admin/activate') {
        const body = await parseBody(request);
        const activated = await change(state => {
          const draft = state.drafts.find(d => d.id === body.id);
          if (!draft) fail(404, 'Không tìm thấy bản huấn luyện.');
          const profile = draft.profile;
          if (!profile.metrics.eligible) fail(409, 'Mô hình chưa đạt tiêu chí kích hoạt.');
          const current = state.profiles.find(p => p.key === profile.key);
          if ((current?.version ?? 0) + 1 !== profile.version) fail(409, 'Đã có phiên bản mới hơn. Hãy huấn luyện lại.');
          state.profiles = [profile, ...state.profiles.filter(p => p.key !== profile.key)];
          state.drafts = state.drafts.filter(d => d.id !== draft.id);
          const waiting = state.jobs.filter(j => j.status === 'waiting' && j.key === profile.key);
          for (const job of waiting) {
            if (job.format) {
              job.status = 'processing';
              job.updated = now();
            } else applyProfile(state, job, parseCsv(job.raw), profile);
          }
          return { profile: publicProfile(profile), reprocessed: waiting.length };
        });
        kickQueue();
        return send(activated);
      }
      if (method === 'POST' && path === '/api/admin/resolve') {
        const body = await parseBody(request);
        return send(await change(state => {
          const job = state.jobs.find(j => j.id === body.id && j.status === 'review');
          if (!job) fail(409, 'File không còn ở trạng thái cần kiểm tra.');
          job.status = 'done';
          job.updated = now();
          addNotice(state, job, job.owner, 'Admin đã xem báo cáo', job.name + ' đã được kiểm tra. Báo cáo vẫn ghi rõ các giá trị chưa xác minh.', 'success');
          return jobSummary(job);
        }));
      }
      fail(404, 'Không tìm thấy chức năng.');
    } catch (error) {
      if (!error.status) console.error(error);
      return send({ error: error.status ? error.message : 'Máy chủ chưa thể hoàn thành yêu cầu.' },
        undefined, error.status ?? 500);
    }
  };
}
