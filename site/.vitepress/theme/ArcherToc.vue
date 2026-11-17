<script setup lang="ts">
import { getScrollOffset, onContentUpdated, useData } from "vitepress";
import { computed, onMounted, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import ArcherTocList from "./ArcherTocList.vue";
import { tocKey } from "./toc-context.mts";
import {
  activeHeadingId,
  buildTocTree,
  initialTocState,
  type TocEvent,
  type TocHeading,
  type TocNode,
  type TocState,
  tocReducer,
} from "./toc.mts";

const { frontmatter } = useData();
const tree = shallowRef<TocNode[]>([]);
const state = shallowRef<TocState>(initialTocState());
const nav = ref<HTMLElement>();
let elements: HTMLElement[] = [];

function dispatch(event: TocEvent) {
  state.value = tocReducer(tree.value, state.value, event);
}

/** Heading text without the permalink mark or badges, as VitePress's own outline reads it. */
function headingText(heading: HTMLElement): string {
  let text = "";
  for (const node of Array.from(heading.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
    else if (node instanceof HTMLElement && !/\b(?:VPBadge|header-anchor|footnote-ref|ignore-header)\b/.test(node.className))
      text += node.textContent ?? "";
  }
  return text.trim();
}

function collect() {
  elements = Array.from(document.querySelectorAll<HTMLElement>(".VPDoc .vp-doc :where(h2, h3, h4)")).filter(
    (heading) => heading.id && heading.hasChildNodes() && !heading.classList.contains("ignore-header"),
  );
  const headings: TocHeading[] = elements.map((heading) => ({
    id: heading.id,
    level: Number(heading.tagName[1]),
    title: headingText(heading),
  }));
  tree.value = frontmatter.value.outline === false ? [] : buildTocTree(headings);
  state.value = initialTocState();
  update();
}

function update() {
  if (locked || elements.length === 0) return;
  const positions = elements.map((heading) => ({
    id: heading.id,
    top: heading.offsetParent ? heading.getBoundingClientRect().top + window.scrollY : Number.NaN,
  }));
  dispatch({
    type: "scroll",
    id: activeHeadingId(positions, {
      scrollY: window.scrollY,
      offset: getScrollOffset(),
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    }),
  });
}

// While a followed link scrolls the page, the sections it passes are not where the reader is going.
let locked = false;
let unlockTimer: ReturnType<typeof setTimeout> | undefined;
function unlock() {
  if (!locked) return;
  locked = false;
  clearTimeout(unlockTimer);
  update();
}

function navigate(id: string) {
  dispatch({ type: "navigate", id });
  locked = true;
  clearTimeout(unlockTimer);
  unlockTimer = setTimeout(unlock, 1000);
}

function toggle(id: string) {
  dispatch({ type: "toggle", id });
}

provide(tocKey, { state, toggle, navigate });

let frame = 0;
function onScroll() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    update();
  });
}

onContentUpdated(collect);
onMounted(() => {
  collect();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("scrollend", unlock);
});
onUnmounted(() => {
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("scrollend", unlock);
  cancelAnimationFrame(frame);
  clearTimeout(unlockTimer);
});

// Keep the reader's entry in view inside the aside's own scroll area, never scrolling the page.
watch(
  () => state.value.active,
  (active) => {
    if (!active || !nav.value) return;
    requestAnimationFrame(() => {
      const link = nav.value?.querySelector<HTMLElement>(`a[href="#${CSS.escape(active)}"]`);
      const scroller = nav.value?.closest<HTMLElement>(".aside-container");
      if (!link || !scroller || link.offsetParent === null) return;
      const box = link.getBoundingClientRect();
      const frameBox = scroller.getBoundingClientRect();
      const margin = 48;
      if (box.top < frameBox.top + margin) scroller.scrollTop -= frameBox.top + margin - box.top;
      else if (box.bottom > frameBox.bottom - margin) scroller.scrollTop += box.bottom - (frameBox.bottom - margin);
    });
  },
  { flush: "post" },
);

const hasEntries = computed(() => tree.value.length > 0);
</script>

<template>
  <nav v-if="hasEntries" ref="nav" class="ArcherToc" aria-labelledby="archer-toc-title">
    <div id="archer-toc-title" class="ArcherToc-title" role="heading" aria-level="2">On This Page</div>
    <ArcherTocList :nodes="tree" :depth="0" />
  </nav>
</template>
