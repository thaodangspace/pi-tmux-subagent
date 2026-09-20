import readline from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

let count = 0;
let sessionFile = undefined;
let thinkingLevel = "off";
let memory = {};

// Parse CLI flags
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--session" && i + 1 < process.argv.length) {
    sessionFile = process.argv[++i];
  } else if (process.argv[i] === "--thinking" && i + 1 < process.argv.length) {
    thinkingLevel = process.argv[++i];
  }
}

// If session file exists, restore state
if (sessionFile) {
  try {
    const content = readFileSync(sessionFile, "utf8");
    const data = JSON.parse(content);
    count = data.count ?? 0;
    memory = data.memory ?? {};
    thinkingLevel = data.thinkingLevel ?? thinkingLevel;
  } catch {
    // New or unreadable session file
  }
}

function persistSession() {
  if (sessionFile) {
    try {
      writeFileSync(sessionFile, JSON.stringify({ count, memory, thinkingLevel }));
    } catch {
      // Ignore write errors in mock
    }
  }
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

let pendingDialogResolver = null;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  const command = JSON.parse(line);

  if (command.type === "extension_ui_response") {
    if (pendingDialogResolver) {
      pendingDialogResolver(command);
      pendingDialogResolver = null;
    }
    return;
  }

  if (["prompt", "steer", "follow_up"].includes(command.type)) {
    send({ type: "response", id: command.id, command: command.type, success: true });
    send({ type: "agent_start" });

    // Check if dialog test triggered
    if (command.message && command.message.includes("trigger_dialog")) {
      send({ type: "extension_ui_request", id: "dialog-1", method: "confirm", message: "Confirm action?" });
      await new Promise((resolve) => { pendingDialogResolver = resolve; });
    }

    if (command.message && command.message.startsWith("remember:")) {
      memory.secret = command.message.slice("remember:".length).trim();
    }

    let text;
    if (command.message && command.message.includes("recall")) {
      text = `recalled:${memory.secret ?? "none"}`;
    } else {
      text = `reply-${++count}:${command.message}`;
    }

    persistSession();

    // High frequency streaming update
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    send({ type: "agent_settled" });
  } else if (command.type === "get_state") {
    send({
      type: "response",
      id: command.id,
      command: "get_state",
      success: true,
      data: {
        sessionId: "fake-session-id",
        sessionFile: sessionFile || "/tmp/fake-pi-session.jsonl",
        thinkingLevel,
      },
    });
  } else if (command.type === "set_thinking_level") {
    thinkingLevel = command.level;
    persistSession();
    send({ type: "response", id: command.id, command: "set_thinking_level", success: true });
  } else if (command.type === "switch_session") {
    sessionFile = command.sessionPath;
    if (sessionFile) {
      try {
        const content = readFileSync(sessionFile, "utf8");
        const data = JSON.parse(content);
        count = data.count ?? count;
        memory = data.memory ?? memory;
      } catch {}
    }
    send({ type: "response", id: command.id, command: "switch_session", success: true, data: { cancelled: false } });
  } else if (command.type === "abort") {
    send({ type: "response", id: command.id, command: "abort", success: true });
  } else {
    send({ type: "response", id: command.id, command: command.type, success: true });
  }
});
