import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";

/**
 * Minimal migration runner. Applies every .sql file in ./migrations in order.
 * Idempotent — files use `CREATE TABLE IF NOT EXISTS` etc.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const dir = "migrations";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const f of files) {
      const sql = await readFile(join(dir, f), "utf8");
      console.log(`→ applying ${f}`);
      await client.query(sql);
    }
    console.log("✓ migrations applied");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
