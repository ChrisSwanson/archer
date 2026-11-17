import { useEffect, useState, type JSX } from "react";
import {
  reloadApplication,
  restoreScrollAfterUpdate,
  subscribeApplicationUpdate,
  type ReloadCue,
} from "./application-update";
import "./ApplicationUpdateCue.css";

/**
 * The App Shell's one reload cue (ADR 0032): an upgraded service, when the page could not reload itself
 * without losing work, or a layout worker that could not start. It is announced (a status), never blocks or
 * takes focus; Reload is the person's choice.
 */
export function ApplicationUpdateCue(): JSX.Element | null {
  const [shown, setShown] = useState<ReloadCue>(false);
  useEffect(() => {
    restoreScrollAfterUpdate();
    return subscribeApplicationUpdate(setShown);
  }, []);
  if (!shown) return null;
  return (
    <p className="archer-update-cue" role="status">
      <span className="archer-update-cue-text">
        {shown === "layout" ? "Layout could not start" : "Archer was updated"}
      </span>
      <span className="archer-update-cue-short" aria-hidden="true">
        {shown === "layout" ? "Layout failed" : "Updated"}
      </span>
      <span aria-hidden="true"> · </span>
      <button type="button" className="archer-update-cue-reload" onClick={reloadApplication}>
        Reload
      </button>
    </p>
  );
}
