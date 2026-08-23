import assert from "node:assert/strict";
import test from "node:test";
import { auditForkSpec, resolveRepositoryRoot } from "./fork-spec-audit.mjs";

test("keeps required implementation and production-test evidence present", () => {
	const result = auditForkSpec();
	assert.deepEqual(result.failures, []);
	assert.ok(result.checkedFiles >= 27);
	assert.ok(result.checkedPatterns >= 30);
});

test("resolves URL-encoded repository paths portably", () => {
	assert.match(resolveRepositoryRoot("file:///tmp/pi%20workspace/scripts/fork-spec-audit.mjs"), /pi workspace[\\/]/);
});
