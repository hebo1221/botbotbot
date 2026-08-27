import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asId,
  type AuditEvent,
  type AuditEventType,
  type Clock,
  type DraftAuditEvent,
  type ProviderAdapter,
  type ProviderAuthoritySnapshot,
  type ProviderCapability,
  type ProviderChunk,
  type ProviderModelCapabilitySnapshot,
  type ProviderId,
  type ProviderTurnRequest,
  type ReviewedProviderTool,
  type CredentialBindingRevision,
} from "../src/domain/contracts";
import type { ToolAuditPort } from "../src/tools/universalToolGateway";
import type { TrustedCostAccountingPort } from "../src/runtime/runtimeCoordinator";

export const zeroCostAccounting: TrustedCostAccountingPort = Object.freeze({
  costForProviderChunk: () => 0,
});

export class TempArea {
  private readonly paths: string[] = [];

  async directory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "botbotbot-test-"));
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  }
}

export class MutableClock implements Clock {
  constructor(private milliseconds: number) {}

  now(): Date {
    return new Date(this.milliseconds);
  }

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

export class MemoryAuditPort implements ToolAuditPort {
  readonly events: AuditEvent[] = [];

  async append<Type extends AuditEventType>(draft: DraftAuditEvent<Type>): Promise<AuditEvent<Type>> {
    const sequence = this.events.length + 1;
    const event = {
      ...draft,
      globalSequence: sequence,
      previousHash: this.events.at(-1)?.currentHash ?? "0".repeat(64),
      currentHash: sequence.toString(16).padStart(64, "0"),
    } as AuditEvent<Type>;
    this.events.push(event);
    return event;
  }

  async appendGuarded<Type extends AuditEventType>(
    draft: DraftAuditEvent<Type>,
    guard: () => boolean,
  ): Promise<AuditEvent<Type>> {
    if (guard() !== true) throw new Error("Memory audit commit guard rejected the event");
    return this.append(draft);
  }

  async appendBatchGuarded(
    drafts: readonly DraftAuditEvent[],
    guard: () => boolean,
  ): Promise<readonly AuditEvent[]> {
    if (guard() !== true) throw new Error("Memory audit commit guard rejected the batch");
    const events: AuditEvent[] = [];
    for (const draft of drafts) {
      const sequence = this.events.length + 1;
      const event = {
        ...draft,
        globalSequence: sequence,
        previousHash: this.events.at(-1)?.currentHash ?? "0".repeat(64),
        currentHash: sequence.toString(16).padStart(64, "0"),
      } as AuditEvent;
      this.events.push(event);
      events.push(event);
    }
    return events;
  }
}

export type ProviderScript = (request: ProviderTurnRequest) => AsyncIterable<ProviderChunk>;

export class ScriptedProvider implements ProviderAdapter {
  readonly requests: ProviderTurnRequest[] = [];
  readonly providerId: ProviderId;
  readonly credentialAudience = "openai" as const;
  readonly capabilities: readonly ProviderModelCapabilitySnapshot[];
  readonly credentialBindingRevision: CredentialBindingRevision;
  readonly reviewedTools: readonly ReviewedProviderTool[];

  constructor(
    providerId: string,
    readonly scripts: readonly ProviderScript[],
    capabilities: readonly ProviderCapability[] = ["streaming", "tool_proposals", "usage"],
    modelIds: readonly string[] = ["test-model"],
    reviewedTools: readonly ReviewedProviderTool[] = [],
  ) {
    this.providerId = asId<ProviderId>(providerId);
    this.credentialBindingRevision = `bind_fixture_${providerId.replace(/[^A-Za-z0-9_-]/g, "_")}_00000000000000000000000000000001` as CredentialBindingRevision;
    this.reviewedTools = Object.freeze([...reviewedTools]);
    const available = new Set(capabilities);
    this.capabilities = Object.freeze(modelIds.map((modelId) => Object.freeze({
      providerId: this.providerId,
      modelId,
      protocolRevision: "fixture-1",
      streaming: available.has("streaming"),
      toolProposals: available.has("tool_proposals"),
      imageInput: available.has("image_input"),
      usage: available.has("usage"),
      cancellation: available.has("cancellation") || available.has("streaming"),
      opaqueReasoningRoundTrip: available.has("opaque_reasoning_round_trip"),
    })));
  }

  streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    const script = this.scripts[this.requests.length - 1];
    if (!script) throw new Error(`No script for provider call ${this.requests.length}`);
    return script(request);
  }

  authoritySnapshot(): ProviderAuthoritySnapshot {
    return Object.freeze({
      credentialAudience: this.credentialAudience,
      credentialBindingRevision: this.credentialBindingRevision,
    });
  }
}

type LegacyProviderChunk =
  | { readonly kind: "delta"; readonly text: string; readonly costUnits?: number }
  | { readonly kind: "finish"; readonly costUnits?: number }
  | {
      readonly kind: "tool_proposal";
      readonly toolId: Extract<ProviderChunk, { kind: "tool_proposal" }>["toolId"];
      readonly arguments: Extract<ProviderChunk, { kind: "tool_proposal" }>["arguments"];
      readonly summary: string;
      readonly costUnits?: number;
      readonly providerItemId?: string;
      readonly providerCallId?: string;
    };

export function chunks(...items: readonly (ProviderChunk | LegacyProviderChunk)[]): ProviderScript {
  return async function* () {
    for (const item of items) {
      if (item.kind === "delta") yield { kind: "delta", text: item.text };
      else if (item.kind === "finish") yield { kind: "finish" };
      else if (item.kind === "tool_proposal") {
        yield {
          kind: "tool_proposal",
          providerItemId: item.providerItemId ?? "fixture_item_0001",
          providerCallId: item.providerCallId ?? "fixture_call_0001",
          toolId: item.toolId,
          arguments: item.arguments,
          summary: item.summary,
        };
      } else yield item;
    }
  };
}

export function uniqueEventId() {
  return asId(randomUUID());
}
