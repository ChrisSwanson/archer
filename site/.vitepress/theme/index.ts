import { inBrowser, type Theme, withBase } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import "./style.css";
import "./toc.css";
import Layout from "./Layout.vue";
import { warmPlayground } from "./warm-playground.mts";

export default {
  ...DefaultTheme,
  Layout,
  enhanceApp({ router }) {
    // Every docs page, once per session: the Playground's first view goes into the HTTP cache while the reader reads.
    if (inBrowser) void warmPlayground(window, withBase("/"));
    // The Playground app is its own document, not a VitePress page: the client router would otherwise take a click on
    // any link into it and draw VitePress's 404. Let the browser load it.
    router.onBeforeRouteChange = (to) => {
      if (!inBrowser) return;
      const url = new URL(to, window.location.href);
      if (!url.pathname.startsWith(withBase("/playground/app/"))) return;
      window.location.assign(url.href);
      return false;
    };
  },
} satisfies Theme;
