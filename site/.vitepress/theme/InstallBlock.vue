<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { type InstallMethod, installCommands } from "./install-commands.mts";
import { type TerminalOs, terminalOs } from "./terminal-os.mts";

const props = defineProps<{ name: string }>();

// Shared by every install block on the page, and remembered per viewer when storage allows.
const method = ref<InstallMethod>("npx");
const status = ref("");
const tabs = ref<HTMLButtonElement[]>([]);
const current = computed(() => installCommands.find((entry) => entry.id === method.value) ?? installCommands[0]);
const failed = computed(() => status.value.startsWith("Copy failed"));
const storageKey = "archer-docs-install-method";
// The reader's own terminal, chosen after mount; the page is served with the neutral frame, of the same height.
const os = ref<TerminalOs>("neutral");
const titles: Record<TerminalOs, string> = { mac: "Terminal", linux: "Terminal", windows: "", neutral: "Terminal" };
const guide = withBase("/install#windows-wsl");

onMounted(() => {
  os.value = terminalOs(navigator as Navigator & { userAgentData?: { platform?: string } });
  try {
    const saved = localStorage.getItem(storageKey);
    if (installCommands.some((entry) => entry.id === saved)) method.value = saved as InstallMethod;
  } catch {}
  window.addEventListener("archer-install-method", onMethod);
});
// Another install block on the page chose a method. Removed on unmount: the landing mounts again on each visit.
function onMethod(event: Event) {
  method.value = (event as CustomEvent<InstallMethod>).detail;
}
onUnmounted(() => {
  unmounted = true;
  window.removeEventListener("archer-install-method", onMethod);
  clearTimeout(clear);
});

function choose(id: InstallMethod, focus = false) {
  method.value = id;
  status.value = "";
  try {
    localStorage.setItem(storageKey, id);
  } catch {}
  window.dispatchEvent(new CustomEvent("archer-install-method", { detail: id }));
  if (focus) tabs.value[installCommands.findIndex((entry) => entry.id === id)]?.focus();
}

function onKey(event: KeyboardEvent, index: number) {
  const last = installCommands.length - 1;
  const next =
    event.key === "ArrowRight"
      ? (index + 1) % (last + 1)
      : event.key === "ArrowLeft"
        ? (index + last) % (last + 1)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : -1;
  if (next < 0) return;
  event.preventDefault();
  choose(installCommands[next]!.id, true);
}

let clear: ReturnType<typeof setTimeout> | undefined;
let unmounted = false;
// A click anywhere in the terminal copies, unless it was a selection the reader is making, a link or the button.
function copyFromBody(event: MouseEvent) {
  if ((event.target as Element).closest("a, button")) return;
  if (String(window.getSelection() ?? "").length > 0) return;
  void copy();
}
async function copy() {
  try {
    await navigator.clipboard.writeText(current.value.command);
    status.value = "Copied";
  } catch {
    status.value = "Copy failed: select the command and copy it";
  }
  // The landing may have gone while the clipboard answered: nothing is left to clear.
  if (unmounted) return;
  clearTimeout(clear);
  clear = setTimeout(() => (status.value = ""), 2400);
}
</script>

<template>
  <div class="install" :data-os="os">
    <div class="install-bar">
      <span v-if="os === 'mac'" class="install-lights" aria-hidden="true"><i /><i /><i /></span>
      <div class="install-tabs" role="tablist" aria-label="Install with">
        <button
          v-for="(entry, index) in installCommands"
          :id="`${props.name}-tab-${entry.id}`"
          :key="entry.id"
          ref="tabs"
          type="button"
          role="tab"
          class="install-tab"
          :aria-selected="method === entry.id"
          :aria-controls="`${props.name}-panel`"
          :tabindex="method === entry.id ? 0 : -1"
          @click="choose(entry.id)"
          @keydown="onKey($event, index)"
        >
          <span v-if="os === 'windows'" class="install-profile" aria-hidden="true">Ubuntu (WSL) · </span>{{ entry.label }}
        </button>
      </div>
      <span v-if="titles[os]" class="install-title" aria-hidden="true">{{ titles[os] }}</span>
      <span v-if="os === 'linux'" class="install-close" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      </span>
      <span v-if="os === 'windows'" class="install-controls" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" stroke-width="1.1" /></svg>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.1" /></svg>
      </span>
    </div>
    <!-- biome-ignore lint/a11y/useKeyWithClickEvents: a pointer shortcut; the Copy button is the same action for the keyboard. -->
    <div
      :id="`${props.name}-panel`"
      class="install-panel"
      role="tabpanel"
      :aria-labelledby="`${props.name}-tab-${current.id}`"
      :title="current.command"
      @click="copyFromBody"
    >
      <pre class="install-command"><span class="install-prompt" aria-hidden="true">$ </span><code>{{ current.shown[0] }}<span class="install-elide">{{ current.shown[1] }}</span>{{ current.shown[2] }}</code></pre>
      <button type="button" class="install-copy" :class="{ 'is-done': status === 'Copied' }" @click="copy">
        <svg v-if="status === 'Copied'" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
        <svg v-else viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        <span v-if="status === 'Copied'">Copied</span>
        <span v-else class="install-sr">Copy the {{ current.label }} command</span>
      </button>
    </div>
    <p class="install-status" :class="{ 'is-visible': failed }" role="status" aria-live="polite">{{ status === "Copied" ? "Command copied" : status }}</p>
    <!-- One line under the frame, in every frame, so the Windows note never moves the page. -->
    <!-- Every note laid in one cell, the unshown ones invisible: the line is as tall as the longest at any width,
         so neither the frame nor the method moves the page. -->
    <div class="install-notes">
      <p v-for="entry in installCommands" :key="entry.id" class="install-note install-note--ghost" aria-hidden="true">
        {{ entry.note }} The copy button copies the full command.
      </p>
      <p class="install-note install-note--ghost" aria-hidden="true">Archer runs in WSL on Windows. Set up WSL</p>
      <p class="install-note">
        <span v-if="os === 'windows'">Archer runs in WSL on Windows. <a :href="guide">Set up WSL</a></span>
        <span v-else>{{ current.note }} The copy button copies the full command.</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
/* The design's terminal, dark in both themes, in the reader's own window frame: macOS Terminal (lights and a
   title), GNOME's header bar (one round close button) or Windows Terminal (a WSL profile tab, the window's three
   controls). The frames differ only inside the bar, at one height. The command is the whole command in the page;
   the long address in its middle is drawn as "…/". */
.install {
  --install-bg: #0d1117;
  --install-bar: #161b22;
  --install-line: #30363d;
  --install-text: #e6edf3;
  --install-dim: #9aa6b6;
  --install-prompt: #7ee2b8;
  --install-mark: #9db4ff;
  --install-light-close: #ff5f57;
  --install-light-min: #febc2e;
  --install-light-zoom: #28c840;
  width: 100%;
  max-width: 44rem;
  min-width: 0;
  text-align: left;
}
.install-panel {
  background: var(--install-bg);
}
.install-bar {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
  height: 36px;
  padding: 0 0.75rem;
  border-radius: 12px 12px 0 0;
  background: var(--install-bar);
  color: var(--install-dim);
}
.install-panel {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.875rem 0.625rem 0.875rem 1.25rem;
  border-radius: 0 0 12px 12px;
  cursor: copy;
  box-shadow: 0 22px 50px -22px rgb(15 23 42 / 55%), 0 0 0 1px rgb(15 23 42 / 12%);
}
:global(.dark) .install-panel {
  box-shadow: 0 22px 50px -22px rgb(0 0 0 / 70%), 0 0 0 1px var(--vp-c-divider);
}
.install-lights {
  display: inline-flex;
  align-self: center;
  gap: 6px;
}
.install-lights i {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--install-light-close);
}
.install-lights i:nth-child(2) {
  background: var(--install-light-min);
}
.install-lights i:nth-child(3) {
  background: var(--install-light-zoom);
}
.install-tabs {
  display: flex;
  gap: 2px;
  margin-left: 0.5rem;
  min-width: 0;
}
.install-tab {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 1rem;
  border-radius: 7px 7px 0 0;
  color: var(--install-dim);
  font: 500 0.8125rem/1 var(--vp-font-family-mono);
  --type-tracking: 0;
  white-space: nowrap;
}
.install-tab[aria-selected="true"] {
  background: var(--install-bg);
  color: #ffffff;
}
.install-tab:hover {
  color: #ffffff;
}
.install-title {
  margin-left: auto;
  align-self: center;
  font-size: 0.75rem;
  pointer-events: none;
}
/* GNOME's header bar: one round close button at the end. */
.install-close {
  display: inline-grid;
  place-items: center;
  align-self: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgb(255 255 255 / 8%);
}
/* Windows Terminal: the window's three controls at the end of the bar. */
.install[data-os="windows"] .install-bar {
  padding-right: 0;
}
.install-controls {
  display: inline-flex;
  align-self: stretch;
  margin-left: auto;
}
.install-controls svg {
  box-sizing: content-box;
  align-self: center;
  padding: 0 15px;
}
.install-profile {
  font-family: var(--vp-font-family-base);
}
.install-command {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--install-text);
  font: 400 1rem/1.6 var(--vp-font-family-mono);
  --type-tracking: 0;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.install-command code {
  font: inherit;
  color: inherit;
  background: none;
  padding: 0;
}
/* The prompt is furniture, not part of the command: never copied. */
.install-prompt {
  color: var(--install-prompt);
  user-select: none;
}
/* The long address stays in the page (selected, copied and read out whole) and is drawn as "…/". */
.install-elide {
  display: inline-block;
  width: 2ch;
  overflow: hidden;
  vertical-align: bottom;
  white-space: nowrap;
  color: transparent;
  position: relative;
}
.install-elide::before {
  content: "…/" / "";
  position: absolute;
  inset: 0 auto 0 0;
  color: var(--install-dim);
}
.install-copy {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-width: 44px;
  height: 44px;
  padding: 0 0.625rem;
  border-radius: 8px;
  color: var(--install-text);
  opacity: 0.6;
  font: 500 0.8125rem var(--vp-font-family-base);
  transition: opacity 0.15s, background-color 0.15s;
}
.install-copy:hover,
.install-copy:focus-visible {
  opacity: 1;
  background: rgb(255 255 255 / 8%);
}
.install-copy.is-done {
  opacity: 1;
  color: var(--install-prompt);
}
.install :focus-visible {
  outline: 2px solid var(--install-mark);
  outline-offset: 2px;
}
.install-sr,
.install-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.install-status.is-visible {
  position: static;
  width: auto;
  height: auto;
  overflow: visible;
  clip-path: none;
  white-space: normal;
  margin: 8px 4px 0;
  color: var(--vp-c-text-1);
  font-size: 0.875rem;
}
.install-notes {
  display: grid;
  margin-top: 1rem;
}
.install-notes > .install-note {
  grid-area: 1 / 1;
}
.install-note--ghost {
  visibility: hidden;
}
.install-note {
  min-height: 1.5rem;
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.875rem;
  line-height: 1.5rem;
  text-align: center;
}
.install-note a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.2em;
}
/* Phone: the window furniture that would crowd the tabs steps aside; every control stays a 44px target. */
@media (max-width: 639px) {
  .install-title,
  .install-controls,
  .install-profile {
    display: none;
  }
  .install-command {
    font-size: 0.875rem;
  }
}
</style>
