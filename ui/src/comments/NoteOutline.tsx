import { useEffect, useState, type JSX, type RefObject } from "react";
import "./NoteOutline.css";

const OUTLINE_DOCUMENT_GAP = 24;
const OUTLINE_READER_EDGE = 12;

type Topic = { readonly id: string; readonly label: string; readonly level: number; readonly element: HTMLElement };

/** Uses the rendered document: fences, figure chrome and raw HTML cannot invent topics. */
export function NoteOutline({
  documentRoot,
  scrollRoot,
  path,
}: {
  readonly documentRoot: RefObject<HTMLDivElement | null>;
  readonly scrollRoot: RefObject<HTMLElement | null>;
  readonly path: string;
}): JSX.Element | null {
  const [topics, setTopics] = useState<readonly Topic[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [gutterWidth, setGutterWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(() => window.innerWidth > 640);
  useEffect(() => {
    const column = documentRoot.current;
    const reader = scrollRoot.current;
    if (!column || !reader) return;
    let held: readonly Topic[] = [];
    let initialized = false;
    const updatePlacement = (): void => {
      const available =
        column.getBoundingClientRect().left -
        reader.getBoundingClientRect().left -
        OUTLINE_DOCUMENT_GAP -
        OUTLINE_READER_EDGE;
      setGutterWidth(available >= 112 ? Math.min(196, available) : null);
    };
    const updateActive = (): void => {
      const top = reader.getBoundingClientRect().top + 64;
      let current = held[0]?.id ?? null;
      for (const topic of held) {
        if (topic.element.getBoundingClientRect().top <= top) current = topic.id;
        else break;
      }
      setActive(current);
    };
    const refresh = (): void => {
      const used = new Set<string>();
      const suffixes = new Map<string, number>();
      const next = [
        ...column.querySelectorAll<HTMLElement>(
          ".archer-note-body .archer-note-h1, .archer-note-body .archer-note-h2, .archer-note-body .archer-note-h3, .archer-note-body .archer-note-h4, .archer-note-body .archer-note-h5, .archer-note-body .archer-note-h6",
        ),
      ].map((element) => {
        const label = (element.textContent ?? "").trim();
        const level = Number(element.className.match(/archer-note-h([1-6])/)?.[1] ?? 1);
        const slug =
          label
            .normalize("NFKC")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-|-$/g, "") || "section";
        const base = `note-section-${slug}`;
        let suffix = suffixes.get(base) ?? 1;
        let id = suffix === 1 ? base : `${base}-${suffix}`;
        while (used.has(id)) id = `${base}-${++suffix}`;
        suffixes.set(base, suffix + 1);
        used.add(id);
        element.id = id;
        element.tabIndex = -1;
        return { id, label: label || "Untitled section", level, element };
      });
      if (
        !initialized ||
        next.length !== held.length ||
        next.some(
          (item, index) =>
            item.id !== held[index]?.id ||
            item.label !== held[index]?.label ||
            item.element !== held[index]?.element ||
            item.level !== held[index]?.level,
        )
      ) {
        initialized = true;
        held = next;
        setTopics(next);
      }
      updateActive();
      updatePlacement();
    };
    refresh();
    const mutations = new MutationObserver(refresh);
    mutations.observe(column, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(() => {
      updateActive();
      updatePlacement();
    });
    resize.observe(column);
    resize.observe(reader);
    const layout = new MutationObserver(updatePlacement);
    layout.observe(reader, { attributes: true, subtree: true, attributeFilter: ["data-rail-layout"] });
    reader.addEventListener("scroll", updateActive, { passive: true });
    return () => {
      mutations.disconnect();
      layout.disconnect();
      resize.disconnect();
      reader.removeEventListener("scroll", updateActive);
    };
  }, [documentRoot, scrollRoot, path]);
  if (topics.length < 2) return null;
  const minimum = topics.reduce((level, topic) => (topic.level < level ? topic.level : level), 6);
  return (
    <div
      className={`primary-note-outline${gutterWidth === null ? "" : " primary-note-outline--margin"}`}
      style={gutterWidth === null ? undefined : { width: gutterWidth, left: -gutterWidth - OUTLINE_DOCUMENT_GAP }}
    >
      <details
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
        className="primary-note-outline-disclosure"
      >
        <summary>
          <svg className="primary-note-outline-chevron" viewBox="0 0 10 10" width={10} height={10} aria-hidden="true">
            <path d="M3,2 L7,5 L3,8" />
          </svg>
          On this page
        </summary>
        <nav aria-label="Table of contents">
          <ol>
            {topics.map((topic) => (
              <li key={topic.id}>
                <a
                  href={`#${encodeURIComponent(topic.id)}`}
                  title={topic.label}
                  data-depth={topic.level - minimum}
                  style={{ paddingInlineStart: `${12 + (topic.level - minimum) * 12}px` }}
                  aria-current={active === topic.id ? "location" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    const root = scrollRoot.current;
                    if (!root) return;
                    const top =
                      root.scrollTop +
                      topic.element.getBoundingClientRect().top -
                      root.getBoundingClientRect().top -
                      48;
                    topic.element.focus({ preventScroll: true });
                    root.scrollTo({
                      top: Math.max(0, top),
                      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
                    });
                    setActive(topic.id);
                  }}
                >
                  {topic.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </details>
    </div>
  );
}
