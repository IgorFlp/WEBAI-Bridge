import express from "express";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// 📁 Base directory for file operations
const BASE_DIR = process.env.BASE_DIR || process.cwd();

// 🛠️ Tool Definitions (matching Anthropic format)
const TOOLS_DEFINITION = [
  {
    name: "read_file",
    description: "Read the contents of a file in the workspace",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative or absolute path to the file to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file with the specified content",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative or absolute path to create the file",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Edit an existing file by replacing a section",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative or absolute path to the file",
        },
        oldContent: {
          type: "string",
          description: "The exact content to find and replace",
        },
        newContent: {
          type: "string",
          description: "The new content to replace with",
        },
      },
      required: ["path", "oldContent", "newContent"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the workspace",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative or absolute path to the file to delete",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List the contents of a directory",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative or absolute path to the directory",
        },
      },
      required: ["path"],
    },
  },
];

// 🔧 Tool Execution Functions
function getFilePath(relativePath) {
  const resolved = path.resolve(BASE_DIR, relativePath);
  if (!resolved.startsWith(BASE_DIR)) {
    throw new Error("Access denied: path outside base directory");
  }
  return resolved;
}

function executeTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case "read_file": {
        const filePath = getFilePath(toolInput.path);
        const content = fs.readFileSync(filePath, "utf-8");
        return { content, success: true };
      }
      case "create_file": {
        const filePath = getFilePath(toolInput.path);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, toolInput.content, "utf-8");
        return { success: true, message: `File created: ${toolInput.path}` };
      }
      case "edit_file": {
        const filePath = getFilePath(toolInput.path);
        let content = fs.readFileSync(filePath, "utf-8");
        if (!content.includes(toolInput.oldContent)) {
          return { success: false, error: "oldContent not found in file" };
        }
        content = content.replace(toolInput.oldContent, toolInput.newContent);
        fs.writeFileSync(filePath, content, "utf-8");
        return { success: true, message: `File edited: ${toolInput.path}` };
      }
      case "delete_file": {
        const filePath = getFilePath(toolInput.path);
        fs.unlinkSync(filePath);
        return { success: true, message: `File deleted: ${toolInput.path}` };
      }
      case "list_dir": {
        const dirPath = getFilePath(toolInput.path);
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const files = entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
        }));
        return { entries: files, success: true };
      }
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 🔍 Parse response for tool use
function parseToolUse(response) {
  const toolCalls = [];
  try {
    // Procura por padrão JSON de tool use
    const pattern = /\{"type"\s*:\s*"tool_use"[^}]*\}/g;
    const matches = response.match(pattern);
    if (matches) {
      matches.forEach((match) => {
        try {
          const parsed = JSON.parse(match);
          if (parsed.type === "tool_use" && parsed.tool && parsed.input) {
            toolCalls.push(parsed);
          }
        } catch (e) {
          // ignore invalid JSON
        }
      });
    }
  } catch (err) {
    console.error("Error parsing tool use:", err);
  }
  return toolCalls;
}

let browserSocket;

const wss = new WebSocketServer({ port: 3001 });

wss.on("connection", (ws) => {
  console.log("Browser conectado");
  browserSocket = ws;
});

function extractText(content) {
  if (!content) return "";

  // caso simples (string)
  if (typeof content === "string") {
    return content;
  }

  // caso Anthropic (array)
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c.type === "text") return c.text;
        return "";
      })
      .join("");
  }

  return "";
}
// 🔹 Converte messages → prompt (com suporte a tools)
function buildPrompt(messages, tools = []) {
  let prompt = "";

  for (const m of messages) {
    const text = extractText(m.content);

    if (m.role === "system") {
      prompt += `SYSTEM: ${text}\n`;
    } else if (m.role === "user") {
      prompt += `USER: ${text}\n`;
    } else if (m.role === "assistant") {
      prompt += `ASSISTANT: ${text}\n`;
    }
  }

  // 🛠️ Se houver tools, adiciona instruções
  if (tools.length > 0) {
    prompt += "\n[AVAILABLE TOOLS]\n";
    tools.forEach((tool) => {
      prompt += `Tool: ${tool.name}\n`;
      prompt += `Description: ${tool.description}\n`;
      prompt += `Input Schema: ${JSON.stringify(tool.input_schema)}\n\n`;
    });
    prompt +=
      "When you need to use a tool, respond with JSON in this format:\n";
    prompt += '{"type": "tool_use", "tool": "tool_name", "input": {...}}\n';
    prompt += "You can call multiple tools in sequence.\n";
  }

  prompt += "ASSISTANT:";
  return prompt;
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function askBrowserStream(prompt, onChunk, onDone, tools = []) {
  const id = crypto.randomUUID();

  const handler = (msg) => {
    let data;

    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // 🔥 ignora mensagens de outras requests
    if (data.id !== id) return;

    if (data.type === "chunk") {
      onChunk(data.content);
    }

    if (data.type === "done") {
      browserSocket.off("message", handler);
      onDone();
    }
  };

  browserSocket.on("message", handler);

  browserSocket.send(
    JSON.stringify({
      id,
      prompt,
      tools,
    }),
  );
}

function askBrowserFull(prompt, tools = []) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    if (!browserSocket) {
      return reject("Browser não conectado");
    }

    let fullText = "";

    const handler = (msg) => {
      let data;

      try {
        data = JSON.parse(msg.toString());
      } catch {
        return; // ignora lixo
      }
      if (data.id !== id) return;

      if (data.type === "chunk") {
        fullText += data.content;
      }

      if (data.type === "done") {
        browserSocket.off("message", handler);
        resolve(fullText);
      }
    };

    browserSocket.on("message", handler);

    browserSocket.send(
      JSON.stringify({
        id,
        prompt,
        tools,
      }),
    );
  });
}
app.post("/v1/messages", async (req, res) => {
  try {
    const { messages, stream, tools } = req.body;

    // Determina quais tools usar
    const requestedTools = tools || [];
    const activeTools =
      requestedTools.length > 0
        ? TOOLS_DEFINITION.filter((t) =>
            requestedTools.some((rt) => rt.name === t.name),
          )
        : [];

    const prompt = buildPrompt(messages, activeTools);

    console.log("\n--- PROMPT ---\n", prompt);

    // =========================
    // 🧩 NÃO STREAMING (com tool use)
    // =========================
    if (!stream) {
      const start = Date.now();

      let response = await askBrowserFull(prompt, activeTools);
      let fullContent = [{ type: "text", text: response }];

      // 🔥 Detecta e executa tool use
      let toolCalls = parseToolUse(response);
      while (toolCalls.length > 0) {
        console.log("🛠️ Tool calls detected:", toolCalls.length);

        const toolResults = [];
        for (const toolCall of toolCalls) {
          console.log(`Executing tool: ${toolCall.tool}`, toolCall.input);
          const result = executeTool(toolCall.tool, toolCall.input);
          toolResults.push({
            tool: toolCall.tool,
            input: toolCall.input,
            result: result,
          });
        }

        // Adiciona tool use e resultados ao histórico
        fullContent.push({
          type: "tool_use",
          tools: toolResults,
        });

        // Continua a conversa com resultados das tools
        const toolResultText = toolResults
          .map((tr) => `Tool ${tr.tool} result: ${JSON.stringify(tr.result)}`)
          .join("\n");

        response = await askBrowserFull(
          prompt + "\n\n[TOOL RESULTS]\n" + toolResultText,
          activeTools,
        );
        fullContent.push({ type: "text", text: response });

        toolCalls = parseToolUse(response);
      }

      const end = Date.now();
      const durationSec = (end - start) / 1000;

      const inputTokens = estimateTokens(prompt);
      const outputTokens = estimateTokens(JSON.stringify(fullContent));
      const tps = outputTokens / durationSec;

      console.log("\n--- RESPONSE ---\n", fullContent);
      console.log(`⚡ ${outputTokens} tokens | ${tps.toFixed(2)} t/s`);

      return res.json({
        id: "msg-local",
        type: "message",
        role: "assistant",
        content: fullContent,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      });
    }

    // =========================
    // 🔥 STREAMING MODE (SSE)
    // =========================

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullText = "";
    const start = Date.now();

    // 🔥 1. INÍCIO DA MENSAGEM (ESSENCIAL)
    res.write(`event: message_start\n`);
    res.write(
      `data: ${JSON.stringify({
        id: "msg-local",
        type: "message",
        role: "assistant",
        content: [],
      })}\n\n`,
    );

    // 🔥 2. INÍCIO DO BLOCO DE CONTEÚDO
    res.write(`event: content_block_start\n`);
    res.write(
      `data: ${JSON.stringify({
        index: 0,
        type: "text",
      })}\n\n`,
    );

    askBrowserStream(
      prompt,

      // 🔹 cada chunk
      (chunk) => {
        fullText += chunk;

        res.write(`event: content_block_delta\n`);
        res.write(
          `data: ${JSON.stringify({
            index: 0,
            delta: {
              type: "text_delta",
              text: chunk,
            },
          })}\n\n`,
        );
      },

      // 🔹 fim
      () => {
        // 🛠️ Detecta tool use no streaming
        const toolCalls = parseToolUse(fullText);

        if (toolCalls.length > 0) {
          console.log("🛠️ Tool calls detected in streaming:", toolCalls.length);

          // Executa tools
          const toolResults = [];
          for (const toolCall of toolCalls) {
            console.log(`Executing tool: ${toolCall.tool}`, toolCall.input);
            const result = executeTool(toolCall.tool, toolCall.input);
            toolResults.push({
              tool: toolCall.tool,
              input: toolCall.input,
              result: result,
            });
          }

          // Envia tool use como novo bloco
          res.write(`event: content_block_stop\n`);
          res.write(
            `data: ${JSON.stringify({
              index: 0,
            })}\n\n`,
          );

          // Envia tool results como novo bloco
          res.write(`event: content_block_start\n`);
          res.write(
            `data: ${JSON.stringify({
              index: 1,
              type: "tool_use",
            })}\n\n`,
          );

          res.write(`event: content_block_delta\n`);
          res.write(
            `data: ${JSON.stringify({
              index: 1,
              delta: {
                type: "tool_results",
                tools: toolResults,
              },
            })}\n\n`,
          );

          res.write(`event: content_block_stop\n`);
          res.write(
            `data: ${JSON.stringify({
              index: 1,
            })}\n\n`,
          );
        } else {
          // Sem tool use, apenas fecha o bloco de texto
          res.write(`event: content_block_stop\n`);
          res.write(
            `data: ${JSON.stringify({
              index: 0,
            })}\n\n`,
          );
        }

        const end = Date.now();
        const durationSec = (end - start) / 1000;

        const inputTokens = estimateTokens(prompt);
        const outputTokens = estimateTokens(fullText);
        const tps = outputTokens / durationSec;

        console.log(`⚡ ${outputTokens} tokens | ${tps.toFixed(2)} t/s`);

        // 🔥 FIM DA MENSAGEM
        res.write(`event: message_delta\n`);
        res.write(
          `data: ${JSON.stringify({
            delta: {
              stop_reason: "end_turn",
            },
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
            },
          })}\n\n`,
        );

        res.write(`event: message_stop\n`);
        res.write(`data: {}\n\n`);

        res.end();
      },
      activeTools,
    );
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: {
        message: err.toString(),
        type: "internal_error",
      },
    });
  }
});
/*
app.post("/v1/messages", async (req, res) => {
  try {
    const { messages, stream } = req.body;

    const prompt = buildPrompt(messages);

    console.log("\n--- PROMPT ---\n", prompt);

    // =========================
    // 🧩 NÃO STREAMING
    // =========================
    if (!stream) {
        const start = Date.now();

        const response = await askBrowserFull(prompt);

        const end = Date.now();
        const durationSec = (end - start) / 1000;

        const tokens = estimateTokens(response);
        const tps = tokens / durationSec;
        const inputTokens = estimateTokens(prompt);
        const outputTokens = estimateTokens(response);

        console.log(`⚡ ${tokens} tokens | ${tps.toFixed(2)} t/s`);

        return res.json({   // 🔥 AQUI
            id: "msg-local",
            type: "message",
            role: "assistant",
            content: [
            {
                type: "text",
                text: response
            }
            ],
            usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens
            }
        });
        }

    // =========================
    // 🔥 STREAMING MODE (SSE)
    // =========================

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullText = "";
    const start = Date.now();

    askBrowserStream(
      prompt,

      // 🔹 cada chunk
      (chunk) => {
        fullText += chunk;

        const event = {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: chunk
          }
        };

        res.write(`event: content_block_delta\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },

      // 🔹 fim
      () => {
        const end = Date.now();
        const durationSec = (end - start) / 1000;

        const tokens = estimateTokens(fullText);
        const tps = tokens / durationSec;

        console.log(`⚡ ${tokens} tokens | ${tps.toFixed(2)} t/s`);

        // evento de fim do bloco
        res.write(`event: content_block_stop\n`);
        res.write(`data: {}\n\n`);

        // mensagem final        
        res.write(`event: message_stop\n`);
        res.write(`data: ${JSON.stringify({
        stop_reason: "end_turn",
        usage: {
            input_tokens: estimateTokens(prompt),
            output_tokens: estimateTokens(fullText)
        }
        })}\n\n`);
        res.end();
      }
    );

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: {
        message: err.toString(),
        type: "internal_error"
      }
    });
  }
});
*/
app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  next();
});

// �️ Endpoint de tools
app.get("/v1/tools", (req, res) => {
  res.json({
    object: "list",
    data: TOOLS_DEFINITION,
  });
});

// �🔹 Endpoint de modelos (opcional mas recomendado)
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "gemini-nano-local",
        object: "model",
        owned_by: "local",
      },
    ],
  });
});

app.listen(3000, () => {
  console.log("🚀 API OpenAI-like rodando em http://localhost:3000");
});
