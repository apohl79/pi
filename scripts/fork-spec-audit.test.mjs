import assert from "node:assert/strict";
import test from "node:test";
import { auditForkSpec } from "./fork-spec-audit.mjs";

test("keeps required implementation and production-test evidence present", () => {
	const result = auditForkSpec();
	assert.deepEqual(result.failures, []);
	assert.ok(result.checkedFiles >= 15);
	assert.ok(result.checkedPatterns >= 5);
});
