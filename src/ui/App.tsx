import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  validateDecisionReceipt,
  type ApprovalControlPort,
} from "../application/approvalControl";
import {
  validateMessageReceipt,
  type ConversationControlPort,
} from "../application/conversationControl";
import type {
  AgentColorToken,
  AgentMarkToken,
  AgentProfileView,
  AgentStatus,
  ControlRoomViewModel,
  DecisionNodeView,
  ReactionToken,
  SectionView,
  RibbonState,
} from "../application/controlRoomViewModel";
import {
  executeTurnControlMutation,
  executeWorkspaceControlMutation,
  type AssignAgentSectionRequest,
  type ControlRoomViewPort,
  type TurnControlPort,
  type TurnControlRequest,
  type WorkspaceControlPort,
  type WorkspaceControlRequest,
} from "../application/workspaceControlPorts";
import "./styles.css";

export const demoModel: ControlRoomViewModel = {
  workspaceId: "workspace-botbotbot-lab",
  currentHumanId: "human-owner",
  workspaceName: "봇봇봇 연구실",
  lastGlobalSequence: 184,
  sections: [
    { id: "section-research", name: "실험 릴레이", orderKey: 100, revision: 3 },
    { id: "section-release", name: "배포 검증", orderKey: 200, revision: 2 },
  ],
  agents: [
    {
      id: "agent-yoonseul", displayName: "윤슬", roleTitle: "메모리 감사",
      colorToken: "warm-coral", markToken: "signal", status: "waiting_for_human", revision: 4, membershipRevision: 1,
      sectionId: "section-research", activeConversationId: "conv-memory-audit",
    },
    {
      id: "agent-moseori", displayName: "모서리", roleTitle: "제공자 분석",
      colorToken: "relay-cobalt", markToken: "prism", status: "working", revision: 2, membershipRevision: 1,
      sectionId: "section-research", activeConversationId: "conv-provider-notes",
    },
    {
      id: "agent-compass", displayName: "나침반", roleTitle: "릴리스 검증",
      colorToken: "mineral-mint", markToken: "orbit", status: "stopped", revision: 5, membershipRevision: 2,
      sectionId: "section-release", activeConversationId: "conv-release-check",
    },
    {
      id: "agent-goyo", displayName: "고요", roleTitle: "대기 조사원",
      colorToken: "graphite-fog", markToken: "bridge", status: "idle", revision: 1, membershipRevision: 0,
    },
    {
      id: "agent-signal", displayName: "신호", roleTitle: "회복 필요",
      colorToken: "warm-coral", markToken: "prism", status: "error", revision: 2, membershipRevision: 0,
    },
  ],
  activeConversationId: "conv-memory-audit",
  conversations: [
    { id: "conv-memory-audit", title: "메모리 감사", agentId: "agent-yoonseul", unread: 1 },
    { id: "conv-provider-notes", title: "제공자 비교 노트", agentId: "agent-moseori" },
    { id: "conv-release-check", title: "릴리스 증거", agentId: "agent-compass" },
  ],
  activeTurn: {
    turnId: "turn-memory-audit-019",
    directionEpoch: 3,
    state: "running",
    connected: true,
  },
  selectedProvider: "Clarity · balanced",
  providers: ["Clarity · balanced", "Lattice · precise", "Harbor · local"],
  budget: { stepsUsed: 4, stepsLimit: 12, costUsed: "₩184", timeRemaining: "07:42" },
  timeline: [
    {
      id: "m1",
      role: "human",
      author: "나",
      timestamp: "14:08",
      body: "지난 평가 기록을 읽고, 다음 실험의 체크리스트를 만들어 줘.",
      streamState: "complete",
      reactions: [
        { token: "useful", label: "주목", glyph: "◆", count: 2, presentForCurrentHuman: true },
        { token: "follow_up", label: "후속 필요", glyph: "?", count: 1, presentForCurrentHuman: false },
      ],
    },
    {
      id: "m2",
      role: "agent",
      author: "윤슬",
      timestamp: "14:08",
      body: "평가 기록의 범위와 날짜를 확인했습니다. 읽기 작업을 준비했지만, 지정된 자료 범위가 아직 승인되지 않았습니다.",
      streamState: "paused",
      reactions: [
        { token: "clear", label: "확인", glyph: "✓", count: 3, presentForCurrentHuman: false },
      ],
      decisionNodes: [
        { id: "agent", label: "제안", value: "윤슬", state: "verified", detail: "agent:yoonseul" },
        { id: "provider", label: "경로", value: "Clarity", state: "verified", detail: "capabilities checked" },
        { id: "policy", label: "정책", value: "범위 확인", state: "verified", detail: "policy v1 · external read" },
        { id: "human", label: "결정", value: "대기 중", state: "waiting", detail: "one exact use · 04:31" },
        { id: "receipt", label: "영수증", value: "아직 없음", state: "missing", detail: "execution has not started" },
      ],
    },
  ],
  approval: {
    proposalId: "prop_7d91",
    action: "평가 기록 3개 읽기",
    scope: "workspace/evaluations · 읽기 전용",
    expiresIn: "04:31",
    fingerprint: "a61c…9e42",
  },
  lastReceipt: {
    label: "제공자 사전 확인",
    detail: "capabilities matched",
    globalSequence: 178,
  },
};

const stateGlyph: Record<RibbonState, string> = {
  verified: "✓",
  active: "↻",
  waiting: "?",
  blocked: "×",
  missing: "—",
};

const statusPresentation: Record<AgentStatus, { readonly glyph: string; readonly label: string }> = {
  idle: { glyph: "○", label: "대기" },
  working: { glyph: "▶", label: "작업 중" },
  waiting_for_human: { glyph: "?", label: "사람의 결정 대기" },
  stopped: { glyph: "■", label: "중지됨" },
  error: { glyph: "!", label: "오류" },
};

const colorOptions: readonly AgentColorToken[] = ["relay-cobalt", "warm-coral", "mineral-mint", "graphite-fog"];
const markOptions: readonly AgentMarkToken[] = ["orbit", "prism", "signal", "bridge"];
const statusOptions = Object.keys(statusPresentation) as readonly AgentStatus[];

type WorkspaceCommandRunner = (request: WorkspaceControlRequest, pendingKey: string) => Promise<boolean>;

export function DecisionRibbon({ nodes }: { readonly nodes: readonly DecisionNodeView[] }) {
  return (
    <ol className="decision-ribbon" aria-label="행동 결정 경로">
      {nodes.map((node, index) => (
        <li className={`decision-node state-${node.state}`} key={node.id}>
          <div
            role="group"
            className="decision-node-button"
            aria-label={`${node.label}: ${node.value}. ${node.detail}`}
            title={node.detail}
          >
            <span className="node-glyph" aria-hidden="true">{stateGlyph[node.state]}</span>
            <span className="node-copy">
              <span className="node-label">{node.label}</span>
              <strong>{node.value}</strong>
            </span>
          </div>
          {index < nodes.length - 1 ? <span className="ribbon-link" aria-hidden="true" /> : null}
        </li>
      ))}
    </ol>
  );
}

function AgentEditor({
  agent,
  sections,
  model,
  available,
  pending,
  run,
  createClientRequestId,
}: {
  readonly agent: AgentProfileView;
  readonly sections: readonly SectionView[];
  readonly model: ControlRoomViewModel;
  readonly available: boolean;
  readonly pending: ReadonlySet<string>;
  readonly run: WorkspaceCommandRunner;
  readonly createClientRequestId: () => string;
}) {
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [roleTitle, setRoleTitle] = useState(agent.roleTitle);
  const [colorToken, setColorToken] = useState<AgentColorToken>(agent.colorToken);
  const [markToken, setMarkToken] = useState<AgentMarkToken>(agent.markToken);
  const [status, setStatus] = useState<AgentStatus>(agent.status);
  const profileKey = `agent:${agent.id}:profile`;
  const assignmentKey = `agent:${agent.id}:section`;

  const submitProfile = (event: FormEvent) => {
    event.preventDefault();
    void run({
      action: "agent.update",
      workspaceId: model.workspaceId,
      humanActorId: model.currentHumanId,
      clientRequestId: createClientRequestId(),
      agentId: agent.id,
      expectedRevision: agent.revision,
      displayName,
      roleTitle,
      colorToken,
      markToken,
      status,
    }, profileKey);
  };

  const assignSection = (sectionId: string) => {
    const section = sections.find((item) => item.id === sectionId);
    const request: AssignAgentSectionRequest = {
      action: "section.assign_agent",
      workspaceId: model.workspaceId,
      humanActorId: model.currentHumanId,
      clientRequestId: createClientRequestId(),
      agentId: agent.id,
      expectedMembershipRevision: agent.membershipRevision,
      sectionId: section?.id ?? null,
    };
    void run(request, assignmentKey);
  };

  return (
    <details className="agent-editor">
      <summary aria-label={`${agent.displayName} 프로필과 소속 편집`}>편집</summary>
      <form onSubmit={submitProfile}>
        <label>이름<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>역할<input value={roleTitle} onChange={(event) => setRoleTitle(event.target.value)} /></label>
        <div className="editor-pair">
          <label>색상<select value={colorToken} onChange={(event) => setColorToken(event.target.value as AgentColorToken)}>{colorOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>표식<select value={markToken} onChange={(event) => setMarkToken(event.target.value as AgentMarkToken)}>{markOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
        <label>상태<select value={status} onChange={(event) => setStatus(event.target.value as AgentStatus)}>{statusOptions.map((item) => <option value={item} key={item}>{statusPresentation[item].label}</option>)}</select></label>
        <button type="submit" disabled={!available || pending.has(profileKey)}>{pending.has(profileKey) ? "기록 중" : "프로필 저장"}</button>
      </form>
      <label className="assignment-control">
        소속
        <select
          value={agent.sectionId ?? ""}
          disabled={!available || pending.has(assignmentKey)}
          onChange={(event) => assignSection(event.target.value)}
        >
          <option value="">미배정</option>
          {sections.map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}
        </select>
      </label>
    </details>
  );
}

function SectionEditor({
  section,
  model,
  available,
  pending,
  run,
  createClientRequestId,
}: {
  readonly section: SectionView;
  readonly model: ControlRoomViewModel;
  readonly available: boolean;
  readonly pending: ReadonlySet<string>;
  readonly run: WorkspaceCommandRunner;
  readonly createClientRequestId: () => string;
}) {
  const [name, setName] = useState(section.name);
  const [orderKey, setOrderKey] = useState(String(section.orderKey));
  const sectionKey = `section:${section.id}`;
  const base = {
    workspaceId: model.workspaceId,
    humanActorId: model.currentHumanId,
    sectionId: section.id,
    expectedRevision: section.revision,
  } as const;
  return (
    <details className="section-editor">
      <summary aria-label={`${section.name} 섹션 관리`}>관리</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        void run({ ...base, action: "section.rename", clientRequestId: createClientRequestId(), name }, `${sectionKey}:rename`);
      }}>
        <label>이름<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button type="submit" disabled={!available || pending.has(`${sectionKey}:rename`)}>이름 저장</button>
      </form>
      <form onSubmit={(event) => {
        event.preventDefault();
        void run({ ...base, action: "section.reorder", clientRequestId: createClientRequestId(), orderKey: Number(orderKey) }, `${sectionKey}:order`);
      }}>
        <label>순서<input type="number" value={orderKey} onChange={(event) => setOrderKey(event.target.value)} /></label>
        <button type="submit" disabled={!available || pending.has(`${sectionKey}:order`)}>순서 저장</button>
      </form>
      <button
        type="button"
        className="section-delete"
        disabled={!available || pending.has(`${sectionKey}:delete`)}
        onClick={() => void run({ ...base, action: "section.delete", clientRequestId: createClientRequestId() }, `${sectionKey}:delete`)}
      >
        섹션만 삭제 · 에이전트는 미배정으로
      </button>
    </details>
  );
}

function DirectoryCreateControls({
  model,
  available,
  pending,
  run,
  createClientRequestId,
}: {
  readonly model: ControlRoomViewModel;
  readonly available: boolean;
  readonly pending: ReadonlySet<string>;
  readonly run: WorkspaceCommandRunner;
  readonly createClientRequestId: () => string;
}) {
  const [agentName, setAgentName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [sectionName, setSectionName] = useState("");

  return (
    <details className="directory-create-controls">
      <summary>프로필과 섹션 추가</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        const id = createClientRequestId();
        void run({
          action: "agent.create",
          workspaceId: model.workspaceId,
          humanActorId: model.currentHumanId,
          clientRequestId: `create-agent:${id}`,
          agentId: `agent:${id}`,
          displayName: agentName,
          roleTitle,
          colorToken: "relay-cobalt",
          markToken: "signal",
          status: "idle",
        }, "directory:create-agent").then((accepted) => {
          if (accepted) { setAgentName(""); setRoleTitle(""); }
        });
      }}>
        <strong>에이전트 추가</strong>
        <label>이름<input value={agentName} onChange={(event) => setAgentName(event.target.value)} /></label>
        <label>역할<input value={roleTitle} onChange={(event) => setRoleTitle(event.target.value)} /></label>
        <button type="submit" disabled={!available || !agentName.trim() || !roleTitle.trim() || pending.has("directory:create-agent")}>기록하고 추가</button>
      </form>
      <form onSubmit={(event) => {
        event.preventDefault();
        const id = createClientRequestId();
        const lastOrder = Math.max(0, ...model.sections.map((section) => section.orderKey));
        void run({
          action: "section.create",
          workspaceId: model.workspaceId,
          humanActorId: model.currentHumanId,
          clientRequestId: `create-section:${id}`,
          sectionId: `section:${id}`,
          name: sectionName,
          orderKey: lastOrder + 100,
        }, "directory:create-section").then((accepted) => {
          if (accepted) setSectionName("");
        });
      }}>
        <strong>섹션 추가</strong>
        <label>이름<input value={sectionName} onChange={(event) => setSectionName(event.target.value)} /></label>
        <button type="submit" disabled={!available || !sectionName.trim() || pending.has("directory:create-section")}>기록하고 추가</button>
      </form>
      {!available ? <span className="control-port-note">제어 서비스와 기록 보기가 연결되기 전에는 구성을 바꿀 수 없습니다.</span> : null}
    </details>
  );
}

export function App({
  initialModel = demoModel,
  approvalControl,
  conversationControl,
  workspaceControl,
  turnControl,
  viewControl,
  createClientRequestId = () => crypto.randomUUID(),
}: {
  readonly initialModel?: ControlRoomViewModel;
  readonly approvalControl?: ApprovalControlPort;
  readonly conversationControl?: ConversationControlPort;
  readonly workspaceControl?: WorkspaceControlPort;
  readonly turnControl?: TurnControlPort;
  readonly viewControl?: ControlRoomViewPort;
  readonly createClientRequestId?: () => string;
}) {
  const [model, setModel] = useState(initialModel);
  const [composer, setComposer] = useState("");
  const [steerText, setSteerText] = useState("");
  const [decision, setDecision] = useState<"pending" | "submitting" | "allowed" | "denied">("pending");
  const [isSending, setIsSending] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());
  const [controlNotice, setControlNotice] = useState<string>();
  const [messageNotice, setMessageNotice] = useState<string>();
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const ledgerToggleRef = useRef<HTMLButtonElement>(null);
  const ledgerCloseRef = useRef<HTMLButtonElement>(null);

  const activeConversation = useMemo(
    () => model.conversations.find((item) => item.id === model.activeConversationId),
    [model],
  );
  const activeAgent = useMemo(
    () => model.agents.find((agent) => agent.id === activeConversation?.agentId),
    [activeConversation, model.agents],
  );
  const orderedSections = useMemo(
    () => [...model.sections].sort((left, right) => left.orderKey - right.orderKey || left.id.localeCompare(right.id)),
    [model.sections],
  );
  const unassignedAgents = useMemo(
    () => model.agents.filter((agent) => !agent.sectionId),
    [model.agents],
  );
  const workspaceAvailable = Boolean(workspaceControl && viewControl);
  const turnAvailable = Boolean(turnControl && viewControl && model.activeTurn?.connected);

  useEffect(() => {
    setDecision("pending");
  }, [model.approval?.proposalId]);

  const closeLedger = () => {
    setLedgerOpen(false);
    requestAnimationFrame(() => ledgerToggleRef.current?.focus());
  };

  const openLedger = () => {
    setLedgerOpen(true);
    setTimeout(() => ledgerCloseRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!ledgerOpen) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setLedgerOpen(false);
      requestAnimationFrame(() => ledgerToggleRef.current?.focus());
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [ledgerOpen]);

  const markPending = (key: string, present: boolean) => {
    setPendingKeys((current) => {
      const next = new Set(current);
      if (present) next.add(key); else next.delete(key);
      return next;
    });
  };

  const acceptSnapshot = (snapshot: ControlRoomViewModel) => {
    setModel((current) => snapshot.lastGlobalSequence >= current.lastGlobalSequence ? snapshot : current);
  };

  const runWorkspaceCommand: WorkspaceCommandRunner = async (request, pendingKey) => {
    if (!workspaceControl || !viewControl || pendingKeys.has(pendingKey)) return false;
    markPending(pendingKey, true);
    setControlNotice(undefined);
    try {
      acceptSnapshot(await executeWorkspaceControlMutation(workspaceControl, viewControl, request));
      return true;
    } catch {
      setControlNotice("기존 표시를 바꾸지 않았습니다. 응답과 기록을 확인한 뒤 다시 시도하세요.");
      return false;
    } finally {
      markPending(pendingKey, false);
    }
  };

  const runTurnCommand = async (request: TurnControlRequest, pendingKey: string) => {
    if (!turnControl || !viewControl || pendingKeys.has(pendingKey)) return false;
    markPending(pendingKey, true);
    setControlNotice(undefined);
    try {
      acceptSnapshot(await executeTurnControlMutation(turnControl, viewControl, request));
      return true;
    } catch {
      setControlNotice("실행 상태를 바꾸지 않았습니다. 턴과 방향 epoch을 다시 확인하세요.");
      return false;
    } finally {
      markPending(pendingKey, false);
    }
  };

  const decide = async (next: "allowed" | "denied") => {
    if (!approvalControl || !model.approval) return;
    setDecision("submitting");
    try {
      const receipt = validateDecisionReceipt(
        await approvalControl.decide({
          proposalId: model.approval.proposalId,
          disposition: next === "allowed" ? "allow_exact" : "deny",
        }),
        model.approval.proposalId,
      );
      setDecision(receipt.disposition);
    } catch {
      setDecision("pending");
      setControlNotice("결정 상태를 바꾸지 않았습니다. 영수증을 확인한 뒤 다시 시도하세요.");
    }
  };

  const sendMessage = async () => {
    if (!conversationControl || !composer.trim() || !activeConversation) return;
    const request = {
      conversationId: activeConversation.id,
      clientRequestId: createClientRequestId(),
      content: composer,
    };
    setIsSending(true);
    setMessageNotice(undefined);
    try {
      validateMessageReceipt(await conversationControl.sendMessage(request), request);
      setComposer("");
    } catch {
      setMessageNotice("초안을 보존했습니다. 일치하는 기록 영수증을 받지 못했습니다.");
    } finally {
      setIsSending(false);
    }
  };

  const setReaction = (messageId: string, reactionToken: ReactionToken, present: boolean) => {
    if (!activeConversation) return;
    const key = `reaction:${activeConversation.id}:${messageId}:${reactionToken}`;
    void runWorkspaceCommand({
      action: "reaction.set",
      workspaceId: model.workspaceId,
      humanActorId: model.currentHumanId,
      clientRequestId: createClientRequestId(),
      conversationId: activeConversation.id,
      messageId,
      reactionToken,
      present,
    }, key);
  };

  const selectAgent = (agentId: string) => {
    const agent = model.agents.find((item) => item.id === agentId);
    if (agent?.activeConversationId) setModel((current) => ({ ...current, activeConversationId: agent.activeConversationId ?? current.activeConversationId }));
  };

  const renderAgent = (agent: AgentProfileView) => {
    const conversation = model.conversations.find((item) => item.id === agent.activeConversationId);
    const status = statusPresentation[agent.status];
    const active = conversation?.id === model.activeConversationId;
    return (
      <div className="agent-entry" key={agent.id}>
        <button
          type="button"
          className={`conversation-row ${active ? "is-active" : ""}`}
          aria-current={active ? "page" : undefined}
          disabled={!conversation}
          onClick={() => selectAgent(agent.id)}
        >
          <span className={`agent-mark color-${agent.colorToken} mark-${agent.markToken}`} aria-hidden="true"><i /><i /></span>
          <span className="conversation-copy">
            <strong>{agent.displayName}</strong>
            <small>{conversation?.title ?? agent.roleTitle}</small>
            <span className={`agent-status status-${agent.status}`}><i aria-hidden="true">{status.glyph}</i>{status.label}</span>
          </span>
          {conversation?.unread ? <span className="unread-count" aria-label={`읽지 않은 항목 ${conversation.unread}개`}>{conversation.unread}</span> : null}
        </button>
        <AgentEditor
          key={`${agent.id}:${agent.revision}`}
          agent={agent}
          sections={orderedSections}
          model={model}
          available={workspaceAvailable}
          pending={pendingKeys}
          run={runWorkspaceCommand}
          createClientRequestId={createClientRequestId}
        />
      </div>
    );
  };

  const turnDisabledReason = !turnControl || !viewControl
    ? "제어 서비스와 기록 보기가 연결되지 않아 방향 제어를 보낼 수 없습니다."
    : model.activeTurn?.disabledReason ?? "실행 연결이 끊겨 턴을 안전하게 제어할 수 없습니다.";

  return (
    <main className="control-room">
      <header className="command-bar">
        <div className="brand-lockup" aria-label="BotBotBot">
          <span className="relay-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>BotBotBot</span>
        </div>
        <div className="workspace-heading">
          <span className="eyebrow">Workspace</span>
          <strong>{model.workspaceName}</strong>
        </div>
        <div className="durability-state" role="status">
          <span className="state-dot" aria-hidden="true" />
          기록됨 · seq {model.lastGlobalSequence}
        </div>
      </header>

      <div className="room-grid">
        <nav className="conversation-rail" aria-label="섹션별 에이전트와 대화">
          <div className="pane-heading">
            <div><span className="eyebrow">Relay rail</span><h2>작업 흐름</h2></div>
          </div>
          <div className="agent-groups">
            {orderedSections.map((section) => {
              const agents = model.agents.filter((agent) => agent.sectionId === section.id);
              return (
                <section className="agent-section" key={section.id} aria-labelledby={`section-${section.id}`}>
                  <div className="section-heading">
                    <h3 id={`section-${section.id}`}>{section.name}<span>{agents.length}</span></h3>
                    <SectionEditor
                      key={`${section.id}:${section.revision}`}
                      section={section}
                      model={model}
                      available={workspaceAvailable}
                      pending={pendingKeys}
                      run={runWorkspaceCommand}
                      createClientRequestId={createClientRequestId}
                    />
                  </div>
                  <div className="agent-list">{agents.map(renderAgent)}</div>
                </section>
              );
            })}
            {unassignedAgents.length > 0 ? (
              <section className="agent-section unassigned-group" aria-labelledby="unassigned-heading">
                <div className="section-heading"><h3 id="unassigned-heading">미배정<span>{unassignedAgents.length}</span></h3></div>
                <div className="agent-list">{unassignedAgents.map(renderAgent)}</div>
              </section>
            ) : null}
          </div>
          <div className="rail-footer">
            <DirectoryCreateControls
              model={model}
              available={workspaceAvailable}
              pending={pendingKeys}
              run={runWorkspaceCommand}
              createClientRequestId={createClientRequestId}
            />
          </div>
        </nav>

        <section className="timeline-pane" aria-labelledby="timeline-title">
          <label className="mobile-agent-switcher">
            <span>에이전트 전환</span>
            <select value={activeAgent?.id ?? ""} onChange={(event) => selectAgent(event.target.value)}>
              {orderedSections.map((section) => (
                <optgroup label={section.name} key={section.id}>
                  {model.agents.filter((agent) => agent.sectionId === section.id).map((agent) => (
                    <option value={agent.id} key={agent.id}>{agent.displayName} · {statusPresentation[agent.status].label}</option>
                  ))}
                </optgroup>
              ))}
              {unassignedAgents.length > 0 ? (
                <optgroup label="미배정">
                  {unassignedAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName} · {statusPresentation[agent.status].label}</option>)}
                </optgroup>
              ) : null}
            </select>
          </label>
          <div className="timeline-header">
            <div><span className="eyebrow">Durable timeline</span><h1 id="timeline-title">{activeConversation?.title ?? "대화"}</h1></div>
            <label className="provider-picker">
              <span>이번 경로</span>
              <select aria-label="제공자 경로 선택" value={model.selectedProvider} onChange={(event) => setModel({ ...model, selectedProvider: event.target.value })}>
                {model.providers.map((provider) => <option key={provider}>{provider}</option>)}
              </select>
            </label>
          </div>

          <div className="timeline" aria-live="polite">
            <div className="sequence-marker"><span>through seq {model.lastGlobalSequence}</span><i /></div>
            {model.timeline.map((item) => (
              <article className={`timeline-item role-${item.role}`} key={item.id}>
                <div className="message-meta">
                  <span className="author-token">{item.author.slice(0, 1)}</span>
                  <strong>{item.author}</strong>
                  <time>{item.timestamp}</time>
                  {item.streamState === "paused" ? <span className="pause-badge" role="status">결정에서 멈춤</span> : null}
                  {item.streamState === "streaming" ? <span className="stream-badge" role="status">응답 작성 중</span> : null}
                </div>
                <p>{item.body}</p>
                {item.decisionNodes ? <DecisionRibbon nodes={item.decisionNodes} /> : null}
                {item.reactions?.length ? (
                  <div className="reaction-bar" aria-label={`${item.author} 메시지 반응`}>
                    {item.reactions.map((reaction) => {
                      const key = `reaction:${model.activeConversationId}:${item.id}:${reaction.token}`;
                      return (
                        <button
                          type="button"
                          className="reaction-button"
                          key={reaction.token}
                          aria-pressed={reaction.presentForCurrentHuman}
                          aria-label={`${reaction.label} 반응, ${reaction.count}개, ${reaction.presentForCurrentHuman ? "내 반응 있음" : "내 반응 없음"}`}
                          disabled={!workspaceAvailable || pendingKeys.has(key)}
                          title={!workspaceAvailable ? "제어 서비스와 기록 보기 연결이 필요합니다" : undefined}
                          onClick={() => setReaction(item.id, reaction.token, !reaction.presentForCurrentHuman)}
                        >
                          <span aria-hidden="true">{reaction.glyph}</span><span>{reaction.label}</span><strong>{reaction.count}</strong>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            ))}
          </div>

          {model.activeTurn?.state === "running" && activeConversation ? (
            <section className="turn-direction-dock" aria-label="실행 방향 제어">
              <div className="turn-target">
                <span className="eyebrow">Exact target</span>
                <code>{model.activeTurn.turnId} · epoch {model.activeTurn.directionEpoch}</code>
              </div>
              <label htmlFor="steer-composer">방향 전환 지시</label>
              <textarea id="steer-composer" rows={2} value={steerText} onChange={(event) => setSteerText(event.target.value)} placeholder="이전 지시를 바꾸지 않고 새 방향을 추가합니다" />
              <div className="turn-actions">
                <button
                  type="button"
                  className="stop-button"
                  disabled={!turnAvailable || pendingKeys.has("turn:stop") || pendingKeys.has("turn:steer")}
                  aria-label={`${model.activeTurn.turnId}, direction epoch ${model.activeTurn.directionEpoch} 턴 중지`}
                  onClick={() => void runTurnCommand({
                    action: "turn.stop", workspaceId: model.workspaceId, humanActorId: model.currentHumanId,
                    clientRequestId: createClientRequestId(), conversationId: activeConversation.id,
                    turnId: model.activeTurn?.turnId ?? "", directionEpoch: model.activeTurn?.directionEpoch ?? -1,
                  }, "turn:stop")}
                >{pendingKeys.has("turn:stop") ? "중지를 기록하는 중" : "이 턴 중지"}</button>
                <button
                  type="button"
                  className="steer-button"
                  disabled={!turnAvailable || !steerText.trim() || pendingKeys.has("turn:stop") || pendingKeys.has("turn:steer")}
                  aria-label={`${model.activeTurn.turnId}, direction epoch ${model.activeTurn.directionEpoch} 턴에 새 방향 추가`}
                  onClick={() => {
                    const request: TurnControlRequest = {
                      action: "turn.steer", workspaceId: model.workspaceId, humanActorId: model.currentHumanId,
                      clientRequestId: createClientRequestId(), conversationId: activeConversation.id,
                      turnId: model.activeTurn?.turnId ?? "", directionEpoch: model.activeTurn?.directionEpoch ?? -1,
                      direction: steerText,
                    };
                    void runTurnCommand(request, "turn:steer").then((accepted) => { if (accepted) setSteerText(""); });
                  }}
                >{pendingKeys.has("turn:steer") ? "방향을 기록하는 중" : "Steer · 새 방향"}</button>
              </div>
              {!turnAvailable ? <p className="control-port-note">{turnDisabledReason}</p> : <p className="control-port-note">기록 영수증과 새 뷰가 모두 확인된 뒤에만 상태가 바뀌니다.</p>}
            </section>
          ) : null}

          <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
            <label htmlFor="message-composer">메시지</label>
            <textarea id="message-composer" value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="다음 지시를 입력하세요" rows={2} />
            {messageNotice ? <p className="inline-notice" role="alert">{messageNotice}</p> : null}
            <div className="composer-actions">
              <span>{conversationControl ? "기록 확인 뒤 전송 상태가 바뀌니다" : "제어 서비스 연결 전에는 초안을 보낼 수 없습니다"}</span>
              <button type="submit" disabled={!conversationControl || !composer.trim() || isSending}>{isSending ? "기록 중" : "메시지 보내기"}</button>
            </div>
          </form>
        </section>

        <button
          ref={ledgerToggleRef}
          className="mobile-ledger-toggle"
          type="button"
          aria-controls="authority-ledger"
          aria-expanded={ledgerOpen}
          onClick={openLedger}
        >현재 권한 보기 <span>{model.approval ? 1 : 0}</span></button>
        {ledgerOpen ? <button className="ledger-scrim" type="button" aria-label="권한 원장 닫기" onClick={closeLedger} /> : null}
        <aside
          id="authority-ledger"
          className={`authority-ledger ${ledgerOpen ? "is-open" : ""}`}
          aria-label="현재 권한 원장"
          role={ledgerOpen ? "dialog" : undefined}
          aria-modal={ledgerOpen ? true : undefined}
        >
          <div className="pane-heading">
            <div><span className="eyebrow">Authority ledger</span><h2>현재 권한</h2></div>
            <span className="ledger-count">{model.approval ? 1 : 0} pending</span>
            <button ref={ledgerCloseRef} className="ledger-close" type="button" onClick={closeLedger} aria-label="권한 원장 닫기">×</button>
          </div>

          {controlNotice ? <p className="inline-notice" role="alert">{controlNotice}</p> : null}
          <section className="budget-instrument" aria-label="턴 예산">
            <div className="budget-topline"><span>턴 예산</span><strong>{model.budget.stepsUsed}/{model.budget.stepsLimit} steps</strong></div>
            <div className="budget-track" aria-hidden="true"><i style={{ width: `${(model.budget.stepsUsed / model.budget.stepsLimit) * 100}%` }} /></div>
            <dl><div><dt>비용</dt><dd>{model.budget.costUsed}</dd></div><div><dt>남은 시간</dt><dd>{model.budget.timeRemaining}</dd></div></dl>
          </section>

          <section className="mobile-directory-panel" aria-label="모바일 프로필과 섹션 관리">
            <h3>프로필과 섹션</h3>
            {activeAgent ? (
              <AgentEditor
                key={`mobile:${activeAgent.id}:${activeAgent.revision}`}
                agent={activeAgent}
                sections={orderedSections}
                model={model}
                available={workspaceAvailable}
                pending={pendingKeys}
                run={runWorkspaceCommand}
                createClientRequestId={createClientRequestId}
              />
            ) : null}
            {activeAgent?.sectionId ? orderedSections.filter((section) => section.id === activeAgent.sectionId).map((section) => (
              <SectionEditor
                key={`mobile:${section.id}:${section.revision}`}
                section={section}
                model={model}
                available={workspaceAvailable}
                pending={pendingKeys}
                run={runWorkspaceCommand}
                createClientRequestId={createClientRequestId}
              />
            )) : null}
            <DirectoryCreateControls
              model={model}
              available={workspaceAvailable}
              pending={pendingKeys}
              run={runWorkspaceCommand}
              createClientRequestId={createClientRequestId}
            />
          </section>

          {model.approval ? (
            <section className={`approval-card decision-${decision}`} aria-label="대기 중인 승인">
              <div className="approval-kicker"><span className="coral-pin" />{decision === "pending" ? "한 번의 결정 필요" : decision === "submitting" ? "결정을 기록하는 중" : decision === "allowed" ? "기록된 허용 결정" : "기록된 거부 결정"}</div>
              <h3>{model.approval.action}</h3><p>{model.approval.scope}</p>
              <dl className="approval-facts"><div><dt>제안</dt><dd>{model.approval.proposalId}</dd></div><div><dt>유효 시간</dt><dd>{model.approval.expiresIn}</dd></div><div><dt>지문</dt><dd>{model.approval.fingerprint}</dd></div></dl>
              {decision === "pending" || decision === "submitting" ? (
                <div className="decision-actions">
                  <button className="deny-button" type="button" disabled={!approvalControl || decision === "submitting"} onClick={() => void decide("denied")}>읽기 거부</button>
                  <button className="allow-button" type="button" disabled={!approvalControl || decision === "submitting"} onClick={() => void decide("allowed")}>이 읽기만 허용</button>
                  {!approvalControl ? <span className="control-port-note">제어 서비스 연결 전에는 결정할 수 없습니다.</span> : null}
                </div>
              ) : <p className="durable-decision-note">이 결정은 영수증에 따라 확정되었으며 현재 화면에서 다시 대기 상태로 돌릴 수 없습니다.</p>}
            </section>
          ) : <section className="empty-authority"><strong>대기 중인 결정 없음</strong><span>새 제안이 생기면 정확한 범위가 여기에 표시됩니다.</span></section>}

          <section className="audit-tail">
            <span className="eyebrow">Last receipt</span>
            {model.lastReceipt ? <div><span className="receipt-check">✓</span><p><strong>{model.lastReceipt.label}</strong><small>{model.lastReceipt.detail} · seq {model.lastReceipt.globalSequence}</small></p></div> : <p className="control-port-note">아직 표시할 영수증이 없습니다.</p>}
          </section>
        </aside>
      </div>
    </main>
  );
}
