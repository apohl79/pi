import { type Static, Type } from "typebox";
import type { HarnessTool } from "../agent-harness.ts";
import type { GoalManager, GoalSnapshot } from "../goals.ts";

const createGoalSchema = Type.Object({
	objective: Type.String({ minLength: 1, description: "The explicit user-requested objective to track." }),
	token_budget: Type.Optional(Type.Integer({ minimum: 0, description: "Optional token budget for the goal." })),
});
const getGoalSchema = Type.Object({});
const updateGoalSchema = Type.Object({
	status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
});

type GoalToolResult = { goal?: GoalSnapshot };

function result(goal: GoalSnapshot | undefined): {
	content: [{ type: "text"; text: string }];
	details: GoalToolResult;
} {
	return {
		content: [{ type: "text", text: goal === undefined ? "No active goal." : JSON.stringify(goal) }],
		details: goal === undefined ? {} : { goal },
	};
}

export function createGoalTools(goals: GoalManager): HarnessTool[] {
	return [
		{
			name: "create_goal",
			label: "create_goal",
			description: "Create one durable goal when the user or system explicitly requests one.",
			parameters: createGoalSchema,
			execute: async (_toolCallId, input: unknown) => {
				const params = input as Static<typeof createGoalSchema>;
				return result(await goals.create(params.objective, params.token_budget));
			},
		},
		{
			name: "get_goal",
			label: "get_goal",
			description: "Read the current durable goal and its accounting.",
			parameters: getGoalSchema,
			execute: async () => result(await goals.read()),
		},
		{
			name: "update_goal",
			label: "update_goal",
			description: "Mark a durable goal complete or blocked after the requested work reaches that state.",
			parameters: updateGoalSchema,
			execute: async (_toolCallId, input: unknown) => {
				const params = input as Static<typeof updateGoalSchema>;
				return result(await goals.update({ status: params.status }));
			},
		},
	];
}
