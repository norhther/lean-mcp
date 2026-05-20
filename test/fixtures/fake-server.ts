#!/usr/bin/env tsx
/**
 * A realistic downstream MCP server used by the integration test and the
 * benchmark. It is a vanilla stdio MCP server — it has no idea a gateway is
 * proxying it, which is the whole point of retro-compatibility.
 *
 * The tools mimic a project-tracker API: verbose descriptions and multi-field
 * schemas, so the baseline (all definitions in context) is realistically big.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "tracker", version: "1.0.0" });

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

server.registerTool(
  "create_issue",
  {
    description:
      "Create a new issue in a project. Issues track bugs, features, and chores. Returns the created issue with its assigned numeric id.",
    inputSchema: {
      project: z.string().describe("Project key, e.g. 'CORE'."),
      title: z.string().describe("Short summary of the issue."),
      body: z.string().optional().describe("Full markdown description."),
      labels: z.array(z.string()).optional().describe("Label names to attach."),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .describe("Triage priority."),
    },
  },
  async ({ project, title }) => text({ id: 4711, project, title, state: "open" }),
);

server.registerTool(
  "update_issue",
  {
    description:
      "Update fields on an existing issue: title, body, state, assignee, or labels. Only supplied fields change.",
    inputSchema: {
      id: z.number().int().describe("Numeric issue id."),
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(["open", "closed"]).optional(),
      assignee: z.string().optional().describe("Username to assign."),
    },
  },
  async ({ id }) => text({ id, updated: true }),
);

server.registerTool(
  "get_issue",
  {
    description: "Fetch a single issue by its numeric id, including comments.",
    inputSchema: { id: z.number().int().describe("Numeric issue id.") },
  },
  async ({ id }) => text({ id, title: "Example issue", state: "open", comments: 2 }),
);

server.registerTool(
  "list_issues",
  {
    description:
      "List issues in a project with optional filters by state, label, and assignee. Supports pagination.",
    inputSchema: {
      project: z.string().describe("Project key."),
      state: z.enum(["open", "closed", "all"]).optional(),
      label: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ project }) =>
    text({ project, issues: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
);

server.registerTool(
  "comment_on_issue",
  {
    description: "Add a markdown comment to an existing issue.",
    inputSchema: {
      id: z.number().int().describe("Numeric issue id."),
      body: z.string().describe("Markdown comment body."),
    },
  },
  async ({ id }) => text({ id, commentId: 99 }),
);

server.registerTool(
  "search_code",
  {
    description:
      "Full-text search across the repository's source files. Returns matching file paths and line numbers.",
    inputSchema: {
      query: z.string().describe("Search expression."),
      path: z.string().optional().describe("Restrict to a subdirectory."),
      ignoreCase: z.boolean().optional(),
    },
  },
  async ({ query }) => text({ query, matches: 7 }),
);

server.registerTool(
  "create_pull_request",
  {
    description:
      "Open a pull request from a head branch into a base branch, with a title and description.",
    inputSchema: {
      head: z.string().describe("Source branch."),
      base: z.string().describe("Target branch."),
      title: z.string(),
      body: z.string().optional(),
      draft: z.boolean().optional().describe("Open as a draft PR."),
    },
  },
  async ({ head, base }) => text({ number: 88, head, base, state: "open" }),
);

server.registerTool(
  "merge_pull_request",
  {
    description:
      "Merge an open pull request using merge, squash, or rebase strategy.",
    inputSchema: {
      number: z.number().int().describe("Pull request number."),
      strategy: z.enum(["merge", "squash", "rebase"]).optional(),
    },
  },
  async ({ number }) => text({ number, merged: true }),
);

server.registerTool(
  "list_milestones",
  {
    description: "List milestones for a project with their due dates and progress.",
    inputSchema: { project: z.string().describe("Project key.") },
  },
  async ({ project }) => text({ project, milestones: ["v1.0", "v1.1"] }),
);

server.registerTool(
  "assign_reviewer",
  {
    description:
      "Request a review on a pull request from one or more team members.",
    inputSchema: {
      number: z.number().int().describe("Pull request number."),
      reviewers: z.array(z.string()).describe("Usernames to request."),
    },
  },
  async ({ number, reviewers }) => text({ number, requested: reviewers }),
);

server.registerTool(
  "get_build_status",
  {
    description:
      "Return the CI build status for a commit: pending, success, or failure, with per-check detail.",
    inputSchema: { sha: z.string().describe("Full or short commit SHA.") },
  },
  async ({ sha }) => text({ sha, status: "success", checks: 12 }),
);

server.registerTool(
  "dump_logs",
  {
    description:
      "Return the raw CI log for a build. Output is intentionally large — this exercises result-bloat handling.",
    inputSchema: { sha: z.string().describe("Commit SHA.") },
  },
  async ({ sha }) => {
    const lines = Array.from(
      { length: 1200 },
      (_, i) =>
        `[${String(i).padStart(5, "0")}] build ${sha} :: step ${i % 9} :: ` +
        "compiled module and emitted artifact without error",
    );
    return text(`BUILD LOG START\n${lines.join("\n")}\nBUILD LOG END`);
  },
);

await server.connect(new StdioServerTransport());
