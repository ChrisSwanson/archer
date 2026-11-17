import { useState, type JSX } from "react";
import type { MissingTarget } from "./useAuthoring";

/**
 * The editor reopened on work whose diagram file is gone: deleted, renamed or moved before it was saved, or a save
 * held offline (claude-203). The person's Mermaid is shown, with Copy, and three ways on: save it as a new diagram
 * where it was, keep it as a private proposal, or discard it. Nothing is sent to the missing file, and a new file is
 * never written over another one (the service creates files only where none exists).
 */
export function MissingWork({
  missing,
  discarded,
  busy,
  error,
  onSaveNew,
  onProposal,
  onDiscard,
  onBack,
  projectHref,
  onResume,
}: {
  missing: MissingTarget | null;
  discarded: boolean;
  busy: boolean;
  error: string | null;
  onSaveNew: (path: string) => void;
  onProposal: () => void;
  onDiscard: () => void;
  onBack?: () => void;
  projectHref?: string | null;
  /** Takes another tab's (closed) work on it here, when `missing.other` is `offered` (claude-403). */
  onResume?: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false),
    [confirming, setConfirming] = useState(false);
  const back = onBack ? (
    <button type="button" onClick={onBack}>
      Back to reading
    </button>
  ) : projectHref ? (
    <a href={projectHref}>Go to the project</a>
  ) : null;
  if (!missing)
    return (
      <section className="authoring-workspace authoring-missing" aria-labelledby="authoring-missing-title">
        <h2 id="authoring-missing-title">Change Discarded</h2>
        <p role="status">Your change was removed from this browser. Nothing was saved.</p>
        {back ? <p>{back}</p> : null}
      </section>
    );
  void discarded;
  const source = missing.source;
  if (source === null)
    return (
      <section className="authoring-workspace authoring-missing" aria-labelledby="authoring-missing-title">
        <h2 id="authoring-missing-title">This Diagram’s File Is Gone</h2>
        <p role="status">
          {missing.path
            ? missing.blockId
              ? `The diagram “${missing.blockId}” in ${missing.path}`
              : missing.path
            : "It"}{" "}
          was deleted, renamed or moved.{" "}
          {missing.other === "offered"
            ? missing.otherSave === "held"
              ? "A save of it from another tab, now closed, is held in this browser, not sent yet."
              : missing.otherSave === "unconfirmed"
                ? "A save of it from another tab, now closed, got no answer: not known whether it reached Archer. It is kept in this browser."
                : "Your unsaved changes to it from another tab, now closed, are kept in this browser."
            : missing.other === "open"
              ? "Unsaved changes to it are open in another tab; they stay there."
              : "You have no unsaved changes to it in this browser."}
        </p>
        {missing.other === "offered" && onResume ? (
          <p>
            <button type="button" className="authoring-primary" onClick={onResume}>
              Resume them
            </button>
          </p>
        ) : null}
        {back ? <p>{back}</p> : null}
      </section>
    );
  const embedded = missing.blockId !== null || !missing.path?.endsWith(".mmd");
  const here = embedded ? `diagrams/${missing.blockId ?? "recovered"}.mmd` : missing.path!;
  const where = missing.path
    ? missing.blockId
      ? `The diagram “${missing.blockId}” in ${missing.path}`
      : missing.path
    : "Its file";
  const copy = () => {
    void navigator.clipboard?.writeText(source).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };
  return (
    <section className="authoring-workspace authoring-missing" aria-labelledby="authoring-missing-title">
      <h2 id="authoring-missing-title">This Diagram’s File Is Gone</h2>
      <p role="status">
        {where} was deleted, renamed or moved before your change was saved.{" "}
        {missing.held
          ? "Your save was kept in this browser and was not sent, so nothing was written."
          : "Your change is not saved anywhere else; it is kept in this browser."}
      </p>
      <label className="authoring-missing-source">
        Your Mermaid
        <textarea
          readOnly
          value={source}
          rows={Math.min(16, Math.max(4, source.split("\n").length))}
          spellCheck={false}
        />
      </label>
      <div className="authoring-recovery-actions">
        <button type="button" className="authoring-primary" disabled={busy} onClick={() => onSaveNew(here)}>
          {embedded ? "Save as a new diagram" : "Save as a new diagram here"}
        </button>
        <button type="button" disabled={busy} onClick={onProposal}>
          Save as a proposal
        </button>
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy my Mermaid"}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
          Discard
        </button>
        {back}
      </div>
      <p className="authoring-secondary">
        {embedded ? (
          <>
            Save as a new diagram creates <span className="authoring-path">{here}</span>.
          </>
        ) : (
          <>
            Save as a new diagram here creates <span className="authoring-path">{here}</span> again.
          </>
        )}{" "}
        If a file is already there, nothing is written over it and you choose another name. A proposal is kept privately
        and writes no file.
      </p>
      {confirming ? (
        <div className="authoring-error" role="alertdialog" aria-labelledby="authoring-missing-discard">
          <span id="authoring-missing-discard">Discard your change? It is not saved anywhere else.</span>{" "}
          <button type="button" onClick={onDiscard}>
            Discard
          </button>{" "}
          <button type="button" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="authoring-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
