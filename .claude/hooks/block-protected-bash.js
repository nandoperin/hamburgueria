// PreToolUse guard for Bash: blocks commands that delete/overwrite/move .env or auth_info_baileys/.
let data = "";
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(data);
  } catch {
    return;
  }

  const command = (input.tool_input && input.tool_input.command) || "";

  const targetsProtected = /(^|[\s"'/])\.env(\s|"|'|$)|auth_info_baileys/i.test(command);
  if (!targetsProtected) return;

  const mutates =
    /\b(rm|del|erase|shred|truncate|mv|move|Remove-Item)\b/i.test(command) ||
    />>?\s*['"]?\.env\b/.test(command);

  if (mutates) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Bloqueado pelo hook do projeto: comandos que apagam/sobrescrevem/movem .env ou auth_info_baileys/ nao sao permitidos (ver CLAUDE.md).",
        },
      })
    );
  }
});
