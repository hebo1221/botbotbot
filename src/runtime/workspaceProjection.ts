import {
  asId,
  type AgentId,
  type AgentProfile,
  type AgentSectionMembership,
  type AuditEvent,
  type AuditPayloads,
  type SectionId,
  type WorkspaceId,
  type WorkspaceSection,
} from "../domain/contracts";

export interface DeletedSection {
  readonly id: SectionId;
  readonly revision: number;
  readonly deletedAt: string;
}

export interface WorkspaceProjection {
  readonly workspaceId: WorkspaceId;
  readonly agents: Readonly<Record<string, AgentProfile>>;
  readonly sections: Readonly<Record<string, WorkspaceSection>>;
  readonly deletedSections: Readonly<Record<string, DeletedSection>>;
  readonly memberships: Readonly<Record<string, AgentSectionMembership>>;
  readonly orderedSectionIds: readonly SectionId[];
  readonly unassignedAgentIds: readonly AgentId[];
  readonly lastGlobalSequence: number;
}

function eventPayload<Type extends keyof AuditPayloads>(
  event: AuditEvent,
  type: Type,
): AuditPayloads[Type] {
  if (event.type !== type) throw new Error(`Expected ${type}, received ${event.type}`);
  return event.payload as AuditPayloads[Type];
}

export function projectWorkspace(
  events: readonly AuditEvent[],
  workspaceId: WorkspaceId,
): WorkspaceProjection {
  const agents = new Map<string, AgentProfile>();
  const sections = new Map<string, WorkspaceSection>();
  const deletedSections = new Map<string, DeletedSection>();
  const memberships = new Map<string, AgentSectionMembership>();
  let lastGlobalSequence = 0;

  for (const event of events) {
    if (event.workspaceId !== workspaceId) continue;
    lastGlobalSequence = event.globalSequence;

    switch (event.type) {
      case "agent.profile.created": {
        const item = eventPayload(event, "agent.profile.created");
        agents.set(item.agentId, Object.freeze({
          id: item.agentId,
          workspaceId,
          displayName: item.displayName,
          roleTitle: item.roleTitle,
          colorToken: item.colorToken,
          markToken: item.markToken,
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          revision: item.revision,
        }));
        memberships.set(item.agentId, Object.freeze({
          agentId: item.agentId,
          revision: 0,
          updatedAt: item.createdAt,
        }));
        break;
      }
      case "agent.profile.updated": {
        const item = eventPayload(event, "agent.profile.updated");
        const previous = agents.get(item.agentId);
        if (!previous) break;
        agents.set(item.agentId, Object.freeze({
          ...previous,
          displayName: item.displayName,
          roleTitle: item.roleTitle,
          colorToken: item.colorToken,
          markToken: item.markToken,
          status: item.status,
          updatedAt: item.updatedAt,
          revision: item.revision,
        }));
        break;
      }
      case "section.created": {
        const item = eventPayload(event, "section.created");
        sections.set(item.sectionId, Object.freeze({
          id: item.sectionId,
          workspaceId,
          name: item.name,
          orderKey: item.orderKey,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          revision: item.revision,
        }));
        break;
      }
      case "section.renamed": {
        const item = eventPayload(event, "section.renamed");
        const previous = sections.get(item.sectionId);
        if (!previous) break;
        sections.set(item.sectionId, Object.freeze({
          ...previous,
          name: item.name,
          updatedAt: item.updatedAt,
          revision: item.revision,
        }));
        break;
      }
      case "section.reordered": {
        const item = eventPayload(event, "section.reordered");
        const previous = sections.get(item.sectionId);
        if (!previous) break;
        sections.set(item.sectionId, Object.freeze({
          ...previous,
          orderKey: item.orderKey,
          updatedAt: item.updatedAt,
          revision: item.revision,
        }));
        break;
      }
      case "agent.section.changed": {
        const item = eventPayload(event, "agent.section.changed");
        memberships.set(item.agentId, Object.freeze({
          agentId: item.agentId,
          ...(item.sectionId === null ? {} : { sectionId: item.sectionId }),
          revision: item.revision,
          updatedAt: item.changedAt,
        }));
        break;
      }
      case "section.deleted": {
        const item = eventPayload(event, "section.deleted");
        sections.delete(item.sectionId);
        deletedSections.set(item.sectionId, Object.freeze({
          id: item.sectionId,
          revision: item.revision,
          deletedAt: item.deletedAt,
        }));
        for (const agentId of item.unassignedAgentIds) {
          const membership = memberships.get(agentId);
          if (membership?.sectionId !== item.sectionId) continue;
          memberships.set(agentId, Object.freeze({
            agentId: asId<AgentId>(agentId, "agent ID"),
            revision: membership.revision + 1,
            updatedAt: item.deletedAt,
          }));
        }
        break;
      }
      default:
        break;
    }
  }

  const orderedSectionIds = [...sections.values()]
    .sort((left, right) => left.orderKey - right.orderKey || left.id.localeCompare(right.id))
    .map((section) => section.id);
  const unassignedAgentIds = [...agents.keys()]
    .filter((agentId) => memberships.get(agentId)?.sectionId === undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((agentId) => asId<AgentId>(agentId, "agent ID"));

  return Object.freeze({
    workspaceId,
    agents: Object.freeze(Object.fromEntries(agents)),
    sections: Object.freeze(Object.fromEntries(sections)),
    deletedSections: Object.freeze(Object.fromEntries(deletedSections)),
    memberships: Object.freeze(Object.fromEntries(memberships)),
    orderedSectionIds: Object.freeze(orderedSectionIds),
    unassignedAgentIds: Object.freeze(unassignedAgentIds),
    lastGlobalSequence,
  });
}
