---
title: Using the Playground
---

# Using the Playground

Try Archer with real example projects. Browse diagrams and notes, follow a saved walkthrough, select part of a drawing and leave a local comment.

<a class="VPButton medium brand" href="playground/app/index.html">Open Playground</a>

Everything starts from public examples: **Archer Tour**, **HTCPCP** and **IP over Avian Carriers**. Changes stay in this browser. **Reset demo** clears your demo comments and drafts; it keeps your ordinary documentation preferences.

No agent is connected. Walkthroughs are prerecorded examples. Source editing, agent delivery, history, project settings and service exports are unavailable. To work with your own codebase and agent, [install Archer](/install).

## What Is an Example

Two surfaces open with example content so you can see what they hold. Neither reaches a service or an agent.

- **Settings** (the gear in the sidebar) shows example values for a fresh install. In your own Archer they come from `~/.config/archer/archer.toml`, environment variables and command-line flags, and the page shows them read-only there too. The keyboard shortcut switch is real and is saved in this browser.
- **The chat bubble** shows a short scripted conversation about the diagram, note or project you are on, labelled **Example chat**. There is nowhere to type: in your own project, what you write there waits for your coding agent's next turn in your terminal.

On a phone the bar above the Playground is one row; **About** holds the link back to these docs and **Reset demo**.

## Try Browser Agent Tools

The Playground can expose local tools through [WebMCP](https://webmachinelearning.github.io/webmcp/), an experimental browser API. An available browser agent can list and read the examples, show a diagram, highlight its elements, step a saved walkthrough and leave local comments. The tools use the same example data and local state as the page; they do not contact an Archer service or an agent server.

1. Use a Chromium browser with WebMCP enabled. For local testing in Chrome, open `chrome://flags/#enable-webmcp-testing`, enable the WebMCP testing flag and relaunch. Edge offers the corresponding `edge://flags/#enable-webmcp-testing` flag.
2. Open the full Playground and wait for **Agent tools available (WebMCP)**. That indicator appears only after tool registration succeeds. Without it, the ordinary Playground still works.
3. Use your browser's WebMCP-capable agent or developer tooling. For example: “Show Archer Containers and highlight the browser.” The browser must supply the agent; Archer does not add a chat service.

Chrome also offers a [WebMCP origin trial](https://developer.chrome.com/blog/ai-webmcp-origin-trial): a site operator enrolls the hosting origin and supplies its trial token. This site does not claim an active trial enrollment. See the [current Chrome WebMCP guidance](https://developer.chrome.com/docs/ai/webmcp) for browser requirements and availability.

## Example Notices

Original RFC permissions and distribution notices remain available:

- [HTCPCP distribution notice](/generated/examples/rfc-2324-htcpcp/notice)
- [IP over Avian Carriers distribution notice](/generated/examples/rfc-1149-ipoac/notice)

The Playground's **About this demo** also includes the RFC notices and Fira Sans licence.
