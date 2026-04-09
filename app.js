import express from "express";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json());

let browserSocket;

const wss = new WebSocketServer({ port: 3001 });

wss.on("connection", (ws) => {
  console.log("Browser conectado");
  browserSocket = ws;
});

// 🔹 Converte messages → prompt
function buildPrompt(messages) {
  let prompt = "";

  for (const m of messages) {
    if (m.role === "system") {
      prompt += `SYSTEM: ${m.content}\n`;
    } else if (m.role === "user") {
      prompt += `USER: ${m.content}\n`;
    } else if (m.role === "assistant") {
      prompt += `ASSISTANT: ${m.content}\n`;
    }
  }

  prompt += "ASSISTANT:";
  return prompt;
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
// 🔹 Comunicação com browser
function askBrowser(prompt) {
  return new Promise((resolve, reject) => {
    if (!browserSocket) {
      return reject("Browser não conectado");
    }

    browserSocket.once("message", (msg) => {
      resolve(msg.toString());
    });

    browserSocket.send(prompt);
  });
}

// 🔥 Endpoint padrão OpenAI
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages, stream } = req.body;

    // (opcional) ignorar streaming por enquanto
    if (stream) {
      console.warn("Streaming não suportado ainda");
    }

    const prompt = buildPrompt(messages);

    console.log("\n--- PROMPT ---\n", prompt);

    const start = Date.now();

    const response = await askBrowser(prompt);

    const end = Date.now();
    const durationSec = (end - start) / 1000;
    
    const completionTokens = estimateTokens(response);
    const tokensPerSecond = completionTokens / durationSec;

    const debugInfo = `
    ---
    ⚡ Tokens: ${completionTokens}
    ⏱️ Tempo: ${durationSec.toFixed(2)}s
    🚀 Velocidade: ${tokensPerSecond.toFixed(2)} tokens/s
    `;

    console.log("\n--- RESPONSE ---\n", response);
    console.log(debugInfo);

    res.json({
      id: "chatcmpl-local",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gemini-nano-local",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response + debugInfo
          },
          finish_reason: "stop"
        }
      ]
    });

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
/*
import express from "express";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json());

let browserSocket;

const wss = new WebSocketServer({ port: 3001 });

wss.on("connection", (ws) => {
  console.log("Browser conectado");
  browserSocket = ws;
});

function askBrowser(prompt) {
  return new Promise((resolve) => {
    browserSocket.once("message", (msg) => {
      resolve(msg.toString());
    });

    browserSocket.send(prompt);
  });
}

app.post("/chat", async (req, res) => {
    console.log(req.body);
  const response = await askBrowser(req.body.prompt);
  res.json({ response });
});

app.listen(3000, async  ()=>{
    console.log("Servidor rodando na porta 3000");
})*/