export function assistantText(event: any): string | undefined {
  if (
    event?.type !== "message_end" ||
    event.message?.role !== "assistant" ||
    !Array.isArray(event.message.content)
  )
    return undefined;
  return event.message.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("");
}
