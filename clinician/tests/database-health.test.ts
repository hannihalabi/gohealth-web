import assert from "node:assert/strict";
import test from "node:test";
import { assessHealth, cacheHitRatio, formatBytes, formatDuration, type DatabaseHealth } from "../src/lib/database-health";

const base: DatabaseHealth = {
  checkedAt: "2026-11-21T20:00:00Z", version: "17.4", startedAt: "2026-11-01T00:00:00Z",
  connections: { used: 10, max: 60, active: 1, idle: 9, idleInTransaction: 0, longestTransactionSeconds: 2 },
  database: { sizeBytes: 50e6, tables: 30, commits: 5000, rollbacks: 10, blocksRead: 100, blocksHit: 99900, deadlocks: 0, tempBytes: 0, statsReset: null },
  topTables: [{ name: "public.a", size_bytes: 1, live_rows: 10, dead_rows: 0 }],
  storage: { objects: 1, bytes: 100 }, users: 3, lastMigration: "20261121",
};

test("a quiet database is healthy", () => {
  assert.equal(assessHealth(base).level, "ok");
});
test("connection pressure raises warnings and then risk", () => {
  assert.equal(assessHealth({ ...base, connections: { ...base.connections, used: 45 } }).level, "warn");
  assert.equal(assessHealth({ ...base, connections: { ...base.connections, used: 58 } }).level, "bad");
});
test("cache ratio is ignored until there is enough traffic, then judged", () => {
  assert.equal(cacheHitRatio({ ...base, database: { ...base.database, blocksHit: 10, blocksRead: 10 } }), null);
  assert.equal(assessHealth({ ...base, database: { ...base.database, blocksHit: 800, blocksRead: 700 } }).level, "bad");
  assert.equal(assessHealth({ ...base, database: { ...base.database, blocksHit: 9300, blocksRead: 700 } }).level, "warn");
});
test("long transactions, deadlocks and dead rows are reported", () => {
  assert.equal(assessHealth({ ...base, connections: { ...base.connections, longestTransactionSeconds: 400 } }).level, "warn");
  assert.equal(assessHealth({ ...base, connections: { ...base.connections, longestTransactionSeconds: 4000 } }).level, "bad");
  assert.equal(assessHealth({ ...base, database: { ...base.database, deadlocks: 2 } }).level, "warn");
  assert.equal(assessHealth({ ...base, topTables: [{ name: "x", size_bytes: 1, live_rows: 2000, dead_rows: 1000 }] }).level, "warn");
});
test("sizes and durations read naturally", () => {
  assert.equal(formatBytes(512 * 1024), "512 kB");
  assert.equal(formatBytes(42.5 * 1024 ** 2), "42.5 MB");
  assert.equal(formatDuration(30), "30 s");
  assert.equal(formatDuration(3 * 86400), "3 dygn");
});
