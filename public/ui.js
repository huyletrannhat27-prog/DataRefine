
const $ = id => document.getElementById(id);
const adminPage = location.pathname === '/admin';
const main = $('main');
const dialog = $('dialog');
const view = adminPage ? '?view=admin' : '';
const page = { state: null, training: '', validation: '', split: null, busy: false, active: false };
const label = { done:'Đã xử lý', review:'Cần kiểm tra', waiting:'Chờ hỗ trợ', processing:'Đang xử lý', failed:'Lỗi xử lý' };
const hasCsv = job => job.status === 'done' || job.status === 'review';
const hasReport = job => hasCsv(job) || job.status === 'waiting';
const maxDatasetSize = 10 * 1024 ** 3;
const format = new Intl.DateTimeFormat('vi-VN', { dateStyle:'short', timeStyle:'short' });
const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const chip = (text, cls = '') => '<span class="chip ' + cls + '">' + esc(text) + '</span>';
const status = job => chip(job.status === 'processing'
  ? (job.progress == null ? 'Trong hàng xử lý' : 'Đang xử lý · ' + job.progress + '%')
  : label[job.status], ['waiting','failed'].includes(job.status) ? 'warning' : job.status === 'review' ? 'review' : '');
const formatSize = bytes => bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(2) + ' GiB'
  : bytes >= 1024 ** 2 ? (bytes / 1024 ** 2).toFixed(1) + ' MiB'
    : Math.ceil(bytes / 1024) + ' KiB';
const empty = text => '<div class="empty">' + esc(text) + '</div>';
const textFile = async file => {
  if (file.size > 200000) throw Error('Mỗi file CSV tối đa 200 KB.');
  if (!/\.csv$/i.test(file.name)) throw Error('Hãy chọn file có đuôi .csv.');
  return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
};
const sample = async name => {
  const r = await fetch('/samples/' + name);
  if (!r.ok) throw Error('Chưa tải được file mẫu.');
  return r.text();
};
async function api(path, body) {
  const r = await fetch('/api/' + path, body === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(Error(data.error ?? 'Yêu cầu chưa hoàn tất. Hãy thử lại.'), {status:r.status});
  return data;
}
const metric = (n, label) => '<div class="metric"><b>' + esc(n) + '</b><span>' + esc(label) + '</span></div>';
const metrics = (...cells) => '<div class="metric-grid">' + cells.map(x => metric(...x)).join('') + '</div>';
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => { $('toast').hidden = true; }, 4200);
}
function showStatus(id, message, error = false) {
  const el = $(id);
  if (el) { el.textContent = message; el.classList.toggle('error', error); }
}
function openDialog(title, html) {
  $('dialog-title').textContent = title;
  $('dialog-body').innerHTML = html;
  if (!dialog.open) dialog.showModal();
}
function table(headers, contents) {
  return '<div class="table-scroll"><table><thead><tr>' + headers.map(x => '<th scope="col">' + esc(x) + '</th>').join('') +
    '</tr></thead><tbody>' + contents.map(row => '<tr>' + row.map(x => '<td>' + x + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}
const link = (url, title, tone = 'neutral') => '<a class="button ' + tone + '" href="' + esc(url) + '">' + esc(title) + '</a>';
const jobUrl = (job, kind) => '/api/jobs/' + job.id + '/' + kind + view;
const detailButton = job => '<button class="button neutral" data-job="' + esc(job.id) + '">Chi tiết</button>';
function showNotice() {
  const list = page.state?.notices ?? [];
  openDialog('Thông báo', list.length ? list.map(n =>
    '<button class="notice ' + (n.tone === 'warning' ? 'warning' : '') + '" data-job="' + esc(n.jobId) + '"><b>' +
    esc(n.title) + '</b>' + esc(n.message) + '<small>' + esc(format.format(new Date(n.time))) + '</small></button>').join('')
    : empty('Chưa có thông báo.'));
  if (list[0]) {
    try { localStorage.setItem('datarefine-notices-' + adminPage, list[0].id); } catch {}
    noticeCount();
  }
}
function noticeCount() {
  const list = page.state?.notices ?? [];
  let seen;
  try { seen = localStorage.getItem('datarefine-notices-' + adminPage); } catch {}
  const index = list.findIndex(n => n.id === seen);
  const count = index < 0 ? list.length : index;
  $('notice-count').textContent = count > 99 ? '99+' : count;
  $('notice-count').hidden = count === 0;
}
function history(jobs) {
  if (!jobs.length) return empty('Chưa có file. Chọn một hoặc nhiều file dữ liệu hoặc dùng file mẫu để thử.');
  return table(['Tên file', 'Trạng thái', 'Ô trống', 'Còn cần kiểm tra', 'Thao tác'], jobs.map(j => [
    '<span class="file-name">' + esc(j.name) + '</span><div class="muted">' + esc(format.format(new Date(j.created))) +
      (j.format ? ' · ' + esc(j.format) + ' · ' + formatSize(j.bytes) : '') +
      (j.profile ? ' · ' + esc(j.profile) + ' v' + esc(j.version) : '') + '</div>',
    status(j), esc(j.stats.missing), esc(j.stats.unresolved),
    '<div class="file-actions">' + detailButton(j) + (hasCsv(j) ? link(jobUrl(j, 'csv'), 'Tải CSV', 'soft') : '') + '</div>'
  ]));
}
function workspace() {
  const tiles = after => '<div class="matrix">' + Array.from({length:16}, (_, i) =>
    '<i' + ([6,9,14].includes(i) ? ' class="' + (after ? 'fixed' : 'blank') + '"' : '') + '></i>').join('') + '</div>';
  main.innerHTML = '<section class="hero"><div class="hero-copy"><h1>Làm sạch dữ liệu bảng</h1><p>Tải file lên để tự động xử lý dữ liệu, xem từng thay đổi và tải về bản kết quả.</p></div>' +
    '<div class="hero-visual" aria-hidden="true"><div class="flow">' + tiles(false) + '<span class="flow-arrow">→</span>' + tiles(true) + '</div></div></section>' +
    '<div class="grid"><section class="panel"><div class="section-top"><div><h2>Tải dataset lên</h2><p>File thuộc dạng đã hỗ trợ sẽ được xử lý tự động.</p></div></div>' +
    '<div class="upload-zone" id="drop-zone"><span class="upload-icon" aria-hidden="true">↑</span><h3>Kéo và thả một hoặc nhiều file</h3><p>CSV, TSV, TXT, JSONL, NDJSON · UTF-8 · Tối đa 10 GiB mỗi file</p>' +
    '<input type="file" accept=".csv,.tsv,.txt,.jsonl,.ndjson" id="file" multiple hidden><button type="button" class="button" id="pick-file">Chọn file dữ liệu</button></div>' +
    '<div class="samples"><span>Thử với dữ liệu mẫu</span><button type="button" data-sample="ban-hang.csv">Bán hàng</button><button type="button" data-sample="kho-moi.csv">Kho hàng</button></div>' +
    '<progress id="upload-progress" class="upload-progress" max="100" aria-label="Tiến độ tải lên" hidden></progress>' +
    '<div class="status-text" id="upload-status" role="status"></div><ul class="upload-errors" id="upload-errors" hidden></ul></section>' +
    '<section class="panel"><div class="section-top"><div><h2>Tổng quan</h2><p>Trạng thái file của bạn</p></div></div><div id="summary"></div>' +
    '<div class="supported"><h3>Dạng dữ liệu đã hỗ trợ</h3><div class="row" id="profiles"></div></div></section></div>' +
    '<section class="panel history"><div class="section-top"><div><h2>Lịch sử xử lý</h2></div></div><div id="history"></div></section>';
  $('pick-file').onclick = () => $('file').click();
  $('file').onchange = () => {
    const chosen = [...$('file').files];
    if (chosen.length) void uploadBatch(chosen);
    $('file').value = '';
  };
  const zone = $('drop-zone');
  zone.ondragover = event => { event.preventDefault(); zone.classList.add('drag'); };
  zone.ondragleave = () => zone.classList.remove('drag');
  zone.ondrop = event => {
    event.preventDefault();
    zone.classList.remove('drag');
    const chosen = [...event.dataTransfer.files];
    if (chosen.length) void uploadBatch(chosen);
  };
}
function sendDataset(file, onProgress, endpoint = '/api/jobs/upload') {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', endpoint + '?' + new URLSearchParams({ name:file.name }));
    request.setRequestHeader('Content-Type','application/octet-stream');
    request.responseType = 'json';
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.floor(event.loaded * 100 / event.total));
    };
    request.onload = () => request.status === 202 ? resolve(request.response)
      : reject(Error(request.response?.error ?? 'Không tải được file.'));
    request.onerror = () => reject(Error('Kết nối bị gián đoạn.'));
    request.onabort = () => reject(Error('Quá trình tải đã dừng.'));
    request.send(file);
  });
}
async function uploadBatch(files) {
  if (page.busy || !files.length) return;
  page.busy = true;
  const picker = $('pick-file'), bar = $('upload-progress'), errors = $('upload-errors');
  picker.disabled = true;
  bar.hidden = false;
  errors.replaceChildren();
  errors.hidden = true;
  let accepted = 0;
  try {
    // Establish the session before the first upload so results stay with this browser.
    await refresh();
    for (const [i, file] of files.entries()) {
      bar.value = 0;
      showStatus('upload-status', 'Đang tải ' + (i + 1) + '/' + files.length + ' · ' + file.name);
      try {
        if (!/\.(csv|tsv|txt|jsonl|ndjson)$/i.test(file.name)) throw Error('Định dạng chưa được hỗ trợ.');
        if (!file.size || file.size > maxDatasetSize) throw Error('File phải có dữ liệu và tối đa 10 GiB.');
        await sendDataset(file, percent => { bar.value = percent; });
        accepted++;
      } catch (error) {
        const row = document.createElement('li');
        row.textContent = file.name + ' · ' + error.message;
        errors.append(row);
        errors.hidden = false;
      }
    }
    await refresh();
    showStatus('upload-status', 'Đã nhận ' + accepted + '/' + files.length + ' file. Theo dõi kết quả trong lịch sử.', accepted === 0);
  } catch (error) {
    showStatus('upload-status', error.message, true);
  } finally {
    page.busy = false;
    bar.hidden = true;
    picker.disabled = false;
  }
}
function login() {
  page.active = false;
  page.state = null;
  noticeCount();
  main.innerHTML = '<section class="panel login"><h1>Quản trị dữ liệu</h1><p>Nhập mã quản trị để xem yêu cầu và huấn luyện mô hình.</p>' +
    '<form id="login-form" class="train-form"><label class="field">Mã quản trị<input id="code" type="password" required autocomplete="current-password"></label>' +
    '<div><button class="button">Đăng nhập</button></div><div class="status-text" id="login-status" role="status"></div></form></section>';
  $('login-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try { await api('admin/login', {code:$('code').value.trim()}); admin(); await refresh(); }
    catch (e) { showStatus('login-status', e.message, true); }
    finally { button.disabled = false; }
  };
}
function admin() {
  page.active = true;
  main.innerHTML = '<div class="page-title"><div><h1>Quản trị dữ liệu</h1><p>Xem các file cần hỗ trợ và kích hoạt mô hình cho dạng dữ liệu mới.</p></div><button class="button neutral" id="logout">Đăng xuất</button></div>' +
    '<div class="grid"><div class="sublist"><section class="panel"><div class="section-top"><div><h2>Hàng chờ xử lý</h2><p>File chưa được hỗ trợ hoặc còn lỗi cần kiểm tra</p></div></div><div class="sublist" id="queue"></div></section>' +
    '<section class="panel"><div class="section-top"><div><h2>Mô hình đang dùng</h2><p>Mô hình KNN cho từng cấu trúc CSV</p></div></div><div class="sublist" id="models"></div></section></div>' +
    '<section class="panel"><div class="section-top"><div><h2>Huấn luyện mô hình</h2><p>Dùng các mẫu có giá trị đã được xác minh.</p></div></div>' +
    '<form id="split-form" class="train-form"><label class="field">Dataset để tự chia train / validation / test' +
    '<input id="split-file" type="file" required accept=".csv,.tsv,.txt,.jsonl,.ndjson"><span class="muted">Một file UTF-8, tối đa 10 GiB.</span></label>' +
    '<div class="row"><button class="button" id="split-submit">Tải lên và chia 70 / 15 / 15</button></div>' +
    '<progress id="split-progress" class="upload-progress" max="100" aria-label="Tiến độ tải dataset" hidden></progress>' +
    '<div class="status-text" id="split-status" role="status"></div></form>' +
    '<form id="train-form" class="train-form"><label class="field">Tên dạng dữ liệu<input id="model-label" required maxlength="60" placeholder="Ví dụ: Kho hàng"></label>' +
    '<p id="selected-split" class="muted" hidden></p>' +
    '<details class="details" id="manual-training"><summary>Nhập hai file CSV nhỏ</summary>' +
    '<label class="field">CSV huấn luyện<input type="file" id="train-file" accept=".csv,text/csv"><span id="train-name" class="muted"></span></label>' +
    '<label class="field">CSV validation<input type="file" id="test-file" accept=".csv,text/csv"><span id="test-name" class="muted"></span></label></details>' +
    '<label class="field">Cột số cần điền<select id="target" required><option value="">Chọn CSV huấn luyện trước</option></select></label>' +
    '<fieldset id="feature-box" hidden><legend>Cột dùng để ước lượng</legend><div id="features" class="check-list"></div></fieldset>' +
    '<div class="row"><button class="button" id="train-button" disabled>Huấn luyện và đánh giá</button><button class="button neutral" id="sample-model" type="button">Dùng mẫu kho hàng</button></div>' +
    '<div class="status-text" id="train-status" role="status"></div></form>' +
    '<details class="details"><summary>Yêu cầu dữ liệu và tiêu chí kích hoạt</summary><p>Cần ít nhất 12 dòng train và 5 dòng validation có giá trị thật. Nếu dùng dataset tự chia, tập test cũng cần ít nhất 5 dòng hợp lệ. MAE phải bằng hoặc thấp hơn phương pháp trung vị và mô hình đang dùng (nếu có). Mô hình phải ước lượng được ít nhất 60% mẫu validation.</p>' +
    '<p><a href="/samples/kho-huan-luyen.csv">Tải CSV huấn luyện mẫu</a> · <a href="/samples/kho-kiem-thu.csv">Tải CSV kiểm thử mẫu</a></p></details></section></div>' +
    '<section class="panel gap"><div class="section-top"><div><h2>Dataset huấn luyện đã lưu</h2><p>Tải từng tập CSV hoặc chọn dataset để huấn luyện.</p></div></div>' +
    '<div class="sublist" id="split-library"></div><div class="sublist gap" id="training-library"></div></section>' +
    '<section class="panel gap"><div class="section-top"><div><h2>Kết quả huấn luyện</h2><p>Kích hoạt sẽ tự chạy lại file đang chờ có cùng cấu trúc.</p></div></div><div class="sublist" id="drafts"></div></section>';
  $('logout').onclick = async () => {
    try { await api('admin/logout', {}); page.training = ''; page.validation = ''; page.split = null; login(); }
    catch (e) { toast(e.message); }
  };
  $('split-form').onsubmit = async event => {
    event.preventDefault();
    const file = $('split-file').files[0];
    if (!file || !file.size || file.size > maxDatasetSize || !/\.(csv|tsv|txt|jsonl|ndjson)$/i.test(file.name)) {
      showStatus('split-status','Chọn một dataset CSV, TSV, TXT, JSONL hoặc NDJSON từ 1 byte đến 10 GiB.',true);
      return;
    }
    const button = $('split-submit'), bar = $('split-progress');
    button.disabled = true;
    bar.hidden = false;
    bar.value = 0;
    showStatus('split-status','Đang tải ' + file.name + '…');
    try {
      await sendDataset(file,percent => { bar.value = percent; },'/api/admin/training-upload');
      $('split-file').value = '';
      await refresh();
      showStatus('split-status','Đã nhận file. Theo dõi tiến độ ở Dataset huấn luyện đã lưu.');
    } catch (error) { showStatus('split-status',error.message,true); }
    finally { button.disabled = false; bar.hidden = true; }
  };
  $('train-file').onchange = async () => {
    const file = $('train-file').files[0];
    if (file) await setupTraining(() => textFile(file), file.name);
  };
  $('test-file').onchange = async () => {
    const file = $('test-file').files[0];
    if (file) await setupValidation(() => textFile(file), file.name);
  };
  $('target').onchange = updateFeatures;
  $('sample-model').onclick = async () => {
    $('sample-model').disabled = true;
    try {
      $('model-label').value = 'Kho hàng';
      $('train-file').value = '';
      $('test-file').value = '';
      await setupTraining(() => sample('kho-huan-luyen.csv'), 'kho-huan-luyen.csv', 'ton_kho');
      await setupValidation(() => sample('kho-kiem-thu.csv'), 'kho-kiem-thu.csv');
    } finally { $('sample-model').disabled = false; }
  };
  $('train-form').onsubmit = async event => {
    event.preventDefault();
    const features = [...$('features').querySelectorAll('input:checked:not(:disabled)')].map(el => el.value);
    if (!features.length) { showStatus('train-status', 'Chọn ít nhất một cột đầu vào.', true); return; }
    $('train-button').disabled = true;
    showStatus('train-status', 'Đang huấn luyện và đánh giá…');
    try {
      const source = page.split ? { splitId:page.split } : { training:page.training, validation:page.validation };
      const draft = await api('admin/train', {label:$('model-label').value, target:$('target').value, features,...source});
      await refresh();
      showStatus('train-status', draft.metrics.eligible ? 'Đánh giá hoàn tất. Có thể kích hoạt ở mục Kết quả huấn luyện.' : 'Mô hình chưa đạt tiêu chí kích hoạt.');
    } catch (e) { showStatus('train-status', e.message, true); }
    finally { toggleTrain(); }
  };
}
function toggleTrain() {
  $('train-button').disabled = !((page.split || (page.training && page.validation)) && $('target').value);
}
function updateFeatures() {
  for (const input of $('features').querySelectorAll('input')) {
    const target = input.value === $('target').value;
    if (target) input.checked = false;
    else if (input.disabled) input.checked = true;
    input.disabled = target;
  }
  toggleTrain();
}
function populateTrainingColumns(headers, selected = '') {
  $('target').innerHTML = headers.map(c => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
  $('target').value = selected && headers.includes(selected) ? selected : headers.at(-1);
  $('features').innerHTML = headers.map(c => '<label><input type="checkbox" checked value="' + esc(c) + '">' + esc(c) + '</label>').join('');
  $('feature-box').hidden = false;
  updateFeatures();
}
function clearSplit() {
  page.split = null;
  $('selected-split').hidden = true;
}
async function setupTraining(read, name, selected = '') {
  clearSplit();
  page.training = '';
  toggleTrain();
  $('train-name').textContent = '';
  $('feature-box').hidden = true;
  try {
    const csv = await read();
    const result = await api('admin/headers', {csv});
    populateTrainingColumns(result.headers,selected);
    $('train-name').textContent = name;
    page.training = csv;
    showStatus('train-status', '');
  } catch (e) { showStatus('train-status', e.message, true); }
  updateFeatures();
}
async function setupValidation(read, name) {
  clearSplit();
  page.validation = '';
  $('test-name').textContent = '';
  try { page.validation = await read(); $('test-name').textContent = name; }
  catch (e) { showStatus('train-status', e.message, true); }
  toggleTrain();
}
function renderTrainingLibrary(state) {
  const groups = ['train','validation','test'];
  const imports = state.trainingImports ?? [];
  $('split-library').innerHTML = imports.length ? imports.map(item => {
    const base = '/api/admin/training-imports/' + encodeURIComponent(item.id) + '/';
    const counts = item.counts ? '<p>' + groups.map(group => esc(group) + ' ' + item.counts[group]).join(' · ') + ' bản ghi</p>' : '';
    const sampleInfo = item.sampled ? '<p>Số dòng lấy mẫu cho KNN: ' + groups.map(group =>
      esc(group) + ' ' + item.sampled[group]).join(' · ') + '</p>' : '';
    const actions = item.status === 'done' ? groups.map(group => link(base + group,'Tải ' + group)).join('') +
      '<button class="button" data-use-split="' + esc(item.id) + '">Dùng để huấn luyện</button>' : '';
    return '<article class="subitem"><div class="section-top"><div><h3>' + esc(item.name) + '</h3><p>' +
      esc(item.format) + ' · ' + formatSize(item.bytes) + '</p></div>' +
      (item.status === 'done' ? chip('Đã chia') : status(item)) + '</div>' +
      counts + sampleInfo + (item.error ? '<p class="error">' + esc(item.error) + '</p>' : '') +
      '<div class="row">' + link(base + 'original','Tải file gốc') + actions + '</div></article>';
  }).join('') : empty('Chưa có dataset nào được chia.');
  $('training-library').innerHTML = (state.trainingSets ?? []).map(set =>
    '<article class="subitem"><h3>' + esc(set.label) + '</h3><p>CSV lưu từ lần huấn luyện · ' +
    set.trainRows + ' dòng train · ' + set.validationRows + ' dòng validation</p>' +
    '<div class="row"><button class="button neutral" data-use-archive="' + esc(set.id) + '">Nạp lại vào form</button></div></article>'
  ).join('');
}

function renderAdmin(state) {
  renderTrainingLibrary(state);
  const queue = state.jobs.filter(j => j.status === 'waiting' || j.status === 'review');
  $('queue').innerHTML = queue.length ? queue.map(j => '<article class="subitem"><h3>' + esc(j.name) + '</h3><p>' +
    esc(j.headers.join(' · ')) + '</p><div class="row">' + status(j) + detailButton(j) + '</div></article>').join('') : empty('Không có file nào cần admin xử lý.');
  $('models').innerHTML = state.profiles.map(p => '<article class="subitem"><div class="section-top"><h3>' + esc(p.label) + '</h3>' +
    chip('v' + p.version) + '</div><p>Điền cột <b>' + esc(p.target) + '</b> · MAE ' + esc(p.metrics.mae) + ' · ' +
    esc(p.metrics.coverage) + '% mẫu validation được ước lượng</p><p>' + esc(p.headers.join(' · ')) + '</p></article>').join('');
  $('drafts').innerHTML = state.drafts.length ? state.drafts.map(p => '<article class="subitem"><div class="section-top"><div><h3>' +
    esc(p.label) + ' · v' + esc(p.version) + '</h3><p>' + p.metrics.train + ' mẫu train · ' + p.metrics.test + ' mẫu validation</p></div>' +
    chip(p.metrics.eligible ? 'Đạt tiêu chí' : 'Chưa đạt', p.metrics.eligible ? '' : 'warning') + '</div>' +
    metrics([p.metrics.mae,'MAE mô hình'], [p.metrics.baseline,'MAE trung vị'], [p.metrics.coverage + '%','Tỷ lệ ước lượng']) +
    (p.metrics.previous === null ? '' : '<p>MAE mô hình hiện tại trên cùng tập validation: ' + esc(p.metrics.previous) + '</p>') +
    (p.metrics.holdout ? '<p><b>Test riêng:</b> MAE ' + esc(p.metrics.holdout.mae) + ' · ' +
      esc(p.metrics.holdout.coverage) + '% ước lượng được · ' + esc(p.metrics.holdout.rows) + ' bản ghi</p>' : '') +
    '<div class="row"><button class="button" data-activate="' + esc(p.id) + '"' + (p.metrics.eligible ? '' : ' disabled') + '>Kích hoạt</button></div></article>').join('') : empty('Chưa có kết quả huấn luyện mới.');
}
function renderUser(state) {
  const { jobs, profiles } = state;
  $('summary').innerHTML = metrics([jobs.length,'File đã tải'], [jobs.filter(hasCsv).length,'Có kết quả'],
    [jobs.filter(j => j.status === 'waiting').length,'Chờ hỗ trợ']);
  $('profiles').innerHTML = profiles.map(p => chip(p.label + ' · v' + p.version)).join('');
  $('history').innerHTML = history(jobs);
}
async function refresh() {
  const state = await api('state' + view);
  const changed = JSON.stringify(state) !== JSON.stringify(page.state);
  page.state = state;
  if (changed) {
    if (adminPage) renderAdmin(state);
    else renderUser(state);
    noticeCount();
  }
}
async function jobDetails(id) {
  try {
    const j = await api('jobs/' + id + view);
    const unresolved = j.stats.unresolved;
    const summary = metrics([j.stats.rows,'Bản ghi gốc'], [j.stats.missing,'Ô trống'], [unresolved,'Vấn đề còn tồn tại']);
    const rows = j.issues.map(i => [esc(i.row), esc(i.column), esc(i.kind), esc(i.action),
      esc(i.value === '' ? '—' : i.value)]);
    const actions = (hasCsv(j) ? link(jobUrl(j, 'csv'), 'Tải CSV đã xử lý', '') : '') +
      (hasReport(j) ? link(jobUrl(j, 'report'), 'Tải báo cáo') : '') + link(jobUrl(j, 'original'), 'Tải file gốc') +
      (adminPage && j.status === 'review' ? '<button class="button neutral" data-resolve="' + esc(j.id) + '">Đánh dấu đã xem</button>' : '');
    openDialog(j.name, '<section><div class="row section-top">' + status(j) + (j.profile ? chip(j.profile + ' · v' + j.version) : '') +
      '</div>' + summary + '<p class="details">Đã ước lượng ' + j.stats.filled + ' ô · Đã loại ' + j.stats.duplicates + ' dòng trùng</p>' +
      (j.status === 'waiting' ? '<p class="details">File sẽ tự chạy lại khi admin kích hoạt mô hình phù hợp.</p>' : '') +
      (j.error ? '<p class="details error">' + esc(j.error) + '</p>' : '') +
      '<div class="row gap">' + actions + '</div></section><section><h3>Chi tiết thay đổi và lỗi</h3>' +
      (rows.length ? table(['Bản ghi','Cột','Loại','Xử lý','Giá trị mới'], rows)
        : empty(hasReport(j) ? 'Không phát hiện thay đổi hoặc lỗi.' : 'Báo cáo chưa có.')) +
      (j.issueCount > rows.length ? '<p class="details">Tải báo cáo CSV để xem toàn bộ ' + j.issueCount + ' mục.</p>' : '') +
      '</section>' + (j.preview.length ? '<section><h3>Xem trước kết quả</h3>' + table(j.headers, j.preview.map(row => row.map(esc))) + '</section>' : ''));
  } catch (e) { toast(e.message); }
}

document.addEventListener('click', async event => {
  const btn = event.target.closest('button[data-job],button[data-sample],button[data-activate],button[data-resolve],button[data-use-split],button[data-use-archive]');
  if (!btn) return;
  if (btn.dataset.job) return jobDetails(btn.dataset.job);
  if (btn.dataset.sample) {
    if (page.busy) return;
    try {
      const name = btn.dataset.sample;
      await uploadBatch([new File([await sample(name)], name)]);
    } catch (error) { toast(error.message); }
    return;
  }
  if (btn.dataset.useSplit) {
    const item = page.state.trainingImports.find(record => record.id === btn.dataset.useSplit && record.status === 'done');
    if (!item) return;
    page.split = item.id;
    page.training = '';
    page.validation = '';
    $('train-file').value = '';
    $('test-file').value = '';
    $('train-name').textContent = '';
    $('test-name').textContent = '';
    $('manual-training').open = false;
    $('model-label').value = item.name.replace(/\.[^.]+$/,'').slice(0,60);
    $('selected-split').textContent = 'Đang dùng dataset đã chia: ' + item.name;
    $('selected-split').hidden = false;
    populateTrainingColumns(item.headers);
    showStatus('train-status','Chọn cột số cần điền và các cột đầu vào.');
    $('target').focus();
    return;
  }
  if (btn.dataset.useArchive) {
    btn.disabled = true;
    try {
      const saved = await api('admin/training-sets/' + encodeURIComponent(btn.dataset.useArchive));
      $('manual-training').open = true;
      $('train-file').value = '';
      $('test-file').value = '';
      $('model-label').value = saved.label;
      await setupTraining(() => saved.training,'CSV train đã lưu');
      await setupValidation(() => saved.validation,'CSV validation đã lưu');
      $('target').focus();
    } catch (error) { toast(error.message); }
    finally { btn.disabled = false; }
    return;
  }
  btn.disabled = true;
  try {
    if (btn.dataset.activate) {
      const r = await api('admin/activate', {id:btn.dataset.activate});
      await refresh();
      toast('Đã kích hoạt ' + r.profile.label + '. ' + r.reprocessed + ' file sẽ được xử lý lại.');
    } else {
      await api('admin/resolve', {id:btn.dataset.resolve});
      await refresh();
      await jobDetails(btn.dataset.resolve);
      toast('Đã ghi nhận admin xem báo cáo.');
    }
  } catch (e) { toast(e.message); btn.disabled = false; }
});
$('dialog-close').onclick = () => dialog.close();
$('notices-button').onclick = () => showNotice();
$(adminPage ? 'admin-link' : 'workspace-link').setAttribute('aria-current','page');

async function init() {
  if (adminPage) {
    try { await api('state?view=admin'); admin(); await refresh(); }
    catch (e) { if (e.status === 401) login(); else main.textContent = e.message; }
  } else {
    workspace();
    try { await refresh(); }
    catch (e) { showStatus('upload-status', e.message, true); }
  }
}
await init();
setInterval(async () => {
  if (document.hidden || (adminPage && !page.active)) return;
  try { await refresh(); }
  catch (e) { if (adminPage && e.status === 401) login(); }
}, 3000);
