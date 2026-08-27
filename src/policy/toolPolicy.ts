import { canonicalHash } from "../domain/canonical";
import {
  type Clock,
  type PolicyDecision,
  type PreparedToolProposal,
  type ToolEffect,
  type ToolManifest,
  systemClock,
} from "../domain/contracts";

export const MAX_APPROVAL_LIFETIME_MS = 5 * 60 * 1000;

export interface PolicyContext {
  readonly grantedDataScopes: readonly string[];
  readonly grantedNetworkScopes: readonly string[];
}

const EFFECTS = new Set<ToolEffect>([
  "pure_compute",
  "external_read",
  "write",
  "delete",
  "message",
  "credential",
  "purchase",
  "financial",
  "local_execution",
  "unknown",
]);

const ASK_EFFECTS = new Set<ToolEffect>([
  "write",
  "delete",
  "message",
  "credential",
  "purchase",
  "financial",
  "local_execution",
]);

function includesEvery(granted: readonly string[], required: readonly string[]): boolean {
  const available = new Set(granted);
  return required.every((scope) => available.has(scope));
}

export function manifestIsComplete(manifest: ToolManifest): boolean {
  return (
    Boolean(manifest.toolId) &&
    Boolean(manifest.version) &&
    /^[a-f0-9]{64}$/.test(manifest.schemaHash) &&
    EFFECTS.has(manifest.effect) &&
    Array.isArray(manifest.dataScope) &&
    manifest.dataScope.every((scope) => typeof scope === "string" && scope.length > 0) &&
    Array.isArray(manifest.networkScope) &&
    manifest.networkScope.every((scope) => typeof scope === "string" && scope.length > 0) &&
    ["idempotent", "non_idempotent"].includes(manifest.idempotency)
  );
}

export class ToolPolicy {
  constructor(
    readonly version: string,
    private readonly clock: Clock = systemClock,
  ) {
    if (!version.trim()) throw new Error("Policy version must not be empty");
  }

  evaluate(proposal: PreparedToolProposal, context: PolicyContext): PolicyDecision {
    const now = this.clock.now().toISOString();
    const manifest = proposal.manifest;

    if (!manifestIsComplete(manifest)) {
      return { outcome: "deny", policyVersion: this.version, reasonCode: "manifest_incomplete", decidedAt: now };
    }
    if (manifest.effect === "unknown") {
      return { outcome: "deny", policyVersion: this.version, reasonCode: "effect_unknown", decidedAt: now };
    }
    if (manifest.effect === "pure_compute") {
      const isActuallyPure =
        manifest.allowPureComputation === true &&
        manifest.dataScope.length === 0 &&
        manifest.networkScope.length === 0;
      return isActuallyPure
        ? { outcome: "allow", policyVersion: this.version, reasonCode: "reviewed_pure_computation", decidedAt: now }
        : { outcome: "deny", policyVersion: this.version, reasonCode: "pure_manifest_has_scope", decidedAt: now };
    }
    if (manifest.effect === "external_read") {
      const inScope =
        includesEvery(context.grantedDataScopes, manifest.dataScope) &&
        includesEvery(context.grantedNetworkScopes, manifest.networkScope);
      return inScope
        ? { outcome: "allow", policyVersion: this.version, reasonCode: "read_scope_granted", decidedAt: now }
        : { outcome: "ask", policyVersion: this.version, reasonCode: "read_scope_requires_approval", decidedAt: now };
    }
    if (ASK_EFFECTS.has(manifest.effect)) {
      return { outcome: "ask", policyVersion: this.version, reasonCode: `effect_${manifest.effect}`, decidedAt: now };
    }
    return { outcome: "deny", policyVersion: this.version, reasonCode: "effect_unclassified", decidedAt: now };
  }
}

export function proposalFingerprint(proposal: PreparedToolProposal): string {
  return canonicalHash({
    proposalId: proposal.proposalId,
    workspaceId: proposal.workspaceId,
    conversationId: proposal.conversationId,
    turnId: proposal.turnId,
    directionEpoch: proposal.directionEpoch ?? 1,
    actor: proposal.actor,
    stableToolId: proposal.manifest.toolId,
    toolVersion: proposal.manifest.version,
    toolSchemaHash: proposal.manifest.schemaHash,
    effect: proposal.manifest.effect,
    argumentsHash: proposal.argumentsHash,
    targetScope: [...proposal.targetScope].sort(),
  });
}

export type ApprovalRejectionCode =
  | "approval_not_applicable"
  | "invalid_approval_lifetime"
  | "grant_unknown"
  | "grant_tampered"
  | "grant_replayed"
  | "grant_expired"
  | "approver_not_authenticated_human"
  | "proposal_mismatch"
  | "actor_mismatch"
  | "workspace_mismatch"
  | "conversation_mismatch"
  | "turn_mismatch"
  | "direction_epoch_mismatch"
  | "tool_mismatch"
  | "schema_mismatch"
  | "arguments_mismatch"
  | "scope_mismatch"
  | "policy_mismatch"
  | "policy_no_longer_asks";

export class ApprovalRejectedError extends Error {
  constructor(readonly reasonCode: ApprovalRejectionCode) {
    super(`Approval rejected (${reasonCode}).`);
    this.name = "ApprovalRejectedError";
  }
}
