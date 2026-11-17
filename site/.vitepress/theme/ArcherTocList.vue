<script setup lang="ts">
import { inject } from "vue";
import { tocKey } from "./toc-context.mts";
import type { TocNode } from "./toc.mts";

defineProps<{ nodes: TocNode[]; depth: number }>();
const toc = inject(tocKey)!;
const isOpen = (id: string) => toc.state.value.open.includes(id);
const holds = (id: string) => toc.state.value.trail.includes(id) && toc.state.value.active !== id;
</script>

<template>
  <ul class="ArcherToc-list" :data-depth="depth">
    <li
      v-for="node in nodes"
      :key="node.id"
      class="ArcherToc-item"
      :class="{ 'is-active': toc.state.value.active === node.id, 'holds-active': holds(node.id) }"
    >
      <div class="ArcherToc-row">
        <a
          class="ArcherToc-link"
          :href="`#${node.id}`"
          :aria-current="toc.state.value.active === node.id ? 'location' : undefined"
          @click="toc.navigate(node.id)"
          >{{ node.title }}</a
        >
        <button
          v-if="node.children.length > 0"
          type="button"
          class="ArcherToc-toggle"
          :aria-expanded="isOpen(node.id)"
          :aria-controls="`archer-toc-${node.id}`"
          :aria-label="`${node.title}: ${node.children.length} ${node.children.length === 1 ? 'subsection' : 'subsections'}`"
          @click="toc.toggle(node.id)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <div
        v-if="node.children.length > 0"
        :id="`archer-toc-${node.id}`"
        class="ArcherToc-children"
        :data-open="isOpen(node.id)"
        :inert="!isOpen(node.id)"
      >
        <div class="ArcherToc-clip">
          <ArcherTocList :nodes="node.children" :depth="depth + 1" />
        </div>
      </div>
    </li>
  </ul>
</template>
