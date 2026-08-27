import { randomUUID } from "node:crypto";
import { canonicalHash, canonicalStringify, type JsonValue } from "../domain/canonical";
import {
  asId,
  type Actor,
  type ApprovalGrant,
  type AuditEvent,
  type AuditPayloads,
  type AuditEventType,
  type Clock,
  type DraftAuditEvent,
  type GrantId,
  type PolicyDecision,
  type PreparedToolProposal,
  type ProposalId,
  type ReviewedToolAuthority,
  type ReceiptId,
  type ToolEntryPath,
  type ToolId,
  type ToolManifest,
  systemClock,
} from "../domain/contracts";
import {
  ApprovalRejectedError,
  MAX_APPROVAL_LIFETIME_MS,
  ToolPolicy,
  manifestIsComplete,
  proposalFingerprint,
  type PolicyContext,
} from "../policy/toolPolicy";

export interface ToolAuditPort {
  append<Type extends AuditEventType>(event: DraftAuditEvent<Type>): Promise<AuditEvent<Type>>;
  appendGuarded<Type extends AuditEventType>(
    event: DraftAuditEvent<Type>,
    guard: () => boolean,
  ): Promise<AuditEvent<Type>>;
  appendBatchGuarded(
    events: readonly DraftAuditEvent[],
    guard: () => boolean,
  ): Promise<readonly AuditEvent[]>;
}

export interface AuthenticatedHumanApprover {
  readonly principalId: string;
  readonly kind: "human";
  readonly assurance: "authenticated_control_plane";
}

export interface ToolExecutorContext {
  readonly arguments: JsonValue;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface ToolExecutorResult {
  readonly output: JsonValue;
  readonly outputSummary: string;
}

export type ToolExecutor = (context: ToolExecutorContext) => Promise<ToolExecutorResult>;

export interface ToolRegistration {
  readonly manifest: ToolManifest;
  readonly execute: ToolExecutor;
}

export interface PrepareEffectInput {
  readonly proposalId?: ProposalId;
  readonly workspaceId: PreparedToolProposal["workspaceId"];
  readonly conversationId: PreparedToolProposal["conversationId"];
  readonly turnId: PreparedToolProposal["turnId"];
  readonly directionEpoch?: number;
  readonly actor: Actor;
  readonly toolId: ToolId;
  readonly arguments: JsonValue;
  readonly summary: string;
  readonly reviewedToolAuthority?: ReviewedToolAuthority;
}

export interface ExecuteEffectInput {
  readonly proposal: PreparedToolProposal;
  readonly grant?: ApprovalGrant;
  readonly policyContext: PolicyContext;
  readonly signal?: AbortSignal;
  readonly requireExactGrant?: boolean;
  readonly startCommitGuard?: () => boolean;
  readonly onExecutionStarted?: () => void;
}

export interface ExactGrantOptions {
  readonly requireExactGrant?: boolean;
}

export interface ToolExecutionResult {
  readonly receipt: {
    readonly receiptId: ReceiptId;
    readonly proposalId: ProposalId;
    readonly idempotencyKey: string;
    readonly outcome: "succeeded";
    readonly outputSummary: string;
    readonly startedAt: string;
    readonly finishedAt: string;
  };
  readonly output: JsonValue;
}

export class ToolPreparationError extends Error {
  constructor(readonly reasonCode: "tool_unknown" | "manifest_incomplete" | "proposal_forged") {
    super(`Tool effect was not prepared (${reasonCode}).`);
    this.name = "ToolPreparationError";
  }
}

export class ToolExecutionBlockedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Tool execution stopped (${reasonCode}).`);
    this.name = "ToolExecutionBlockedError";
  }
}

export class ToolOutcomeUnknownError extends Error {
  constructor(message = "The executor cannot determine whether the effect occurred.") {
    super(message);
    this.name = "ToolOutcomeUnknownError";
  }
}

export class ExecutionOutcomeUnknownError extends Error {
  constructor(
    readonly receipt: {
      readonly receiptId: ReceiptId;
      readonly proposalId: ProposalId;
      readonly idempotencyKey: string;
      readonly outcome: "outcome_unknown";
      readonly outputSummary: string;
      readonly startedAt: string;
      readonly finishedAt: string;
    },
  ) {
    super("Execution outcome is unknown. Reconcile it before any retry.");
    this.name = "ExecutionOutcomeUnknownError";
  }
}

interface StoredGrant {
  readonly canonicalToken: string;
  readonly grant: ApprovalGrant;
  consumed: boolean;
}

type AttemptState = "reserved" | "started" | "succeeded" | "failed" | "outcome_unknown" | "denied";

export const MAX_GATEWAY_AUTHORITY_CACHE_ENTRIES = 1_024;

function immutableJson(value: JsonValue): JsonValue {
  return JSON.parse(canonicalStringify(value)) as JsonValue;
}

function cloneManifest(manifest: ToolManifest): ToolManifest {
  return Object.freeze({
    ...manifest,
    dataScope: Object.freeze([...manifest.dataScope]),
    networkScope: Object.freeze([...manifest.networkScope]),
  });
}

export class UniversalToolGateway {
  private readonly registrations = new Map<ToolId, ToolRegistration>();
  private readonly grants = new Map<GrantId, StoredGrant>();
  private readonly attempts = new Map<string, AttemptState>();
  private pendingGrantReservations = 0;
  private readonly pendingAttemptReservations = new Set<string>();
  private policy: ToolPolicy;

  constructor(
    policy: ToolPolicy,
    private readonly audit: ToolAuditPort,
    private readonly clock: Clock = systemClock,
    recoveryEvents: readonly AuditEvent[] = [],
    private readonly authorityCacheMaximum = MAX_GATEWAY_AUTHORITY_CACHE_ENTRIES,
  ) {
    if (!Number.isSafeInteger(authorityCacheMaximum) || authorityCacheMaximum < 1 ||
      authorityCacheMaximum > MAX_GATEWAY_AUTHORITY_CACHE_ENTRIES) {
      throw new ToolExecutionBlockedError("authority_cache_capacity");
    }
    this.policy = policy;
    this.recoverFromAudit(recoveryEvents);
  }

  recoverFromAudit(events: readonly AuditEvent[]): void {
    const proposalFingerprints = new Map<ProposalId, string>();
    for (const event of events) {
      if (event.type === "tool.proposed") {
        const proposal = event.payload as AuditPayloads["tool.proposed"];
        proposalFingerprints.set(proposal.proposal.proposalId, proposal.proposalFingerprint);
      }
      if (event.type === "approval.granted") {
        const grant = (event.payload as AuditPayloads["approval.granted"]).grant;
        this.storeRecoveredGrant(grant.grantId, {
          grant,
          canonicalToken: canonicalStringify(grant),
          consumed: true,
        });
        this.setRecoveredAttempt(grant.proposalFingerprint, "reserved");
      }
    }
    for (const event of events) {
      if (event.type === "approval.denied") {
        const denied = event.payload as AuditPayloads["approval.denied"];
        const fingerprint = proposalFingerprints.get(denied.proposalId);
        if (fingerprint) this.setRecoveredAttempt(fingerprint, "denied");
        continue;
      }
      if (
        event.type !== "tool.execution.started" &&
        event.type !== "tool.execution.succeeded" &&
        event.type !== "tool.execution.failed" &&
        event.type !== "tool.execution.uncertain"
      ) {
        continue;
      }
      const item = event.payload as
        | AuditPayloads["tool.execution.started"]
        | AuditPayloads["tool.execution.succeeded"]
        | AuditPayloads["tool.execution.failed"]
        | AuditPayloads["tool.execution.uncertain"];
      const fingerprint = "idempotencyKey" in item ? item.idempotencyKey : item.receipt.idempotencyKey;
      if (event.type === "tool.execution.succeeded") this.setRecoveredAttempt(fingerprint, "succeeded");
      else if (event.type === "tool.execution.failed") this.setRecoveredAttempt(fingerprint, "failed");
      else this.setRecoveredAttempt(fingerprint, "outcome_unknown");
    }
  }

  registerTool(registration: ToolRegistration): void {
    if (!manifestIsComplete(registration.manifest)) {
      throw new ToolPreparationError("manifest_incomplete");
    }
    if (this.registrations.has(registration.manifest.toolId)) {
      throw new Error(`Tool is already registered: ${registration.manifest.toolId}`);
    }
    this.registrations.set(registration.manifest.toolId, {
      manifest: cloneManifest(registration.manifest),
      execute: registration.execute,
    });
  }

  replacePolicy(policy: ToolPolicy): void {
    this.policy = policy;
  }

  authorityCacheSizes(): Readonly<{ grants: number; attempts: number }> {
    return Object.freeze({ grants: this.grants.size, attempts: this.attempts.size });
  }

  prepare(input: PrepareEffectInput): PreparedToolProposal {
    if (input.directionEpoch !== undefined &&
      (!Number.isSafeInteger(input.directionEpoch) || input.directionEpoch < 1)) {
      throw new ToolPreparationError("proposal_forged");
    }
    const registration = this.registrations.get(input.toolId);
    if (!registration) throw new ToolPreparationError("tool_unknown");
    if (!manifestIsComplete(registration.manifest)) throw new ToolPreparationError("manifest_incomplete");
    if (input.reviewedToolAuthority !== undefined) {
      const authority = input.reviewedToolAuthority;
      if (authority === null || typeof authority !== "object" || Array.isArray(authority) ||
        Object.getPrototypeOf(authority) !== Object.prototype ||
        Object.keys(authority).sort().join("\u0000") !== ["manifestHash", "schemaHash", "toolId"].sort().join("\u0000") ||
        authority.toolId !== registration.manifest.toolId ||
        authority.schemaHash !== registration.manifest.schemaHash ||
        authority.manifestHash !== canonicalHash(registration.manifest)) {
        throw new ToolPreparationError("proposal_forged");
      }
    }

    const canonicalArguments = immutableJson(input.arguments);
    const targetScope = [
      ...registration.manifest.dataScope.map((scope) => `data:${scope}`),
      ...registration.manifest.networkScope.map((scope) => `network:${scope}`),
    ].sort();
    return Object.freeze({
      proposalId: input.proposalId ?? asId<ProposalId>(randomUUID(), "proposal ID"),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      ...(input.directionEpoch === undefined ? {} : { directionEpoch: input.directionEpoch }),
      actor: Object.freeze({ ...input.actor }),
      manifest: registration.manifest,
      arguments: canonicalArguments,
      argumentsHash: canonicalHash(canonicalArguments),
      targetScope: Object.freeze(targetScope),
      summary: input.summary,
      preparedAt: this.clock.now().toISOString(),
    });
  }

  async evaluateAndRecord(
    proposal: PreparedToolProposal,
    context: PolicyContext,
    options: ExactGrantOptions = {},
  ): Promise<PolicyDecision> {
    this.assertPrepared(proposal);
    const decision = this.effectiveDecision(proposal, context, options.requireExactGrant === true);
    await this.audit.append(
      this.event(proposal, "policy.decided", {
        turnId: proposal.turnId,
        proposalId: proposal.proposalId,
        decision,
      }),
    );
    return decision;
  }

  async grantApproval(
    proposal: PreparedToolProposal,
    approver: AuthenticatedHumanApprover,
    context: PolicyContext,
    lifetimeMs = MAX_APPROVAL_LIFETIME_MS,
    options: ExactGrantOptions = {},
  ): Promise<ApprovalGrant> {
    this.assertPrepared(proposal);
    const priorState = this.attempts.get(proposalFingerprint(proposal));
    if (
      priorState === "succeeded" ||
      priorState === "outcome_unknown" ||
      priorState === "reserved" ||
      priorState === "started" ||
      priorState === "denied"
    ) {
      throw new ToolExecutionBlockedError("terminal_attempt_requires_reconciliation");
    }
    if (
      approver.kind !== "human" ||
      approver.assurance !== "authenticated_control_plane" ||
      !approver.principalId ||
      approver.principalId === proposal.actor.id
    ) {
      throw new ApprovalRejectedError("approver_not_authenticated_human");
    }
    if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > MAX_APPROVAL_LIFETIME_MS) {
      throw new ApprovalRejectedError("invalid_approval_lifetime");
    }

    const freshDecision = this.effectiveDecision(proposal, context, options.requireExactGrant === true);
    if (freshDecision.outcome !== "ask") {
      throw new ApprovalRejectedError("approval_not_applicable");
    }
    const grantedAt = this.clock.now();
    const grant: ApprovalGrant = Object.freeze({
      grantId: asId<GrantId>(randomUUID(), "grant ID"),
      proposalFingerprint: proposalFingerprint(proposal),
      principalId: approver.principalId,
      proposingActorId: proposal.actor.id,
      workspaceId: proposal.workspaceId,
      conversationId: proposal.conversationId,
      turnId: proposal.turnId,
      ...(proposal.directionEpoch === undefined ? {} : { directionEpoch: proposal.directionEpoch }),
      stableToolId: proposal.manifest.toolId,
      toolSchemaHash: proposal.manifest.schemaHash,
      argumentsHash: proposal.argumentsHash,
      targetScope: Object.freeze([...proposal.targetScope].sort()),
      policyVersion: freshDecision.policyVersion,
      grantedAt: grantedAt.toISOString(),
      expiresAt: new Date(grantedAt.getTime() + lifetimeMs).toISOString(),
      nonce: randomUUID(),
      maximumUseCount: 1,
    });

    const releaseGrantSlot = this.reserveGrantSlot();
    try {
      await this.audit.append(
        this.event(proposal, "approval.granted", { turnId: proposal.turnId, grant }),
      );
      this.grants.set(grant.grantId, {
        grant,
        canonicalToken: canonicalStringify(grant),
        consumed: false,
      });
    } finally {
      releaseGrantSlot();
    }
    return grant;
  }

  async denyApproval(
    proposal: PreparedToolProposal,
    reasonCode = "human_denied",
    commitGuard: () => boolean = () => true,
  ): Promise<void> {
    this.assertPrepared(proposal);
    const fingerprint = proposalFingerprint(proposal);
    const priorState = this.attempts.get(fingerprint);
    if (priorState) throw new ToolExecutionBlockedError(`cannot_deny_${priorState}`);
    const releaseAttemptSlot = this.reserveAttemptSlot(fingerprint);
    try {
      await this.audit.appendGuarded(
        this.event(proposal, "approval.denied", {
          turnId: proposal.turnId,
          proposalId: proposal.proposalId,
          reasonCode,
        }),
        commitGuard,
      );
      this.attempts.set(fingerprint, "denied");
    } finally {
      releaseAttemptSlot();
    }
  }

  executeDirect(input: ExecuteEffectInput): Promise<ToolExecutionResult> {
    return this.execute("direct", input);
  }

  executeRouted(input: ExecuteEffectInput): Promise<ToolExecutionResult> {
    return this.execute("routed", input);
  }

  executeRetry(input: ExecuteEffectInput): Promise<ToolExecutionResult> {
    return this.execute("retry", input);
  }

  executeResume(input: ExecuteEffectInput): Promise<ToolExecutionResult> {
    return this.execute("resume", input);
  }

  private async execute(entryPath: ToolEntryPath, input: ExecuteEffectInput): Promise<ToolExecutionResult> {
    const { proposal } = input;
    const registration = this.assertPrepared(proposal);
    const fingerprint = proposalFingerprint(proposal);
    const priorState = this.attempts.get(fingerprint);
    if (priorState === "succeeded") throw new ToolExecutionBlockedError("already_succeeded");
    if (priorState === "outcome_unknown") throw new ToolExecutionBlockedError("reconciliation_required");
    if (priorState === "reserved") throw new ToolExecutionBlockedError("reconciliation_required");
    if (priorState === "started") throw new ToolExecutionBlockedError("already_in_progress");
    if (priorState === "denied") throw new ToolExecutionBlockedError("human_denied");

    const freshDecision = this.effectiveDecision(
      proposal,
      input.policyContext,
      input.requireExactGrant === true,
    );
    if (freshDecision.outcome === "deny") {
      throw new ToolExecutionBlockedError(freshDecision.reasonCode);
    }
    let grantToConsume: StoredGrant | undefined;
    if (freshDecision.outcome === "ask") {
      if (!input.grant) throw new ApprovalRejectedError("grant_unknown");
      try {
        grantToConsume = this.validateGrant(input.grant, proposal, freshDecision);
      } catch (error) {
        if (error instanceof ApprovalRejectedError && error.reasonCode === "grant_expired") {
          await this.audit.append(
            this.event(proposal, "approval.expired", {
              turnId: proposal.turnId,
              proposalId: proposal.proposalId,
              grantId: input.grant.grantId,
            }),
          );
        }
        throw error;
      }
    }

    const idempotencyKey = fingerprint;
    const startedAt = this.clock.now().toISOString();
    const releaseAttemptSlot = this.reserveAttemptSlot(fingerprint);
    try {
      if (grantToConsume) grantToConsume.consumed = true;
      this.attempts.set(fingerprint, "reserved");
      if (input.signal?.aborted) {
        throw new ToolExecutionBlockedError("turn_or_direction_retired");
      }
      const startEvent = this.event(proposal, "tool.execution.started", {
        turnId: proposal.turnId,
        proposalId: proposal.proposalId,
        idempotencyKey,
        entryPath,
      });
      const events: DraftAuditEvent[] = grantToConsume && input.grant
        ? [
            this.event(proposal, "approval.consumed", {
              turnId: proposal.turnId,
              proposalId: proposal.proposalId,
              grantId: input.grant.grantId,
            }),
            startEvent,
          ]
        : [startEvent];
      await this.audit.appendBatchGuarded(
        events,
        () => (input.startCommitGuard?.() ?? true) && input.signal?.aborted !== true,
      );
      this.attempts.set(fingerprint, "started");
    } finally {
      releaseAttemptSlot();
    }

    try {
      input.onExecutionStarted?.();
      const result = await registration.execute({
        arguments: proposal.arguments,
        idempotencyKey,
        signal: input.signal ?? new AbortController().signal,
      });
      const receipt = Object.freeze({
        receiptId: asId<ReceiptId>(randomUUID(), "receipt ID"),
        proposalId: proposal.proposalId,
        idempotencyKey,
        outcome: "succeeded" as const,
        outputSummary: result.outputSummary,
        startedAt,
        finishedAt: this.clock.now().toISOString(),
      });
      try {
        await this.audit.append(
          this.event(proposal, "tool.execution.succeeded", { turnId: proposal.turnId, receipt }),
        );
      } catch {
        this.attempts.set(fingerprint, "outcome_unknown");
        const uncertain = { ...receipt, outcome: "outcome_unknown" as const };
        throw new ExecutionOutcomeUnknownError(uncertain);
      }
      this.attempts.set(fingerprint, "succeeded");
      return { receipt, output: result.output };
    } catch (error) {
      if (error instanceof ExecutionOutcomeUnknownError) throw error;

      const unknown = error instanceof ToolOutcomeUnknownError;
      const receipt = Object.freeze({
        receiptId: asId<ReceiptId>(randomUUID(), "receipt ID"),
        proposalId: proposal.proposalId,
        idempotencyKey,
        outcome: unknown ? ("outcome_unknown" as const) : ("failed" as const),
        outputSummary: unknown ? "Execution requires reconciliation." : "Execution failed before a confirmed effect.",
        startedAt,
        finishedAt: this.clock.now().toISOString(),
      });
      this.attempts.set(fingerprint, receipt.outcome);
      await this.audit.append(
        this.event(
          proposal,
          unknown ? "tool.execution.uncertain" : "tool.execution.failed",
          { turnId: proposal.turnId, receipt } as never,
        ),
      );
      if (unknown) throw new ExecutionOutcomeUnknownError({ ...receipt, outcome: "outcome_unknown" });
      throw error;
    }
  }

  private validateGrant(
    presented: ApprovalGrant,
    proposal: PreparedToolProposal,
    freshDecision: PolicyDecision,
  ): StoredGrant {
    const stored = this.grants.get(presented.grantId);
    if (!stored) throw new ApprovalRejectedError("grant_unknown");
    if (stored.canonicalToken !== canonicalStringify(presented)) {
      throw new ApprovalRejectedError("grant_tampered");
    }
    if (stored.consumed) throw new ApprovalRejectedError("grant_replayed");
    const grant = stored.grant;
    if (this.clock.now().getTime() >= Date.parse(grant.expiresAt)) {
      throw new ApprovalRejectedError("grant_expired");
    }
    if (grant.proposingActorId !== proposal.actor.id) throw new ApprovalRejectedError("actor_mismatch");
    if (grant.workspaceId !== proposal.workspaceId) throw new ApprovalRejectedError("workspace_mismatch");
    if (grant.conversationId !== proposal.conversationId) {
      throw new ApprovalRejectedError("conversation_mismatch");
    }
    if (grant.turnId !== proposal.turnId) throw new ApprovalRejectedError("turn_mismatch");
    if ((grant.directionEpoch ?? 1) !== (proposal.directionEpoch ?? 1)) {
      throw new ApprovalRejectedError("direction_epoch_mismatch");
    }
    if (grant.stableToolId !== proposal.manifest.toolId) throw new ApprovalRejectedError("tool_mismatch");
    if (grant.toolSchemaHash !== proposal.manifest.schemaHash) {
      throw new ApprovalRejectedError("schema_mismatch");
    }
    if (grant.argumentsHash !== proposal.argumentsHash) {
      throw new ApprovalRejectedError("arguments_mismatch");
    }
    if (canonicalStringify(grant.targetScope) !== canonicalStringify([...proposal.targetScope].sort())) {
      throw new ApprovalRejectedError("scope_mismatch");
    }
    if (grant.policyVersion !== freshDecision.policyVersion) {
      throw new ApprovalRejectedError("policy_mismatch");
    }
    if (freshDecision.outcome !== "ask") {
      throw new ApprovalRejectedError("policy_no_longer_asks");
    }
    if (grant.proposalFingerprint !== proposalFingerprint(proposal)) {
      throw new ApprovalRejectedError("proposal_mismatch");
    }
    return stored;
  }

  private effectiveDecision(
    proposal: PreparedToolProposal,
    context: PolicyContext,
    requireExactGrant: boolean,
  ): PolicyDecision {
    const decision = this.policy.evaluate(proposal, context);
    if (!requireExactGrant || decision.outcome !== "allow") return decision;
    return Object.freeze({
      ...decision,
      outcome: "ask" as const,
      reasonCode: "provider_proposal_requires_exact_grant",
    });
  }

  private assertPrepared(proposal: PreparedToolProposal): ToolRegistration {
    const registration = this.registrations.get(proposal.manifest.toolId);
    if (!registration) throw new ToolPreparationError("tool_unknown");
    if (
      canonicalHash(registration.manifest) !== canonicalHash(proposal.manifest) ||
      proposal.argumentsHash !== canonicalHash(proposal.arguments)
    ) {
      throw new ToolPreparationError("proposal_forged");
    }
    return registration;
  }

  private reserveGrantSlot(): () => void {
    const now = this.clock.now().getTime();
    for (const [grantId, stored] of this.grants) {
      if (this.grants.size + this.pendingGrantReservations < this.authorityCacheMaximum) break;
      if (stored.consumed || Date.parse(stored.grant.expiresAt) <= now) this.grants.delete(grantId);
    }
    if (this.grants.size + this.pendingGrantReservations >= this.authorityCacheMaximum) {
      throw new ToolExecutionBlockedError("authority_cache_capacity");
    }
    this.pendingGrantReservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingGrantReservations -= 1;
    };
  }

  private reserveAttemptSlot(fingerprint: string): () => void {
    if (!this.attempts.has(fingerprint) &&
      (this.attempts.size + this.pendingAttemptReservations.size >= this.authorityCacheMaximum ||
        this.pendingAttemptReservations.has(fingerprint))) {
      throw new ToolExecutionBlockedError("authority_cache_capacity");
    }
    if (this.attempts.has(fingerprint)) return () => undefined;
    this.pendingAttemptReservations.add(fingerprint);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingAttemptReservations.delete(fingerprint);
    };
  }

  private setRecoveredAttempt(fingerprint: string, state: AttemptState): void {
    if (!this.attempts.has(fingerprint) && this.attempts.size >= this.authorityCacheMaximum) {
      throw new ToolExecutionBlockedError("authority_cache_capacity");
    }
    this.attempts.set(fingerprint, state);
  }

  private storeRecoveredGrant(grantId: GrantId, grant: StoredGrant): void {
    while (!this.grants.has(grantId) && this.grants.size >= this.authorityCacheMaximum) {
      const oldest = this.grants.keys().next();
      if (oldest.done) break;
      this.grants.delete(oldest.value);
    }
    this.grants.set(grantId, grant);
  }

  private event<Type extends AuditEventType>(
    proposal: PreparedToolProposal,
    type: Type,
    payload: DraftAuditEvent<Type>["payload"],
  ): DraftAuditEvent<Type> {
    return {
      eventId: asId(randomUUID(), "event ID"),
      workspaceId: proposal.workspaceId,
      conversationId: proposal.conversationId,
      actor: { kind: "system", id: "tool-gateway", label: "Tool gateway" },
      timestamp: this.clock.now().toISOString(),
      payloadSchemaVersion: 1,
      type,
      payload,
    };
  }
}
