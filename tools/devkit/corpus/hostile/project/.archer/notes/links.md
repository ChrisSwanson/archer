---
title: Links x" onmouseover="window.__xss='fm-title' <img src=x onerror=alert('fm')
description: javascript:window.__xss='fm-desc' <svg/onload=alert('fm-desc')
views: [flow-inert]
---
# Hostile links

Inline links, one per line:

- [js](javascript:window.__xss='md-js')
- [JS case](JaVaScRiPt:window.__xss='md-case')
- [entity dec](&#106;avascript:window.__xss='md-ent-dec')
- [entity hex](&#x6A;avascript:window.__xss='md-ent-hex')
- [entity named](javascript&colon;window.__xss='md-ent-colon')
- [tab](java&#9;script:window.__xss='md-tab')
- [leading space](<  javascript:window.__xss='md-space'>)
- [percent](javascript%3Awindow.__xss='md-pct')
- [data html](data:text/html;base64,PHNjcmlwdD5hbGVydCgnbWQtZGF0YScpPC9zY3JpcHQ+)
- [data svg](data:image/svg+xml,<svg onload=alert('md-data-svg')>)
- [vbscript](vbscript:msgbox('md-vb'))
- [VBScript case](VbScRiPt:msgbox('md-vb-case'))
- [file](file:///etc/passwd)
- [title break](https://xss-canary.invalid/title "a&quot; onmouseover=&quot;window.__xss='md-title'")
- [web link](https://xss-canary.invalid/web)
- [scheme-relative](//xss-canary.invalid/rel.md)
- [internal js](javascript:x.md)
- [internal up](../../../../etc/passwd.md)
- [ref link][evil]

[evil]: javascript:window.__xss='md-ref'

Autolinks:

<javascript:window.__xss='auto-js'>
<JAVASCRIPT:window.__xss='auto-case'>
<data:text/html,<script>alert('auto-data')</script>>
<vbscript:msgbox('auto-vb')>
<https://xss-canary.invalid/autolink>

Bare (linkify is off): javascript:window.__xss='bare' https://xss-canary.invalid/bare

Images (shown as alt text):

![img js](javascript:window.__xss='img-js')
![pixel](https://xss-canary.invalid/pixel.png)
![x" onerror="window.__xss='img-alt'](x)
