// Kept apart from the painter so the command line can use it without loading
// the layout engine.

// C0 and C1 controls (0x9B alone starts an escape sequence on some
// terminals), DEL, and the bidi overrides and isolates that reorder what the
// reader sees. Text from a label is painted, never sent: each of these becomes
// a replacement mark instead of reaching the terminal.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const printable = (s: string): string => s.replace(CONTROL, "�");
