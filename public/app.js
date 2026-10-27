const $ = (selector) => document.querySelector(selector);
const state = { employees: [], active: [], ticker: null };

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить запрос.');
  return payload;
}
function initials(name) { return name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase(); }
function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours > 0 ? `${hours} ч ${String(minutes).padStart(2, '0')} мин` : `${minutes} мин ${String(secs).padStart(2, '0')} сек`;
}
function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return [Math.floor(safe / 3600), Math.floor((safe % 3600) / 60), safe % 60].map((n) => String(n).padStart(2, '0')).join(':');
}
function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
function setMessage(selector, message = '') { $(selector).textContent = message; }
function setTab(tab) {
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `panel-${tab}`));
}
function renderEmployeeSelects() {
  const timerSelect = $('#timer-employee');
  const reportSelect = $('#report-employee');
  const currentTimer = timerSelect.value;
  const currentReport = reportSelect.value || 'all';
  timerSelect.innerHTML = '<option value="">Выберите сотрудника</option>';
  reportSelect.innerHTML = '<option value="all">Все сотрудники</option>';
  state.employees.forEach((employee) => {
    const option = new Option(employee.name, employee.id);
    timerSelect.add(option);
    reportSelect.add(new Option(employee.name, employee.id));
  });
  if (state.employees.some((employee) => String(employee.id) === currentTimer)) timerSelect.value = currentTimer;
  if (currentReport === 'all' || state.employees.some((employee) => String(employee.id) === currentReport)) reportSelect.value = currentReport;
}
function renderEmployees() {
  $('#employee-count').textContent = state.employees.length;
  const list = $('#employee-list');
  if (!state.employees.length) {
    list.innerHTML = '<div class="empty-state"><strong>Список пока пуст</strong><p>Добавьте первого сотрудника.</p></div>';
    return;
  }
  list.innerHTML = state.employees.map((employee) => `<div class="employee-card"><span class="avatar">${escapeHtml(initials(employee.name))}</span><div><strong>${escapeHtml(employee.name)}</strong><small>Сотрудник команды · ID ${employee.id}</small></div></div>`).join('');
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function renderActive() {
  $('#active-count').textContent = state.active.length;
  const list = $('#active-list');
  if (!state.active.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">◷</span><strong>Пока нет активных таймеров</strong><p>Выберите сотрудника и начните первую задачу.</p></div>';
    return;
  }
  list.innerHTML = state.active.map((entry) => {
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(entry.started_at)) / 1000));
    return `<article class="active-card"><div><div class="active-meta"><span class="avatar">${escapeHtml(initials(entry.employee_name))}</span><p>${escapeHtml(entry.employee_name)}</p></div><h4>${escapeHtml(entry.task)}</h4><p>Начато ${escapeHtml(formatDate(entry.started_at))}</p></div><div><div class="timer-clock" data-start="${escapeHtml(entry.started_at)}">${formatClock(elapsed)}</div></div><button class="stop-button" data-stop="${entry.id}">■ &nbsp; Остановить таймер</button></article>`;
  }).join('');
}
function updateTicker() {
  document.querySelectorAll('[data-start]').forEach((element) => {
    element.textContent = formatClock(Math.max(0, Math.floor((Date.now() - Date.parse(element.dataset.start)) / 1000)));
  });
}
async function refreshActive() {
  state.active = await api('/api/timer/active');
  renderActive();
}
async function loadEmployees() {
  state.employees = await api('/api/employees');
  renderEmployeeSelects();
  renderEmployees();
}
function setDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  $('#report-from').value = localDate(start);
  $('#report-to').value = localDate(now);
}
async function loadReport() {
  const from = $('#report-from').value;
  const to = $('#report-to').value;
  const employeeId = $('#report-employee').value || 'all';
  const query = new URLSearchParams({ from, to, employeeId });
  const report = await api(`/api/report?${query}`);
  $('#report-total').textContent = formatDuration(report.totalSeconds);
  $('#hero-hours').textContent = formatDuration(report.totalSeconds);
  $('#report-count').textContent = report.entries.length;
  $('#report-people').textContent = report.totals.length;
  $('#report-period').textContent = `${from} — ${to}`;
  const rows = $('#report-rows');
  if (!report.entries.length) {
    rows.innerHTML = '<tr><td colspan="5" class="table-empty">За выбранный период записей нет.</td></tr>';
  } else {
    rows.innerHTML = report.entries.map((entry) => `<tr><td>${escapeHtml(entry.employee_name)}</td><td>${escapeHtml(entry.task)}${entry.stopped_at ? '' : ' <span class="live-dot" title="Таймер активен"></span>'}</td><td>${escapeHtml(formatDate(entry.started_at))}</td><td>${escapeHtml(formatDate(entry.stopped_at))}</td><td>${escapeHtml(formatDuration(entry.elapsedSeconds))}</td></tr>`).join('');
  }
  const totals = $('#employee-totals');
  totals.innerHTML = report.totals.length ? report.totals.map((item) => `<div class="total-row"><div class="total-person"><span class="avatar">${escapeHtml(initials(item.employeeName))}</span>${escapeHtml(item.employeeName)}</div><span class="total-time">${escapeHtml(formatDuration(item.totalSeconds))}</span></div>`).join('') : '<p class="muted">Нет данных для отображения.</p>';
}

for (const button of document.querySelectorAll('.tab')) button.addEventListener('click', () => setTab(button.dataset.tab));
$('#employee-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#employee-name');
  try {
    await api('/api/employees', { method: 'POST', body: JSON.stringify({ name: input.value }) });
    input.value = '';
    setMessage('#employee-message');
    await loadEmployees();
  } catch (error) { setMessage('#employee-message', error.message); }
});
$('#timer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/timer/start', { method: 'POST', body: JSON.stringify({ employeeId: Number($('#timer-employee').value), task: $('#timer-task').value }) });
    $('#timer-task').value = '';
    setMessage('#timer-message');
    await refreshActive();
  } catch (error) { setMessage('#timer-message', error.message); }
});
$('#active-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-stop]');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/timer/${button.dataset.stop}/stop`, { method: 'POST', body: '{}' });
    setMessage('#timer-message');
    await refreshActive();
    await loadReport();
  } catch (error) { setMessage('#timer-message', error.message); button.disabled = false; }
});
$('#report-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await loadReport(); } catch (error) { setMessage('#timer-message', error.message); }
});

(async function init() {
  setDefaultDates();
  try {
    await loadEmployees();
    await refreshActive();
    await loadReport();
    state.ticker = setInterval(updateTicker, 1000);
  } catch (error) {
    setMessage('#timer-message', `Не удалось загрузить приложение: ${error.message}`);
  }
})();
