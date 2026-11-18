<script setup lang="ts">
// VitePress's search button with its name taken from what it shows. VitePress labels it "Search" while it draws
// "Search ⌘K" (or "Search Ctrl K"), and a name that leaves out visible text fails WCAG 2.5.3, Label in Name.
// Dropping the fixed label lets the button be named by its own text, shortcut included; the shortcut is also
// declared for assistive technology.
import VPNavBarSearchButton from "vitepress-search-button-original";
</script>

<template>
  <VPNavBarSearchButton :aria-label="null" aria-keyshortcuts="Meta+K Control+K" />
</template>
