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

export const OPENROUTER_RESPONSES_PROTOCOL_REVISION =
  "openrouter-openresponses-4b2651bb47fd72031b610c210fdc48aefe5ac6fd";

export class OpenRouterResponsesAdapter implements ProviderAdapter {
  readonly providerId: ProviderId;
  readonly capabilities: readonly ProviderModelCapabilitySnapshot[];
  readonly reviewedTools: readonly ReviewedProviderTool[];
  readonly #config: PreparedAdapterConfiguration;

  constructor(options: ProviderAdapterOptions) {
    this.#config = prepareAdapterConfiguration(
      "openrouter",
      "openrouter",
      options,
      OPENROUTER_RESPONSES_PROTOCOL_REVISION,
    );
    this.providerId = this.#config.providerId;
    this.capabilities = this.#config.capabilities;
    this.reviewedTools = this.#config.reviewedTools;
  }

  streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderChunk> {
    return streamResponsesTurn({
      profile: "openrouter",
      route: "openrouter_responses",
      config: this.#config,
      request,
    });
  }

  authoritySnapshot(): ProviderAuthoritySnapshot | undefined {
    if (!bindingLeaseIsCurrentForBroker(this.#config.broker, this.#config.binding)) return undefined;
    return Object.freeze({
      credentialAudience: "openrouter",
      credentialBindingRevision: this.#config.credentialBindingRevision,
    });
  }
}
