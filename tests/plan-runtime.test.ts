// @ts-nocheck -- Executed as a black-box regression suite against public APIs.
import { snapshotToolSet } from "./tool-set.js";
import assert from "node:assert/strict";
import { ContextManager } from "../src/context/manager.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { CompactContextTool } from "../src/tools/compact-context.js";
import { ProposePlanTool } from "../src/tools/propose-plan.js";
import { applyTaskGraphOperation } from "../src/tasks/task-graph.js";
import { createMcpCatalogTools } from "../src/mcp/source.js";
import { describe, it } from "./harness.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { baseSessionState } from "./session-state.js";
function state(mode = "auto") {
    const now = new Date().toISOString();
    return {
        ...baseSessionState(),
        threadId: "thread_plan_runtime",
        mode,
        provider: "deepseek",
        model: "mock-model",
        thinkingEffort: "medium",
        workspaceRoot: process.cwd(),
        constraints: [],
        messages: [],
        filesRead: new Map(),
        changes: [],
        commands: [],
        commandApprovalPrefixes: [],
        workingSummary: "",
        compactedMessageCount: 0,
        createdAt: now,
        updatedAt: now,
    };
}
function options() {
    return {
        maxSteps: 3,
        maxContextChars: 24_000,
        maxOutputChars: 8_000,
        commandTimeoutMs: 1_000,
        approvalPolicy: "never",
    };
}
function selectMode(mode) {
    return {
        message: {
            role: "assistant",
            content: null,
            tool_calls: [{
                    id: "call_select_mode",
                    type: "function",
                    function: {
                        name: "select_mode",
                        arguments: JSON.stringify({
                            mode,
                            reason: `The model selected ${mode}.`,
                        }),
                    },
                }],
        },
    };
}
function respondDirectly(content) {
    return {
        message: {
            role: "assistant",
            content: null,
            tool_calls: [{
                    id: "call_respond_directly",
                    type: "function",
                    function: {
                        name: "respond_directly",
                        arguments: JSON.stringify({ content }),
                    },
                }],
        },
    };
}
function proposePlanCall() {
    return {
        id: "call_propose_plan",
        type: "function",
        function: {
            name: "propose_plan",
            arguments: JSON.stringify({
                title: "Add login and registration",
                overview: "Implement the approved local authentication demonstration.",
                steps: [{
                        title: "Add authentication state",
                        description: "Add login, registration, logout, and per-user local state.",
                        verification: "Run the relevant tests and verify two accounts remain isolated.",
                    }],
            }),
        },
    };
}
function createFileTool() {
    return {
        name: "create_file",
        mutating: true,
        definition: {
            type: "function",
            function: {
                name: "create_file",
                description: "Create a file",
                parameters: { type: "object" },
            },
        },
        async execute() {
            return { ok: true, summary: "created" };
        },
    };
}
function webSearchTool() {
    return {
        name: "web_search",
        mutating: false,
        definition: {
            type: "function",
            function: {
                name: "web_search",
                description: "Search public Web pages",
                parameters: { type: "object" },
            },
        },
        async execute() {
            return { ok: true, summary: "searched" };
        },
    };
}
function review(status = "awaiting_review") {
    return {
        status,
        proposal: {
            id: "plan_11111111-1111-4111-8111-111111111111",
            revision: 1,
            proposedByTurnId: "turn_original",
            proposedAt: "2026-08-27T00:00:00.000Z",
            title: "Add login and registration",
            overview: "Implement the local authentication demonstration.",
            steps: [{
                    title: "Implement authentication",
                    description: "Add the approved login and registration behavior.",
                    verification: "Run tests for login, logout, and account isolation.",
                }],
        },
        ...(status === "approved_pending_execution"
            ? { approvedAt: "2026-08-27T00:05:00.000Z" }
            : {}),
    };
}
function runtime(provider, tools, events = [], modes = [], usageRecords = [], reasoningTexts = [], limits = DEFAULT_RUNTIME_LIMITS, connectedMcpServers) {
    return new AgentRuntime({
        limits,
        provider,
        toolCatalog: snapshotToolSet(tools),
        connectedMcpServers,
        contextManager: new ContextManager(),
        buildSystemPrompt: async ({ mode }) => {
            modes.push(mode);
            return `mode:${mode}`;
        },
        getWorkspaceSummary: async () => "workspace",
        searchMemories: async () => [],
        appendEvent: async (event) => {
            events.push(event);
        },
        onModelUsage: async (record) => {
            usageRecords.push(record);
        },
        onReasoning: ({ text }) => {
            reasoningTexts.push(text);
        },
        requestApproval: async () => false,
    });
}
describe("model-controlled plan flow", () => {
    it("commits an Auto route before exposing tools and routes again only after manual reset", async () => {
        let routerRequests = 0;
        let workRequests = 0;
        let taskCalls = 0;
        const provider = {
            name: "deepseek", model: "mock-model",
            async complete(request) {
                if (request.tools?.some(tool => tool.function.name === "select_mode")) {
                    routerRequests += 1;
                    return selectMode("code");
                }
                workRequests += 1;
                assert.equal(request.tools?.some(tool => tool.function.name === "manage_tasks"), true);
                if (workRequests === 1) return { message: { role: "assistant", content: null, tool_calls: [{
                    id: "call_task", type: "function", function: {
                        name: "manage_tasks", arguments: '{"action":"list"}',
                    },
                }] } };
                return { message: { role: "assistant", content: "Done in Code mode." } };
            },
        };
        const taskTool = {
            name: "manage_tasks", mutating: true,
            definition: { type: "function", function: { name: "manage_tasks", description: "Manage tasks",
                parameters: { type: "object" } } },
            async execute() { taskCalls += 1; return { ok: true, summary: "Task status checked" }; },
        };
        const current = state("auto");
        const events = [];
        const agent = runtime(provider, [taskTool], events);
        assert.equal((await agent.run(current, "Start the work", options())).reason, "success");
        assert.equal(current.mode, "code");
        assert.equal(taskCalls, 1);
        assert.equal(routerRequests, 1);
        assert.equal(events.filter(event => event.type === "mode.auto_route").length, 1);
        assert.equal((await agent.run(current, "Continue", options())).reason, "success");
        assert.equal(routerRequests, 1);
        current.mode = "auto"; // The CLI/Web mode picker performs this explicit reset.
        assert.equal((await agent.run(current, "Handle another request", options())).reason, "success");
        assert.equal(routerRequests, 2);
        assert.equal(current.mode, "code");
    });
    it("routes a live MCP availability question to Code and exposes the catalog", async () => {
        const tools = createMcpCatalogTools("robinhood", Array.from({ length: 81 }, (_, index) => ({
            name: `tool_${index}`, inputSchema: { type: "object" },
        })), { callTool: async () => ({ content: [] }) });
        let requests = 0;
        const provider = {
            name: "deepseek", model: "mock-model",
            async complete(request) {
                requests += 1;
                if (requests === 1) {
                    const policy = request.messages[0]?.content ?? "";
                    assert.match(policy, /Connected MCP servers: 1/u);
                    assert.match(policy, /Use tools exposed by currently connected external services/u);
                    assert.match(policy, /current capability inspection/u);
                    assert.doesNotMatch(policy, new RegExp(tools[0].name, "u"));
                    return selectMode("code");
                }
                assert.deepEqual(request.tools?.map(tool => tool.function.name), tools.map(tool => tool.name));
                if (requests === 2) return { message: { role: "assistant", content: null, tool_calls: [{
                    id: "call_mcp_search", type: "function", function: {
                        name: tools[0].name, arguments: JSON.stringify({ query: "tool_80" }),
                    },
                }] } };
                assert.match(JSON.stringify(request.messages), /tool_80/u);
                return { message: { role: "assistant", content: "Robinhood tools are available; tool_80 is listed." } };
            },
        };
        const current = state("auto");
        current.messages.push({ role: "assistant", content: "Robinhood tools are not available yet." });
        const result = await runtime(provider, tools, [], [], [], [], DEFAULT_RUNTIME_LIMITS,
            [{ id: "robinhood", toolCount: 81 }]).run(current, "Can you see Robinhood tools now?", options());
        assert.equal(result.reason, "success", result.text);
        assert.equal(requests, 3);
        assert.match(result.text, /tool_80/u);
    });
    it("advertises built-in Web access without MCP and routes live search to Code", async () => {
        let requests = 0;
        const provider = {
            name: "deepseek", model: "mock-model",
            async complete(request) {
                requests += 1;
                if (requests === 1) {
                    const policy = request.messages[0]?.content ?? "";
                    assert.match(policy, /Public Web search\/page reading: Plan and Code/u);
                    assert.match(policy, /Search the public Web and read selected public pages/u);
                    assert.match(policy, /Connected MCP servers: 0/u);
                    assert.doesNotMatch(policy, /web_search|fetch_webpage/u);
                    return selectMode("code");
                }
                assert.deepEqual(request.tools?.map(tool => tool.function.name), ["web_search"]);
                return { message: { role: "assistant", content: "The current Web search capability is available." } };
            },
        };
        const current = state("auto");
        const result = await runtime(provider, [webSearchTool()], [], [], [], [], DEFAULT_RUNTIME_LIMITS, [])
            .run(current, "Search the Web for current information", options());
        assert.equal(result.reason, "success", result.text);
        assert.equal(requests, 2);
        assert.match(result.text, /available/u);
    });
    it("answers a bounded Auto request in one call and records router usage", async () => {
        let requests = 0;
        let routerTools = [];
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete(request) {
                requests += 1;
                routerTools = request.tools?.map((tool) => tool.function.name) ?? [];
                return {
                    message: {
                        ...respondDirectly("The current task is to add usage accounting.").message,
                        reasoning_content: "The bounded conversation already contains the task.",
                    },
                    usage: {
                        promptTokens: 90,
                        completionTokens: 10,
                        totalTokens: 100,
                        cachedInputTokens: 25,
                        reasoningTokens: 4,
                    },
                };
            },
        };
        const events = [];
        const usageRecords = [];
        const reasoningTexts = [];
        const modes = [];
        const current = state("auto");
        const result = await runtime(provider, [], events, modes, usageRecords, reasoningTexts).run(current, "What is the current task?", options());
        assert.equal(requests, 1);
        assert.deepEqual(routerTools, ["select_mode", "respond_directly"]);
        assert.equal(result.reason, "success");
        assert.equal(result.steps, 0);
        assert.equal(result.text, "The current task is to add usage accounting.");
        assert.equal(current.mode, "auto");
        assert.deepEqual(modes, ["auto"]);
        const finalMessage = current.messages.at(-1);
        assert.equal(finalMessage?.role, "assistant");
        assert.equal(finalMessage?.role === "assistant" ? finalMessage.reasoning_content : undefined, "The bounded conversation already contains the task.");
        assert.deepEqual(reasoningTexts, [
            "The bounded conversation already contains the task.",
        ]);
        assert.ok(events.some((event) => event.type === "mode.auto_direct_response"));
        assert.equal(events.some((event) => event.type === "mode.auto_route"), false);
        assert.deepEqual(usageRecords, [{
                actor: "main_agent",
                purpose: "auto_route",
                provider: "deepseek",
                model: "mock-model",
                turnId: result.turnId,
                attempt: 1,
                retry: false,
                usage: {
                    promptTokens: 90,
                    completionTokens: 10,
                    totalTokens: 100,
                    cachedInputTokens: 25,
                    reasoningTokens: 4,
                },
            }]);
    });
    it("records an earlier invalid Auto attempt when the retry request fails", async () => {
        let requests = 0;
        const usageRecords = [];
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete() {
                requests += 1;
                if (requests === 1) {
                    return {
                        message: { role: "assistant", content: "invalid plain text" },
                        usage: { promptTokens: 100, completionTokens: 23, totalTokens: 123 },
                    };
                }
                throw new Error("second controller request failed");
            },
        };
        const result = await runtime(provider, [], [], [], usageRecords).run(state("auto"), "Fix the bug", options());
        assert.equal(result.reason, "failed");
        assert.match(result.text, /second controller request failed/u);
        assert.equal(requests, 2);
        assert.equal(usageRecords.length, 1);
        assert.equal(usageRecords[0]?.purpose, "auto_route");
        assert.equal(usageRecords[0]?.usage?.totalTokens, 123);
    });
    it("compacts an Auto thread at 80% and then restores model-controlled routing", async () => {
        const current = state("auto");
        current.messages.push({ role: "user", content: "Keep existing compatibility" }, { role: "assistant", content: "Old investigation", reasoning_content: "r".repeat(60_000) }, { role: "assistant", content: "Recent observation" }, { role: "assistant", content: "Live work", reasoning_content: "keep this reasoning" });
        const input = "What is the current task?";
        const compactionInput = {
            currentWork: "Reducing the active Auto-thread context before routing.",
            nextStep: "Resume model-controlled routing for the current request.",
        };
        const requestTools = [];
        const modes = [];
        const events = [];
        let requests = 0;
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete(request) {
                requests += 1;
                requestTools.push(request.tools?.map((tool) => tool.function.name) ?? []);
                if (requests === 1) {
                    return {
                        message: {
                            role: "assistant",
                            content: null,
                            tool_calls: [{
                                    id: "call_compact_before_direct",
                                    type: "function",
                                    function: {
                                        name: "compact_context",
                                        arguments: JSON.stringify(compactionInput),
                                    },
                                }],
                        },
                    };
                }
                if (requests === 2)
                    return selectMode("plan");
                return {
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [proposePlanCall()],
                    },
                };
            },
        };
        const result = await runtime(provider, [new ProposePlanTool(), new CompactContextTool()], events, modes, [], [], { ...DEFAULT_RUNTIME_LIMITS, compactionRetainRecentExchanges: 2, contextCompactionTriggerRatio: 0.8, contextSummaryMaxTokens: 2048 }).run(current, input, {
            ...options(),
            maxSteps: 3,
            maxContextChars: 100_000,
            maxContextTokens: 34_000,
        });
        assert.equal(result.reason, "planned", result.text);
        // Pre-routing maintenance retains the Code capability envelope (empty in
        // this fixture), not a new compact_context-only schema surface.
        assert.deepEqual(requestTools[0], []);
        assert.deepEqual(requestTools[1], ["select_mode", "respond_directly"]);
        assert.deepEqual(requestTools[2], ["propose_plan"]);
        assert.deepEqual(modes, ["code", "auto", "plan"]);
        const eventTypes = events.map((event) => event.type);
        assert.ok(eventTypes.indexOf("context.compaction.committed") >= 0);
        assert.ok(eventTypes.indexOf("context.compaction.committed") < eventTypes.indexOf("mode.auto_route"));
    });
    it("records an ordinary Code response as agent-step usage", async () => {
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete() {
                return {
                    message: {
                        role: "assistant",
                        content: "Completed without tools.",
                        tool_calls: [],
                    },
                    usage: { promptTokens: 60, completionTokens: 8, totalTokens: 68 },
                };
            },
        };
        const usageRecords = [];
        const result = await runtime(provider, [], [], [], usageRecords).run(state("code"), "Answer directly", options());
        assert.equal(result.reason, "success");
        assert.equal(usageRecords.length, 1);
        assert.deepEqual(usageRecords[0], {
            actor: "main_agent",
            purpose: "agent_step",
            provider: "deepseek",
            model: "mock-model",
            turnId: result.turnId,
            step: 1,
            attempt: 1,
            retry: false,
            usage: { promptTokens: 60, completionTokens: 8, totalTokens: 68 },
        });
    });
    it("uses select_mode to enter Plan and ends immediately on propose_plan", async () => {
        let requests = 0;
        let mainTools = [];
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete(request) {
                requests += 1;
                if (requests === 1)
                    return selectMode("plan");
                mainTools = request.tools?.map((tool) => tool.function.name) ?? [];
                return {
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [proposePlanCall()],
                    },
                };
            },
        };
        const current = state("auto");
        const events = [];
        const modes = [];
        const result = await runtime(provider, [new ProposePlanTool(), createFileTool()], events, modes).run(current, "Please decide how to handle this feature", options());
        assert.equal(requests, 2);
        assert.deepEqual(mainTools, ["propose_plan", "create_file"]);
        assert.deepEqual(modes, ["auto", "plan"]);
        assert.equal(current.mode, "plan");
        assert.equal(result.reason, "planned");
        assert.equal(result.planProposal?.id, current.planReview?.proposal.id);
        assert.equal(current.planReview?.status, "awaiting_review");
        assert.equal(current.planReview?.proposal.revision, 1);
        assert.match(result.text, /waiting for user review/u);
        assert.ok(events.some((event) => event.type === "tool.result" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            "planReview" in event.payload));
    });
    it("uses a Code selection without exposing propose_plan", async () => {
        let requests = 0;
        let mainTools = [];
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete(request) {
                requests += 1;
                if (requests === 1)
                    return selectMode("code");
                mainTools = request.tools?.map((tool) => tool.function.name) ?? [];
                return {
                    message: { role: "assistant", content: "Handled directly.", tool_calls: [] },
                };
            },
        };
        const current = state("auto");
        const result = await runtime(provider, [new ProposePlanTool(), createFileTool()]).run(current, "Handle this request", options());
        assert.equal(result.reason, "success");
        assert.deepEqual(mainTools, ["create_file"]);
        assert.equal(current.planReview, undefined);
    });
    it("turns plain Plan text into a proposal without a second model request", async () => {
        let requests = 0;
        let sawReminder = false;
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete(request) {
                requests += 1;
                if (requests === 1) {
                    return {
                        message: { role: "assistant", content: "A plain text plan", tool_calls: [] },
                    };
                }
                sawReminder = request.messages.some((message) => message.role === "user" &&
                    /RUNTIME_COMPLETION_REQUIRED/u.test(message.content) &&
                    /propose_plan/u.test(message.content));
                return {
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [proposePlanCall()],
                    },
                };
            },
        };
        const result = await runtime(provider, [new ProposePlanTool()]).run(state("plan"), "Create a plan", options());
        assert.equal(requests, 1);
        assert.equal(sawReminder, false);
        assert.equal(result.reason, "planned");
        assert.ok(result.planProposal);
        assert.equal(result.planProposal?.steps[0]?.description, "A plain text plan");
    });
    it("does not propose a plan while its planning DAG remains unfinished", async () => {
        const current = state("plan");
        current.taskGraph = applyTaskGraphOperation(undefined, {
            action: "create", goal: "Research before proposing", tasks: [{
                id: "research", title: "Research", description: "Inspect the repository",
                dependencies: [], inputs: ["Project files"], expectedArtifacts: ["Findings"],
                completionChecks: ["Findings are recorded"], failureHandling: "Report a blocker",
            }],
        }, { turnId: "turn_plan_dag" });
        const provider = { name: "deepseek", model: "mock-model", async complete() {
            return { message: { role: "assistant", content: "Plan too early", tool_calls: [] } };
        } };
        const result = await runtime(provider, [new ProposePlanTool()]).run(current, "Plan the work", {
            ...options(), maxSteps: 1,
        });
        assert.equal(result.planProposal, undefined);
        assert.equal(current.planReview, undefined);
        assert.equal(current.messages.some(message => message.role === "user" &&
            message.content.includes("planning task DAG is unfinished")), true);
    });
    it("consumes an exact approved proposal only after the execution message is durable", async () => {
        let requests = 0;
        let mainTools = [];
        const events = [];
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete(request) {
                requests += 1;
                mainTools = request.tools?.map((tool) => tool.function.name) ?? [];
                return {
                    message: { role: "assistant", content: "Executed approved plan.", tool_calls: [] },
                };
            },
        };
        const current = state("auto");
        current.planReview = review("approved_pending_execution");
        const approved = current.planReview.proposal;
        const result = await runtime(provider, [], events).run(current, "Execute the approved plan", {
            ...options(),
            modeOverride: "code",
            approvedPlan: { id: approved.id, revision: approved.revision },
        });
        assert.equal(result.reason, "success");
        assert.equal(requests, 1);
        assert.deepEqual(mainTools, []);
        assert.equal(current.planReview, undefined);
        const userIndex = events.findIndex((event) => event.type === "message.user");
        const executionIndex = events.findIndex((event) => event.type === "plan.execution_started");
        assert.ok(userIndex >= 0 && executionIndex > userIndex);
    });
    it("returns an approved plan to review after a provider timeout", async () => {
        const events = [];
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete() {
                throw new Error("Provider request timed out after 450000ms");
            },
        };
        const current = state("auto");
        current.planReview = review("approved_pending_execution");
        const approved = current.planReview.proposal;
        const result = await runtime(provider, [], events).run(current, "Execute the approved plan", {
            ...options(),
            modeOverride: "code",
            approvedPlan: { id: approved.id, revision: approved.revision },
        });
        assert.equal(result.reason, "failed");
        assert.match(result.text, /timed out after 450000ms/u);
        assert.equal(current.planReview?.status, "awaiting_review");
        assert.equal(current.planReview?.proposal.id, approved.id);
        assert.equal(current.planReview?.proposal.revision, approved.revision);
        assert.equal(Object.prototype.hasOwnProperty.call(current.planReview ?? {}, "approvedAt"), false);
        assert.match(current.planReview?.feedback ?? "", /workspace|partial/u);
        const lifecycle = events
            .map((event) => event.type)
            .filter((type) => [
            "plan.execution_started",
            "model.error",
            "plan.execution_returned_to_review",
            "turn.completed",
        ].includes(type));
        assert.deepEqual(lifecycle, [
            "plan.execution_started",
            "model.error",
            "plan.execution_returned_to_review",
            "turn.completed",
        ]);
        const returned = events.find((event) => event.type === "plan.execution_returned_to_review");
        assert.ok(returned);
        const payload = returned.payload;
        assert.equal(payload.planId, approved.id);
        assert.equal(payload.revision, approved.revision);
        assert.equal(payload.outcome, "failed");
        assert.equal(payload.planReview?.status, "awaiting_review");
    });
    it("revises the same pending plan in a Runtime-owned Plan override", async () => {
        let requests = 0;
        let mainTools = [];
        const provider = {
            name: "deepseek",
            model: "mock-model",
            async complete(request) {
                requests += 1;
                mainTools = request.tools?.map((tool) => tool.function.name) ?? [];
                return {
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [proposePlanCall()],
                    },
                };
            },
        };
        const current = state("auto");
        current.planReview = { ...review(), feedback: "Use a modal dialog." };
        const originalId = current.planReview.proposal.id;
        const result = await runtime(provider, [new ProposePlanTool()]).run(current, "Adjust the pending plan", { ...options(), modeOverride: "plan" });
        assert.equal(requests, 1);
        assert.deepEqual(mainTools, ["propose_plan"]);
        assert.equal(result.planProposal?.id, originalId);
        assert.equal(result.planProposal?.revision, 2);
        assert.equal(current.planReview?.feedback, undefined);
    });
});
