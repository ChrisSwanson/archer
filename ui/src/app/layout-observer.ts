/** Observe only the elements that can change a workspace's available room. */
export function observeLayoutElements(
  selector: string,
  changed: () => void,
  options: {
    readonly fixed?: readonly Element[];
    readonly resized?: () => void;
    /** Position writes on the card itself must not feed back into placement. */
    readonly attributes?: string;
    /** Content edits inside this surface can move anchors without changing any observed size. */
    readonly content?: string;
  } = {},
): () => void {
  const { fixed = [], resized = changed, attributes = selector } = options;
  const observer = new ResizeObserver(resized);
  const attributeMembers = new Set<Element>();
  const observed = new Set<Element>();
  const refresh = () => {
    const next = new Set([...fixed, ...document.querySelectorAll(selector)]);
    attributeMembers.clear();
    for (const element of next) if (element.matches(attributes)) attributeMembers.add(element);
    for (const element of observed) {
      if (!next.has(element)) {
        observer.unobserve(element);
        observed.delete(element);
      }
    }
    for (const element of next) {
      if (!observed.has(element)) {
        observed.add(element);
        observer.observe(element);
      }
    }
  };
  const touches = (node: Node) =>
    node instanceof Element &&
    (node.matches(selector) || node.querySelector(selector) !== null || [...observed].some((el) => node.contains(el)));
  refresh();
  const mutations = new MutationObserver((records) => {
    let relevant = false;
    let membershipChanged = false;
    for (const record of records) {
      const target = record.target;
      if (record.type === "childList") {
        const members = [...record.addedNodes, ...record.removedNodes].some(touches);
        membershipChanged ||= members;
        relevant ||=
          members ||
          (target instanceof Element &&
            (observed.has(target) || (options.content !== undefined && target.closest(options.content) !== null)));
      } else if (target instanceof Element) {
        const matches = target.matches(selector);
        relevant ||= target.matches(attributes) || attributeMembers.has(target);
        membershipChanged ||= (matches || fixed.includes(target)) !== observed.has(target);
      }
    }
    if (membershipChanged) refresh();
    if (relevant) changed();
  });
  mutations.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "transform", "data-collapsed", "data-placement", "hidden"],
  });
  return () => {
    mutations.disconnect();
    observer.disconnect();
  };
}

/** Many notifications in one frame require only one layout read. */
export function layoutFrame(update: () => void): { schedule: () => void; cancel: () => void } {
  let frame = 0;
  return {
    schedule: () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    },
    cancel: () => {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
