'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('../modules/sqlite');

test('node:sqlite adapter supports prepared statements and transactions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rifugio-sqlite-'));
  const file = path.join(dir, 'test.db');
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)');
    const insert = db.prepare('INSERT INTO items (value) VALUES (?)');
    db.transaction(() => {
      insert.run('one');
      insert.run('two');
    })();
    assert.deepEqual(db.prepare('SELECT value FROM items ORDER BY id').all().map(row => row.value), ['one', 'two']);
    assert.throws(() => db.transaction(() => {
      insert.run('rolled back');
      throw new Error('stop');
    })(), /stop/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items').get().count, 2);
    db.transaction(() => {
      insert.run('three');
      try {
        db.transaction(() => { insert.run('nested rollback'); throw new Error('nested stop'); })();
      } catch (error) { assert.match(error.message, /nested stop/); }
      insert.run('four');
    })();
    assert.deepEqual(db.prepare('SELECT value FROM items ORDER BY id').all().map(row => row.value), ['one', 'two', 'three', 'four']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
