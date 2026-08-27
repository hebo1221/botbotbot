import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, demoModel } from "../src/ui/App";
import { validateDecisionReceipt } from "../src/application/approvalControl";
import { validateMessageReceipt } from "../src/application/conversationControl";

describe("desktop-facing control room", () => {
  it("renders the three panes and the complete provider-to-receipt decision ribbon", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Relay rail");
    expect(html).toContain("Durable timeline");
    expect(html).toContain("Authority ledger");
    expect(html).toContain("행동 결정 경로");
    expect(html).toContain('role="group" class="decision-node-button"');
    expect(html).not.toContain('<button type="button" class="decision-node-button"');
    expect(html).toContain("제안: 윤슬");
    expect(html).toContain("경로: Clarity");
    expect(html).toContain("정책: 범위 확인");
    expect(html).toContain("결정: 대기 중");
    expect(html).toContain("영수증: 아직 없음");
    expect(html).toContain("이 읽기만 허용");
    expect(html).toContain("읽기 거부");
    expect(html).toContain("제어 서비스 연결 전에는 결정할 수 없습니다.");
    expect(html).toContain("disabled");
    expect(html).toContain("제어 서비스 연결 전에는 초안을 보낼 수 없습니다");
    expect(html).toContain("실험 릴레이");
    expect(html).toContain("배포 검증");
    expect(html).toContain("미배정");
    expect(html).toContain("대기");
    expect(html).toContain("작업 중");
    expect(html).toContain("사람의 결정 대기");
    expect(html).toContain("중지됨");
    expect(html).toContain("오류");
    expect(html).toContain("status-idle");
    expect(html).toContain("status-working");
    expect(html).toContain("status-waiting_for_human");
    expect(html).toContain("status-stopped");
    expect(html).toContain("status-error");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("aria-pressed=\"false\"");
    expect(html).toContain("주목 반응, 2개, 내 반응 있음");
    expect(html).toContain("turn-memory-audit-019 · epoch 3");
    expect(html).toContain("실행 방향 제어");
    expect(html).toContain("제어 서비스와 기록 보기가 연결되지 않아");
    expect(html).toContain("기록됨 · seq 184");
    expect(html).toContain("현재 권한 보기");
    expect(html).toContain("aria-controls=\"authority-ledger\"");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("결정 검토로 돌아가기");
  });

  it("renders the unassigned projection only when at least one agent needs it", () => {
    const assignedOnly = {
      ...demoModel,
      agents: demoModel.agents.filter((agent) => agent.sectionId),
    };
    const html = renderToStaticMarkup(<App initialModel={assignedOnly} />);
    expect(html).not.toContain("id=\"unassigned-heading\"");
    expect(html).not.toContain("label=\"미배정\"");
  });

  it("does not accept or clear a renderer message without a matching durable message receipt", () => {
    const request = {
      conversationId: "conv-memory-audit",
      clientRequestId: "client-1",
      content: "keep this draft",
    };
    expect(() => validateMessageReceipt({
      receiptKind: "durable_message_event",
      conversationId: "another-conversation",
      clientRequestId: "client-1",
      messageId: "message-1",
      globalSequence: 186,
    }, request)).toThrow("valid durable message receipt");
    expect(validateMessageReceipt({
      receiptKind: "durable_message_event",
      conversationId: "conv-memory-audit",
      clientRequestId: "client-1",
      messageId: "message-1",
      globalSequence: 186,
    }, request)).toMatchObject({ messageId: "message-1", globalSequence: 186 });
  });

  it("accepts authority state only from a matching durable control-service receipt", () => {
    expect(() => validateDecisionReceipt({
      proposalId: "prop_7d91",
      disposition: "allowed",
      globalSequence: 185,
    }, "prop_7d91")).toThrow("valid durable decision receipt");
    expect(() => validateDecisionReceipt({
      receiptKind: "durable_control_event",
      proposalId: "another-proposal",
      disposition: "allowed",
      globalSequence: 185,
    }, "prop_7d91")).toThrow("valid durable decision receipt");
    expect(validateDecisionReceipt({
      receiptKind: "durable_control_event",
      proposalId: "prop_7d91",
      disposition: "denied",
      globalSequence: 185,
    }, "prop_7d91")).toMatchObject({ disposition: "denied", globalSequence: 185 });
  });

  it("includes keyboard focus, mobile layout, and reduced-motion quality gates", async () => {
    const css = await readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".authority-ledger.is-open");
    expect(css).toContain("position: fixed");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("grid-template-columns: repeat(5, 84px)");
  });
});
