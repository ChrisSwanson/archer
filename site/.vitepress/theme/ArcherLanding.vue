<script setup lang="ts">
// The docs landing, as the owner's R3-2 design lays it out: a coloured stage with the side-by-side film, how it
// works, what you can do with it (real Archer Tour captures), the install, and the footer.
import { withBase } from "vitepress";
import appDark from "./assets/landing/app-dark.webp";
import appLight from "./assets/landing/app-light.webp";
import pointDark from "./assets/landing/point-dark.webp";
import pointLight from "./assets/landing/point-light.webp";
import walkDark from "./assets/landing/walk-dark.webp";
import walkLight from "./assets/landing/walk-light.webp";
import InstallBlock from "./InstallBlock.vue";
import "./landing.css";
import LandingFilm from "./LandingFilm.vue";

const steps = [
  {
    title: "Ask in your terminal",
    text: "Ask your coding agent a question or describe an idea, the way you do now. It runs where it always runs; Archer adds no agent of its own.",
  },
  {
    title: "Your agent draws it",
    text: "It writes Mermaid diagrams and Markdown notes into your repo's ",
    code: ".archer/",
    after: " folder and gives you a link. Archer draws them live in your browser.",
  },
  { title: "You point at it", text: "Open the link. Walk through the flow, select the part you mean and leave a comment on it." },
  {
    title: "It revises on its next turn",
    text: "The next time you talk in your terminal, your agent reads your comments, replies in the thread and edits the files. The page redraws, and you look again.",
  },
] as const;

const uses = [
  {
    title: "Follow a path",
    text: "Ask the agent to highlight an existing diagram. Select a part to give your follow-up context. Saved walkthroughs replay an explanation step by step.",
    ask: "Show me how a request reaches storage. Highlight the path on our existing diagram.",
    light: walkLight,
    dark: walkDark,
    width: 680,
    height: 1420,
    fit: "walk",
    alt: "Archer's walkthrough panel at step 5 of 8, The agent revises the picture, with its play controls and numbered steps.",
  },
  {
    title: "Review a proposal",
    text: "Put a proposed change beside the current design. Comment on a connection, revise the proposal and keep it labelled until you agree.",
    ask: "Propose moving this job into a worker. Show the new boundary and what crosses it.",
    light: pointLight,
    dark: pointDark,
    width: 1360,
    height: 850,
    fit: "fill",
    alt: "A selected part of a drawing with its comment pin, and beside it the discussion: your question, and the agent's reply in amber.",
  },
  {
    title: "Keep the understanding",
    text: "Docs mode maintains a small architecture pack with an index for future agents. The next conversation starts from the diagrams you already agreed on.",
    ask: "Keep our architecture docs current. Answer from the diagrams we already have.",
    light: appLight,
    dark: appDark,
    width: 2880,
    height: 1800,
    fit: "fill",
    alt: "The Archer page showing The Heartbeat Loop with a walkthrough and a comment thread beside it.",
  },
] as const;

const repo = "https://github.com/chrisswanson/archer";
const script = withBase("/install.sh");
</script>

<template>
  <div class="landing">
    <main>
      <div class="landing-stage">
        <section class="landing-wrap landing-stage-inner" aria-labelledby="landing-title">
          <div class="landing-intro">
            <h1 id="landing-title" class="landing-title">Give your design conversation a shared picture.</h1>
            <p class="landing-sub">
              Same question, same answer. Archer doesn't replace the chat; it adds a picture you can both point at.
            </p>
          </div>
          <LandingFilm />
        </section>
      </div>

      <div class="landing-main">
        <section class="landing-wrap landing-how" aria-labelledby="landing-how-title">
          <h2 id="landing-how-title" class="landing-h2">How it works</h2>
          <p class="landing-lede">
            Archer gives you and your coding agent one picture to work out the design from. The conversation stays in
            your terminal; the diagrams and notes stay in your repo, beside the code.
          </p>
          <ol class="landing-steps">
            <li v-for="(step, index) in steps" :key="step.title" class="landing-step">
              <span class="landing-step-number">{{ index + 1 }}</span>
              <h3>{{ step.title }}</h3>
              <p>
                {{ step.text }}<template v-if="'code' in step"><code>{{ step.code }}</code>{{ step.after }}</template>
              </p>
            </li>
          </ol>
          <p class="landing-repeat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /></svg>
            Steps 3 and 4 repeat until the picture says what you both mean.
          </p>
        </section>

        <section class="landing-wrap landing-uses" aria-labelledby="landing-uses-title">
          <h2 id="landing-uses-title" class="landing-h2">What you can do with it</h2>
          <div v-for="(use, index) in uses" :key="use.title" class="landing-use" :class="{ 'landing-use--flip': index % 2 === 1 }">
            <div class="landing-use-text">
              <h3>{{ use.title }}</h3>
              <p>{{ use.text }}</p>
              <p class="landing-ask">“{{ use.ask }}”</p>
            </div>
            <figure class="landing-use-figure">
              <div class="landing-shot" :class="`landing-shot--${use.fit}`">
                <img class="only-light" :src="use.light" :alt="use.alt" :width="use.width" :height="use.height" loading="lazy" decoding="async" />
                <img class="only-dark" :src="use.dark" :alt="use.alt" :width="use.width" :height="use.height" loading="lazy" decoding="async" />
              </div>
              <figcaption>From the Archer Tour example.</figcaption>
            </figure>
          </div>
        </section>

        <section id="install" class="landing-install" aria-labelledby="landing-install-title">
          <div class="landing-wrap landing-install-inner">
            <div class="landing-install-head">
              <h2 id="landing-install-title" class="landing-h2">Install Archer</h2>
              <p>
                Install on the computer where your coding agent runs. Requires Node 22.18 or newer and Claude Code or
                Codex. On Windows, use WSL.
              </p>
            </div>
            <InstallBlock name="install" />
            <p class="landing-check">
              Prefer to check first? Read <a :href="script">install.sh</a> before you pipe it, or follow the
              <a :href="withBase('/install')">install guide</a>. Then, in your project: <code>archer init</code>, and ask
              your agent to draw something.
            </p>
          </div>
        </section>
      </div>
    </main>

    <footer class="landing-footer">
      <div class="landing-wrap landing-footer-grid">
        <div class="landing-footer-brand">
          <a :href="withBase('/')" class="landing-footer-name">Archer</a>
          <span>Mermaid and Markdown. Local files. Shared understanding.</span>
        </div>
        <nav aria-label="Docs">
          <span class="landing-footer-head">Docs</span>
          <a :href="withBase('/how-it-works')">How Archer works</a>
          <a :href="withBase('/usage')">Use it with your agent</a>
          <a :href="withBase('/install')">Install guide</a>
        </nav>
        <nav aria-label="Project">
          <span class="landing-footer-head">Project</span>
          <a :href="repo">GitHub</a>
          <a :href="`${repo}/releases`">Releases</a>
          <a :href="`${repo}/issues`">Report an issue</a>
          <a :href="`${repo}/blob/main/LICENSE`">License: Apache-2.0</a>
        </nav>
      </div>
    </footer>
  </div>
</template>
