// SearchButton.vue wraps VitePress's own search button, reached through a Vite alias (config.mts) because VitePress
// ships it as an untyped internal SFC: the theme types the import here rather than type-checking VitePress's source.
declare module "vitepress-search-button-original" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}
