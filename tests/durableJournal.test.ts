import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify, sha256Hex } from "../src/domain/canonical";
import {
  asId,
  normalizeProviderSelectionEvidence,
  type AgentId,
  type ConversationId,
  type DraftAuditEvent,
  type EventId,
  type MessageId,
  type ProviderId,
  type SectionId,
  type TurnId,
  type WorkspaceId,
} from "../src/domain/contracts";
import {
  DurableJournal,
  GENESIS_HASH,
  JournalCorruptionError,
  JournalLockError,
  JournalUnavailableError,
} from "../src/storage/durableJournal";
import { TempArea } from "./helpers";

const temporary = new TempArea();
afterEach(() => temporary.cleanup());

const workspaceId = asId<WorkspaceId>("ws-journal");
const trancheTwoTimestamp = "2026-08-26T06:00:00.000Z";

function trancheTwoBase(
  eventId: string,
  actor: { kind: "human" | "system"; id: string } = { kind: "human", id: "human-journal" },
) {
  return {
    eventId: asId<EventId>(eventId),
    workspaceId,
    actor,
    timestamp: trancheTwoTimestamp,
    payloadSchemaVersion: 1 as const,
  };
}

function profileCreatedEvent(eventId = "profile-created"): DraftAuditEvent<"agent.profile.created"> {
  return {
    ...trancheTwoBase(eventId),
    type: "agent.profile.created",
    payload: {
      agentId: asId<AgentId>("agent-tranche-two"),
      clientRequestId: `client-${eventId}`,
      displayName: "Research Relay",
      roleTitle: "Research agent",
      colorToken: "relay-cobalt",
      markToken: "orbit",
      status: "idle",
      createdAt: trancheTwoTimestamp,
      updatedAt: trancheTwoTimestamp,
      revision: 1,
    },
  };
}

function statusEvent(index: number, conversation = `conv-${index % 7}`): DraftAuditEvent<"agent.status.changed"> {
  return {
    eventId: asId<EventId>(`event-${index}`),
    workspaceId,
    conversationId: asId<ConversationId>(conversation),
    actor: { kind: "system", id: "test-harness" },
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    payloadSchemaVersion: 1,
    type: "agent.status.changed",
    payload: { agentId: `agent-${index}`, status: `state-${index}` },
  };
}

describe("DurableJournal", () => {
  it("writes enriched provider selection as schema v2, rejects incomplete new evidence, and replays legacy v1", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "provider-schema.journal");
    const conversationId = asId<ConversationId>("conversation-provider-schema");
    const turnId = asId<TurnId>("turn-provider-schema");
    const journal = await DurableJournal.open(path);
    await journal.append({
      ...trancheTwoBase("provider-workspace", { kind: "human", id: "human" }),
      type: "workspace.created",
      payload: { name: "Provider workspace", createdAt: trancheTwoTimestamp },
    });
    await journal.append({
      ...trancheTwoBase("provider-conversation", { kind: "human", id: "human" }),
      conversationId,
      type: "conversation.created",
      payload: { title: "Provider conversation", createdAt: trancheTwoTimestamp },
    });
    await journal.append({
      ...trancheTwoBase("provider-user", { kind: "human", id: "human" }),
      conversationId,
      type: "user.message.accepted",
      payload: {
        messageId: asId<MessageId>("message-provider-schema"),
        turnId,
        clientRequestId: "provider-schema-client",
        content: "hello",
      },
    });
    const enriched = {
      ...trancheTwoBase("provider-selected-v2", { kind: "system", id: "provider-router" }),
      payloadSchemaVersion: 2 as const,
      conversationId,
      type: "provider.selected" as const,
      payload: {
        turnId,
        providerId: asId<ProviderId>("openai"),
        modelId: "gpt-exact",
        protocolRevision: "openai-v1",
        credentialBindingRevision: "bind_openai_schema_00000001" as never,
        providerRequestId: "prv_provider_schema_00000001" as never,
        fallbackIndex: 0,
      },
    };
    const written = await journal.append(enriched);
    expect(written.payloadSchemaVersion).toBe(2);
    expect(JSON.stringify(written)).not.toContain("credentialHandle");

    const beforeRejected = await readFile(path);
    await expect(journal.append({
      ...enriched,
      eventId: asId<EventId>("provider-selected-v1-new"),
      payloadSchemaVersion: 1,
    } as never)).rejects.toBeInstanceOf(JournalUnavailableError);
    await expect(journal.append({
      ...enriched,
      eventId: asId<EventId>("provider-selected-extra-authority"),
      payload: { ...enriched.payload, credentialHandle: "cred_forbidden", providerAttemptId: "att_forbidden" },
    } as never)).rejects.toBeInstanceOf(JournalUnavailableError);
    expect(await readFile(path)).toEqual(beforeRejected);
    await journal.close();

    const records = (await readFile(path, "utf8")).trim().split("\n").map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const last = records.at(-1)!;
    const payload = last.payload as Record<string, unknown>;
    const legacyWithoutHash: Record<string, unknown> = {
      ...last,
      payloadSchemaVersion: 1,
      payload: {
        turnId: payload.turnId,
        providerId: payload.providerId,
        modelId: payload.modelId,
        fallbackIndex: payload.fallbackIndex,
      },
    };
    delete legacyWithoutHash.currentHash;
    records[records.length - 1] = {
      ...legacyWithoutHash,
      currentHash: sha256Hex(canonicalStringify(legacyWithoutHash)),
    };
    await writeFile(path, `${records.map(canonicalStringify).join("\n")}\n`);
    const reopened = await DurableJournal.open(path);
    expect(reopened.snapshot().at(-1)?.payloadSchemaVersion).toBe(1);
    const legacyEvidence = normalizeProviderSelectionEvidence(
      reopened.snapshot().at(-1) as never,
    );
    expect(legacyEvidence).toMatchObject({
      authorityKind: "legacy_unattested",
      payloadSchemaVersion: 1,
    });
    expect("credentialBindingRevision" in legacyEvidence.payload).toBe(false);
    await reopened.close();
  });

  it("serializes 200 concurrent cross-conversation appends with no loss or duplicate acknowledgement", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "events.journal");
    const journal = await DurableJournal.open(path);

    const acknowledgements = await Promise.all(
      Array.from({ length: 200 }, (_, index) => journal.append(statusEvent(index))),
    );
    expect(acknowledgements).toHaveLength(200);
    expect(new Set(acknowledgements.map((event) => event.eventId))).toHaveLength(200);
    expect(journal.snapshot().map((event) => event.globalSequence)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    expect(new Set(journal.snapshot().map((event) => event.currentHash)).size).toBe(200);

    const beforeRestart = journal.snapshot();
    await journal.close();
    const reopened = await DurableJournal.open(path);
    expect(reopened.snapshot()).toEqual(beforeRestart);
    await reopened.close();
  });

  it("rejects duplicate event IDs in an existing journal and within a batch before writing", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "duplicates.journal");
    const journal = await DurableJournal.open(path);
    await journal.append(statusEvent(1));
    const before = await readFile(path);

    await expect(journal.append(statusEvent(1, "another-conversation"))).rejects.toBeInstanceOf(
      JournalUnavailableError,
    );
    const duplicate = { ...statusEvent(3), eventId: statusEvent(2).eventId };
    await expect(journal.appendBatch([statusEvent(2), duplicate])).rejects.toBeInstanceOf(
      JournalUnavailableError,
    );
    expect(await readFile(path)).toEqual(before);
    await journal.close();

    const first = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>;
    const rewrittenSecond: Record<string, unknown> = {
      ...first,
      eventId: first.eventId,
      globalSequence: 2,
      previousHash: first.currentHash,
      timestamp: new Date(1_700_000_000_099).toISOString(),
      payload: { agentId: "agent-duplicate", status: "otherwise-valid" },
    };
    delete rewrittenSecond.currentHash;
    const withHash = { ...rewrittenSecond, currentHash: sha256Hex(canonicalStringify(rewrittenSecond)) };
    await writeFile(path, `${canonicalStringify(first)}\n${canonicalStringify(withHash)}\n`);
    const originalBytes = await readFile(path);
    await expect(DurableJournal.open(path)).rejects.toMatchObject({ reasonCode: "duplicate_event_id" });
    expect(await readFile(path)).toEqual(originalBytes);
  });

  it("fails closed for truncation and checksum mutation while preserving every original byte", async () => {
    const directory = await temporary.directory();
    const sourcePath = join(directory, "source.journal");
    const journal = await DurableJournal.open(sourcePath);
    await journal.append(statusEvent(10));
    await journal.append(statusEvent(11));
    await journal.close();
    const valid = await readFile(sourcePath);

    const truncatedPath = join(directory, "truncated.journal");
    const truncated = valid.subarray(0, valid.length - 5);
    await writeFile(truncatedPath, truncated);
    await expect(DurableJournal.open(truncatedPath)).rejects.toMatchObject({ reasonCode: "truncated_frame" });
    expect(await readFile(truncatedPath)).toEqual(truncated);

    const checksumPath = join(directory, "checksum.journal");
    const mutated = Buffer.from(valid);
    const marker = mutated.indexOf(Buffer.from("state-10"));
    expect(marker).toBeGreaterThan(0);
    mutated[marker] = "S".charCodeAt(0);
    await writeFile(checksumPath, mutated);
    await expect(DurableJournal.open(checksumPath)).rejects.toBeInstanceOf(JournalCorruptionError);
    expect(await readFile(checksumPath)).toEqual(mutated);
  });

  it("locks out a second live writer and safely recovers a dead-PID crash lock", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "locked.journal");
    const first = await DurableJournal.open(path);
    await expect(DurableJournal.open(path)).rejects.toBeInstanceOf(JournalLockError);
    const fixture = join(process.cwd(), "tests/fixtures/journalProcess.ts");
    const runner = join(process.cwd(), "node_modules/vite-node/vite-node.mjs");
    const contender = spawn(process.execPath, [runner, fixture, path, "attempt"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let contenderOutput = "";
    contender.stdout.setEncoding("utf8");
    contender.stdout.on("data", (chunk: string) => { contenderOutput += chunk; });
    await once(contender, "exit");
    expect(contenderOutput).toContain("LOCKED");
    await first.close();

    const crashWriter = spawn(process.execPath, [runner, fixture, path, "hold"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    crashWriter.stdout.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
      crashWriter.stdout.on("data", (chunk: string) => {
        if (chunk.includes("READY")) resolve();
      });
      crashWriter.once("error", reject);
      crashWriter.once("exit", (code) => {
        if (code !== null) reject(new Error(`Crash writer exited before READY (${code})`));
      });
    });
    crashWriter.kill("SIGKILL");
    await once(crashWriter, "exit");

    const recovered = await DurableJournal.open(path);
    await recovered.append(statusEvent(21));
    expect(recovered.snapshot()).toHaveLength(1);
    await recovered.close();
  });

  it("poisons the writer after any post-write failure and permits inspection after reopen", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "faulted.journal");
    let injected = false;
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach(phase) {
          if (phase === "after_write_before_sync" && !injected) {
            injected = true;
            throw new Error("injected persistence fault");
          }
        },
      },
    });
    await expect(journal.append(statusEvent(30))).rejects.toThrow("injected persistence fault");
    await expect(journal.append(statusEvent(31))).rejects.toBeInstanceOf(JournalUnavailableError);
    await journal.close();

    const reopened = await DurableJournal.open(path);
    expect(reopened.snapshot().map((event) => event.eventId)).toEqual(["event-30"]);
    await reopened.close();
  });

  it("validates drafts at runtime before assigning a sequence or touching journal bytes", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "validation.journal");
    const journal = await DurableJournal.open(path);
    const invalid = {
      ...statusEvent(40),
      payload: { agentId: "agent", status: "ready", injected: true },
    } as unknown as DraftAuditEvent<"agent.status.changed">;
    await expect(journal.append(invalid)).rejects.toMatchObject({
      message: expect.stringContaining("invalid_draft_payload_fields"),
    });
    expect(journal.nextSequence).toBe(1);
    await journal.append(statusEvent(41));
    expect(journal.snapshot()).toHaveLength(1);
    await journal.close();
  });

  it("rejects wrong primitive, enum, proposal, grant, and receipt shapes before write", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "deep-validation.journal");
    const journal = await DurableJournal.open(path);
    const conversationId = asId<ConversationId>("conv-deep-validation");
    const turnId = "turn-deep-validation";
    const base = {
      workspaceId,
      conversationId,
      actor: { kind: "system" as const, id: "schema-test" },
      timestamp: "2026-08-26T00:00:00.000Z",
      payloadSchemaVersion: 1 as const,
    };
    const manifest = {
      toolId: "tool.schema-test",
      version: "1.0.0",
      schemaHash: "a".repeat(64),
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    };
    const proposal = {
      proposalId: "proposal-schema-test",
      workspaceId,
      conversationId,
      turnId,
      actor: { kind: "agent", id: "agent-schema-test" },
      manifest,
      argumentsHash: "b".repeat(64),
      targetScope: ["data:workspace/notes"],
      summary: "Schema validation",
      preparedAt: "2026-08-26T00:00:00.000Z",
    };
    const grant = {
      grantId: "grant-schema-test",
      proposalFingerprint: "c".repeat(64),
      principalId: "human-owner",
      proposingActorId: "agent-schema-test",
      workspaceId,
      conversationId,
      turnId,
      stableToolId: "tool.schema-test",
      toolSchemaHash: "a".repeat(64),
      argumentsHash: "b".repeat(64),
      targetScope: ["data:workspace/notes"],
      policyVersion: "policy-1",
      grantedAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-08-26T00:05:00.000Z",
      nonce: "nonce-schema-test",
      maximumUseCount: 1,
    };
    const receipt = {
      receiptId: "receipt-schema-test",
      proposalId: "proposal-schema-test",
      idempotencyKey: "c".repeat(64),
      outcome: "succeeded",
      outputSummary: "Done.",
      startedAt: "2026-08-26T00:00:00.000Z",
      finishedAt: "2026-08-26T00:00:01.000Z",
    };
    const malformed = [
      {
        ...base,
        eventId: asId<EventId>("malformed-message-id"),
        type: "user.message.accepted",
        payload: { messageId: 42, turnId, clientRequestId: "client", content: "content" },
      },
      {
        ...base,
        eventId: asId<EventId>("malformed-stop-reason"),
        type: "assistant.stream.completed",
        payload: { streamId: "stream", turnId, stopReason: "silently_done" },
      },
      {
        ...base,
        eventId: asId<EventId>("malformed-terminal-cost"),
        type: "assistant.stream.completed",
        payload: { streamId: "stream", turnId, stopReason: "tool_pause", costUnits: -1 },
      },
      {
        ...base,
        eventId: asId<EventId>("malformed-proposal"),
        type: "tool.proposed",
        payload: {
          turnId,
          proposal: { ...proposal, manifest: { ...manifest, effect: "model_says_safe" } },
          proposalFingerprint: "c".repeat(64),
          providerId: "provider",
        },
      },
      {
        ...base,
        eventId: asId<EventId>("malformed-grant"),
        type: "approval.granted",
        payload: { turnId, grant: { ...grant, maximumUseCount: 2 } },
      },
      {
        ...base,
        eventId: asId<EventId>("malformed-receipt"),
        type: "tool.execution.succeeded",
        payload: { turnId, receipt: { ...receipt, outcome: "failed" } },
      },
    ];

    for (const draft of malformed) {
      await expect(journal.append(draft as unknown as DraftAuditEvent)).rejects.toMatchObject({
        message: expect.stringContaining("invalid_draft_payload_shape"),
      });
    }
    expect(journal.snapshot()).toHaveLength(0);
    await journal.append(statusEvent(60, conversationId));
    expect(journal.snapshot()).toHaveLength(1);
    await journal.close();
  });

  it("rejects a checksummed replay record with an invalid nested enum and preserves its bytes", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "deep-replay.journal");
    const journal = await DurableJournal.open(path);
    const valid = {
      eventId: asId<EventId>("event-valid-completion"),
      workspaceId,
      conversationId: asId<ConversationId>("conv-deep-replay"),
      actor: { kind: "provider" as const, id: "provider" },
      timestamp: "2026-08-26T00:00:00.000Z",
      payloadSchemaVersion: 1 as const,
      type: "assistant.stream.completed" as const,
      payload: { streamId: "stream", turnId: asId<TurnId>("turn"), stopReason: "complete" as const },
    };
    await journal.append(valid);
    await journal.close();

    const record = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>;
    record.payload = { ...(record.payload as Record<string, unknown>), stopReason: "invalid_terminal" };
    delete record.currentHash;
    const mutated = {
      ...record,
      currentHash: sha256Hex(canonicalStringify(record)),
    };
    const bytes = Buffer.from(`${canonicalStringify(mutated)}\n`);
    await writeFile(path, bytes);
    await expect(DurableJournal.open(path)).rejects.toMatchObject({
      reasonCode: "invalid_event_payload_shape",
    });
    expect(await readFile(path)).toEqual(bytes);
  });

  it("accepts every tranche-two event contract with the required workspace or conversation scope", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "tranche-two-contracts.journal");
    const journal = await DurableJournal.open(path);
    const conversationId = asId<ConversationId>("conv-tranche-two");
    const human = { kind: "human" as const, id: "human-journal" };
    const system = { kind: "system" as const, id: "control-kernel" };
    const conversationBase = {
      workspaceId,
      conversationId,
      timestamp: trancheTwoTimestamp,
      payloadSchemaVersion: 1 as const,
    };
    const drafts: readonly DraftAuditEvent[] = [
      profileCreatedEvent("contract-profile-created"),
      {
        ...trancheTwoBase("contract-profile-updated"),
        type: "agent.profile.updated",
        payload: {
          agentId: asId<AgentId>("agent-tranche-two"), clientRequestId: "client-profile-updated",
          expectedRevision: 1, displayName: "Research Relay", roleTitle: "Senior research agent",
          colorToken: "mineral-mint", markToken: "bridge", status: "working",
          updatedAt: trancheTwoTimestamp, revision: 2,
        },
      },
      {
        ...trancheTwoBase("contract-section-created"),
        type: "section.created",
        payload: {
          sectionId: asId<SectionId>("section-research"), clientRequestId: "client-section-created",
          name: "Research", orderKey: 10, createdAt: trancheTwoTimestamp,
          updatedAt: trancheTwoTimestamp, revision: 1,
        },
      },
      {
        ...trancheTwoBase("contract-section-renamed"),
        type: "section.renamed",
        payload: {
          sectionId: asId<SectionId>("section-research"), clientRequestId: "client-section-renamed",
          expectedRevision: 1, name: "Deep Research", updatedAt: trancheTwoTimestamp, revision: 2,
        },
      },
      {
        ...trancheTwoBase("contract-section-reordered"),
        type: "section.reordered",
        payload: {
          sectionId: asId<SectionId>("section-research"), clientRequestId: "client-section-reordered",
          expectedRevision: 2, orderKey: 20, updatedAt: trancheTwoTimestamp, revision: 3,
        },
      },
      {
        ...trancheTwoBase("contract-agent-section-user"),
        type: "agent.section.changed",
        payload: {
          agentId: asId<AgentId>("agent-tranche-two"), clientRequestId: "client-agent-section-user",
          expectedRevision: 0, previousSectionId: null, sectionId: asId<SectionId>("section-research"),
          revision: 1, changedAt: trancheTwoTimestamp, reason: "user_assignment",
        },
      },
      {
        ...trancheTwoBase("contract-agent-section-delete", system),
        type: "agent.section.changed",
        payload: {
          agentId: asId<AgentId>("agent-tranche-two"), clientRequestId: "client-agent-section-delete",
          expectedRevision: 1, previousSectionId: asId<SectionId>("section-research"), sectionId: null,
          revision: 2, changedAt: trancheTwoTimestamp, reason: "section_deleted",
        },
      },
      {
        ...trancheTwoBase("contract-section-deleted"),
        type: "section.deleted",
        payload: {
          sectionId: asId<SectionId>("section-research"), clientRequestId: "client-agent-section-delete",
          expectedRevision: 3, revision: 4,
          unassignedAgentIds: [asId<AgentId>("agent-tranche-two")], deletedAt: trancheTwoTimestamp,
        },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-conversation"), actor: human, type: "conversation.created",
        payload: { title: "Tranche two", createdAt: trancheTwoTimestamp },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-reaction-message"), actor: human, type: "user.message.accepted",
        payload: {
          messageId: asId<MessageId>("message-reaction"), turnId: asId<TurnId>("turn-reaction"),
          clientRequestId: "client-reaction-message", content: "Reaction target",
        },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-direction-message"), actor: human, type: "user.message.accepted",
        payload: {
          messageId: asId<MessageId>("message-direction"), turnId: asId<TurnId>("turn-contract"),
          clientRequestId: "client-direction-message", content: "Steer target",
        },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-reaction"), actor: human, type: "reaction.state.set",
        payload: {
          messageId: asId<MessageId>("message-reaction"), humanActorId: human.id,
          reactionToken: "useful", present: true, clientRequestId: "client-reaction",
          setAt: trancheTwoTimestamp,
        },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-control"), actor: human, type: "human.control.requested",
        payload: {
          controlId: "control-contract", controlKind: "steer", turnId: asId<TurnId>("turn-contract"),
          clientRequestId: "client-control", directionEpoch: 2, directionHash: sha256Hex("Steer target"),
          requestedAt: trancheTwoTimestamp,
        },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-direction"), actor: human, type: "direction.accepted",
        payload: {
          directionId: "direction-contract", turnId: asId<TurnId>("turn-contract"),
          clientRequestId: "client-control", directionEpoch: 3, kind: "steer",
          messageId: asId<MessageId>("message-direction"), contentHash: sha256Hex("Steer target"),
          acceptedAt: trancheTwoTimestamp,
        },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-stop-message"), actor: human, type: "user.message.accepted",
        payload: {
          messageId: asId<MessageId>("message-stop"), turnId: asId<TurnId>("turn-stop"),
          clientRequestId: "client-stop-message", content: "Stop target",
        },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-stop-control"), actor: human, type: "human.control.requested",
        payload: {
          controlId: "control-stop", controlKind: "stop", turnId: asId<TurnId>("turn-stop"),
          clientRequestId: "client-stop", directionEpoch: 1, directionHash: sha256Hex("stop"),
          requestedAt: trancheTwoTimestamp,
        },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-stopped"), actor: system, type: "turn.stopped",
        payload: {
          controlId: "control-stop", turnId: asId<TurnId>("turn-stop"), clientRequestId: "client-stop",
          directionEpoch: 1, reasonCode: "human_stop", stoppedAt: trancheTwoTimestamp,
        },
      },
      {
        ...conversationBase,
        eventId: asId<EventId>("contract-steered"), actor: system, type: "turn.steered",
        payload: {
          controlId: "control-contract", turnId: asId<TurnId>("turn-contract"),
          clientRequestId: "client-control", retiredDirectionEpoch: 2, nextDirectionEpoch: 3,
          directionId: "direction-contract", steeredAt: trancheTwoTimestamp,
        },
      },
    ];

    const appended = await journal.appendBatch(drafts);
    expect(appended).toHaveLength(drafts.length);
    expect(appended.every((event) => Object.isFrozen(event) && Object.isFrozen(event.payload))).toBe(true);
    const deleted = appended.find((event) => event.type === "section.deleted");
    expect(deleted).toBeDefined();
    expect(Object.isFrozen((deleted!.payload as { unassignedAgentIds: readonly string[] }).unassignedAgentIds)).toBe(true);
    const beforeRestart = journal.snapshot();
    await journal.close();

    const reopened = await DurableJournal.open(path);
    expect(reopened.snapshot()).toEqual(beforeRestart);
    await reopened.close();
  });

  it("rejects malformed tranche-two shapes, actors, scopes, bounds, envelopes, and optional epochs before write", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "tranche-two-invalid-drafts.journal");
    const journal = await DurableJournal.open(path);
    const conversationId = asId<ConversationId>("conv-invalid-tranche-two");
    const validProfile = profileCreatedEvent("valid-profile-template");
    const validReaction = {
      ...trancheTwoBase("valid-reaction-template"),
      conversationId,
      type: "reaction.state.set" as const,
      payload: {
        messageId: asId<MessageId>("message-invalid-template"), humanActorId: "human-journal",
        reactionToken: "clear" as const, present: true, clientRequestId: "client-reaction-template",
        setAt: trancheTwoTimestamp,
      },
    };
    const malformed = [
      { ...validProfile, payload: { ...validProfile.payload, injected: true } },
      { ...profileCreatedEvent("bad-profile-name"), payload: { ...validProfile.payload, displayName: "x".repeat(81) } },
      { ...profileCreatedEvent("bad-profile-token"), payload: { ...validProfile.payload, colorToken: "borrowed-blue" } },
      { ...profileCreatedEvent("bad-profile-status"), payload: { ...validProfile.payload, status: "ready" } },
      { ...profileCreatedEvent("bad-profile-actor"), actor: { kind: "system", id: "kernel" } },
      { ...profileCreatedEvent("bad-profile-scope"), conversationId },
      { ...validReaction, eventId: asId<EventId>("bad-reaction-scope"), conversationId: undefined },
      {
        ...validReaction,
        eventId: asId<EventId>("bad-reaction-envelope"),
        payload: { ...validReaction.payload, humanActorId: "different-human" },
      },
      {
        ...validReaction,
        eventId: asId<EventId>("bad-reaction-token"),
        payload: { ...validReaction.payload, reactionToken: "thumbs_up" },
      },
      {
        ...trancheTwoBase("bad-section-derived-actor"),
        type: "agent.section.changed",
        payload: {
          agentId: "agent", clientRequestId: "client-derived", expectedRevision: 1,
          previousSectionId: "section", sectionId: null, revision: 2,
          changedAt: trancheTwoTimestamp, reason: "section_deleted",
        },
      },
      {
        ...trancheTwoBase("bad-control-epoch"), conversationId, type: "human.control.requested",
        payload: {
          controlId: "control", controlKind: "stop", turnId: "turn", clientRequestId: "client-control",
          directionEpoch: 0, directionHash: "a".repeat(64), requestedAt: trancheTwoTimestamp,
        },
      },
      {
        ...trancheTwoBase("bad-control-hash"), conversationId, type: "human.control.requested",
        payload: {
          controlId: "control", controlKind: "stop", turnId: "turn", clientRequestId: "client-control-hash",
          directionEpoch: 1, directionHash: "not-a-hash", requestedAt: trancheTwoTimestamp,
        },
      },
      {
        ...trancheTwoBase("bad-provider-epoch", { kind: "system", id: "kernel" }),
        conversationId,
        type: "provider.selected",
        payload: { turnId: "turn", providerId: "provider", modelId: "model", fallbackIndex: 0, directionEpoch: 1.5 },
      },
      {
        ...trancheTwoBase("bad-steered-epochs", { kind: "system", id: "kernel" }),
        conversationId,
        type: "turn.steered",
        payload: {
          controlId: "control", turnId: "turn", clientRequestId: "client-steered",
          retiredDirectionEpoch: 2, nextDirectionEpoch: 4, directionId: "direction",
          steeredAt: trancheTwoTimestamp,
        },
      },
      {
        ...profileCreatedEvent("bad-profile-timestamp-pair"),
        payload: { ...validProfile.payload, updatedAt: "2026-08-26T06:00:01.000Z" },
      },
    ];

    for (const draft of malformed) {
      await expect(journal.append(draft as unknown as DraftAuditEvent)).rejects.toBeInstanceOf(
        JournalUnavailableError,
      );
    }
    expect(journal.snapshot()).toHaveLength(0);
    await journal.append(profileCreatedEvent("writer-remains-available"));
    expect(journal.snapshot()).toHaveLength(1);
    await journal.close();
  });

  it("fails closed on checksummed tranche-two actor, scope, envelope, enum, and field corruption", async () => {
    const directory = await temporary.directory();
    const conversationId = asId<ConversationId>("conv-replay-validation");
    const validProfile = profileCreatedEvent("replay-profile-template") as unknown as Record<string, unknown>;
    const validReaction = {
      ...trancheTwoBase("replay-reaction-template"),
      conversationId,
      type: "reaction.state.set",
      payload: {
        messageId: "message-replay", humanActorId: "human-journal", reactionToken: "clear",
        present: true, clientRequestId: "client-replay-reaction", setAt: trancheTwoTimestamp,
      },
    } as Record<string, unknown>;
    const profilePayload = validProfile.payload as Record<string, unknown>;
    const cases: readonly { name: string; draft: Record<string, unknown>; reasonCode: string }[] = [
      {
        name: "enum",
        draft: { ...validProfile, payload: { ...profilePayload, status: "ready" } },
        reasonCode: "invalid_event_payload_shape",
      },
      {
        name: "field",
        draft: { ...validProfile, payload: { ...profilePayload, injected: true } },
        reasonCode: "invalid_event_payload_fields",
      },
      {
        name: "actor",
        draft: { ...validProfile, actor: { kind: "system", id: "kernel" } },
        reasonCode: "invalid_event_actor",
      },
      {
        name: "scope",
        draft: { ...validProfile, conversationId },
        reasonCode: "invalid_event_scope",
      },
      {
        name: "envelope",
        draft: {
          ...validReaction,
          payload: { ...(validReaction.payload as Record<string, unknown>), humanActorId: "other-human" },
        },
        reasonCode: "event_payload_envelope_mismatch",
      },
    ];

    for (const item of cases) {
      const path = join(directory, `${item.name}.journal`);
      const hashInput = {
        ...item.draft,
        globalSequence: 1,
        previousHash: GENESIS_HASH,
      };
      const record = { ...hashInput, currentHash: sha256Hex(canonicalStringify(hashInput)) };
      const bytes = Buffer.from(`${canonicalStringify(record)}\n`);
      await writeFile(path, bytes);
      await expect(DurableJournal.open(path)).rejects.toMatchObject({ reasonCode: item.reasonCode });
      expect(await readFile(path)).toEqual(bytes);
    }
  });

  it("rejects cross-workspace membership references before write and during checksummed replay", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "cross-workspace-membership.journal");
    const journal = await DurableJournal.open(path);
    const foreignWorkspace = asId<WorkspaceId>("ws-cross-workspace-foreign");
    await journal.append(profileCreatedEvent("cross-workspace-agent"));
    await journal.append({
      eventId: asId<EventId>("cross-workspace-section"),
      workspaceId: foreignWorkspace,
      actor: { kind: "human", id: "human-journal" },
      timestamp: trancheTwoTimestamp,
      payloadSchemaVersion: 1,
      type: "section.created",
      payload: {
        sectionId: asId<SectionId>("section-cross-foreign"),
        clientRequestId: "client-cross-section",
        name: "Foreign section",
        orderKey: 1,
        createdAt: trancheTwoTimestamp,
        updatedAt: trancheTwoTimestamp,
        revision: 1,
      },
    });
    const crossScopeDraft = {
      eventId: asId<EventId>("cross-workspace-assignment"),
      workspaceId,
      actor: { kind: "human" as const, id: "human-journal" },
      timestamp: trancheTwoTimestamp,
      payloadSchemaVersion: 1 as const,
      type: "agent.section.changed" as const,
      payload: {
        agentId: asId<AgentId>("agent-tranche-two"),
        clientRequestId: "client-cross-assignment",
        expectedRevision: 0,
        previousSectionId: null,
        sectionId: asId<SectionId>("section-cross-foreign"),
        revision: 1,
        changedAt: trancheTwoTimestamp,
        reason: "user_assignment" as const,
      },
    };
    const before = journal.snapshot().length;
    await expect(journal.append(crossScopeDraft)).rejects.toThrow("membership_workspace_scope_invalid");
    expect(journal.snapshot()).toHaveLength(before);
    await journal.close();

    const existing = await readFile(path, "utf8");
    const records = existing.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const hashInput = {
      ...crossScopeDraft,
      globalSequence: records.length + 1,
      previousHash: records.at(-1)!.currentHash,
    };
    const forged = {
      ...hashInput,
      currentHash: sha256Hex(canonicalStringify(hashInput)),
    };
    const bytes = Buffer.from(`${existing}${canonicalStringify(forged)}\n`);
    await writeFile(path, bytes);
    await expect(DurableJournal.open(path)).rejects.toMatchObject({
      reasonCode: "membership_workspace_scope_invalid",
    });
    expect(await readFile(path)).toEqual(bytes);
  });

  it("deep-clones and freezes appended drafts so caller mutation cannot alter acknowledged history", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "deep-immutability.journal");
    const journal = await DurableJournal.open(path);
    const draft = profileCreatedEvent("immutable-profile");
    const acknowledged = await journal.append(draft);
    const mutableDraft = draft as unknown as { actor: { id: string }; payload: { displayName: string } };
    mutableDraft.actor.id = "mutated-human";
    mutableDraft.payload.displayName = "Mutated after append";

    expect(acknowledged.actor.id).toBe("human-journal");
    expect(acknowledged.payload.displayName).toBe("Research Relay");
    expect(Object.isFrozen(acknowledged)).toBe(true);
    expect(Object.isFrozen(acknowledged.actor)).toBe(true);
    expect(Object.isFrozen(acknowledged.payload)).toBe(true);
    const beforeRestart = journal.snapshot();
    await journal.close();
    const reopened = await DurableJournal.open(path);
    expect(reopened.snapshot()).toEqual(beforeRestart);
    expect(Object.isFrozen(reopened.snapshot()[0].payload)).toBe(true);
    await reopened.close();
  });

  it("snapshots every append API before a blocked queue can observe caller mutations", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "invocation-snapshot.journal");
    let releaseBlockedWrite!: () => void;
    let reportBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => { releaseBlockedWrite = resolve; });
    const writeReached = new Promise<void>((resolve) => { reportBlockedWrite = resolve; });
    let didBlock = false;
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach(phase, events) {
          if (phase === "before_write" && events[0]?.eventId === "snapshot-blocker" && !didBlock) {
            didBlock = true;
            reportBlockedWrite();
            return blockedWrite;
          }
        },
      },
    });

    const blocker = journal.append({
      ...statusEvent(2_000),
      eventId: asId<EventId>("snapshot-blocker"),
    });
    await writeReached;

    const singleDraft = profileCreatedEvent("snapshot-single-original");
    const expectedSingleDraft = canonicalStringify(singleDraft);
    const single = journal.append(singleDraft);

    const unassignedAgentIds: AgentId[] = [];
    const sectionCreated = {
      ...trancheTwoBase("snapshot-section-created-original"),
      type: "section.created" as const,
      payload: {
        sectionId: asId<SectionId>("snapshot-section"),
        clientRequestId: "snapshot-section-create",
        name: "Snapshot section",
        orderKey: 10,
        createdAt: trancheTwoTimestamp,
        updatedAt: trancheTwoTimestamp,
        revision: 1,
      },
    };
    const sectionDeleted = {
      ...trancheTwoBase("snapshot-section-deleted-original"),
      type: "section.deleted" as const,
      payload: {
        sectionId: asId<SectionId>("snapshot-section"),
        clientRequestId: "snapshot-section-delete",
        expectedRevision: 1,
        revision: 2,
        unassignedAgentIds,
        deletedAt: trancheTwoTimestamp,
      },
    };
    const batchDrafts: DraftAuditEvent[] = [sectionCreated, sectionDeleted];
    const expectedBatchDrafts = canonicalStringify(batchDrafts);
    const batch = journal.appendBatch(batchDrafts);

    let singleGuardAllowsCommit = false;
    const guardedDraft = {
      ...statusEvent(2_001),
      eventId: asId<EventId>("snapshot-guarded-single-original"),
    };
    const expectedGuardedDraft = canonicalStringify(guardedDraft);
    const guardedSingle = journal.appendGuarded(guardedDraft, () => singleGuardAllowsCommit);

    let batchGuardAllowsCommit = false;
    const guardedBatchDrafts: DraftAuditEvent[] = [{
      ...statusEvent(2_002),
      eventId: asId<EventId>("snapshot-guarded-batch-original"),
    }];
    const expectedGuardedBatchDrafts = canonicalStringify(guardedBatchDrafts);
    const guardedBatch = journal.appendBatchGuarded(guardedBatchDrafts, () => batchGuardAllowsCommit);

    singleGuardAllowsCommit = true;
    batchGuardAllowsCommit = true;

    const mutableSingleDraft = singleDraft as unknown as {
      eventId: EventId;
      actor: { id: string };
      payload: { displayName: string; createdAt: string };
    };
    mutableSingleDraft.eventId = asId<EventId>("snapshot-single-mutated");
    mutableSingleDraft.actor.id = "mutated-single-actor";
    mutableSingleDraft.payload.displayName = "Mutated single profile";
    mutableSingleDraft.payload.createdAt = "2099-01-01T00:00:00.000Z";

    sectionCreated.eventId = asId<EventId>("snapshot-section-created-mutated");
    sectionCreated.actor.id = "mutated-batch-actor";
    sectionCreated.payload.name = "Mutated batch section";
    sectionCreated.payload.createdAt = "2099-01-01T00:00:00.000Z";
    sectionDeleted.payload.deletedAt = "2099-01-02T00:00:00.000Z";
    unassignedAgentIds.push(asId<AgentId>("mutated-array-entry"));
    batchDrafts.push(statusEvent(2_003));

    const mutableGuardedDraft = guardedDraft as unknown as {
      eventId: EventId;
      actor: { id: string };
      payload: { status: string };
    };
    mutableGuardedDraft.eventId = asId<EventId>("snapshot-guarded-single-mutated");
    mutableGuardedDraft.actor.id = "mutated-guarded-actor";
    mutableGuardedDraft.payload.status = "mutated-guarded-status";
    guardedBatchDrafts[0] = statusEvent(2_004);
    guardedBatchDrafts.push(statusEvent(2_005));

    const invalidDate = profileCreatedEvent("snapshot-invalid-date");
    (invalidDate.payload as unknown as { createdAt: unknown }).createdAt = new Date(trancheTwoTimestamp);
    const invalidDateOutcome = await Promise.race([
      journal.append(invalidDate).then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "still_queued" }>((resolve) => {
        setImmediate(() => resolve({ kind: "still_queued" }));
      }),
    ]);
    const invalidBatchOutcome = await Promise.race([
      journal.appendBatch(new Date() as never).then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "still_queued" }>((resolve) => {
        setImmediate(() => resolve({ kind: "still_queued" }));
      }),
    ]);
    const invalidShapeOutcome = await Promise.race([
      journal.append({
        ...statusEvent(2_006),
        payload: { agentId: "agent-2006", status: "state-2006", injected: true },
      } as never).then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "still_queued" }>((resolve) => {
        setImmediate(() => resolve({ kind: "still_queued" }));
      }),
    ]);
    const hostileDraft = Object.defineProperty({}, "eventId", {
      enumerable: true,
      get() {
        throw new Error("journal-input-error-canary");
      },
    });
    const hostileOutcome = await Promise.race([
      journal.append(hostileDraft as never).then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "still_queued" }>((resolve) => {
        setImmediate(() => resolve({ kind: "still_queued" }));
      }),
    ]);

    releaseBlockedWrite();
    await blocker;
    const [singleEvent, batchEvents, guardedSingleEvent, guardedBatchEvents] = await Promise.all([
      single,
      batch,
      guardedSingle,
      guardedBatch,
    ]);

    expect(invalidDateOutcome).toMatchObject({
      kind: "rejected",
      error: { message: expect.stringContaining("draft_not_canonicalizable") },
    });
    expect(invalidBatchOutcome).toMatchObject({
      kind: "rejected",
      error: { message: expect.stringContaining("draft_batch_not_array") },
    });
    expect(invalidShapeOutcome).toMatchObject({
      kind: "rejected",
      error: { message: expect.stringContaining("invalid_draft_payload_fields") },
    });
    expect(hostileOutcome).toMatchObject({
      kind: "rejected",
      error: { message: expect.stringContaining("draft_not_canonicalizable") },
    });
    expect(JSON.stringify(hostileOutcome)).not.toContain("journal-input-error-canary");
    expect(singleEvent).toMatchObject({
      eventId: "snapshot-single-original",
      actor: { id: "human-journal" },
      payload: { displayName: "Research Relay", createdAt: trancheTwoTimestamp },
    });
    expect(batchEvents).toHaveLength(2);
    expect(batchEvents[0]).toMatchObject({
      eventId: "snapshot-section-created-original",
      actor: { id: "human-journal" },
      payload: { name: "Snapshot section", createdAt: trancheTwoTimestamp },
    });
    expect(batchEvents[1]).toMatchObject({
      eventId: "snapshot-section-deleted-original",
      payload: { unassignedAgentIds: [], deletedAt: trancheTwoTimestamp },
    });
    expect(guardedSingleEvent).toMatchObject({
      eventId: "snapshot-guarded-single-original",
      actor: { id: "test-harness" },
      payload: { status: "state-2001" },
    });
    expect(guardedBatchEvents).toHaveLength(1);
    expect(guardedBatchEvents[0]?.eventId).toBe("snapshot-guarded-batch-original");

    const canonicalPersistedDraft = (event: unknown): string => {
      const draft = { ...(event as Record<string, unknown>) };
      delete draft.globalSequence;
      delete draft.previousHash;
      delete draft.currentHash;
      return canonicalStringify(draft);
    };
    expect(canonicalPersistedDraft(singleEvent)).toBe(expectedSingleDraft);
    expect(canonicalStringify(batchEvents.map((event) =>
      JSON.parse(canonicalPersistedDraft(event)) as unknown))).toBe(expectedBatchDrafts);
    expect(canonicalPersistedDraft(guardedSingleEvent)).toBe(expectedGuardedDraft);
    expect(canonicalStringify(guardedBatchEvents.map((event) =>
      JSON.parse(canonicalPersistedDraft(event)) as unknown))).toBe(expectedGuardedBatchDrafts);

    const beforeRestart = journal.snapshot();
    for (const event of beforeRestart) {
      const { currentHash, ...hashInput } = event;
      expect(currentHash).toBe(sha256Hex(canonicalStringify(hashInput)));
    }
    expect(await readFile(path, "utf8")).toBe(
      `${beforeRestart.map((event) => canonicalStringify(event)).join("\n")}\n`,
    );
    await journal.close();

    const reopened = await DurableJournal.open(path);
    expect(reopened.snapshot()).toEqual(beforeRestart);
    await reopened.close();
  });

  it("rejects advanced and completed output for a durably retired direction epoch on append and replay", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "retired-epoch.journal");
    const conversationId = asId<ConversationId>("conv-retired-epoch");
    const providerBase = {
      workspaceId, conversationId, actor: { kind: "provider" as const, id: "provider-epoch" },
      timestamp: trancheTwoTimestamp, payloadSchemaVersion: 1 as const,
    };
    const started = {
      ...providerBase, eventId: asId<EventId>("epoch-started"), type: "assistant.stream.started" as const,
      payload: {
        streamId: "stream-epoch", messageId: asId<MessageId>("message-epoch"),
        turnId: asId<TurnId>("turn-epoch"), providerId: asId<ProviderId>("provider-epoch"), directionEpoch: 1,
      },
    };
    const accepted = {
      ...trancheTwoBase("epoch-turn-accepted"),
      conversationId,
      type: "user.message.accepted" as const,
      payload: {
        messageId: asId<MessageId>("message-epoch-user"),
        turnId: asId<TurnId>("turn-epoch"),
        clientRequestId: "client-epoch-turn",
        content: "Start epoch",
      },
    };
    const control = {
      ...trancheTwoBase("epoch-control"), conversationId, type: "human.control.requested" as const,
      payload: {
        controlId: "control-epoch", controlKind: "stop" as const, turnId: asId<TurnId>("turn-epoch"),
        clientRequestId: "client-epoch-control", directionEpoch: 1,
        directionHash: "c".repeat(64), requestedAt: trancheTwoTimestamp,
      },
    };
    const journal = await DurableJournal.open(path);
    await journal.append(accepted);
    await journal.append(started);
    await journal.append({
      ...providerBase, eventId: asId<EventId>("epoch-advanced-before-control"),
      type: "assistant.stream.advanced",
      payload: { streamId: "stream-epoch", turnId: asId<TurnId>("turn-epoch"), delta: "kept", costUnits: 1 },
    });
    await journal.append(control);
    const countAfterControl = journal.snapshot().length;

    await expect(journal.append({
      ...providerBase, eventId: asId<EventId>("epoch-late-explicit"), type: "assistant.stream.advanced",
      payload: {
        streamId: "stream-epoch", turnId: asId<TurnId>("turn-epoch"), delta: "late", costUnits: 0,
        directionEpoch: 1,
      },
    })).rejects.toThrow("retired_direction_epoch");
    await expect(journal.append({
      ...providerBase, eventId: asId<EventId>("epoch-late-inferred"), type: "assistant.stream.completed",
      payload: { streamId: "stream-epoch", turnId: asId<TurnId>("turn-epoch"), stopReason: "complete" },
    })).rejects.toThrow("retired_direction_epoch");
    expect(journal.snapshot()).toHaveLength(countAfterControl);
    await journal.append({
      ...providerBase, eventId: asId<EventId>("epoch-cancelled"), type: "assistant.stream.cancelled",
      payload: { streamId: "stream-epoch", turnId: asId<TurnId>("turn-epoch"), preservedDeltaCount: 1 },
    });
    await journal.close();

    const replayPath = join(directory, "retired-epoch-replay.journal");
    const replayJournal = await DurableJournal.open(replayPath);
    await replayJournal.append(accepted);
    await replayJournal.append(started);
    await replayJournal.append(control);
    await replayJournal.close();
    const existing = await readFile(replayPath, "utf8");
    const records = existing.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const previous = records.at(-1)!;
    const lateDraft = {
      ...providerBase,
      eventId: asId<EventId>("epoch-replay-late"),
      type: "assistant.stream.advanced" as const,
      payload: {
        streamId: "stream-epoch", turnId: asId<TurnId>("turn-epoch"), delta: "late", costUnits: 0,
        directionEpoch: 1,
      },
    };
    const lateHashInput = {
      ...lateDraft,
      globalSequence: records.length + 1,
      previousHash: previous.currentHash,
    };
    const lateRecord = {
      ...lateHashInput,
      currentHash: sha256Hex(canonicalStringify(lateHashInput)),
    };
    const forgedBytes = Buffer.from(`${existing}${canonicalStringify(lateRecord)}\n`);
    await writeFile(replayPath, forgedBytes);
    await expect(DurableJournal.open(replayPath)).rejects.toMatchObject({
      reasonCode: "retired_direction_epoch",
    });
    expect(await readFile(replayPath)).toEqual(forgedBytes);
  });
});
