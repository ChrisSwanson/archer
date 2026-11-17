<script setup lang="ts">
import DefaultTheme from "vitepress/theme-without-fonts";
import ArcherToc from "./ArcherToc.vue";
</script>

<template>
  <DefaultTheme.Layout>
    <template #aside-outline-before>
      <ArcherToc />
    </template>
  </DefaultTheme.Layout>
</template>
