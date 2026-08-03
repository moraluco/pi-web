"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  AskUserAnswer,
  AskUserOption,
  AskUserQuestion,
  AskUserRequestEvent,
  AskUserSubmitResponse,
  AskUserSubmitResult,
} from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "./MarkdownBody";

interface AnswerDraft {
  values: string[];
  customSelected: boolean;
  customText: string;
  note: string;
  optionNotes: Record<string, string>;
}

type Drafts = Record<string, AnswerDraft>;

const EMPTY_DRAFT: AnswerDraft = {
  values: [],
  customSelected: false,
  customText: "",
  note: "",
  optionNotes: {},
};

function draftFor(drafts: Drafts, questionId: string): AnswerDraft {
  return drafts[questionId] ?? EMPTY_DRAFT;
}

function isDraftEmpty(draft: AnswerDraft): boolean {
  return (
    draft.values.length === 0 &&
    !draft.customSelected &&
    !draft.customText.trim() &&
    !draft.note.trim() &&
    Object.values(draft.optionNotes).every((note) => !note.trim())
  );
}

function summarizeDraft(question: AskUserQuestion, draft: AnswerDraft): string | null {
  const parts: string[] = draft.values.map(
    (value) => question.options.find((option) => option.value === value)?.label ?? value,
  );
  if (draft.customText.trim()) parts.push(draft.customText.trim());
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Build the pi-ask remote answer payload, skipping questions the user left untouched. */
export function buildAskUserAnswers(drafts: Drafts): Record<string, AskUserAnswer> {
  const answers: Record<string, AskUserAnswer> = {};
  for (const [questionId, draft] of Object.entries(drafts)) {
    if (isDraftEmpty(draft)) continue;
    const answer: AskUserAnswer = {};
    if (draft.values.length > 0) answer.values = draft.values;
    if (draft.customSelected && draft.customText.trim()) answer.customText = draft.customText;
    if (draft.note.trim()) answer.note = draft.note;
    const optionNotes = Object.fromEntries(
      Object.entries(draft.optionNotes).filter(([, note]) => note.trim()),
    );
    if (Object.keys(optionNotes).length > 0) answer.optionNotes = optionNotes;
    answers[questionId] = answer;
  }
  return answers;
}

export function AskUserDialog({
  flow,
  onRespond,
}: {
  flow: AskUserRequestEvent;
  onRespond: (flow: AskUserRequestEvent, response: AskUserSubmitResponse) => Promise<AskUserSubmitResult>;
}) {
  const { t } = useI18n();
  const questions = flow.questions;
  const reviewTabIndex = questions.length;
  const [activeTab, setActiveTab] = useState(0);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [previewOption, setPreviewOption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset local state when a new flow arrives.
  useEffect(() => {
    setActiveTab(0);
    setDrafts({});
    setPreviewOption(null);
    setError(null);
    setSubmitting(false);
  }, [flow.flowId]);

  const activeQuestion: AskUserQuestion | undefined = questions[activeTab];
  const isReview = activeTab === reviewTabIndex;

  const updateDraft = (questionId: string, patch: Partial<AnswerDraft>) => {
    setDrafts((current) => ({
      ...current,
      [questionId]: { ...draftFor(current, questionId), ...patch },
    }));
  };

  const selectOption = (question: AskUserQuestion, option: AskUserOption) => {
    const draft = draftFor(drafts, question.id);
    if (question.type === "multi") {
      const values = draft.values.includes(option.value)
        ? draft.values.filter((value) => value !== option.value)
        : [...draft.values, option.value];
      updateDraft(question.id, { values });
    } else if (draft.values.includes(option.value)) {
      // Clicking the selected single/preview option again deselects it.
      updateDraft(question.id, { values: [] });
    } else {
      updateDraft(question.id, { values: [option.value], customSelected: false });
      setPreviewOption(option.value);
    }
  };

  const selectCustom = (question: AskUserQuestion) => {
    const draft = draftFor(drafts, question.id);
    if (question.type === "multi") {
      updateDraft(question.id, { customSelected: !draft.customSelected });
    } else {
      updateDraft(question.id, { values: [], customSelected: true });
      setPreviewOption(null);
    }
  };

  const respond = async (response: AskUserSubmitResponse) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onRespond(flow, response);
      if (!result.ok) setError(result.message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitAnswers = (mode: "submit" | "elaborate") =>
    respond({ kind: "answer", answers: buildAskUserAnswers(drafts), mode });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        void respond({ kind: "cancel" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.flowId, submitting]);

  const currentPreview = useMemo(() => {
    if (!activeQuestion || activeQuestion.type !== "preview") return null;
    const draft = draftFor(drafts, activeQuestion.id);
    const value = previewOption ?? draft.values[0] ?? null;
    if (!value) return null;
    return activeQuestion.options.find((option) => option.value === value)?.preview ?? null;
  }, [activeQuestion, drafts, previewOption]);

  const tabButton = (index: number, label: string, answered: boolean) => (
    <button
      key={index}
      onClick={() => setActiveTab(index)}
      style={{
        padding: "4px 10px",
        borderRadius: 6,
        border: "1px solid",
        borderColor: activeTab === index ? "var(--accent)" : "var(--border)",
        background: activeTab === index ? "var(--bg-panel)" : "transparent",
        color: activeTab === index ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        fontSize: 12,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        whiteSpace: "nowrap",
      }}
    >
      {label}
      {answered && <span style={{ color: "var(--accent)", fontSize: 10 }}>●</span>}
    </button>
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(720px, 100%)",
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>
              {flow.title ?? t("chat.askUser.title")}
            </div>
            <div style={{ color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>ask_user</div>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {questions.map((question, index) =>
              tabButton(index, question.label || `Q${index + 1}`, !isDraftEmpty(draftFor(drafts, question.id))),
            )}
            {tabButton(reviewTabIndex, t("chat.askUser.review"), false)}
          </div>
        </div>

        <div style={{ padding: 14, overflowY: "auto", flex: 1, minHeight: 0 }}>
          {!isReview && activeQuestion && (
            <div>
              <div style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {activeQuestion.prompt}
                {activeQuestion.required && (
                  <span style={{ marginLeft: 6, color: "#d97706", fontSize: 11 }}>
                    {t("chat.askUser.required")}
                  </span>
                )}
              </div>

              <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                {activeQuestion.options.map((option) => {
                  const draft = draftFor(drafts, activeQuestion.id);
                  const selected = draft.values.includes(option.value);
                  return (
                    <div key={option.value}>
                      <button
                        onClick={() => selectOption(activeQuestion, option)}
                        onMouseEnter={() => activeQuestion.type === "preview" && setPreviewOption(option.value)}
                        style={{
                          width: "100%",
                          padding: "9px 10px",
                          borderRadius: 7,
                          border: "1px solid",
                          borderColor: selected ? "var(--accent)" : "var(--border)",
                          background: selected ? "var(--bg-panel)" : "transparent",
                          color: "var(--text)",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: 13,
                          display: "flex",
                          alignItems: "baseline",
                          gap: 8,
                        }}
                      >
                        <span style={{ color: selected ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                          {activeQuestion.type === "multi" ? (selected ? "☑" : "☐") : selected ? "●" : "○"}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          {option.label}
                          {option.description && (
                            <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: 12 }}>
                              {option.description}
                            </span>
                          )}
                        </span>
                      </button>
                      {selected && (
                        <input
                          value={draftFor(drafts, activeQuestion.id).optionNotes[option.value] ?? ""}
                          placeholder={t("chat.askUser.optionNote")}
                          onChange={(event) =>
                            updateDraft(activeQuestion.id, {
                              optionNotes: {
                                ...draftFor(drafts, activeQuestion.id).optionNotes,
                                [option.value]: event.target.value,
                              },
                            })
                          }
                          style={{
                            marginTop: 4,
                            marginLeft: 26,
                            width: "calc(100% - 26px)",
                            padding: "6px 8px",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            background: "var(--bg-panel)",
                            color: "var(--text)",
                            outline: "none",
                            fontSize: 12,
                          }}
                        />
                      )}
                    </div>
                  );
                })}

                <div>
                  <button
                    onClick={() => selectCustom(activeQuestion)}
                    style={{
                      width: "100%",
                      padding: "9px 10px",
                      borderRadius: 7,
                      border: "1px dashed",
                      borderColor: draftFor(drafts, activeQuestion.id).customSelected
                        ? "var(--accent)"
                        : "var(--border)",
                      background: "transparent",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 13,
                    }}
                  >
                    ✎ {t("chat.askUser.custom")}
                  </button>
                  {draftFor(drafts, activeQuestion.id).customSelected && (
                    <textarea
                      autoFocus
                      value={draftFor(drafts, activeQuestion.id).customText}
                      onChange={(event) =>
                        updateDraft(activeQuestion.id, { customText: event.target.value })
                      }
                      style={{
                        marginTop: 6,
                        width: "100%",
                        minHeight: 64,
                        padding: 8,
                        borderRadius: 7,
                        border: "1px solid var(--border)",
                        background: "var(--bg-panel)",
                        color: "var(--text)",
                        outline: "none",
                        fontSize: 13,
                        resize: "vertical",
                      }}
                    />
                  )}
                </div>
              </div>

              {activeQuestion.type === "preview" && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 10,
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    fontSize: 13,
                    // Fixed height: the pane must not resize the dialog as
                    // the user hovers different options.
                    height: 180,
                    overflowY: "auto",
                  }}
                >
                  {currentPreview ? (
                    <MarkdownBody>{currentPreview}</MarkdownBody>
                  ) : (
                    <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                      {t("chat.askUser.previewHint")}
                    </span>
                  )}
                </div>
              )}

              <input
                value={draftFor(drafts, activeQuestion.id).note}
                placeholder={t("chat.askUser.note")}
                onChange={(event) => updateDraft(activeQuestion.id, { note: event.target.value })}
                style={{
                  marginTop: 10,
                  width: "100%",
                  padding: "7px 9px",
                  borderRadius: 7,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  outline: "none",
                  fontSize: 12,
                }}
              />
            </div>
          )}

          {isReview && (
            <div style={{ display: "grid", gap: 10 }}>
              {questions.map((question, index) => {
                const draft = draftFor(drafts, question.id);
                const summary = summarizeDraft(question, draft);
                return (
                  <button
                    key={question.id}
                    onClick={() => setActiveTab(index)}
                    style={{
                      padding: "9px 10px",
                      borderRadius: 7,
                      border: "1px solid var(--border)",
                      background: "var(--bg-panel)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                      {question.label || `Q${index + 1}`}
                    </div>
                    <div style={{ marginTop: 2, color: "var(--text)", fontSize: 13 }}>
                      {summary ?? (
                        <span style={{ color: "var(--text-dim)" }}>{t("chat.askUser.unanswered")}</span>
                      )}
                    </div>
                    {draft.note.trim() && (
                      <div style={{ marginTop: 2, color: "var(--text-muted)", fontSize: 12 }}>
                        {t("chat.askUser.noteLabel")}: {draft.note.trim()}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {error && (
          <div
            style={{
              padding: "8px 14px",
              borderTop: "1px solid var(--border)",
              color: "#dc2626",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <button
            onClick={() => void respond({ kind: "cancel" })}
            disabled={submitting}
            style={{
              padding: "7px 12px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {t("chat.cancel")}
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {!isReview && (
              <button
                onClick={() => setActiveTab(reviewTabIndex)}
                style={{
                  padding: "7px 12px",
                  borderRadius: 7,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {t("chat.askUser.review")} →
              </button>
            )}
            {isReview && (
              <>
                <button
                  onClick={() => void submitAnswers("elaborate")}
                  disabled={submitting}
                  style={{
                    padding: "7px 12px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  {t("chat.askUser.elaborate")}
                </button>
                <button
                  onClick={() => void submitAnswers("submit")}
                  disabled={submitting}
                  style={{
                    padding: "7px 14px",
                    borderRadius: 7,
                    border: "1px solid var(--accent)",
                    background: "var(--accent)",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {t("chat.submit")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
