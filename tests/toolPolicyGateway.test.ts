import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash, type JsonValue } from "../src/domain/canonical";
import {
  asId,
  type Actor,
  type ConversationId,
  type PreparedToolProposal,
  type ToolEntryPath,
  type ToolId,
  type ToolManifest,
  type TurnId,
  type WorkspaceId,
} from "../src/domain/contracts";
import {
  ApprovalRejectedError,
  MAX_APPROVAL_LIFETIME_MS,
  ToolPolicy,
  type PolicyContext,
} from "../src/policy/toolPolicy";
import { DurableJournal } from "../src/storage/durableJournal";
import {
  ExecutionOutcomeUnknownError,
  MAX_GATEWAY_AUTHORITY_CACHE_ENTRIES,
  ToolExecutionBlockedError,
  ToolOutcomeUnknownError,
  ToolPreparationError,
  UniversalToolGateway,
  type AuthenticatedHumanApprover,
  type ToolExecutionResult,
} from "../src/tools/universalToolGateway";
import { MemoryAuditPort, MutableClock, TempArea } from "./helpers";

const temporary = new TempArea();
afterEach(() => temporary.cleanup());

const workspaceId = asId<WorkspaceId>("ws-policy");
const conversationId = asId<ConversationId>("conv-policy");
const agent: Actor = { kind: "agent", id: "agent-proposer" };
const human: AuthenticatedHumanApprover = {
  principalId: "human-owner",
  kind: "human",
  assurance: "authenticated_control_plane",
};
const noScopes: PolicyContext = { grantedDataScopes: [], grantedNetworkScopes: [] };

function mutationManifest(toolId = "tool.write-note"): ToolManifest {
  return {
    toolId: asId<ToolId>(toolId),
    version: "1.0.0",
    schemaHash: "a".repeat(64),
    effect: "write",
    dataScope: ["workspace/notes"],
    networkScope: [],
    idempotency: "non_idempotent",
  };
}

function registerMutation(
  gateway: UniversalToolGateway,
  ledger: string[],
  execute?: (argumentsValue: JsonValue) => Promise<void>,
) {
  const manifest = mutationManifest();
  gateway.registerTool({
    manifest,
    execute: async ({ arguments: argumentsValue, idempotencyKey }) => {
      await execute?.(argumentsValue);
      ledger.push(`${idempotencyKey}:${JSON.stringify(argumentsValue)}`);
      return { output: { stored: true }, outputSummary: "Note stored." };
    },
  });
  return manifest;
}

function prepare(gateway: UniversalToolGateway, suffix = "base"): PreparedToolProposal {
  return gateway.prepare({
    workspaceId,
    conversationId,
    turnId: asId<TurnId>(`turn-${suffix}`),
    actor: agent,
    toolId: asId<ToolId>("tool.write-note"),
    arguments: { text: `note-${suffix}` },
    summary: "Write one note",
  });
}

async function executePath(
  gateway: UniversalToolGateway,
  path: ToolEntryPath,
  input: Parameters<UniversalToolGateway["executeDirect"]>[0],
): Promise<ToolExecutionResult> {
  if (path === "direct") return gateway.executeDirect(input);
  if (path === "routed") return gateway.executeRouted(input);
  if (path === "retry") return gateway.executeRetry(input);
  return gateway.executeResume(input);
}

describe("UniversalToolGateway", () => {
  it("bounds grant and attempt authority caches and fails closed before durable overflow", async () => {
    expect(MAX_GATEWAY_AUTHORITY_CACHE_ENTRIES).toBe(1_024);

    const grantAudit = new MemoryAuditPort();
    const grantClock = new MutableClock(1_700_000_000_000);
    const grantGateway = new UniversalToolGateway(
      new ToolPolicy("policy-cache-grants", grantClock),
      grantAudit,
      grantClock,
      [],
      2,
    );
    registerMutation(grantGateway, []);
    for (const suffix of ["grant-a", "grant-b"]) {
      await grantGateway.grantApproval(prepare(grantGateway, suffix), human, noScopes);
    }
    await expect(
      grantGateway.grantApproval(prepare(grantGateway, "grant-overflow"), human, noScopes),
    ).rejects.toMatchObject({ reasonCode: "authority_cache_capacity" });
    expect(grantGateway.authorityCacheSizes()).toEqual({ grants: 2, attempts: 0 });
    expect(grantAudit.events.filter((event) => event.type === "approval.granted")).toHaveLength(2);

    const attemptAudit = new MemoryAuditPort();
    const attemptClock = new MutableClock(1_700_000_000_000);
    const attemptGateway = new UniversalToolGateway(
      new ToolPolicy("policy-cache-attempts", attemptClock),
      attemptAudit,
      attemptClock,
      [],
      2,
    );
    registerMutation(attemptGateway, []);
    for (const suffix of ["attempt-a", "attempt-b"]) {
      await attemptGateway.denyApproval(prepare(attemptGateway, suffix));
    }
    await expect(
      attemptGateway.denyApproval(prepare(attemptGateway, "attempt-overflow")),
    ).rejects.toMatchObject({ reasonCode: "authority_cache_capacity" });
    expect(attemptGateway.authorityCacheSizes()).toEqual({ grants: 0, attempts: 2 });
    expect(attemptAudit.events.filter((event) => event.type === "approval.denied")).toHaveLength(2);
  });

  it("denies unknown tools before an external effect exists", () => {
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), new MemoryAuditPort());
    expect(() => gateway.prepare({
      workspaceId,
      conversationId,
      turnId: asId<TurnId>("turn-unknown"),
      actor: agent,
      toolId: asId<ToolId>("model.claims.this-is-safe"),
      arguments: {},
      summary: "Untrusted model description",
    })).toThrow(ToolPreparationError);
  });

  it.each(["direct", "routed", "retry", "resume"] as const)(
    "requires a fresh exact approval through the %s entry path",
    async (entryPath) => {
      const audit = new MemoryAuditPort();
      const ledger: string[] = [];
      const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), audit);
      registerMutation(gateway, ledger);
      const proposal = prepare(gateway, entryPath);
      expect((await gateway.evaluateAndRecord(proposal, noScopes)).outcome).toBe("ask");

      await expect(executePath(gateway, entryPath, { proposal, policyContext: noScopes })).rejects.toBeInstanceOf(
        ApprovalRejectedError,
      );
      expect(ledger).toHaveLength(0);

      const grant = await gateway.grantApproval(proposal, human, noScopes);
      await executePath(gateway, entryPath, { proposal, grant, policyContext: noScopes });
      expect(ledger).toHaveLength(1);
      expect(audit.events.map((event) => event.type)).toEqual([
        "policy.decided",
        "approval.granted",
        "approval.consumed",
        "tool.execution.started",
        "tool.execution.succeeded",
      ]);
    },
  );

  it("rejects argument, actor, conversation, expiry, policy, and replay mismatches with zero new effects", async () => {
    const mismatchCases: Array<{
      name: string;
      mutate: (proposal: PreparedToolProposal, gateway: UniversalToolGateway, clock: MutableClock) => PreparedToolProposal;
    }> = [
      {
        name: "arguments",
        mutate: (proposal) => {
          const argumentsValue = { text: "changed" } as const;
          return { ...proposal, arguments: argumentsValue, argumentsHash: canonicalHash(argumentsValue) };
        },
      },
      { name: "actor", mutate: (proposal) => ({ ...proposal, actor: { kind: "agent", id: "other-agent" } }) },
      {
        name: "conversation",
        mutate: (proposal) => ({ ...proposal, conversationId: asId<ConversationId>("conv-other") }),
      },
      {
        name: "expiry",
        mutate: (proposal, _gateway, clock) => {
          clock.advance(MAX_APPROVAL_LIFETIME_MS);
          return proposal;
        },
      },
      {
        name: "policy",
        mutate: (proposal, gateway) => {
          gateway.replacePolicy(new ToolPolicy("policy-2"));
          return proposal;
        },
      },
    ];

    for (const mismatch of mismatchCases) {
      const clock = new MutableClock(1_700_000_000_000);
      const ledger: string[] = [];
      const gateway = new UniversalToolGateway(new ToolPolicy("policy-1", clock), new MemoryAuditPort(), clock);
      registerMutation(gateway, ledger);
      const proposal = prepare(gateway, mismatch.name);
      const grant = await gateway.grantApproval(proposal, human, noScopes);
      const changed = mismatch.mutate(proposal, gateway, clock);
      await expect(gateway.executeResume({ proposal: changed, grant, policyContext: noScopes })).rejects.toBeInstanceOf(
        Error,
      );
      expect(ledger, mismatch.name).toHaveLength(0);
    }

    const ledger: string[] = [];
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), new MemoryAuditPort());
    const manifest = mutationManifest();
    gateway.registerTool({
      manifest,
      execute: async () => {
        throw new Error("definite failure before effect");
      },
    });
    const proposal = prepare(gateway, "replay");
    const grant = await gateway.grantApproval(proposal, human, noScopes);
    await expect(gateway.executeResume({ proposal, grant, policyContext: noScopes })).rejects.toThrow(
      "definite failure",
    );
    await expect(gateway.executeRetry({ proposal, grant, policyContext: noScopes })).rejects.toMatchObject({
      reasonCode: "grant_replayed",
    });
    expect(ledger).toHaveLength(0);
  });

  it("does not let a prompt, proposing agent, or tool self-approve", async () => {
    const ledger: string[] = [];
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), new MemoryAuditPort());
    registerMutation(gateway, ledger);
    const proposal = prepare(gateway, "self-approval");

    await expect(gateway.grantApproval(proposal, {
      principalId: agent.id,
      kind: "human",
      assurance: "authenticated_control_plane",
    }, noScopes)).rejects.toMatchObject({ reasonCode: "approver_not_authenticated_human" });
    await expect(gateway.grantApproval(proposal, {
      principalId: "model-from-prompt",
      kind: "agent",
      assurance: "model_claim",
    } as unknown as AuthenticatedHumanApprover, noScopes)).rejects.toMatchObject({
      reasonCode: "approver_not_authenticated_human",
    });
    expect(ledger).toHaveLength(0);
  });

  it.each(["direct", "routed", "retry", "resume"] as const)(
    "irreversibly burns a one-use grant when guarded %s start is rejected",
    async (initialPath) => {
      const directory = await temporary.directory();
      const path = join(directory, `guard-burn-${initialPath}.journal`);
      const effects: string[] = [];
      const firstJournal = await DurableJournal.open(path);
      const first = new UniversalToolGateway(new ToolPolicy("policy-guard-burn"), firstJournal);
      registerMutation(first, effects);
      const proposal = prepare(first, `guard-burn-${initialPath}`);
      const grant = await first.grantApproval(proposal, human, noScopes);

      await expect(executePath(first, initialPath, {
        proposal,
        grant,
        policyContext: noScopes,
        startCommitGuard: () => false,
      })).rejects.toBeInstanceOf(Error);
      expect(effects).toEqual([]);
      expect(firstJournal.snapshot().filter((event) => event.type === "approval.consumed")).toEqual([]);
      expect(firstJournal.snapshot().filter((event) => event.type === "tool.execution.started")).toEqual([]);
      for (const retryPath of ["direct", "routed", "retry", "resume"] as const) {
        await expect(executePath(first, retryPath, {
          proposal,
          grant,
          policyContext: noScopes,
        })).rejects.toMatchObject({ reasonCode: "reconciliation_required" });
      }
      await expect(first.grantApproval(proposal, human, noScopes)).rejects.toMatchObject({
        reasonCode: "terminal_attempt_requires_reconciliation",
      });
      expect(effects).toEqual([]);
      await firstJournal.close();

      const reopened = await DurableJournal.open(path);
      const second = new UniversalToolGateway(
        new ToolPolicy("policy-guard-burn"),
        reopened,
        undefined,
        reopened.snapshot(),
      );
      registerMutation(second, effects);
      for (const retryPath of ["direct", "routed", "retry", "resume"] as const) {
        await expect(executePath(second, retryPath, {
          proposal,
          grant,
          policyContext: noScopes,
        })).rejects.toMatchObject({ reasonCode: "reconciliation_required" });
      }
      await expect(second.grantApproval(proposal, human, noScopes)).rejects.toMatchObject({
        reasonCode: "terminal_attempt_requires_reconciliation",
      });
      expect(effects).toEqual([]);
      await reopened.close();
    },
  );

  it("marks non-idempotent ambiguous failures outcome-unknown and blocks blind retry", async () => {
    const audit = new MemoryAuditPort();
    const externalEffects: string[] = [];
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), audit);
    gateway.registerTool({
      manifest: mutationManifest(),
      execute: async ({ idempotencyKey }) => {
        externalEffects.push(idempotencyKey);
        throw new ToolOutcomeUnknownError();
      },
    });
    const proposal = prepare(gateway, "uncertain");
    const grant = await gateway.grantApproval(proposal, human, noScopes);
    await expect(gateway.executeResume({ proposal, grant, policyContext: noScopes })).rejects.toBeInstanceOf(
      ExecutionOutcomeUnknownError,
    );
    await expect(gateway.executeRetry({ proposal, grant, policyContext: noScopes })).rejects.toBeInstanceOf(
      ToolExecutionBlockedError,
    );
    expect(externalEffects).toHaveLength(1);
    expect(audit.events.some((event) => event.type === "tool.execution.uncertain")).toBe(true);
  });

  it.each(["succeeded", "outcome_unknown"] as const)(
    "derives %s terminal attempts and consumed grants from durable audit evidence after restart",
    async (outcome) => {
      const directory = await temporary.directory();
      const path = join(directory, `${outcome}.journal`);
      const externalEffects: string[] = [];
      const firstJournal = await DurableJournal.open(path);
      const first = new UniversalToolGateway(new ToolPolicy("policy-1"), firstJournal);
      first.registerTool({
        manifest: mutationManifest(),
        execute: async ({ idempotencyKey }) => {
          externalEffects.push(idempotencyKey);
          if (outcome === "outcome_unknown") throw new ToolOutcomeUnknownError();
          return { output: { ok: true }, outputSummary: "Stored once." };
        },
      });
      const proposal = prepare(first, `restart-${outcome}`);
      const grant = await first.grantApproval(proposal, human, noScopes);
      if (outcome === "succeeded") {
        await first.executeResume({ proposal, grant, policyContext: noScopes });
      } else {
        await expect(first.executeResume({ proposal, grant, policyContext: noScopes })).rejects.toBeInstanceOf(
          ExecutionOutcomeUnknownError,
        );
      }
      await firstJournal.close();

      const secondJournal = await DurableJournal.open(path);
      const second = new UniversalToolGateway(
        new ToolPolicy("policy-1"),
        secondJournal,
        undefined,
        secondJournal.snapshot(),
      );
      second.registerTool({
        manifest: mutationManifest(),
        execute: async ({ idempotencyKey }) => {
          externalEffects.push(idempotencyKey);
          return { output: { duplicated: true }, outputSummary: "Duplicated." };
        },
      });
      await expect(second.grantApproval(proposal, human, noScopes)).rejects.toBeInstanceOf(
        ToolExecutionBlockedError,
      );
      await expect(second.executeResume({ proposal, grant, policyContext: noScopes })).rejects.toBeInstanceOf(
        ToolExecutionBlockedError,
      );
      expect(externalEffects).toHaveLength(1);
      await secondJournal.close();
    },
  );

  it("passes 200 deterministic authorization state-machine traces with no unauthorized effects", async () => {
    const audit = new MemoryAuditPort();
    const effects: string[] = [];
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), audit);
    registerMutation(gateway, effects);

    for (let index = 0; index < 200; index += 1) {
      const proposal = prepare(gateway, `trace-${index}`);
      if (index % 4 === 0) {
        const grant = await gateway.grantApproval(proposal, human, noScopes);
        await gateway.executeRouted({ proposal, grant, policyContext: noScopes });
      } else if (index % 4 === 1) {
        await expect(gateway.executeDirect({ proposal, policyContext: noScopes })).rejects.toBeInstanceOf(
          ApprovalRejectedError,
        );
      } else if (index % 4 === 2) {
        const grant = await gateway.grantApproval(proposal, human, noScopes);
        const changedArguments = { text: "tampered" } as const;
        await expect(gateway.executeRetry({
          proposal: { ...proposal, arguments: changedArguments, argumentsHash: canonicalHash(changedArguments) },
          grant,
          policyContext: noScopes,
        })).rejects.toBeInstanceOf(ApprovalRejectedError);
      } else {
        await expect(gateway.grantApproval(proposal, {
          principalId: proposal.actor.id,
          kind: "human",
          assurance: "authenticated_control_plane",
        }, noScopes)).rejects.toBeInstanceOf(ApprovalRejectedError);
      }
    }
    expect(effects).toHaveLength(50);
  });
});
