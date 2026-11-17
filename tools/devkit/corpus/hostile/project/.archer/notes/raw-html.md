---
title: Raw HTML
---
# Raw HTML (html is off)

<script>window.__xss='html-script'</script>

<img src=x onerror="window.__xss='html-img';alert('html-img')">

<svg onload="window.__xss='html-svg'"><circle r=5 /></svg>

<iframe srcdoc="<script>parent.__xss='html-iframe'</script>"></iframe>

<a href="javascript:window.__xss='html-a'">raw anchor</a>

<details open ontoggle="window.__xss='html-details'"><summary>x</summary></details>

<math><mtext><table><mglyph><style><img src=x onerror="window.__xss='html-mxss'"></style></mglyph></table></mtext></math>

<style>@import url(https://xss-canary.invalid/html-style);</style>

<base href="https://xss-canary.invalid/">

<meta http-equiv="refresh" content="0;url=javascript:window.__xss='html-meta'">

<form action="https://xss-canary.invalid/html-form"><button>go</button></form>

<object data="javascript:window.__xss='html-object'"></object>

<a id="__archerTelemetry" name="__archerTelemetry" href="https://xss-canary.invalid/clobber">clobber</a>
<form id="root"><input name="parentNode"></form>
<img name="getElementById"><img id="archer-walk-panel">

Inline code stays text: `<img src=x onerror="window.__xss='html-code'">`

```html
<script>window.__xss='html-fence'</script>
```

| a | b |
|---|---|
| <img src=x onerror="window.__xss='html-table'"> | x |

> <img src=x onerror="window.__xss='html-quote'">

&lt;img src=x onerror="window.__xss='html-entity'"&gt; and &#60;script&#62;window.__xss='html-num'&#60;/script&#62;
