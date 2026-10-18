// 测试用最小 MCP stdio server（JSON-RPC 2.0，newline-delimited）。
// 不依赖任何 SDK，只实现 initialize / tools/list / tools/call。

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // 忽略坏行。
      }
    }
    index = buffer.indexOf("\n");
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (message.method === "initialize") {
    // 鉴权测试：让服务端把 env 值打到 stderr，验证 client 日志脱敏。
    if (process.env.FAKE_STDERR_TOKEN === "1") {
      process.stderr.write(`stderr token=${process.env.FAKE_TOKEN ?? ""}\n`);
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            title: "Echo",
            description: "回显传入的文本",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            // 鉴权测试用：把启动时注入的 FAKE_TOKEN 环境变量读出来。
            // 值只进 stdout 的工具回执，不会出现在 GET /api/mcp。
            name: "env_echo",
            title: "Env Echo",
            description: "返回启动时注入的 FAKE_TOKEN 环境变量",
            inputSchema: { type: "object", properties: {} },
          },
          ...(process.env.FAKE_EXTRA_TOOLS === "1"
            ? [
                {
                  // 鉴权测试用：故意把 env 值塞进 JSON-RPC 错误信息，
                  // 验证 client 对错误信息也做脱敏。
                  name: "token_error",
                  title: "Token Error",
                  description: "返回包含 FAKE_TOKEN 的错误信息",
                  inputSchema: { type: "object", properties: {} },
                },
              ]
            : []),
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params?.name === "echo") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: `echo:${String(message.params?.arguments?.text ?? "")}` }],
        },
      });
    } else if (message.params?.name === "token_error") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: `secret is ${process.env.FAKE_TOKEN ?? "(missing)"}`,
        },
      });
    } else if (message.params?.name === "env_echo") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            { type: "text", text: `env:${process.env.FAKE_TOKEN ?? "(missing)"}` },
          ],
        },
      });
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown tool" } });
    }
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
  }
}
