// A compact, interactive repository card for testing GitHub-style switches.
// The generated artifact stays self-contained so it can be opened offline.

export default {
  id: "github-repository-card",

  triggers: [
    "github repository card",
    "repository card",
    "github card",
  ],

  questions: [
    { key: "repository", ask: "Which GitHub repository should the card show?" },
    { key: "test", ask: "What switch test should the card demonstrate?" },
  ],

  systemPrompt: (params) =>
    [
      `Build a polished GitHub repository card for ${params.repository}.`,
      `Use ${params.test} as the initial switch-test label and scenario.`,
      "",
      "Write it to a single file named index.html in the current directory.",
      "The card should feel like a focused developer-tool interface: repository name, owner, description, language, stars, forks, and an action area.",
      "Include one prominent accessible switch that toggles the test state between off and on, updates its label and a small status line, and persists only for the current page.",
      "",
      "Hard constraints:",
      "- One self-contained index.html with inline CSS and JavaScript only.",
      "- No external assets, fonts, frameworks, CDNs, or image URLs.",
      "- Use text and inline SVG/CSS for all graphics.",
      "- Use semantic HTML, a visible focus state, an accurate aria-checked value, and keyboard support.",
      "- Make the interaction obvious at a glance and responsive from 360px to 1440px.",
      "- Use realistic repository metadata, but do not pretend to fetch live GitHub data.",
      "- Respect prefers-reduced-motion.",
      "",
      "Write the file, then stop. Do not explain the code afterwards.",
    ].join("\n"),

  allowedTools: ["Write", "Edit", "Read"],
  mcp: [],
  outputContract: "index.html",
  doneLine: (params) => `Your GitHub repository card for ${params.repository} is ready, sir.`,
  timeoutMs: 300000,
};
