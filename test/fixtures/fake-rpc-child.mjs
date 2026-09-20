import readline from "node:readline";
let count = 0;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const command = JSON.parse(line);
  if (["prompt", "steer", "follow_up"].includes(command.type)) {
    send({ type: "response", id: command.id, command: command.type, success: true }); send({ type: "agent_start" });
    const text = `reply-${++count}:${command.message}`;
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }); send({ type: "agent_settled" });
  } else if (command.type === "abort") send({ type: "response", id: command.id, command: "abort", success: true });
  else send({ type: "response", id: command.id, command: command.type, success: true });
}
