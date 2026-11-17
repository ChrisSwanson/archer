import { useState } from "react";

/**
 * The live role for a banner that stays up while its words change (O156): "alert" when it first appears, so it is
 * announced as it happens; "status" once its words have changed, because an alert is read out again, assertively,
 * every time its text changes, and those changes follow the person's own actions. `null` while nothing is shown;
 * the next appearance is an alert again. Adjusted during render, not in an effect, so the first paint has the role.
 */
export function useAnnouncedOnce(text: string | null): "alert" | "status" | null {
  const [shown, setShown] = useState<{ first: string; changed: boolean } | null>(null);
  if (text === null) {
    if (shown !== null) setShown(null);
    return null;
  }
  if (shown === null) {
    setShown({ first: text, changed: false });
    return "alert";
  }
  const changed = shown.changed || shown.first !== text;
  if (changed && !shown.changed) setShown({ ...shown, changed: true });
  return changed ? "status" : "alert";
}
