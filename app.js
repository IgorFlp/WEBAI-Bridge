import express from "express";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.use(express.json());

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
// 🔹 Converte messages → prompt
function buildPrompt(messages) {
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

  prompt += "ASSISTANT:";
  return prompt;
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function askBrowserStream(prompt, onChunk, onDone) {
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

  browserSocket.send(JSON.stringify({
    id,
    prompt
  }));
}

function askBrowserFull(prompt) {
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

    browserSocket.send(JSON.stringify({
        id,
        prompt
        }));
  });
}
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

      const inputTokens = estimateTokens(prompt);
      const outputTokens = estimateTokens(response);
      const tps = outputTokens / durationSec;

      console.log(`⚡ ${outputTokens} tokens | ${tps.toFixed(2)} t/s`);

      return res.json({
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

    // 🔥 1. INÍCIO DA MENSAGEM (ESSENCIAL)
    res.write(`event: message_start\n`);
    res.write(`data: ${JSON.stringify({
      id: "msg-local",
      type: "message",
      role: "assistant",
      content: []
    })}\n\n`);

    // 🔥 2. INÍCIO DO BLOCO DE CONTEÚDO
    res.write(`event: content_block_start\n`);
    res.write(`data: ${JSON.stringify({
      index: 0,
      type: "text"
    })}\n\n`);

    askBrowserStream(
      prompt,

      // 🔹 cada chunk
      (chunk) => {
        fullText += chunk;

        res.write(`event: content_block_delta\n`);
        res.write(`data: ${JSON.stringify({
          index: 0,
          delta: {
            type: "text_delta",
            text: chunk
          }
        })}\n\n`);
      },

      // 🔹 fim
      () => {
        const end = Date.now();
        const durationSec = (end - start) / 1000;

        const inputTokens = estimateTokens(prompt);
        const outputTokens = estimateTokens(fullText);
        const tps = outputTokens / durationSec;

        console.log(`⚡ ${outputTokens} tokens | ${tps.toFixed(2)} t/s`);

        // 🔥 3. FIM DO BLOCO
        res.write(`event: content_block_stop\n`);
        res.write(`data: ${JSON.stringify({
          index: 0
        })}\n\n`);

        // 🔥 4. FIM DA MENSAGEM (ESSENCIAL)
        res.write(`event: message_stop\n`);
        res.write(`data: ${JSON.stringify({
          stop_reason: "end_turn",
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens
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

// 🔹 Endpoint de modelos (opcional mas recomendado)
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "gemini-nano-local",
        object: "model",
        owned_by: "local"
      }
    ]
  });
});

app.listen(3000, () => {
  console.log("🚀 API OpenAI-like rodando em http://localhost:3000");
});
