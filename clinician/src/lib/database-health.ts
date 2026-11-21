import { z } from "zod";

export const databaseHealthRequest = z
  .object({ action: z.literal("database"), organizationId: z.uuid() })
  .strict();

export type DatabaseHealth = {
  checkedAt: string;
  version: string;
  startedAt: string;
  connections: { used: number; max: number; active: number; idle: number; idleInTransaction: number; longestTransactionSeconds: number };
  database: {
    sizeBytes: number; tables: number; commits: number; rollbacks: number;
    blocksRead: number; blocksHit: number; deadlocks: number; tempBytes: number; statsReset: string | null;
  };
  topTables: { name: string; size_bytes: number; live_rows: number; dead_rows: number }[];
  storage: { objects: number; bytes: number };
  users: number;
  lastMigration: string | null;
  dashboardUrl?: string;
};

export type Verdict = { level: "ok" | "warn" | "bad"; title: string; reasons: string[] };

export const connectionShare = (h: DatabaseHealth) => (h.connections.max ? h.connections.used / h.connections.max : 0);
/** Share of block reads served from memory. Null until the database has served enough reads to mean something. */
export function cacheHitRatio(h: DatabaseHealth) {
  const total = h.database.blocksHit + h.database.blocksRead;
  return total < 1000 ? null : h.database.blocksHit / total;
}

export function assessHealth(h: DatabaseHealth): Verdict {
  const bad: string[] = [];
  const warn: string[] = [];
  const share = connectionShare(h);
  if (share >= 0.9) bad.push(`Nästan alla anslutningar används (${h.connections.used} av ${h.connections.max}).`);
  else if (share >= 0.7) warn.push(`Många anslutningar används (${h.connections.used} av ${h.connections.max}).`);
  const cache = cacheHitRatio(h);
  if (cache !== null && cache < 0.9) bad.push("Databasen läser ofta från disk i stället för minnet. Det kan tyda på för lite minne.");
  else if (cache !== null && cache < 0.95) warn.push("Cacheträffen är lägre än önskat.");
  if (h.connections.longestTransactionSeconds > 1800) bad.push("En transaktion har pågått i över 30 minuter.");
  else if (h.connections.longestTransactionSeconds > 300) warn.push("En transaktion har pågått i över 5 minuter.");
  if (h.connections.idleInTransaction > 3) warn.push(`${h.connections.idleInTransaction} anslutningar står öppna i en transaktion.`);
  if (h.database.deadlocks > 0) warn.push(`${h.database.deadlocks} låsningar (deadlocks) sedan statistiken nollställdes.`);
  const rolled = h.database.commits + h.database.rollbacks;
  if (rolled > 1000 && h.database.rollbacks / rolled > 0.1) warn.push("Ovanligt många transaktioner rullas tillbaka.");
  const worst = h.topTables.find((t) => t.live_rows > 1000 && t.dead_rows / (t.live_rows + t.dead_rows) > 0.2);
  if (worst) warn.push(`Tabellen ${worst.name} har många döda rader och behöver städas.`);
  if (bad.length) return { level: "bad", title: "Risk för överbelastning", reasons: [...bad, ...warn] };
  if (warn.length) return { level: "warn", title: "Behöver uppmärksamhet", reasons: warn };
  return { level: "ok", title: "Databasen mår bra", reasons: [] };
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} kB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 100 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
export function formatDuration(seconds: number) {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} dygn`;
}
