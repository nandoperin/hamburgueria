// PreToolUse guard for Write/Edit: blocks .env and auth_info_baileys/ (WhatsApp session).
let data = "";
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(data);
  } catch {
    return;
  }

  const filePath = (input.tool_input && input.tool_input.file_path) || "";
  const norm = filePath.replace(/\\/g, "/");

  const isDotEnv = /(^|\/)\.env$/.test(norm);
  const isAuthSession = /(^|\/)auth_info_baileys(\/|$)/.test(norm);

  if (isDotEnv || isAuthSession) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Bloqueado pelo hook do projeto: " +
            filePath +
            " nao pode ser editado/escrito (.env e auth_info_baileys/ sao protegidos - ver CLAUDE.md).",
        },
      })
    );
  }
});
