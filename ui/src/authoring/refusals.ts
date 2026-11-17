/**
 * User-facing copy for every way an authoring request can be refused.
 *
 * `describeRefusal(code, detail?)` turns a server refusal code (the editors' `edit_*` codes and the codes in
 * `authoring-http.ts`'s status map) into what happened, what to do next, and optional structured actions the
 * caller may render as buttons. The raw code never belongs in the main text: it is returned as `details` for
 * a tooltip or a "details" disclosure (agents and bug reports still want it).
 *
 * Copy rules: say what happened in the user's terms ("connections", "shapes", not "declarations" or "ids"
 * unless Mermaid source is the point), then the next step. No blame, no jargon, no trailing codes.
 */

/** A next step the caller can offer. `kind` says what to do; `label` is the button text. */
export type RefusalAction =
  | { kind: "delete-connections"; label: string }
  | { kind: "show-existing"; label: string; id: string }
  | { kind: "open-source"; label: string }
  | { kind: "reload"; label: string }
  | { kind: "retry"; label: string }
  | { kind: "undo"; label: string }
  | { kind: "rename"; label: string };

/** What the caller knows about the refused edit. Everything is optional. */
export interface RefusalDetail {
  /** `existingId` from `edit_relationship_exists`. */
  existingId?: string;
  /** The compiler's first error, attached to `edit_requires_valid_*`. */
  diagnostic?: { message: string; line?: number; code?: string };
  /** The subject's name as the user sees it (label, never an internal id when a label exists). */
  name?: string;
  /** How many connections (or similar) are in the way. */
  count?: number;
  /** The server's own message, shown only for codes with no copy of their own. */
  message?: string;
  /** The refused edit's kind (`change-arrow`, `retarget-edge`, …), for codes several edits share. */
  edit?: string;
}

export interface Refusal {
  /** What happened, one sentence. */
  what: string;
  /** What to do about it, one sentence. */
  todo: string;
  /** `what` and `todo` as one string, for call sites that show a single line. */
  message: string;
  /** Buttons worth offering, most useful first. */
  actions: RefusalAction[];
  /** `info`: nothing is wrong. `blocked`: the edit can't be done as asked. `problem`: something needs attention. */
  severity: "info" | "blocked" | "problem";
  /** The raw code (plus compiler diagnostic) for a tooltip or "details". */
  details: string;
  /** False for codes this table has no copy for. */
  known: boolean;
}

type Entry = {
  what: string | ((d: RefusalDetail) => string);
  todo: string | ((d: RefusalDetail) => string);
  actions?: RefusalAction[] | ((d: RefusalDetail) => RefusalAction[]);
  severity?: Refusal["severity"];
};

const SOURCE: RefusalAction = { kind: "open-source", label: "Edit the Mermaid source" };
const RELOAD: RefusalAction = { kind: "reload", label: "Reload" };
const RETRY: RefusalAction = { kind: "retry", label: "Try again" };
const RENAME: RefusalAction = { kind: "rename", label: "Choose another name" };

const subject = (d: RefusalDetail, fallback: string): string => (d.name ? `“${d.name}”` : fallback);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The compiler's reason, when the refusal carries one. */
function why(d: RefusalDetail): string {
  const found = d.diagnostic;
  if (!found) return "The source uses Mermaid that the visual editor does not handle yet.";
  return `Line ${found.line ?? "?"}: ${found.message}`;
}
const needsValid = (kind: string): Entry => ({
  what: (d) => `This ${kind} can't be edited visually yet. ${why(d)}`,
  todo: "Fix it in the Mermaid source, and the canvas will pick it up again.",
  actions: [SOURCE],
  severity: "problem",
});

const ENTRIES: Record<string, Entry> = {
  // --- Deleting -----------------------------------------------------------------------------------------
  edit_delete_referenced_node: {
    what: (d) =>
      d.count
        ? `${subject(d, "This shape")} still has ${plural(d.count, "connection", "connections")}.`
        : `${subject(d, "This shape")} still has connections.`,
    todo: "Delete it together with its connections; Undo brings it all back.",
    actions: () => [{ kind: "delete-connections", label: "Delete it and its connections" }],
  },
  edit_delete_styling_dependency: {
    what: "The diagram has style lines (style, class, linkStyle) that point at this, and deleting it would leave them dangling.",
    todo: "Remove the matching style lines in the Mermaid source, then delete it.",
    actions: [SOURCE],
  },
  edit_delete_inline_declaration: {
    what: "This is written inside a connection line (for example a[A] --> b[B]), so deleting it would rewrite that line.",
    todo: "Split the line in the Mermaid source, or rename it instead.",
    actions: [SOURCE],
  },
  edit_delete_nonisolated_declaration: {
    what: "This shares its line with other statements, so it can’t be removed on its own.",
    todo: "Put it on its own line in the Mermaid source, then try again.",
    actions: [SOURCE],
  },
  edit_delete_multiple_declarations: {
    what: "This is declared more than once in the source.",
    todo: "Remove the duplicates in the Mermaid source, then try again.",
    actions: [SOURCE],
  },
  edit_delete_boundary_unsupported: {
    what: "Deleting a whole boundary isn’t supported from the canvas.",
    todo: "Delete the elements inside it one by one, or remove the boundary in the Mermaid source.",
    actions: [SOURCE],
  },
  edit_delete_last_in_boundary: {
    what: "That is the last element in its boundary, and an empty boundary isn’t valid.",
    todo: "Add another element first, or delete the boundary in the Mermaid source.",
    actions: [SOURCE],
  },
  edit_delete_last_element: {
    what: "That is the only element in the diagram, and a diagram needs at least one.",
    todo: "Add another element first, then delete this one.",
  },
  edit_delete_composite_unsupported: {
    what: "This state contains other states, so it can’t be deleted from the canvas.",
    todo: "Delete the states inside it first, or remove it in the Mermaid source.",
    actions: [SOURCE],
  },
  edit_delete_note_dependency: {
    what: "A note is attached to this state.",
    todo: "Delete the note in the Mermaid source first, then delete the state.",
    actions: [SOURCE],
  },
  edit_delete_leaves_undrawn_state: {
    what: "Deleting this connection would leave a state that appears nowhere in the drawing.",
    todo: "Give the state a name, or delete the state itself.",
  },
  edit_activation_dependency: {
    what: "This message turns an activation on or off, so deleting, moving or reversing it would leave the activations unbalanced.",
    todo: "Remove the matching activation message too, or edit the Mermaid source.",
    actions: [SOURCE],
  },
  // --- Reattaching and connecting -----------------------------------------------------------------------
  edit_retarget_inline_declaration: {
    what: "This connection is written together with a shape (for example a[A] --> b[B]), so moving its end would rewrite the shape too.",
    todo: "Split the line in the Mermaid source, then drag the end again.",
    actions: [SOURCE],
  },
  edit_retarget_styling_dependency: {
    what: "The diagram has style lines that refer to this connection, and moving its end would leave them pointing at the wrong thing.",
    todo: "Update or remove those style lines in the Mermaid source first.",
    actions: [SOURCE],
  },
  edit_retarget_leaves_undrawn_state: {
    what: "Moving this end would leave a state that appears nowhere in the drawing.",
    todo: "Give the state a name or another connection first.",
  },
  edit_relationship_exists: {
    what: (d) =>
      `There is already a connection between those two${d.existingId ? ` (${d.existingId.replace("--", " → ")})` : ""}.`,
    todo: "Edit the existing connection, or pick a different pair.",
    actions: (d) => (d.existingId ? [{ kind: "show-existing", label: "Show the existing one", id: d.existingId }] : []),
  },
  edit_relationship_id_ambiguous: {
    what: "A name that contains “--” can’t be told apart from the arrow that joins two names.",
    todo: "Rename it without “--”, then connect it.",
    actions: [RENAME],
  },
  edit_relationship_id_derived: {
    what: "A connection’s identity comes from the two things it joins and can’t be set by hand.",
    todo: "Leave it out and try again.",
  },
  edit_endpoint_boundary: {
    what: "A boundary can’t be one end of a connection.",
    todo: "Connect to an element inside it instead.",
  },
  edit_invalid_endpoint: {
    what: "A start marker can only begin a transition, and an end marker can only finish one.",
    todo: "Draw from the start marker to a state, or from a state to the end marker.",
  },
  edit_start_end_scope: {
    what: "The start and end markers belong to one level of the diagram, and this connection crosses levels.",
    todo: "Connect states at the same level, or use the marker inside the composite state.",
  },
  edit_scope_mismatch: {
    what: "These two states are at different levels (one is inside a composite state), so they can’t be connected directly.",
    todo: "Connect states at the same level.",
  },
  edit_endpoint_required: {
    what: "There is no new end to attach to.",
    todo: "Drop the end on a shape or participant.",
  },
  edit_invalid_relation: {
    what: "That kind of relationship isn’t available in this diagram.",
    todo: "Pick one from the parts bar.",
  },
  edit_invalid_cardinality: {
    what: "That cardinality isn’t available.",
    todo: "Pick one from the parts bar.",
  },
  edit_invalid_line: {
    what: (d) => (d.edit === "change-arrow" ? "That arrow isn’t available." : "That line style isn’t available."),
    todo: (d) =>
      d.edit === "change-arrow"
        ? "Pick One-way, Two-way or Reverse."
        : "Pick Arrow, Dashed or Thick from the parts bar.",
  },
  edit_invalid_message_kind: {
    // Mermaid has two-way sync (<<->>) and reply (<<-->>) arrows, but no two-way async one.
    what: (d) =>
      d.edit === "change-arrow"
        ? "An async message has one arrowhead only: Mermaid has no two-way async arrow."
        : d.edit === "retarget-edge"
          ? "A two-way message can’t be async: Mermaid has no two-way async arrow."
          : "That message type isn’t available.",
    todo: (d) =>
      d.edit === "change-arrow"
        ? "Change its type to Message or Reply first."
        : d.edit === "retarget-edge"
          ? "Make it one-way first, then async."
          : "Pick one from the parts bar.",
  },
  edit_invalid_note: {
    what: "A note must sit beside, or over one or two, participants.",
    todo: "Select the participant (or two, for “over”) first, then add the note.",
  },
  // --- Names, labels and kinds --------------------------------------------------------------------------
  edit_invalid_label: {
    what: "That label can’t be written to the source as typed.",
    todo: "Remove leading or trailing spaces, line breaks and <tags>, and keep it short.",
  },
  edit_label_required: {
    what: "This connection needs a label.",
    todo: "Type a short label and try again.",
  },
  edit_label_unsupported: {
    what: "This kind of state (choice, fork, join or the start and end markers) has no label.",
    todo: "Leave its label empty.",
  },
  edit_relabel_unsupported: {
    what: "This kind of state (choice, fork, join or the start and end markers) can’t be renamed.",
    todo: "Rename a normal state instead.",
  },
  edit_relabel_styled_declaration: {
    what: "This state is styled in its declaration line (:::), so renaming it would disturb the style.",
    todo: "Rename it in the Mermaid source.",
    actions: [SOURCE],
  },
  edit_id_exists: {
    what: (d) => `${subject(d, "That name")} is already used in this diagram.`,
    todo: "Choose a different name.",
    actions: [RENAME],
  },
  edit_id_required: {
    what: "A name is required.",
    todo: "Type a name and try again.",
  },
  edit_id_reserved: {
    what: (d) => `${subject(d, "That name")} is a Mermaid keyword, and would be read as syntax.`,
    todo: "Choose a different name.",
    actions: [RENAME],
  },
  edit_invalid_id: {
    what: "Names must start with a letter and use only letters, digits, “_” and “-”, within the length limit.",
    todo: "Choose a simpler name.",
    actions: [RENAME],
  },
  edit_invalid_shape: { what: "That shape isn’t available.", todo: "Pick one from the parts bar." },
  edit_invalid_element: { what: "That kind of element isn’t available.", todo: "Pick one from the parts bar." },
  edit_element_required: {
    what: "An element needs a kind (person, system, container…).",
    todo: "Pick one from the parts bar.",
  },
  edit_invalid_state_kind: { what: "That kind of state isn’t available.", todo: "Pick one from the parts bar." },
  edit_invalid_participant_kind: {
    what: "That kind of participant isn’t available.",
    todo: "Pick one from the parts bar.",
  },
  // --- Sequence ordering and blocks ---------------------------------------------------------------------
  edit_move_same_message: {
    what: "That message is already there.",
    todo: "Nothing to change; drop it on a different spot to move it.",
    severity: "info",
  },
  edit_move_same_participant: {
    what: "That participant is already there.",
    todo: "Nothing to change; drop it on a different spot to move it.",
    severity: "info",
  },
  edit_move_cross_block: {
    what: "Messages can’t be moved across the edge of a block (loop, if/else, optional or parallel).",
    todo: "Move it within its block, or edit the Mermaid source.",
    actions: [SOURCE],
  },
  edit_move_in_fragment: {
    what: "A participant can’t be moved relative to something inside a block.",
    todo: "Drop it before or after a participant outside any block.",
  },
  edit_wrap_cross_block: {
    what: "The selected messages sit in different blocks, so they can’t be wrapped together.",
    todo: "Select messages that are all in the same block.",
  },
  edit_wrap_not_consecutive: {
    what: "Only messages that follow one another can be wrapped together.",
    todo: "Select an unbroken run of messages (Shift-click the last one).",
  },
  edit_wrap_spans_declaration: {
    what: "Something between these messages (a participant declaration or other line) would end up inside the block.",
    todo: "Move that line out of the way in the Mermaid source, or wrap fewer messages.",
    actions: [SOURCE],
  },
  edit_unwrap_sections: {
    what: "This block has more than one section (else, and, option), so it can’t be removed in one step.",
    todo: "Remove it in the Mermaid source.",
    actions: [SOURCE],
  },
  edit_fragment_unsupported: {
    what: "Archer can’t wrap messages in that kind of block yet.",
    todo: "Use Loop, If / else, Optional or Parallel, or write it in the Mermaid source.",
    actions: [SOURCE],
  },
  edit_invalid_fragment: { what: "That kind of block isn’t available.", todo: "Pick one from the parts bar." },
  // --- The source itself --------------------------------------------------------------------------------
  edit_requires_valid_flowchart: needsValid("flowchart"),
  edit_requires_valid_c4: needsValid("C4 diagram"),
  edit_requires_valid_er: needsValid("ER diagram"),
  edit_requires_valid_state: needsValid("state diagram"),
  edit_requires_valid_sequence: needsValid("sequence diagram"),
  edit_source_mapping_ambiguous: {
    what: "The source has something (a duplicate, a combined line or an unusual layout) that makes it unclear which line to change.",
    todo: "Make the change in the Mermaid source instead.",
    actions: [SOURCE],
  },
  edit_invalid_result: {
    what: "That change would have produced a diagram that doesn’t compile, so it was not applied.",
    todo: "Try a simpler value, or make the change in the Mermaid source.",
    actions: [SOURCE],
  },
  edit_target_missing: {
    what: "The thing you changed is no longer in the diagram. It was probably renamed or removed a moment ago.",
    todo: "Select it again and retry.",
    actions: [RETRY],
  },
  edit_unsupported_family: {
    what: "Visual editing isn’t available for this type of diagram.",
    todo: "Edit the Mermaid source.",
    actions: [SOURCE],
  },
  edit_unsupported_for_family: {
    what: "This action doesn’t apply to this type of diagram.",
    todo: "Use one of the parts in the bar above the canvas.",
  },
  // --- Access, input and size ---------------------------------------------------------------------------
  authoring_forbidden: {
    what: "Editing isn’t allowed from this page.",
    todo: "Open Archer from a new link or pairing code, or reload to check your access.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_invalid_request: {
    what: "The editor sent something the service couldn’t read.",
    todo: "Reload and try again. If it keeps happening, copy your Mermaid and report it.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_generation_required: {
    what: "The editor lost track of this editing session.",
    todo: "Reload the page; your unsaved edits are kept as a recovered draft.",
    actions: [RELOAD],
  },
  authoring_target_invalid: {
    what: "That diagram can’t be edited here.",
    todo: "Open it from the project page and try again.",
  },
  authoring_presentation_invalid: {
    what: "That presentation couldn’t be started.",
    todo: "Reload and try again.",
    actions: [RELOAD],
  },
  invalid_source: {
    what: "The Mermaid source isn’t something Archer can read.",
    todo: "Fix the highlighted line in the source.",
    actions: [SOURCE],
    severity: "problem",
  },
  invalid_target: {
    what: "That diagram or note can’t be found at that address.",
    todo: "Go back to the project and open it again.",
  },
  invalid_arguments: {
    what: "The request was missing something it needs.",
    todo: "Reload and try again.",
    actions: [RELOAD],
  },
  change_invalid_input: {
    what: "That change request couldn’t be read.",
    todo: "Reload and try again.",
    actions: [RELOAD],
  },
  change_cursor_invalid: {
    what: "The list of changes is out of date.",
    todo: "Reload to see the current list.",
    actions: [RELOAD],
  },
  change_review_invalid: {
    what: "That review decision couldn’t be read.",
    todo: "Reload and try again.",
    actions: [RELOAD],
  },
  path_outside_archer_folder: {
    what: "That location is outside the project’s Archer folder.",
    todo: "Pick a place inside the Archer folder.",
  },
  authoring_source_limit: {
    what: "The Mermaid source is larger than the editor accepts (262,144 bytes).",
    todo: "Split the diagram into smaller ones.",
    severity: "problem",
  },
  authoring_body_too_large: {
    what: "That request was larger than the editor accepts.",
    todo: "Split the diagram into smaller ones.",
    severity: "problem",
  },
  method_not_allowed: {
    what: "The editor and the service don’t agree on how to talk to each other.",
    todo: "Reload the page; if that doesn’t help, update Archer.",
    actions: [RELOAD],
    severity: "problem",
  },
  // --- Editing is turned off (ADR 0028) -----------------------------------------------------------------
  editing_disabled: {
    what: "Editing is off for this project (edit = false in archer.toml).",
    todo: "You can still read and comment. Copy your Mermaid if you want to keep it.",
    severity: "problem",
  },
  create_not_allowed: {
    what: "Archer creates new files only in diagrams/ or notes/ inside the Archer folder.",
    todo: "Choose a path such as diagrams/checkout-flow.mmd.",
    severity: "problem",
  },
  write_rule_denied: {
    what: "Your Archer settings make this project read-only for this change.",
    todo: "You can still read. Copy your Mermaid if you want to keep it.",
    severity: "problem",
  },
  // --- Not found ----------------------------------------------------------------------------------------
  authoring_not_found: {
    what: "The diagram or project could not be found.",
    todo: "It may have been moved or deleted. Go back to the project.",
    severity: "problem",
  },
  change_not_found: {
    what: "That change no longer exists.",
    todo: "Reload to see the current list.",
    actions: [RELOAD],
  },
  diagram_not_found: {
    what: "That diagram could not be found.",
    todo: "It may have been moved or deleted. Go back to the project.",
    severity: "problem",
  },
  ENOENT: {
    what: "The diagram’s file no longer exists.",
    todo: "Reload. If it was deleted, save your Mermaid elsewhere before closing.",
    actions: [RELOAD],
    severity: "problem",
  },
  // --- Someone else moved first -------------------------------------------------------------------------
  revision_conflict: {
    what: "The diagram changed on disk after you opened it.",
    todo: "Reload to see the new version; your edits are kept as a draft you can compare.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_draft_conflict: {
    what: "Another editor saved a draft of this diagram in the meantime.",
    todo: "Reload to see their version before saving yours.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_draft_mismatch: {
    what: "This draft no longer matches the saved one.",
    todo: "Reload to start from the current version.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_target_conflict: {
    what: "The diagram was replaced while you were editing it.",
    todo: "Reload to see the current version.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_operation_mismatch: {
    what: "This save doesn’t match the one the service was working on.",
    todo: "Check the save status, then try again.",
    actions: [RETRY],
  },
  authoring_generation_retired: {
    what: "This editing session was replaced by a newer one.",
    todo: "Reload; your edits are kept as a recovered draft.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_probe_unavailable: {
    what: "Archer can’t tell yet whether your last save went through.",
    todo: "Wait a moment and check the save status. Don’t save again until you know.",
    severity: "problem",
  },
  authoring_reconcile_required: {
    what: "A previous save needs to be settled before you can continue.",
    todo: "Open the unfinished save and choose to keep or discard it.",
    severity: "problem",
  },
  authoring_authority_changed: {
    what: "Who may edit this project changed while you were working.",
    todo: "Reload to check your access.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_resolution_conflict: {
    what: "That unfinished save was already resolved elsewhere.",
    todo: "Reload to see where it ended up.",
    actions: [RELOAD],
  },
  authoring_presentation_conflict: {
    what: "Someone else is presenting a different view of this diagram.",
    todo: "Reload, then try again.",
    actions: [RELOAD],
  },
  change_review_conflict: {
    what: "That change was already reviewed by someone else.",
    todo: "Reload to see the decision.",
    actions: [RELOAD],
  },
  change_review_terminal: {
    what: "That change is already settled and can’t be reviewed again.",
    todo: "Nothing to do.",
    severity: "info",
  },
  change_operation_mismatch: {
    what: "That review step doesn’t match the change’s current state.",
    todo: "Reload and try again.",
    actions: [RELOAD],
  },
  ambiguous_diagram: {
    what: "More than one diagram matches that name.",
    todo: "Open the diagram you want from the project page.",
  },
  EEXIST: { what: "A file already exists at that location.", todo: "Choose a different name.", actions: [RENAME] },
  // --- Busy or full -------------------------------------------------------------------------------------
  authoring_busy: {
    what: "The editor is finishing another request.",
    todo: "Wait a moment, then try again.",
    actions: [RETRY],
    severity: "info",
  },
  source_busy: {
    what: "Another save is touching this file right now.",
    todo: "Wait a moment, then try again.",
    actions: [RETRY],
    severity: "info",
  },
  authoring_store_capacity: {
    what: "The editor’s draft storage is full.",
    todo: "Discard old drafts or unfinished saves, then try again.",
    severity: "problem",
  },
  change_store_capacity: {
    what: "There are too many open changes to add another.",
    todo: "Resolve some of the open changes first.",
    severity: "problem",
  },
  authoring_grant_capacity: {
    what: "The maximum number of editing links is already in use.",
    todo: "Revoke one you no longer need, then issue a new one.",
    severity: "problem",
  },
  authoring_presentation_limit: {
    what: "Too many presentations are open.",
    todo: "Close one you no longer need.",
    severity: "problem",
  },
  // --- Trouble in the service --------------------------------------------------------------------------
  authoring_store_invalid: {
    what: "The editor’s private storage looks damaged.",
    todo: "Copy your Mermaid somewhere safe, then ask whoever runs Archer to check its data folder.",
    severity: "problem",
  },
  invalid_authoring_store: {
    what: "The editor’s private storage looks damaged.",
    todo: "Copy your Mermaid somewhere safe, then ask whoever runs Archer to check its data folder.",
    severity: "problem",
  },
  change_store_invalid: {
    what: "The change store looks damaged.",
    todo: "Ask whoever runs Archer to check its data folder.",
    severity: "problem",
  },
  authoring_project_unavailable: {
    what: "The project can’t be reached right now.",
    todo: "Check that the folder is still there, then reload.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_store_limit: {
    what: "The editor’s private storage has grown too large.",
    todo: "Discard old drafts, or ask whoever runs Archer to clean it up.",
    severity: "problem",
  },
  change_store_limit: {
    what: "The change store has grown too large.",
    todo: "Ask whoever runs Archer to clean it up.",
    severity: "problem",
  },
  authoring_store_unavailable: {
    what: "The editor’s storage is unavailable.",
    todo: "Copy your Mermaid before closing this tab, then try again in a moment.",
    actions: [RETRY],
    severity: "problem",
  },
  authoring_store_io: {
    what: "The editor couldn’t read or write its storage.",
    todo: "Copy your Mermaid before closing this tab, then try again in a moment.",
    actions: [RETRY],
    severity: "problem",
  },
  authoring_store_closed: {
    what: "The service is shutting down.",
    todo: "Copy your Mermaid, then reload once Archer is back.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_operation_uncertain: {
    what: "Archer can’t tell whether your last save went through.",
    todo: "Check the save status before saving again; saving twice could repeat it.",
    severity: "problem",
  },
  write_uncertain: {
    what: "Archer can’t tell whether the file was written.",
    todo: "Reload and check the diagram before saving again.",
    actions: [RELOAD],
    severity: "problem",
  },
  invalid_callback: {
    what: "The service hit an internal error.",
    todo: "Copy your Mermaid, reload, and try again.",
    actions: [RELOAD],
    severity: "problem",
  },
  authoring_unavailable: {
    what: "Editing is unavailable right now.",
    todo: "Check the save status, then try again. Don’t repeat a save until you know it didn’t go through.",
    actions: [RETRY],
    severity: "problem",
  },
};

/** Every code with its own copy (the tests compare it with the server's maps). */
export const REFUSAL_CODES: readonly string[] = Object.keys(ENTRIES);

const resolve = <T>(value: T | ((d: RefusalDetail) => T), detail: RefusalDetail): T =>
  typeof value === "function" ? (value as (d: RefusalDetail) => T)(detail) : value;

/**
 * Describe a refusal in plain language.
 * @param code the server's refusal code (`edit_delete_referenced_node`, `revision_conflict`, …)
 * @param detail whatever the caller knows: the subject's label, `existingId`, the compiler's `diagnostic`, a count
 */
export function describeRefusal(code: string, detail: RefusalDetail = {}): Refusal {
  const entry = Object.hasOwn(ENTRIES, code) ? ENTRIES[code]! : undefined;
  const diagnostic = detail.diagnostic ? ` — line ${detail.diagnostic.line ?? "?"}: ${detail.diagnostic.message}` : "";
  const details = `${code}${diagnostic}`;
  if (!entry) {
    const what = "That didn’t work.";
    const todo = "Try again, or make the change in the Mermaid source.";
    return {
      what,
      todo,
      message: `${what} ${todo}`,
      actions: [RETRY, SOURCE],
      severity: "problem",
      details: detail.message ? `${details}: ${detail.message}` : details,
      known: false,
    };
  }
  const what = resolve(entry.what, detail);
  const todo = resolve(entry.todo, detail);
  return {
    what,
    todo,
    message: `${what} ${todo}`,
    actions: entry.actions ? [...resolve(entry.actions, detail)] : [],
    severity: entry.severity ?? "blocked",
    details,
    known: true,
  };
}
