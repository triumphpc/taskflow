# Golden files for the existing MCP tools

Do not regenerate. These files were produced from the behavior of `mcp.mjs` before the agent delegation
change (fixture `test/fixtures/legacy-tasks.json`, no `agent` block). `test/mcp-contract.test.mjs`
compares the output of every existing tool byte for byte (NFR-007, AC-027). A diff in this directory
means the output of an existing tool changed.

Regeneration is only for a deliberate, reviewed change of the contract:
`UPDATE_GOLDEN=1 node --test test/mcp-contract.test.mjs`.
