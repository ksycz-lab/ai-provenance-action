// Validates a downloaded audit report against schema/report.v1.schema.json.
// Usage: node scripts/validate-report.mjs <path/to/report.json>
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/validate-report.mjs <report.json>");
  process.exit(2);
}

const schema = JSON.parse(
  readFileSync(new URL("../schema/report.v1.schema.json", import.meta.url), "utf8"),
);
const report = JSON.parse(readFileSync(path, "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

if (!validate(report)) {
  console.error(`${path} does not match the report schema:`);
  console.error(JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}
console.log(
  `${path} is valid: schema ${report.schemaVersion}, verdict ${report.verdict}, ` +
    `${report.commits.filter((c) => c.aiTagged).length} AI-tagged commit(s).`,
);
