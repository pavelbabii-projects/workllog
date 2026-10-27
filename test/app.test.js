const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-time-test-'));
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');
const { app, db } = require('../server');
let server;
let baseUrl;
let employeeId;

async function request(url, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('создание сотрудника и проверка пустого имени', async () => {
  const empty = await request('/api/employees', { method: 'POST', body: JSON.stringify({ name: '   ' }) });
  assert.equal(empty.status, 400);
  const created = await request('/api/employees', { method: 'POST', body: JSON.stringify({ name: 'Тестовый сотрудник' }) });
  assert.equal(created.status, 201);
  employeeId = created.body.id;
  assert.equal(created.body.name, 'Тестовый сотрудник');
  const duplicate = await request('/api/employees', { method: 'POST', body: JSON.stringify({ name: 'Тестовый сотрудник' }) });
  assert.equal(duplicate.status, 409);
});

test('запуск таймера, защита от повторного запуска и остановка', async () => {
  const invalid = await request('/api/timer/start', { method: 'POST', body: JSON.stringify({ employeeId, task: '' }) });
  assert.equal(invalid.status, 400);
  const started = await request('/api/timer/start', { method: 'POST', body: JSON.stringify({ employeeId, task: 'Проверка интерфейса' }) });
  assert.equal(started.status, 201);
  const duplicate = await request('/api/timer/start', { method: 'POST', body: JSON.stringify({ employeeId, task: 'Вторая задача' }) });
  assert.equal(duplicate.status, 409);
  const active = await request('/api/timer/active');
  assert.equal(active.body.length, 1);
  const stopped = await request(`/api/timer/${started.body.id}/stop`, { method: 'POST', body: '{}' });
  assert.equal(stopped.status, 200);
  assert.ok(stopped.body.stopped_at);
  assert.ok(stopped.body.duration_seconds >= 0);
  const stopAgain = await request(`/api/timer/${started.body.id}/stop`, { method: 'POST', body: '{}' });
  assert.equal(stopAgain.status, 409);
});

test('пустой отчет возвращает пустые записи и нулевую сумму', async () => {
  const response = await request('/api/report?from=2000-01-01&to=2000-01-02&employeeId=all');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.entries, []);
  assert.deepEqual(response.body.totals, []);
  assert.equal(response.body.totalSeconds, 0);
});

test('записи сохраняются в SQLite после повторного открытия файла базы', () => {
  const secondConnection = new DatabaseSync(process.env.DB_PATH);
  const employee = secondConnection.prepare('SELECT name FROM employees WHERE id = ?').get(employeeId);
  const entry = secondConnection.prepare('SELECT task, stopped_at FROM time_entries WHERE employee_id = ?').get(employeeId);
  assert.equal(employee.name, 'Тестовый сотрудник');
  assert.equal(entry.task, 'Проверка интерфейса');
  assert.ok(entry.stopped_at);
  secondConnection.close();
});
