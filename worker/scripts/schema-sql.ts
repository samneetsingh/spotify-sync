// Prints the full D1 schema as an idempotent SQL file for `wrangler d1 execute --file`.
import { MIGRATIONS, migrationStatements } from "../src/db/schema";

console.log(MIGRATIONS.flatMap(migrationStatements).map((s) => `${s};`).join("\n\n"));
