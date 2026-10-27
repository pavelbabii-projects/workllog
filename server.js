const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH || path.join(dataDir, 'work-time.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;')
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    task TEXT NOT NULL,
    started_at TEXT NOT NULL,
    stopped_at TEXT,
    duration_seconds INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_timer_per_employee
    ON time_entries(employee_id) WHERE stopped_at IS NULL;
`);

const getEmployee = db.prepare('SELECT id, name FROM employees WHERE id = ?');
const getActiveTimer = db.prepare(`SELECT t.*, e.name AS employee_name FROM time_entries t
  JOIN employees e ON e.id = t.employee_id WHERE t.employee_id = ? AND t.stopped_at IS NULL`);
const toIso = (value) => new Date(value).toISOString();

// node:sqlite reports constraint failures differently from better-sqlite3.
function isUniqueConstraint(error, tableColumn) {
  return error?.errcode === 2067 ||
    error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (typeof error?.message === 'string' && error.message.includes(`UNIQUE constraint failed: ${tableColumn}`));
}

app.get('/api/employees', (_req, res) => {
  res.json(db.prepare('SELECT id, name, created_at FROM employees ORDER BY name').all());
});

app.post('/api/employees', (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Введите имя сотрудника.' });
  if (name.length > 100) return res.status(400).json({ error: 'Имя должно быть не длиннее 100 символов.' });
  try {
    const result = db.prepare('INSERT INTO employees (name) VALUES (?)').run(name);
    res.status(201).json(getEmployee.get(result.lastInsertRowid));
  } catch (error) {
    if (isUniqueConstraint(error, 'employees.name')) {
      return res.status(409).json({ error: 'Сотрудник с таким именем уже существует.' });
    }
    throw error;
  }
});

app.get('/api/timer/active', (_req, res) => {
  const rows = db.prepare(`SELECT t.id, t.employee_id, e.name AS employee_name, t.task, t.started_at
    FROM time_entries t JOIN employees e ON e.id = t.employee_id
    WHERE t.stopped_at IS NULL ORDER BY t.started_at`).all();
  res.json(rows);
});

app.post('/api/timer/start', (req, res) => {
  const employeeId = Number(req.body.employeeId);
  const task = typeof req.body.task === 'string' ? req.body.task.trim() : '';
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'Выберите сотрудника.' });
  if (!task) return res.status(400).json({ error: 'Опишите задачу перед запуском таймера.' });
  if (task.length > 500) return res.status(400).json({ error: 'Описание задачи должно быть не длиннее 500 символов.' });
  if (!getEmployee.get(employeeId)) return res.status(404).json({ error: 'Сотрудник не найден.' });
  if (getActiveTimer.get(employeeId)) return res.status(409).json({ error: 'У этого сотрудника уже запущен таймер. Сначала остановите его.' });
  const startedAt = new Date().toISOString();
  try {
    const result = db.prepare(`INSERT INTO time_entries (employee_id, task, started_at)
      VALUES (?, ?, ?)`).run(employeeId, task, startedAt);
    res.status(201).json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(result.lastInsertRowid));
  } catch (error) {
    if (isUniqueConstraint(error, 'time_entries.employee_id')) {
      return res.status(409).json({ error: 'У этого сотрудника уже запущен таймер. Сначала остановите его.' });
    }
    throw error;
  }
});

app.post('/api/timer/:id/stop', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Некорректный идентификатор таймера.' });
  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Запись не найдена.' });
  if (entry.stopped_at) return res.status(409).json({ error: 'Этот таймер уже остановлен.' });
  const stoppedAt = new Date().toISOString();
  const durationSeconds = Math.max(0, Math.floor((Date.parse(stoppedAt) - Date.parse(entry.started_at)) / 1000));
  db.prepare('UPDATE time_entries SET stopped_at = ?, duration_seconds = ? WHERE id = ? AND stopped_at IS NULL')
    .run(stoppedAt, durationSeconds, id);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id));
});

app.get('/api/report', (req, res) => {
  const { from, to, employeeId } = req.query;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Укажите период датами в формате YYYY-MM-DD.' });
  }
  if (from > to) return res.status(400).json({ error: 'Дата начала периода не может быть позже даты окончания.' });
  const params = [`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`];
  let employeeClause = '';
  if (employeeId && employeeId !== 'all') {
    const parsedId = Number(employeeId);
    if (!Number.isInteger(parsedId) || parsedId < 1) return res.status(400).json({ error: 'Некорректный сотрудник.' });
    employeeClause = ' AND t.employee_id = ?';
    params.push(parsedId);
  }
  // Include records whose start timestamp falls inside the selected UTC date range.
  const entries = db.prepare(`SELECT t.id, t.employee_id, e.name AS employee_name, t.task,
      t.started_at, t.stopped_at, t.duration_seconds
    FROM time_entries t JOIN employees e ON e.id = t.employee_id
    WHERE t.started_at >= ? AND t.started_at <= ?${employeeClause}
    ORDER BY t.started_at DESC`).all(...params);
  const now = Date.now();
  const totalsByEmployee = new Map();
  const normalizedEntries = entries.map((entry) => {
    const seconds = entry.duration_seconds ?? Math.max(0, Math.floor((now - Date.parse(entry.started_at)) / 1000));
    const current = totalsByEmployee.get(entry.employee_id) || { employeeId: entry.employee_id, employeeName: entry.employee_name, totalSeconds: 0 };
    current.totalSeconds += seconds;
    totalsByEmployee.set(entry.employee_id, current);
    return { ...entry, elapsedSeconds: seconds };
  });
  res.json({ from, to, entries: normalizedEntries, totals: [...totalsByEmployee.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName)), totalSeconds: normalizedEntries.reduce((sum, entry) => sum + entry.elapsedSeconds, 0) });
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`Work Time Tracker доступен: http://localhost:${port}`));
}
module.exports = { app, db };
