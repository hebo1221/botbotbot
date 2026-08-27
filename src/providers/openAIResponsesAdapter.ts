import type {
  ProviderAdapter,
  ProviderAuthoritySnapshot,
  ProviderChunk,
  ProviderId,
  ProviderModelCapabilitySnapshot,
  ProviderTurnRequest,
  ReviewedProviderTool,
} from "../domain/contracts";
import { bindingLeaseIsCurrentForBroker } from "./credentialBroker";
import {
  prepareAdapterConfiguration,
  type PreparedAdapterConfiguration,
  type ProviderAdapterOptions,
} from "./providerAdapterCommon";
import { streamResponsesTurn } from "./responsesProtocol";

export const OPENAI_RESPONSES_PROTOCOL_REVISION = "openai-responses-v1";

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly providerId: ProviderId;
  readonly capabilities: readonly ProviderModelCapabilitySnapshot[];
  readonly reviewedTools: readonly ReviewedProviderTool[];
  readonly #config: PreparedAdapterConfiguration;

  constructor(options: ProviderAdapterOptions) {
    this.#config = prepareAdapterConfiguration(
      "openai",
      "openai",
      options,
      OPENAI_RESPONSES_PROTOCOL_REVISION,
    );
    this.providerId = this.#config.providerId;
    this.capabilities = this.#config.capabilities;
    this.reviewedTools = this.#config.reviewedTools;
    Object.freeze(this.capabilities);
    Object.freeze(this.reviewedTools);
  }

  streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderChunk> {
    return streamResponsesTurn({
      profile: "openai",
      route: "openai_responses",
      config: this.#config,
      request,
    });
  }

  authoritySnapshot(): ProviderAuthoritySnapshot | undefined {
    if (!bindingLeaseIsCurrentForBroker(this.#config.broker, this.#config.binding)) return undefined;
    return Object.freeze({
      credentialAudience: "openai",
      credentialBindingRevision: this.#config.credentialBindingRevision,
    });
  }
}
