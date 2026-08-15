// Commands and paths stay in the visual approval card. They can be long,
// sensitive, and difficult to understand when read aloud.
export function approvalPrompt(reason) {
  return `Codex needs approval for ${reason}. Say approve or deny.`;
}
