export function renderRpcEvent(event: any): string | undefined {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent?.type === "text_delta"
  )
    return event.assistantMessageEvent.delta;
  if (event.type === "tool_execution_start")
    return `\n[tool] ${String(event.toolName)}\n`;
  if (event.type === "agent_start") return "\n[agent running]\n";
  if (event.type === "agent_settled") return "\n[agent waiting]\n";
  if (event.type === "extension_error")
    return `\n[extension error] ${String(event.error)}\n`;
  return undefined;
}
