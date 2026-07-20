'use strict';

const { DatabaseSync } = require('node:sqlite');

let savepointCounter = 0;

class Database {
  constructor(filename, options = {}) {
    this._db = new DatabaseSync(filename, {
      readOnly: Boolean(options.readonly || options.readOnly),
      timeout: Math.max(0, Number(options.timeout ?? 5000) || 5000),
    });
  }

  prepare(sql) {
    return this._db.prepare(sql);
  }

  exec(sql) {
    return this._db.exec(sql);
  }

  close() {
    return this._db.close();
  }

  pragma(expression) {
    const sql = 'PRAGMA ' + String(expression || '').trim();
    if (sql === 'PRAGMA ') throw new Error('pragma expression is required');
    return this._db.prepare(sql).all();
  }

  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction requires a function');
    return (...args) => {
      const nested = Boolean(this._db.isTransaction);
      const savepoint = 'rifugio_sp_' + (++savepointCounter);
      this._db.exec(nested ? 'SAVEPOINT ' + savepoint : 'BEGIN');
      try {
        const result = fn(...args);
        this._db.exec(nested ? 'RELEASE SAVEPOINT ' + savepoint : 'COMMIT');
        return result;
      } catch (error) {
        try {
          if (nested) {
            this._db.exec('ROLLBACK TO SAVEPOINT ' + savepoint);
            this._db.exec('RELEASE SAVEPOINT ' + savepoint);
          } else {
            this._db.exec('ROLLBACK');
          }
        } catch (_) {}
        throw error;
      }
    };
  }
}

module.exports = Database;
